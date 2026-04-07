// api/mlb-stats.js — Proxy a MLB Stats API federal + modelo estadistico Poisson
import { createClient } from "@supabase/supabase-js";

const FREE_LIMIT = 1, PRO_LIMIT = 10, ELITE_LIMIT = 9999;

function getServiceSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

async function handleUsage(req, res) {
  const sb = getServiceSupabase();
  if (!sb) return res.status(500).json({ error: "Supabase no configurado" });
  const { action, userId } = req.method === "POST" ? req.body : req.query;
  if (!userId) return res.status(400).json({ error: "userId requerido" });
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Mexico_City',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  try {
    if (action === "check") {
      const { data: pd } = await sb.from("user_plans").select("plan").eq("user_id", userId).maybeSingle();
      const plan = pd?.plan || "free";
      const limit = plan === "elite" ? ELITE_LIMIT : plan === "pro" ? PRO_LIMIT : FREE_LIMIT;
      const { data: ud } = await sb.from("user_usage").select("count").eq("user_id", userId).eq("date", today).maybeSingle();
      return res.status(200).json({ allowed: (ud?.count || 0) < limit, used: ud?.count || 0, limit, plan });
    }
    if (action === "increment") {
      const { data: ex } = await sb.from("user_usage").select("id, count").eq("user_id", userId).eq("date", today).maybeSingle();
      if (ex) await sb.from("user_usage").update({ count: ex.count + 1 }).eq("id", ex.id);
      else {
        await sb.from("user_usage").upsert(
          { user_id: userId, date: today, count: 1 },
          { onConflict: "user_id,date" }
        );
      }
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "accion invalida" });
  } catch(e) { return res.status(500).json({ error: e.message }); }
}

const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'https://betanalyticsIA.com';

// ── Helpers ──
function toAm(p) {
  if (!p && p !== 0) return null;
  if (Math.abs(p) > 10) return p > 0 ? `+${p}` : `${p}`;
  if (p >= 2) return `+${Math.round((p - 1) * 100)}`;
  if (p > 1) return `-${Math.round(100 / (p - 1))}`;
  return null;
}

function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return x >= 0 ? 1 - poly * Math.exp(-x * x) : -(1 - poly * Math.exp(-x * x));
}
const normCDF = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

// ── MLB Poisson Model ──
function calcMLBPoisson(hStats, aStats, marketTotal = null) {
  if (!hStats || !aStats) return null;

  const leagueAvg = 4.7;
  const homeAdv = 1.02;

  const hOff = parseFloat(hStats.runsPerGame || leagueAvg) / leagueAvg;
  const hDef = parseFloat(hStats.runsAgainstPerGame || leagueAvg) / leagueAvg;
  const aOff = parseFloat(aStats.runsPerGame || leagueAvg) / leagueAvg;
  const aDef = parseFloat(aStats.runsAgainstPerGame || leagueAvg) / leagueAvg;

  let xRunsHome = leagueAvg * hOff * aDef * homeAdv;
  let xRunsAway = leagueAvg * aOff * hDef;

  // Pitcher adjustment
  if (hStats.pitcherEra && hStats.pitcherEra > 0) {
    const pitAdj = hStats.pitcherEra / leagueAvg;
    xRunsAway *= (0.7 * aDef + 0.3 * pitAdj);
  }
  if (aStats.pitcherEra && aStats.pitcherEra > 0) {
    const pitAdj = aStats.pitcherEra / leagueAvg;
    xRunsHome *= (0.7 * hDef + 0.3 * pitAdj);
  }

  // Wider limits
  xRunsHome = Math.max(1.5, Math.min(11, xRunsHome));
  xRunsAway = Math.max(1.5, Math.min(11, xRunsAway));

  let total = xRunsHome + xRunsAway;

  // Market anchor
  if (marketTotal && marketTotal > 5) {
    total = 0.3 * total + 0.7 * marketTotal;
    const ratio = xRunsHome / (xRunsHome + xRunsAway);
    xRunsHome = total * ratio;
    xRunsAway = total * (1 - ratio);
  }

  const spread = xRunsHome - xRunsAway;
  const stdDevSpread = 1.75;
  const stdDevTotal = 2.3;

  const zSpread = spread / stdDevSpread;
  const pHome = Math.min(80, Math.max(20, Math.round(normCDF(zSpread) * 100)));

  const calcOverProb = (line) => {
    const z = (total - line) / stdDevTotal;
    return Math.min(70, Math.max(30, Math.round(normCDF(z) * 100)));
  };

  // Build over probs for common lines
  const overProbs = {};
  for (let line = 8; line <= 12; line += 0.5) {
    const key = `pOver${line}`;
    overProbs[key] = calcOverProb(line);
  }

  return {
    xRunsHome: +xRunsHome.toFixed(2),
    xRunsAway: +xRunsAway.toFixed(2),
    total: +total.toFixed(2),
    spread: +spread.toFixed(2),
    hOff: +hOff.toFixed(2),
    hDef: +hDef.toFixed(2),
    aOff: +aOff.toFixed(2),
    aDef: +aDef.toFixed(2),
    pHome, pAway: 100 - pHome,
    ...overProbs,
  };
}

