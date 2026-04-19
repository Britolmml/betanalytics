// api/mlb-stats.js — MLB Stats API proxy + modelo estadístico Poisson avanzado
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

// ── Pitcher Quality Index ──
// 0.7 = ace, 1.0 = league average, 1.4+ = bad
function pitcherQuality(stats) {
  if (!stats) return 1.0;
  const era = parseFloat(stats.era);
  const whip = parseFloat(stats.whip);
  const ip = parseFloat(stats.ip);
  if (isNaN(era) || era <= 0) return 1.0;
  const leagueERA = 4.3;
  const leagueWHIP = 1.28;
  const eraFactor = era / leagueERA;
  const whipFactor = (!isNaN(whip) && whip > 0) ? whip / leagueWHIP : 1.0;
  const ipFactor = (!isNaN(ip) && ip > 0) ? (ip > 40 ? 1.0 : 1.08) : 1.05;
  return Math.max(0.55, Math.min(1.6, 0.50 * eraFactor + 0.30 * whipFactor + 0.20 * ipFactor));
}

// ── MLB Poisson Model (Enhanced) ──
function calcMLBPoisson(hStats, aStats, marketTotal = null, pitchers = null) {
  if (!hStats || !aStats) return null;

  const leagueAvg = 4.7;
  const homeAdv = 1.02;

  const hOff = parseFloat(hStats.runsPerGame || hStats.avgRuns || leagueAvg) / leagueAvg;
  const hDef = parseFloat(hStats.runsAgainstPerGame || hStats.avgRunsAgainst || leagueAvg) / leagueAvg;
  const aOff = parseFloat(aStats.runsPerGame || aStats.avgRuns || leagueAvg) / leagueAvg;
  const aDef = parseFloat(aStats.runsAgainstPerGame || aStats.avgRunsAgainst || leagueAvg) / leagueAvg;

  let xRunsHome = leagueAvg * hOff * aDef * homeAdv;
  let xRunsAway = leagueAvg * aOff * hDef;

  // Pitcher quality adjustment (home pitcher suppresses away runs, vice versa)
  const homePQ = pitcherQuality(pitchers?.home?.stats);
  const awayPQ = pitcherQuality(pitchers?.away?.stats);
  xRunsAway *= (0.5 + 0.5 * homePQ); // good home pitcher -> fewer away runs
  xRunsHome *= (0.5 + 0.5 * awayPQ);

  // Form adjustment
  const hWinRate = (hStats.wins || 0) / (hStats.games || 10);
  const aWinRate = (aStats.wins || 0) / (aStats.games || 10);
  xRunsHome *= (0.99 + 0.02 * hWinRate);
  xRunsAway *= (0.99 + 0.02 * aWinRate);

  // Bounds
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

  // Over probs for common lines
  const overProbs = {};
  for (let line = 6; line <= 13; line += 0.5) {
    overProbs[`pOver${line}`] = calcOverProb(line);
  }

  // F5 model (first 5 innings ~ 55% of game)
  const xRunsHomeF5 = +(xRunsHome * 0.55).toFixed(2);
  const xRunsAwayF5 = +(xRunsAway * 0.55).toFixed(2);
  const totalF5 = +(xRunsHomeF5 + xRunsAwayF5).toFixed(2);
  const spreadF5 = xRunsHomeF5 - xRunsAwayF5;
  const zSpreadF5 = spreadF5 / (stdDevSpread * 0.7);
  const pHomeF5 = Math.min(78, Math.max(22, Math.round(normCDF(zSpreadF5) * 100)));

  // NRFI model
  const homeNrfiPct = parseFloat(hStats.nrfiPct || 50);
  const awayNrfiPct = parseFloat(aStats.nrfiPct || 50);
  let nrfiBase = (homeNrfiPct + awayNrfiPct) / 200; // 0-1
  // Good pitchers (low ERA, high K/9) increase NRFI probability
  const homeK9 = parseFloat(pitchers?.home?.stats?.k9 || 8);
  const awayK9 = parseFloat(pitchers?.away?.stats?.k9 || 8);
  const pitcherNrfiAdj = ((homeK9 / 9) + (awayK9 / 9)) / 2;
  // Lower quality index = better pitcher = higher NRFI
  const pitcherEraAdj = ((2 - homePQ) + (2 - awayPQ)) / 2;
  const nrfiProb = Math.min(0.78, Math.max(0.30, nrfiBase * 0.5 + pitcherNrfiAdj * 0.2 + pitcherEraAdj * 0.3));

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
    // F5
    xRunsHomeF5, xRunsAwayF5, totalF5, pHomeF5, pAwayF5: 100 - pHomeF5,
    // NRFI
    nrfiProb: +nrfiProb.toFixed(3),
    yrfiProb: +(1 - nrfiProb).toFixed(3),
    // Pitcher quality
    homePQ: +homePQ.toFixed(2),
    awayPQ: +awayPQ.toFixed(2),
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

// ── Edge calculation (expanded) ──
function calcMLBEdges(poisson, parsedOdds, homeName, awayName) {
  if (!poisson || !parsedOdds) return [];
  const edges = [];

  const addEdge = (market, pick, ourProb, price) => {
    if (!price || ourProb == null) return;
    const implied = price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100);
    const edge = ourProb - implied;
    const dec = price > 0 ? (price / 100 + 1) : (100 / Math.abs(price) + 1);
    const fullKelly = edge > 0 ? Math.max(0, (edge / (dec - 1)) * 100) : 0;
    const kelly = parseFloat((Math.min(fullKelly * 0.25, 5)).toFixed(1)); // 25% Kelly, cap 5%
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

  // Total edge
  if (parsedOdds.overOutcome) {
    const line = parsedOdds.overOutcome.point;
    const key = `pOver${line}`;
    const overProb = (poisson[key] || 50) / 100;
    addEdge("Total", `Over ${line}`, overProb, parsedOdds.overOutcome?.price);
    if (parsedOdds.underOutcome) {
      addEdge("Total", `Under ${line}`, 1 - overProb, parsedOdds.underOutcome?.price);
    }
  }

  // Run Line edges (-1.5)
  const zRL = (Math.abs(poisson.spread) - 1.5) / 1.75;
  const rlFavProb = normCDF(zRL);
  if (poisson.spread > 0) {
    addEdge("Run Line", `${homeName} -1.5`, rlFavProb, parsedOdds.mlOutcomes[0]?.price ? parsedOdds.mlOutcomes[0]?.price * 0.7 : null);
    addEdge("Run Line", `${awayName} +1.5`, 1 - rlFavProb, parsedOdds.mlOutcomes[1]?.price ? parsedOdds.mlOutcomes[1]?.price * 1.3 : null);
  } else {
    addEdge("Run Line", `${awayName} -1.5`, rlFavProb, parsedOdds.mlOutcomes[1]?.price ? parsedOdds.mlOutcomes[1]?.price * 0.7 : null);
    addEdge("Run Line", `${homeName} +1.5`, 1 - rlFavProb, parsedOdds.mlOutcomes[0]?.price ? parsedOdds.mlOutcomes[0]?.price * 1.3 : null);
  }

  // NRFI edge
  addEdge("NRFI", "No Run 1st Inning", poisson.nrfiProb, -120); // typical NRFI line
  addEdge("YRFI", "Yes Run 1st Inning", poisson.yrfiProb, -100);

  // F5 Moneyline edge
  addEdge("F5 ML", `${homeName} F5`, poisson.pHomeF5 / 100, parsedOdds.mlOutcomes[0]?.price);
  addEdge("F5 ML", `${awayName} F5`, poisson.pAwayF5 / 100, parsedOdds.mlOutcomes[1]?.price);

  return edges.sort((a, b) => b.edge - a.edge);
}

// ── Generate Alerts ──
function generateMLBAlerts(poisson, homeStats, awayStats, pitchers, homeName, awayName) {
  const alertas = [];

  // Pitcher ERA alerts
  const homeERA = parseFloat(pitchers?.home?.stats?.era);
  const awayERA = parseFloat(pitchers?.away?.stats?.era);
  if (homeERA > 5) alertas.push(`⚠️ Pitcher local ${pitchers.home.name} con ERA alto (${homeERA}) — ofensiva visitante puede explotar`);
  if (awayERA > 5) alertas.push(`⚠️ Pitcher visitante ${pitchers.away.name} con ERA alto (${awayERA}) — ofensiva local puede explotar`);

  // Pitcher WHIP alerts
  const homeWHIP = parseFloat(pitchers?.home?.stats?.whip);
  const awayWHIP = parseFloat(pitchers?.away?.stats?.whip);
  if (homeWHIP > 1.5) alertas.push(`⚠️ ${pitchers?.home?.name || 'Pitcher local'} WHIP alto (${homeWHIP}) — muchos corredores en base`);
  if (awayWHIP > 1.5) alertas.push(`⚠️ ${pitchers?.away?.name || 'Pitcher visitante'} WHIP alto (${awayWHIP}) — muchos corredores en base`);

  // High K/9 pitcher (strikeout upside)
  const homeK9 = parseFloat(pitchers?.home?.stats?.k9);
  const awayK9 = parseFloat(pitchers?.away?.stats?.k9);
  if (homeK9 > 10) alertas.push(`🔥 ${pitchers?.home?.name || 'Pitcher local'} con K/9 elite (${homeK9}) — potencial de strikeout alto`);
  if (awayK9 > 10) alertas.push(`🔥 ${pitchers?.away?.name || 'Pitcher visitante'} con K/9 elite (${awayK9}) — potencial de strikeout alto`);

  // Close game
  if (Math.abs(poisson.spread) <= 0.5) alertas.push("⚖️ Partido muy parejo — spread < 0.5 carreras. Moneyline riesgoso.");

  // Scoring projection
  if (poisson.total >= 10) alertas.push("🔥 Proyección de muchas carreras — pitching débil de ambos lados.");
  else if (poisson.total <= 7) alertas.push("🛡️ Proyección de pocas carreras — pitchers dominantes.");

  // NRFI signal
  const homeNrfi = parseFloat(homeStats.nrfiPct || 0);
  const awayNrfi = parseFloat(awayStats.nrfiPct || 0);
  if (homeNrfi >= 70 && awayNrfi >= 70) {
    alertas.push(`🔒 NRFI alto: ${homeName} ${homeNrfi}% + ${awayName} ${awayNrfi}% = valor en No Run 1st Inning`);
  } else if (homeNrfi <= 35 && awayNrfi <= 35) {
    alertas.push(`💥 YRFI probable: ${homeName} ${homeNrfi}% + ${awayName} ${awayNrfi}% NRFI — carreras tempranas esperadas`);
  }

  // Pitcher quality mismatch
  if (poisson.homePQ && poisson.awayPQ && Math.abs(poisson.homePQ - poisson.awayPQ) > 0.35) {
    const better = poisson.homePQ < poisson.awayPQ ? homeName : awayName;
    alertas.push(`⚾ Gran ventaja de pitcheo para ${better} — desbalance claro en calidad de abridor`);
  }

  return alertas;
}

// ── Generate Tendencias ──
function generateMLBTendencias(poisson, homeStats, awayStats, h2hData, pitchers, homeName, awayName) {
  const tendencias = [];

  // Hot streaks
  if ((homeStats.wins || 0) >= 7) tendencias.push(`${homeName} en racha caliente: ${homeStats.wins}/${homeStats.games} victorias recientes`);
  if ((awayStats.wins || 0) >= 7) tendencias.push(`${awayName} en racha caliente: ${awayStats.wins}/${awayStats.games} victorias recientes`);

  // Cold streaks
  const hLosses = (homeStats.games || 0) - (homeStats.wins || 0);
  const aLosses = (awayStats.games || 0) - (awayStats.wins || 0);
  if (hLosses >= 7) tendencias.push(`${homeName} en mala racha: ${hLosses} derrotas en ${homeStats.games} partidos`);
  if (aLosses >= 7) tendencias.push(`${awayName} en mala racha: ${aLosses} derrotas en ${awayStats.games} partidos`);

  // Scoring
  if (poisson.total >= 10) tendencias.push("Proyección de alto scoring — pitchers vulnerables");
  else if (poisson.total <= 7) tendencias.push("Proyección de bajo scoring — pitchers dominantes");

  // NRFI trends
  if ((homeStats.nrfiPct || 0) >= 60) tendencias.push(`${homeName}: NRFI en ${homeStats.nrfiPct}% de partidos — sin carreras en 1er inning`);
  if ((awayStats.nrfiPct || 0) >= 60) tendencias.push(`${awayName}: NRFI en ${awayStats.nrfiPct}% de partidos`);

  // Favorites
  if (poisson.pHome >= 60) tendencias.push(`${homeName} fuerte favorito local (${poisson.pHome}%)`);
  if (poisson.pAway >= 60) tendencias.push(`${awayName} favorito visitante (${poisson.pAway}%)`);

  // Pitcher dominance
  if (poisson.homePQ <= 0.75) tendencias.push(`${pitchers?.home?.name || 'Pitcher local'} en nivel ace — calidad índice ${poisson.homePQ}`);
  if (poisson.awayPQ <= 0.75) tendencias.push(`${pitchers?.away?.name || 'Pitcher visitante'} en nivel ace — calidad índice ${poisson.awayPQ}`);

  // H2H
  if (h2hData && h2hData.length > 0) {
    const avgH2H = h2hData.reduce((s, g) => s + (g.hScore || 0) + (g.aScore || 0), 0) / h2hData.length;
    if (avgH2H > 9) tendencias.push(`H2H histórico de alto scoring (~${avgH2H.toFixed(0)} carreras)`);
    else if (avgH2H < 6) tendencias.push(`H2H histórico de bajo scoring (~${avgH2H.toFixed(0)} carreras)`);
  }

  // Offensive power
  const hRuns = parseFloat(homeStats.avgRuns || homeStats.runsPerGame || 0);
  const aRuns = parseFloat(awayStats.avgRuns || awayStats.runsPerGame || 0);
  if (hRuns >= 6) tendencias.push(`${homeName} con ofensiva explosiva (${hRuns} carreras/juego)`);
  if (aRuns >= 6) tendencias.push(`${awayName} con ofensiva explosiva (${aRuns} carreras/juego)`);

  return tendencias.length > 0 ? tendencias : ["Sin tendencias claras detectadas"];
}

// ── Detect Line Errors ──
function detectMLBLineErrors(poisson, parsedOdds, homeName, awayName) {
  const errores = [];
  if (!parsedOdds) return errores;

  // Total disagreement (> 2 runs)
  if (parsedOdds.marketTotal && Math.abs(poisson.total - parsedOdds.marketTotal) > 2) {
    const dir = poisson.total > parsedOdds.marketTotal ? "bajo" : "alto";
    errores.push({
      descripcion: `Modelo proyecta ${poisson.total} carreras vs línea ${parsedOdds.marketTotal}. Diferencia de ${Math.abs(poisson.total - parsedOdds.marketTotal).toFixed(1)}. El mercado está ${dir}.`,
      mercado: "Total",
      contradiccion: `Poisson: ${poisson.total} vs Mercado: ${parsedOdds.marketTotal}`,
    });
  }

  // Moneyline probability disagreement (> 8%)
  if (parsedOdds.mlOutcomes.length >= 2) {
    const homePrice = parsedOdds.mlOutcomes[0]?.price;
    if (homePrice) {
      const impliedHome = homePrice > 0 ? 100 / (homePrice + 100) : Math.abs(homePrice) / (Math.abs(homePrice) + 100);
      const diff = Math.abs(poisson.pHome / 100 - impliedHome);
      if (diff > 0.08) {
        const side = poisson.pHome / 100 > impliedHome ? homeName : awayName;
        errores.push({
          descripcion: `${side} tiene ${(diff * 100).toFixed(1)}% de discrepancia entre modelo y mercado. Posible error de línea.`,
          mercado: "Moneyline",
          contradiccion: `Modelo: ${poisson.pHome}% vs Mercado: ${(impliedHome * 100).toFixed(0)}%`,
        });
      }
    }
  }

  return errores;
}

// ── Detect Value Bet ──
function detectMLBValueBet(edges, poisson, splitsData, homeName, awayName) {
  const valueBets = edges.filter(e => e.hasValue).sort((a, b) => b.edge - a.edge);

  if (valueBets.length > 0) {
    const best = valueBets[0];
    let explicacion = `${best.pick} con edge de +${best.edge}% vs mercado. Kelly: ${best.kelly}%.`;

    // Add splits context if available
    if (splitsData?.moneyline) {
      const ml = splitsData.moneyline;
      const homeHandle = ml.home_handle_pct;
      const homeBets = ml.home_bets_pct;
      if (homeHandle && homeBets && Math.abs(homeHandle - homeBets) > 10) {
        const sharpSide = homeHandle > homeBets ? homeName : awayName;
        explicacion += ` Dinero sharp favorece ${sharpSide}.`;
      }
    }

    return {
      existe: true,
      mercado: best.market,
      explicacion,
      oddsRecomendado: best.american || best.decimal.toString(),
      edge: best.edge,
    };
  }

  const anyPositive = edges.find(e => e.edge > 0);
  if (anyPositive) {
    return {
      existe: true,
      mercado: anyPositive.market,
      explicacion: `${anyPositive.pick} con edge marginal de +${anyPositive.edge}%. Precaución.`,
      edge: anyPositive.edge,
    };
  }

  return { existe: false, mensaje: "Sin value bets — mercado bien calibrado" };
}

// ── Build H2H Summary ──
function buildH2HSummary(h2hData, homeName, awayName) {
  if (!h2hData || h2hData.length === 0) return null;
  const hWins = h2hData.filter(g => (g.hScore || 0) > (g.aScore || 0)).length;
  const avgTotal = h2hData.reduce((s, g) => s + (g.hScore || 0) + (g.aScore || 0), 0) / h2hData.length;
  const overCount = h2hData.filter(g => ((g.hScore || 0) + (g.aScore || 0)) > 8.5).length;
  return {
    partidos: h2hData.length,
    victorias: { home: hWins, away: h2hData.length - hWins },
    promedioTotal: +avgTotal.toFixed(1),
    dominador: hWins > h2hData.length - hWins ? homeName : hWins < h2hData.length - hWins ? awayName : null,
    overRate: Math.round((overCount / h2hData.length) * 100),
    detalle: h2hData,
  };
}

// ── Build Picks (11 types) ──
function buildMLBPicks(poisson, edges, homeName, awayName, pitchers, splitsData, h2hData) {
  const picks = [];

  // ── PICK 1: Moneyline ──
  const bestML = edges.find(e => e.market === "Moneyline");
  const pitcherContext = [];
  if (pitchers?.home?.name) pitcherContext.push(`${homeName}: ${pitchers.home.name} (ERA ${pitchers.home.stats?.era || 'N/A'}, WHIP ${pitchers.home.stats?.whip || 'N/A'})`);
  if (pitchers?.away?.name) pitcherContext.push(`${awayName}: ${pitchers.away.name} (ERA ${pitchers.away.stats?.era || 'N/A'}, WHIP ${pitchers.away.stats?.whip || 'N/A'})`);

  if (bestML && Math.abs(bestML.edge) > 2) {
    picks.push({
      tipo: "Moneyline", pick: bestML.pick,
      confianza: Math.min(75, 52 + Math.abs(bestML.edge) * 1.2),
      odds_sugerido: bestML.american || bestML.decimal.toString(),
      categoria: "principal",
      razon: `${bestML.pick} proyectado con ${bestML.ourProb}% vs ${bestML.impliedProb}% implícita. Edge: +${bestML.edge}%.`,
      factores: [
        `xRuns: ${homeName} ${poisson.xRunsHome} - ${awayName} ${poisson.xRunsAway}`,
        `Prob: ${bestML.ourProb}% vs implícita ${bestML.impliedProb}%`,
        `Edge: ${bestML.edge > 0 ? '+' : ''}${bestML.edge}% | Kelly: ${bestML.kelly}%`,
        ...pitcherContext.slice(0, 1),
      ],
    });
  } else {
    const mlWinner = poisson.pHome >= 50 ? homeName : awayName;
    const mlEdge = edges.find(e => e.market === "Moneyline" && e.pick === mlWinner);
    picks.push({
      tipo: "Moneyline", pick: mlWinner,
      confianza: 50 + Math.abs(poisson.pHome - 50) * 0.5,
      odds_sugerido: mlEdge?.american || "-150",
      categoria: "principal",
      razon: `${mlWinner} proyectado como ganador (${poisson.pHome >= 50 ? poisson.pHome : poisson.pAway}%).`,
      factores: [
        `${homeName} ${poisson.pHome}% | ${awayName} ${poisson.pAway}%`,
        `Modelo: ${poisson.xRunsHome}-${poisson.xRunsAway}`,
        ...pitcherContext.slice(0, 1),
      ],
    });
  }

  // ── PICK 2: Total (Over/Under) ──
  // Pick the Total side with the best edge (highest model_prob - implied_prob)
  const totalEdges = edges.filter(e => e.market === "Total");
  const bestTotalEdge = totalEdges.sort((a, b) => b.edge - a.edge)[0] || null;
  const marketLine = bestTotalEdge ? parseFloat(bestTotalEdge.pick.replace(/[^0-9.]/g, '')) : poisson.total;
  const totalPickLabel = bestTotalEdge ? bestTotalEdge.pick : (poisson.total > marketLine ? `Over ${marketLine}` : `Under ${marketLine}`);
  const totalProb = bestTotalEdge?.ourProb || 50;
  picks.push({
    tipo: "Total", pick: totalPickLabel,
    confianza: Math.min(68, 45 + Math.abs(totalProb - 50) * 1.5),
    odds_sugerido: bestTotalEdge?.american || "-110",
    categoria: "totales",
    razon: `Modelo proyecta ${poisson.total} carreras. ${totalPickLabel} con ${typeof totalProb === 'number' ? totalProb.toFixed(1) : totalProb}% (edge: ${bestTotalEdge ? '+' + bestTotalEdge.edge + '%' : 'N/A'}).`,
    factores: [
      `Proyección: ${poisson.total} carreras | Mercado: ${marketLine}`,
      `${totalPickLabel}: ${typeof totalProb === 'number' ? totalProb.toFixed(1) : totalProb}% modelo vs ${bestTotalEdge ? bestTotalEdge.impliedProb + '%' : 'N/A'} implícita`,
      ...pitcherContext.slice(0, 1),
    ],
  });

  // ── PICK 3: Run Line -1.5 ──
  const runLinePick = poisson.spread > 0 ? `${homeName} -1.5` : `${awayName} +1.5`;
  const zRL = (Math.abs(poisson.spread) - 1.5) / 1.75;
  const rlProb = Math.min(65, Math.max(35, Math.round(normCDF(zRL) * 100)));
  picks.push({
    tipo: "Run Line", pick: runLinePick,
    confianza: rlProb,
    odds_sugerido: "-110",
    categoria: "principal",
    razon: `Spread del modelo: ${Math.abs(poisson.spread).toFixed(1)} carreras. ${runLinePick} cubre con ${rlProb}% de probabilidad.`,
    factores: [
      `Spread modelo: ${poisson.spread > 0 ? '+' : ''}${poisson.spread.toFixed(1)} carreras`,
      `Diferencia ofensiva: ${homeName} ${poisson.hOff}x vs ${awayName} ${poisson.aOff}x`,
    ],
  });

  // ── PICK 4: NRFI/YRFI ──
  const nrfiPct = Math.round(poisson.nrfiProb * 100);
  const yrfiPct = 100 - nrfiPct;
  const nrfiPick = nrfiPct >= 55 ? "NRFI (No Run 1st Inning)" : "YRFI (Yes Run 1st Inning)";
  const nrfiConf = Math.min(68, 45 + Math.abs(nrfiPct - 50) * 1.5);
  picks.push({
    tipo: nrfiPct >= 55 ? "NRFI" : "YRFI",
    pick: nrfiPick,
    confianza: nrfiConf,
    odds_sugerido: nrfiPct >= 55 ? "-120" : "-100",
    categoria: "especial",
    razon: `Modelo NRFI: ${nrfiPct}%. Basado en tendencias de ambos equipos y calidad de pitchers abridores.`,
    factores: [
      `NRFI: ${homeName} ${Math.round(parseFloat(poisson.nrfiProb > 0.5 ? (parseFloat(poisson.nrfiProb) * 100) : 50))}% combinado`,
      `Pitcher local K/9: ${pitchers?.home?.stats?.k9 || 'N/A'} | Visitante K/9: ${pitchers?.away?.stats?.k9 || 'N/A'}`,
      `Calidad: Local ${poisson.homePQ} | Visitante ${poisson.awayPQ}`,
    ],
  });

  // ── PICK 5: F5 Moneyline ──
  if (Math.abs(poisson.pHomeF5 - 50) > 5) {
    const f5Winner = poisson.pHomeF5 >= 50 ? homeName : awayName;
    const f5Prob = poisson.pHomeF5 >= 50 ? poisson.pHomeF5 : poisson.pAwayF5;
    picks.push({
      tipo: "F5 Moneyline", pick: `${f5Winner} (Primeras 5)`,
      confianza: Math.min(65, 48 + Math.abs(poisson.pHomeF5 - 50) * 1.2),
      odds_sugerido: "-130",
      categoria: "mitad",
      jugador: null,
      razon: `${f5Winner} proyectado ganador de primeras 5 innings (${f5Prob}%). Depende del pitcheo abridor.`,
      factores: [
        `F5: ${homeName} ${poisson.xRunsHomeF5} - ${awayName} ${poisson.xRunsAwayF5}`,
        `P(${f5Winner} F5): ${f5Prob}%`,
        ...pitcherContext,
      ],
    });
  }

  // ── PICK 6: Alt Run Line -2.5 (strong favorites only) ──
  if (Math.abs(poisson.spread) > 2.0) {
    const altFav = poisson.spread > 0 ? homeName : awayName;
    const zAltRL = (Math.abs(poisson.spread) - 2.5) / 1.75;
    const altRLProb = Math.min(60, Math.max(25, Math.round(normCDF(zAltRL) * 100)));
    picks.push({
      tipo: "Alt Run Line", pick: `${altFav} -2.5`,
      confianza: altRLProb,
      odds_sugerido: "+130",
      categoria: "alternativo",
      razon: `Spread del modelo (${Math.abs(poisson.spread).toFixed(1)}) soporta -2.5. Riesgo alto pero valor en cuotas largas.`,
      factores: [
        `Spread modelo: ${Math.abs(poisson.spread).toFixed(1)} carreras`,
        `Probabilidad -2.5: ${altRLProb}%`,
        `Ventaja de pitcheo: ${poisson.homePQ < poisson.awayPQ ? homeName : awayName}`,
      ],
    });
  }

  // ── PICK 7: Team Total ──
  const teamWithMoreRuns = poisson.xRunsHome >= poisson.xRunsAway ? homeName : awayName;
  const teamXRuns = poisson.xRunsHome >= poisson.xRunsAway ? poisson.xRunsHome : poisson.xRunsAway;
  const teamTotalLine = Math.round(teamXRuns * 2) / 2; // round to nearest 0.5
  const zTeamTotal = (teamXRuns - teamTotalLine) / 1.4;
  const teamOverProb = Math.min(68, Math.max(32, Math.round(normCDF(zTeamTotal) * 100)));
  const teamPick = teamOverProb >= 50 ? `${teamWithMoreRuns} Over ${teamTotalLine}` : `${teamWithMoreRuns} Under ${teamTotalLine}`;
  picks.push({
    tipo: "Team Total", pick: teamPick,
    confianza: Math.min(63, 45 + Math.abs(teamOverProb - 50) * 1.2),
    odds_sugerido: "-115",
    categoria: "totales",
    razon: `${teamWithMoreRuns} proyectado a ${teamXRuns} carreras. ${teamOverProb >= 50 ? 'Over' : 'Under'} ${teamTotalLine} con ${teamOverProb}%.`,
    factores: [
      `xRuns ${teamWithMoreRuns}: ${teamXRuns}`,
      `Ofensiva: ${poisson.xRunsHome >= poisson.xRunsAway ? poisson.hOff : poisson.aOff}x promedio liga`,
      `Pitcher rival calidad: ${poisson.xRunsHome >= poisson.xRunsAway ? poisson.awayPQ : poisson.homePQ}`,
    ],
  });

  // ── PICK 8: Pitcher Strikeouts ──
  const bestPitcher = (poisson.homePQ <= poisson.awayPQ) ? pitchers?.home : pitchers?.away;
  const bestPitcherTeam = (poisson.homePQ <= poisson.awayPQ) ? homeName : awayName;
  if (bestPitcher?.stats?.k9 && parseFloat(bestPitcher.stats.k9) > 6) {
    const k9 = parseFloat(bestPitcher.stats.k9);
    const ip = parseFloat(bestPitcher.stats.ip || 0);
    // Estimate expected innings per start (min 5, max 6.5)
    const estimatedStarts = Math.max(1, Math.round(ip / 5.5));
    const ipPerStart = estimatedStarts > 0 ? Math.min(6.5, Math.max(4.5, ip / estimatedStarts)) : 5.5;
    const expectedKs = +(k9 * ipPerStart / 9).toFixed(1);
    const kLine = Math.round(expectedKs * 2) / 2; // round to 0.5
    const kOverProb = Math.min(65, Math.max(35, 50 + (expectedKs - kLine) * 12));
    picks.push({
      tipo: "Pitcher Strikeouts", pick: `${bestPitcher.name} Over ${kLine} K's`,
      confianza: Math.min(63, 45 + Math.abs(kOverProb - 50) * 1.0),
      odds_sugerido: "-115",
      categoria: "player",
      jugador: bestPitcher.name,
      razon: `${bestPitcher.name} (${bestPitcherTeam}) promedia ${k9} K/9. Proyección: ${expectedKs} K's en ~${ipPerStart.toFixed(1)} IP.`,
      factores: [
        `K/9: ${k9} | IP total: ${bestPitcher.stats.ip}`,
        `Proyección: ${expectedKs} K's en ~${ipPerStart.toFixed(1)} innings`,
        `ERA: ${bestPitcher.stats.era} | WHIP: ${bestPitcher.stats.whip}`,
      ],
    });
  }

  // ── PICK 9: First Inning Total ──
  const fi_pick = poisson.nrfiProb >= 0.60 ? "Under 0.5 (1er Inning)" : "Over 0.5 (1er Inning)";
  const fi_prob = poisson.nrfiProb >= 0.60 ? poisson.nrfiProb : poisson.yrfiProb;
  picks.push({
    tipo: "1st Inning Total", pick: fi_pick,
    confianza: Math.min(63, 45 + Math.abs(fi_prob * 100 - 50) * 0.8),
    odds_sugerido: poisson.nrfiProb >= 0.60 ? "-130" : "+100",
    categoria: "especial",
    razon: `Probabilidad NRFI: ${nrfiPct}%. ${poisson.nrfiProb >= 0.60 ? 'Pitchers dominantes en 1er inning.' : 'Se esperan carreras tempranas.'}`,
    factores: [
      `NRFI modelo: ${nrfiPct}%`,
      `Pitchers: ${pitchers?.home?.name || 'TBD'} vs ${pitchers?.away?.name || 'TBD'}`,
    ],
  });

  // ── PICK 10: Fade al Público ──
  if (splitsData) {
    const ml = splitsData.moneyline || splitsData;
    const homeHandle = parseFloat(ml.home_handle_pct || 0);
    const homeBets = parseFloat(ml.home_bets_pct || 0);
    const awayHandle = parseFloat(ml.away_handle_pct || 0);
    const awayBets = parseFloat(ml.away_bets_pct || 0);

    if (homeHandle && homeBets && Math.abs(homeHandle - homeBets) > 15) {
      // Sharp money divergence detected
      const sharpOn = homeHandle > homeBets ? homeName : awayName;
      const publicOn = homeHandle > homeBets ? awayName : homeName;
      const gap = Math.abs(homeHandle - homeBets);
      picks.push({
        tipo: "Fade al Público", pick: `${sharpOn} (Dinero sharp)`,
        confianza: Math.min(60, 48 + gap * 0.4),
        odds_sugerido: "N/A",
        categoria: "alternativo",
        razon: `Público ${Math.round(Math.max(homeBets, awayBets))}% en ${publicOn}, pero dinero sharp (${Math.round(Math.max(homeHandle, awayHandle))}%) en ${sharpOn}. Gap: ${gap.toFixed(0)}%.`,
        factores: [
          `💰 Handle: ${homeName} ${homeHandle}% | ${awayName} ${awayHandle}%`,
          `🎟 Tickets: ${homeName} ${homeBets}% | ${awayName} ${awayBets}%`,
          `⚡ Sharp divergencia: ${gap.toFixed(0)}%`,
        ],
      });
    }

    // Total fade
    const tot = splitsData.total;
    if (tot) {
      const overHandle = parseFloat(tot.over_handle_pct || 0);
      const overBets = parseFloat(tot.over_bets_pct || 0);
      if (overHandle && overBets && Math.abs(overHandle - overBets) > 20) {
        const sharpTotal = overHandle > overBets ? "Over" : "Under";
        const totalGap = Math.abs(overHandle - overBets);
        picks.push({
          tipo: "Fade Total", pick: `${sharpTotal} (Sharp money)`,
          confianza: Math.min(58, 46 + totalGap * 0.3),
          odds_sugerido: "N/A",
          categoria: "alternativo",
          razon: `Dinero sharp diverge del público en total. ${sharpTotal} con ${totalGap.toFixed(0)}% gap handle vs tickets.`,
          factores: [
            `💰 Over handle: ${overHandle}% | Tickets: ${overBets}%`,
            `⚡ Gap: ${totalGap.toFixed(0)}%`,
          ],
        });
      }
    }
  }

  // ── PICK 11: F5 Total ──
  const f5Total = poisson.totalF5;
  const f5Line = Math.round(f5Total * 2) / 2;
  const zF5Total = (f5Total - f5Line) / (2.3 * 0.7);
  const f5OverProb = Math.min(68, Math.max(32, Math.round(normCDF(zF5Total) * 100)));
  const f5Pick = f5OverProb >= 50 ? `Over ${f5Line} (F5)` : `Under ${f5Line} (F5)`;
  picks.push({
    tipo: "F5 Total", pick: f5Pick,
    confianza: Math.min(62, 45 + Math.abs(f5OverProb - 50) * 1.0),
    odds_sugerido: "-110",
    categoria: "mitad",
    razon: `F5 proyectado: ${f5Total} carreras. ${f5Pick} con ${f5OverProb}% basado en pitchers abridores.`,
    factores: [
      `F5 total: ${f5Total} | Línea: ${f5Line}`,
      `F5: ${homeName} ${poisson.xRunsHomeF5} - ${awayName} ${poisson.xRunsAwayF5}`,
    ],
  });

  // Sort by confidence, then filter out negative EV picks for recommendations
  const sorted = picks.sort((a, b) => b.confianza - a.confianza);

  // Attach EV/edge from edges array to each pick for filtering
  sorted.forEach(p => {
    const matchEdge = edges.find(e =>
      e.pick === p.pick || (p.pick && e.pick && p.pick.includes(e.pick.split(' ')[0]))
    );
    p.ev_percent = matchEdge ? +(((matchEdge.ourProb / 100) * matchEdge.decimal - 1) * 100).toFixed(1) : null;
    p.edge_percent = matchEdge?.edge || null;
    p.hasValue = matchEdge?.hasValue || false;
  });

  // Filter: only EV+ picks with meaningful edge pass as recommendations
  const filtered = sorted.filter(p => {
    if (p.ev_percent == null || p.edge_percent == null) return false;
    return p.ev_percent >= 2 && p.edge_percent >= 3;
  });

  // If no picks pass filter, return top 3 by confidence as fallback (marked as low-value)
  if (filtered.length === 0) {
    return sorted.slice(0, 3).map(p => ({ ...p, hasValue: false }));
  }

  return filtered;
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
      oddsData, splitsData, h2hData, isCalibration,
      pitchers, gameId, gameDate,
    } = req.body;

    if (!homeStats || !awayStats) {
      return res.status(400).json({ error: "homeStats y awayStats requeridos" });
    }

    const parsedOdds = parseMLBOdds(oddsData);
    const poisson = calcMLBPoisson(homeStats, awayStats, parsedOdds?.marketTotal, pitchers);
    if (!poisson) return res.status(500).json({ error: "Error calculando modelo MLB" });

    const edges = calcMLBEdges(poisson, parsedOdds, homeTeam, awayTeam);
    const picks = buildMLBPicks(poisson, edges, homeTeam, awayTeam, pitchers, splitsData, h2hData);

    // Standalone functions
    const alertas = generateMLBAlerts(poisson, homeStats, awayStats, pitchers, homeTeam, awayTeam);
    const tendenciasDetectadas = generateMLBTendencias(poisson, homeStats, awayStats, h2hData, pitchers, homeTeam, awayTeam);
    const erroresLinea = detectMLBLineErrors(poisson, parsedOdds, homeTeam, awayTeam);
    const valueBet = detectMLBValueBet(edges, poisson, splitsData, homeTeam, awayTeam);

    // ── Confianza ──
    const maxEdge = edges.length > 0 ? Math.max(...edges.map(e => Math.abs(e.edge))) : 0;
    let nivelConfianza = "BAJO", razonConfianza = "Mercado bien calibrado. Precaución.";
    if (maxEdge > 8) { nivelConfianza = "ALTO"; razonConfianza = `Edge de +${maxEdge.toFixed(1)}% detectado. Modelo sólido vs mercado.`; }
    else if (maxEdge > 4) { nivelConfianza = "MEDIO"; razonConfianza = `Edge moderado de +${maxEdge.toFixed(1)}%. Confirmar con pitchers titulares.`; }

    // ── Poisson detalle ──
    const overLines = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12];
    const poissonDetalle = {
      xRunsHome: poisson.xRunsHome, xRunsAway: poisson.xRunsAway,
      total: poisson.total, spread: poisson.spread,
      hOff: poisson.hOff, hDef: poisson.hDef, aOff: poisson.aOff, aDef: poisson.aDef,
      pHome: poisson.pHome, pAway: 100 - poisson.pHome,
      // F5
      xRunsHomeF5: poisson.xRunsHomeF5, xRunsAwayF5: poisson.xRunsAwayF5,
      totalF5: poisson.totalF5, pHomeF5: poisson.pHomeF5,
      // NRFI
      nrfiProb: Math.round(poisson.nrfiProb * 100),
      yrfiProb: Math.round(poisson.yrfiProb * 100),
      // Pitcher quality
      homePQ: poisson.homePQ, awayPQ: poisson.awayPQ,
    };
    overLines.forEach(l => { poissonDetalle[`pOver${l}`] = poisson[`pOver${l}`] || null; });

    // ── Stats detalle ──
    const statsDetalle = {
      home: {
        avgRuns: homeStats.avgRuns || homeStats.runsPerGame,
        avgRunsAgainst: homeStats.avgRunsAgainst || homeStats.runsAgainstPerGame,
        wins: homeStats.wins, games: homeStats.games, nrfiPct: homeStats.nrfiPct,
        form: homeStats.results || '',
      },
      away: {
        avgRuns: awayStats.avgRuns || awayStats.runsPerGame,
        avgRunsAgainst: awayStats.avgRunsAgainst || awayStats.runsAgainstPerGame,
        wins: awayStats.wins, games: awayStats.games, nrfiPct: awayStats.nrfiPct,
        form: awayStats.results || '',
      },
    };

    // ── Pitcher detalle ──
    const pitcherDetalle = {
      home: pitchers?.home ? {
        name: pitchers.home.name,
        era: pitchers.home.stats?.era || 'N/A',
        whip: pitchers.home.stats?.whip || 'N/A',
        k9: pitchers.home.stats?.k9 || 'N/A',
        ip: pitchers.home.stats?.ip || 'N/A',
        bb9: pitchers.home.stats?.bb9 || 'N/A',
        hr9: pitchers.home.stats?.hr9 || 'N/A',
        qualityIndex: poisson.homePQ,
      } : null,
      away: pitchers?.away ? {
        name: pitchers.away.name,
        era: pitchers.away.stats?.era || 'N/A',
        whip: pitchers.away.stats?.whip || 'N/A',
        k9: pitchers.away.stats?.k9 || 'N/A',
        ip: pitchers.away.stats?.ip || 'N/A',
        bb9: pitchers.away.stats?.bb9 || 'N/A',
        hr9: pitchers.away.stats?.hr9 || 'N/A',
        qualityIndex: poisson.awayPQ,
      } : null,
    };

    // ── H2H resumen ──
    const h2hResumen = buildH2HSummary(h2hData, homeTeam, awayTeam);

    // ── Summary ──
    const favTeam = poisson.pHome > poisson.pAway ? homeTeam : awayTeam;
    const favPct = Math.max(poisson.pHome, 100 - poisson.pHome);
    const pitcherSummary = (pitchers?.home?.name && pitchers?.away?.name)
      ? ` Pitchers: ${pitchers.home.name} (ERA ${pitchers.home.stats?.era || 'N/A'}) vs ${pitchers.away.name} (ERA ${pitchers.away.stats?.era || 'N/A'}).`
      : '';
    const summary = `Modelo proyecta ${homeTeam} ${poisson.xRunsHome}-${poisson.xRunsAway} ${awayTeam} (total: ${poisson.total}, spread: ${poisson.spread > 0 ? '+' : ''}${poisson.spread}). ${favTeam} tiene ${favPct}% de victoria.${pitcherSummary}${alertas.length ? ' ' + alertas[0] : ''}`;

    // ── Paper Trading: save picks with EV data to Supabase ──
    console.log('[PAPER] Entry check:', { isCalibration, picksCount: picks?.length, homeTeam, awayTeam });
    if (!isCalibration) {
      const sb = getServiceSupabase();
      console.log('[PAPER] Supabase client:', sb ? 'OK' : 'NULL');
      if (sb) {
        const paperRows = picks.map(pick => {
          // Find matching edge for this pick
          const matchEdge = edges.find(e =>
            e.pick === pick.pick || (pick.pick && e.pick && pick.pick.includes(e.pick.split(' ')[0]))
          );
          const oddsStr = pick.odds_sugerido || (matchEdge?.american) || null;
          let decOdds = matchEdge?.decimal || null;
          if (!decOdds && oddsStr) {
            const am = parseInt(String(oddsStr).replace('+',''));
            if (!isNaN(am)) decOdds = am > 0 ? (am/100+1) : (100/Math.abs(am)+1);
          }
          const impliedP = decOdds && decOdds > 1 ? 1/decOdds : null;
          const modelP = matchEdge ? matchEdge.ourProb/100 : (pick.confianza || 50)/100;
          const ev = (decOdds && modelP) ? (modelP * decOdds - 1) : null;
          return {
            game_id: gameId ? String(gameId) : null,
            sport: 'mlb',
            home_team: homeTeam,
            away_team: awayTeam,
            game_date: gameDate || null,
            market: pick.tipo,
            selection: pick.pick,
            pick_type: pick.categoria || 'principal',
            odds_at_pick: oddsStr,
            odds_decimal: decOdds ? +decOdds.toFixed(4) : null,
            implied_prob: impliedP ? +impliedP.toFixed(4) : null,
            model_prob: +modelP.toFixed(4),
            ev: ev != null ? +ev.toFixed(4) : null,
            ev_percent: ev != null ? +(ev*100).toFixed(2) : null,
            edge: matchEdge ? +(matchEdge.edge/100).toFixed(4) : null,
            edge_percent: matchEdge?.edge || null,
            kelly: matchEdge?.kelly || null,
            confidence: pick.confianza || null,
            home_pitcher: pitchers?.home?.name || null,
            away_pitcher: pitchers?.away?.name || null,
            home_pq: poisson.homePQ,
            away_pq: poisson.awayPQ,
            x_runs_home: poisson.xRunsHome,
            x_runs_away: poisson.xRunsAway,
            model_total: poisson.total,
            model_spread: poisson.spread,
            model_version: '3.0',
          };
        });
        console.log('[PAPER] paperRows built:', paperRows.length, 'first row sample:', JSON.stringify(paperRows[0]));
        try {
          const { error } = await sb.from('paper_trades').insert(paperRows);
          if (error) {
            console.error('[PAPER] Insert FAILED:', error.message);
            console.error('[PAPER] Full error:', JSON.stringify(error));
          } else {
            console.log(`[PAPER] Insert SUCCESS: ${paperRows.length} picks for ${homeTeam} vs ${awayTeam}`);
          }
        } catch (err) {
          console.error('[PAPER] Insert threw exception:', err.message);
        }
      } else {
        console.error('[PAPER] Skipped: Supabase client is null');
      }
    } else {
      console.log('[PAPER] Skipped: isCalibration=true');
    }

    return res.status(200).json({
      resumen: summary,
      ganadorProbable: favTeam,
      probabilidades: { local: poisson.pHome, visitante: 100 - poisson.pHome },
      prediccionMarcador: `${poisson.xRunsHome}-${poisson.xRunsAway}`,
      apuestasDestacadas: picks,
      recomendaciones: picks.slice(0, 6).map(p => ({
        mercado: p.tipo, seleccion: p.pick,
        confianza: Math.round(p.confianza),
        razonamiento: p.razon || p.factores?.join('. ') || '',
      })),
      alertas,
      tendencias: {
        puntosEsperados: poisson.total,
        spreadEsperado: poisson.spread,
        nrfiProb: Math.round(poisson.nrfiProb * 100),
        over85Prob: poisson.pOver8 || null,
      },
      tendenciasDetectadas,
      contextoExtra: {
        homeOffense: poisson.hOff, homeDefense: poisson.hDef,
        awayOffense: poisson.aOff, awayDefense: poisson.aDef,
      },
      poissonDetalle,
      statsDetalle,
      pitcherDetalle,
      h2hResumen,
      edgesDetalle: edges.slice(0, 12),
      valueBet,
      erroresLinea,
      nivelConfianza,
      razonConfianza,
      _model: 'mlb-poisson-advanced',
      _version: '3.0',
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