// ── Parse MLB odds ──
function parseMLBOdds(oddsData) {
  if (!oddsData || !Array.isArray(oddsData)) return null;
  const mlMarket = oddsData.find(m => m.key === "h2h");
  const totals = oddsData.find(m => m.key === "totals")?.outcomes || [];

  let marketTotal = null;
  const overOutcome = totals.find(o => o.name === "Over");
  if (overOutcome?.point) marketTotal = parseFloat(overOutcome.point);
  const underOutcome = totals.find(o => o.name === "Under");

  return {
    marketTotal,
    mlOutcomes: mlMarket?.outcomes || [],
    overOutcome, underOutcome,
  };
}

// ── Edge calculation ──
function calcMLBEdges(poisson, parsedOdds, homeName, awayName) {
  if (!poisson || !parsedOdds) return [];
  const edges = [];

  const addEdge = (market, pick, ourProb, price) => {
    if (!price || ourProb == null) return;
    const implied = price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100);
    const edge = ourProb - implied;
    const dec = price > 0 ? (price / 100 + 1) : (100 / Math.abs(price) + 1);
    const kelly = edge > 0 ? Math.max(0, Math.min(15, parseFloat(((edge / (dec - 1)) * 100).toFixed(1)))) : 0;
    edges.push({
      market, pick,
      ourProb: +(ourProb * 100).toFixed(1),
      impliedProb: +(implied * 100).toFixed(1),
      edge: +(edge * 100).toFixed(1),
      kelly,
      decimal: +dec.toFixed(2),
      american: toAm(price),
      hasValue: edge > 0.03,
      isUnderdog: dec >= 2.0,
    });
  };

  // Moneyline edges
  if (parsedOdds.mlOutcomes.length >= 2) {
    addEdge("Moneyline", homeName, poisson.pHome / 100, parsedOdds.mlOutcomes[0]?.price);
    addEdge("Moneyline", awayName, poisson.pAway / 100, parsedOdds.mlOutcomes[1]?.price);
  }

  // Total edge with real market line
  if (parsedOdds.overOutcome) {
    const line = parsedOdds.overOutcome.point;
    const key = `pOver${line}`;
    const overProb = (poisson[key] || 50) / 100;
    addEdge("Total", `Over ${line}`, overProb, parsedOdds.overOutcome?.price);
    if (parsedOdds.underOutcome) {
      addEdge("Total", `Under ${line}`, 1 - overProb, parsedOdds.underOutcome?.price);
    }
  }

  return edges.sort((a, b) => b.edge - a.edge);
}

// ── Build picks ──
function buildMLBPicks(poisson, edges, homeName, awayName) {
  const picks = [];

  const trends = [];
  if (poisson.total >= 10) trends.push("ProYECCION de alta puntuacion");
  else if (poisson.total <= 7) trends.push("ProYECCION de baja puntuacion");

  // ── PICK 1: Moneyline ──
  const bestML = edges.find(e => e.market === "Moneyline");
  if (bestML && Math.abs(bestML.edge) > 2) {
    picks.push({
      tipo: "Moneyline", pick: bestML.pick,
      confianza: Math.min(75, 52 + Math.abs(bestML.edge) * 1.2),
      odds_sugerido: bestML.decimal > 1.8 ? bestML.american : bestML.decimal.toString(),
      categoria: "principal",
      factores: [
        `xRuns: ${homeName} ${poisson.xRunsHome} - ${awayName} ${poisson.xRunsAway}`,
        `Prob: ${bestML.ourProb}% vs implicita ${bestML.impliedProb}%`,
        `Edge: ${bestML.edge > 0 ? '+' : ''}${bestML.edge}% | Kelly: ${bestML.kelly}%`,
      ].concat(trends.slice(0, 1)),
    });
  } else {
    const mlWinner = poisson.pHome >= 50 ? homeName : awayName;
    const mlEdge = edges.find(e => e.market === "Moneyline" && e.pick === mlWinner);
    picks.push({
      tipo: "Moneyline", pick: mlWinner,
      confianza: 50 + Math.abs(poisson.pHome - 50) * 0.5,
      odds_sugerido: mlEdge?.american || "-150",
      categoria: "principal",
      factores: [
        `${homeName} ${poisson.pHome}% | ${awayName} ${poisson.pAway}%`,
        `Modelo: ${poisson.xRunsHome}-${poisson.xRunsAway}`,
      ],
    });
  }

  // ── PICK 2: Total ──
  const totalEdge = edges.find(e => e.market === "Total");
  const marketLine = totalEdge ? parseFloat(totalEdge.pick.replace(/[^0-9.]/g, '')) : poisson.total;
  const overProb = totalEdge?.ourProb || 50;
  const overPick = overProb >= 50 ? `Over ${marketLine}` : `Under ${marketLine}`;

  picks.push({
    tipo: "Total", pick: overPick,
    confianza: Math.min(68, 45 + Math.abs(overProb - 50) * 1.5),
    odds_sugerido: totalEdge?.american || "-110",
    categoria: "totales",
    factores: [
      `ProYECCION: ${poisson.total} carreras | Mercado: ${marketLine}`,
      `${overPick}: ${overProb.toFixed(1)}%`,
    ],
  });

  // ── PICK 3: Run Line ──
  const runLinePick = poisson.spread > 0 ? `${homeName} -1.5` : `${awayName} +1.5`;
  const zRL = (Math.abs(poisson.spread) - 1.5) / 1.75;
  const rlProb = Math.min(65, Math.max(35, Math.round(normCDF(zRL) * 100)));
  picks.push({
    tipo: "Run Line", pick: runLinePick,
    confianza: rlProb,
    odds_sugerido: "-110",
    categoria: "principal",
    factores: [`Run Line: diferencia modelo ${Math.abs(poisson.spread).toFixed(1)} carreras`],
  });

  // ── PICK 4: First 5 innings ──
  const first5 = (poisson.total * 0.5).toFixed(1);
  picks.push({
    tipo: "Primera 5 Innings", pick: `Over ${first5}`,
    confianza: Math.min(60, 47 + Math.abs(overProb - 50) * 0.6),
    odds_sugerido: "-110",
    categoria: "mitad",
    factores: [`F5 proyectado: ${first5} carreras (50% del total de ${poisson.total})`],
  });

  return picks.sort((a, b) => b.confianza - a.confianza);
}

// ── Main handler ──
const BASE = "https://statsapi.mlb.com/api/v1";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Usage tracking routes
  if (req.query.action === "check" || req.query.action === "increment" || req.body?.action) {
    return handleUsage(req, res);
  }

  // ── POST: Analysis endpoint ──
  if (req.method === "POST") {
    const {
      homeTeam, awayTeam, homeStats, awayStats,
      oddsData, splitsData, h2hData, isCalibration
    } = req.body;

    if (!homeStats || !awayStats) {
      return res.status(400).json({ error: "homeStats y awayStats requeridos" });
    }

    const parsedOdds = parseMLBOdds(oddsData);
    const poisson = calcMLBPoisson(homeStats, awayStats, parsedOdds?.marketTotal);
    if (!poisson) return res.status(500).json({ error: "Error calculando modelo MLB" });

    const edges = calcMLBEdges(poisson, parsedOdds, homeTeam, awayTeam);
    const picks = buildMLBPicks(poisson, edges, homeTeam, awayTeam);

    const summary = `Modelo proyecta ${homeTeam} ${poisson.xRunsHome}-${poisson.xRunsAway} ${awayTeam} (total: ${poisson.total}, spread: ${poisson.spread > 0 ? '+' : ''}${poisson.spread}). ${homeTeam} ${poisson.pHome}% | ${awayTeam} ${poisson.pAway}%.`;

    return res.status(200).json({
      resumen: summary,
      ganadorProbable: poisson.pHome > poisson.pAway ? homeTeam : awayTeam,
      probabilidades: { home: poisson.pHome, away: poisson.pAway },
      prediccionMarcador: `${poisson.xRunsHome}-${poisson.xRunsAway}`,
      apuestasDestacadas: picks,
      recomendaciones: picks.slice(0, 3).map(p => ({
        mercado: p.tipo, seleccion: p.pick,
        confianza: Math.round(p.confianza),
        razonamiento: p.factores.join('. '),
      })),
      alertas: [],
      tendencias: {
        puntosEsperados: poisson.total,
        spreadEsperado: poisson.spread,
      },
      contextoExtra: {
        homeOffense: poisson.hOff, homeDefense: poisson.hDef,
        awayOffense: poisson.aOff, awayDefense: poisson.aDef,
      },
      edgesDetalle: edges.slice(0, 5),
      _model: 'mlb-poisson',
      _version: '1.0',
    });
  }

  // ── GET: Proxy to MLB stats API ──
  const { type, date, gamePk, playerId } = req.query;

  try {
    let url = "";

    if (type === "schedule") {
      url = `${BASE}/schedule?sportId=1&date=${date}&hydrate=probablePitcher(note),lineups,linescore`;
    } else if (type === "game") {
      url = `${BASE}/game/${gamePk}/linescore`;
    } else if (type === "boxscore") {
      url = `${BASE}/game/${gamePk}/boxscore`;
    } else if (type === "pitcher_stats") {
      url = `${BASE}/people/${playerId}/stats?stats=season&season=2026&group=pitching`;
    } else if (type === "batter_stats") {
      url = `${BASE}/people/${playerId}/stats?stats=season&season=2026&group=hitting`;
    } else {
      return res.status(400).json({ error: "Tipo invalido. Usa: schedule, game, boxscore, pitcher_stats, batter_stats, o POST para analisis" });
    }

    const r = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": "BetAnalyticsIA/1.0" }
    });

    if (!r.ok) return res.status(r.status).json({ error: `MLB API error: ${r.status}` });

    const data = await r.json();
    return res.status(200).json(data);

  } catch(e) {
    return res.status(500).json({ error: "Error contactando MLB Stats API: " + e.message });
  }
}
