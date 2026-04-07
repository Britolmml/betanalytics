// api/nba-analyze.js — Modelo estadistico NBA (Poisson + Normal approximation)
// Reemplaza Claude API para analisis de partidos NBA

const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'https://betanalyticsIA.com';

// ── NBA Poisson Model (normal approximation para spreads) ──
function calcNBAPoisson(hStats, aStats, marketTotal = null, marketSpread = null) {
  if (!hStats || !aStats) return null;

  const leagueAvg = 113.5;
  const homeAdv = 1.018;

  const hOff = parseFloat(hStats.avgPts) / leagueAvg;
  const hDef = parseFloat(hStats.avgPtsCon) / leagueAvg;
  const aOff = parseFloat(aStats.avgPts) / leagueAvg;
  const aDef = parseFloat(aStats.avgPtsCon) / leagueAvg;

  let xPtsHome = 0.4 * (leagueAvg * hOff * aDef * homeAdv) + 0.6 * parseFloat(hStats.avgPts);
  let xPtsAway = 0.4 * (leagueAvg * aOff * hDef) + 0.6 * parseFloat(aStats.avgPts);

  // Form adjustment
  const hWinRate = hStats.wins / (hStats.games || 5);
  const aWinRate = aStats.wins / (aStats.games || 5);
  xPtsHome *= (0.99 + 0.02 * hWinRate);
  xPtsAway *= (0.99 + 0.02 * aWinRate);

  xPtsHome = Math.max(103, Math.min(119, xPtsHome));
  xPtsAway = Math.max(103, Math.min(119, xPtsAway));

  let total = xPtsHome + xPtsAway;

  // Market anchor
  if (marketTotal && marketTotal > 200) {
    total = 0.35 * total + 0.65 * marketTotal;
    const ratio = xPtsHome / (xPtsHome + xPtsAway);
    xPtsHome = total * ratio;
    xPtsAway = total * (1 - ratio);
  }

  const spread = xPtsHome - xPtsAway;

  // Normal distribution approximation
  const erf = (x) => {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    return x >= 0 ? 1 - poly * Math.exp(-x * x) : -(1 - poly * Math.exp(-x * x));
  };
  const normCDF = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

  const stdDevSpread = 11.5;
  const stdDevTotal = 13.0;

  const zSpread = spread / stdDevSpread;
  const pHome = Math.min(85, Math.max(15, Math.round(normCDF(zSpread) * 100)));
  const pAway = 100 - pHome;

  const calcOverProb = (line) => {
    const z = (total - line) / stdDevTotal;
    return Math.min(68, Math.max(32, Math.round(normCDF(z) * 100)));
  };

  return {
    xPtsHome: +xPtsHome.toFixed(1),
    xPtsAway: +xPtsAway.toFixed(1),
    total: +total.toFixed(1),
    spread: +spread.toFixed(1),
    hOff: +hOff.toFixed(2),
    hDef: +hDef.toFixed(2),
    aOff: +aOff.toFixed(2),
    aDef: +aDef.toFixed(2),
    pHome, pAway,
    pOver215: calcOverProb(215),
    pOver220: calcOverProb(220),
    pOver225: calcOverProb(225),
    pOver230: calcOverProb(230),
  };
}

// ── Parse NBA odds ──
function parseNBAOdds(oddsData) {
  if (!oddsData) return null;
  const h2h = oddsData.find(m => m.key === "h2h") || oddsData.find(m => m.key === "spreads")?.outcomes?.filter(o => !o.name.includes("Over") && !o.name.includes("Under"));
  const spreads = oddsData.find(m => m.key === "spreads")?.outcomes || [];
  const totals = oddsData.find(m => m.key === "totals")?.outcomes || [];

  // Parse market total from totals outcomes
  let marketTotal = null;
  const overOutcome = totals.find(o => o.name === "Over");
  if (overOutcome?.point) marketTotal = parseFloat(overOutcome.point);

  // Parse market spread
  let marketSpread = null;
  const spreadHome = spreads.find(s => s.name === "Home");
  if (spreadHome?.point) marketSpread = parseFloat(spreadHome.point);

  // Parse moneyline
  const mlOutcomes = oddsData.find(m => m.key === "h2h")?.outcomes || [];

  return { marketTotal, marketSpread, mlOutcomes, spreads, totals, overOutcome };
}

// ── Edge calculation ──
function calcNBAEdges(poisson, parsedOdds, homeName, awayName) {
  if (!poisson || !parsedOdds) return [];
  const edges = [];

  const addEdge = (market, pick, ourProb, price) => {
    if (!price || !ourProb) return;
    const implied = price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100);
    const edge = ourProb - implied;
    const kelly = edge > 0 ? (edge / ((price > 0 ? (price/100+1) : (100/Math.abs(price)+1)) - 1)) * 100 : 0;
    edges.push({
      market, pick,
      ourProb: +ourProb.toFixed(1),
      impliedProb: +(implied * 100).toFixed(1),
      edge: +(edge * 100).toFixed(1),
      kelly: +kelly.toFixed(1),
      decimal: +(price > 0 ? (price/100+1) : (100/Math.abs(price)+1)).toFixed(2),
    });
  };

  // Moneyline edges
  const mlAway = parsedOdds.mlOutcomes.find(o => homeName.includes(o.name?.split(' ')[0]));
  const mlHome = parsedOdds.mlOutcomes.find(o => homeName && (o.name.includes("away") || !o.name.includes("away")));

  if (parsedOdds.mlOutcomes.length >= 2) {
    addEdge("Moneyline", homeName, poisson.pHome/100, parsedOdds.mlOutcomes[0]?.price);
    addEdge("Moneyline", awayName, poisson.pAway/100, parsedOdds.mlOutcomes[1]?.price);
  }

  // Totals edges
  if (parsedOdds.overOutcome) {
    const overLine = parsedOdds.overOutcome.point;
    const overKey = `pOver${Math.round(overLine)}`;
    const ourProb = (poisson[overKey] || 50) / 100;
    addEdge("Total", `Over ${overLine}`, ourProb, parsedOdds.overOutcome?.price);
  }

  return edges.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
}

// ── Build picks ──
function buildNBAPicks(poisson, edges, homeName, awayName, injuries, topPlayers, h2h) {
  const picks = [];

  // 1. Moneyline
  const bestML = edges.find(e => e.market === "Moneyline");
  if (bestML && Math.abs(bestML.edge) > 2) {
    picks.push({
      tipo: "Moneyline",
      pick: bestML.pick,
      confianza: Math.min(75, 55 + Math.abs(bestML.edge) * 2),
      odds_sugerido: bestML.decimal.toString(),
      categoria: "principal",
      jugador: null,
      factores: [
        `xPts: ${homeName} ${poisson.xPtsHome} - ${awayName} ${poisson.xPtsAway}`,
        `Prob: ${bestML.ourProb}% vs implícita ${bestML.impliedProb}%`,
        `Edge: ${bestML.edge > 0 ? '+' : ''}${bestML.edge}%`,
      ],
    });
  } else {
    picks.push({
      tipo: "Moneyline",
      pick: homeName,
      confianza: 50 + (poisson.pHome - 50) * 0.5,
      odds_sugerido: "1.95",
      categoria: "principal",
      jugador: null,
      factores: [`${homeName} ${poisson.pHome}% | ${awayName} ${poisson.pAway}%`],
    });
  }

  // 2. Spread
  if (poisson.spread !== 0) {
    const spreadAbs = Math.abs(poisson.spread).toFixed(1);
    const spreadPick = poisson.spread > 0 ? `${homeName} -${spreadAbs}` : `${awayName} -${spreadAbs}`;
    picks.push({
      tipo: "Spread",
      pick: spreadPick,
      confianza: Math.min(68, 50 + Math.abs(poisson.spread) * 1.5),
      odds_sugerido: "1.90",
      categoria: "principal",
      jugador: null,
      factores: [`Spread calculado: ${poisson.spread > 0 ? '+' : ''}${poisson.spread}`],
    });
  }

  // 3. Total (Over/Under)
  const totalEdge = edges.find(e => e.market === "Total");
  const totalLine = 220;
  const overProb = poisson.pOver220;
  const overPick = overProb >= 52 ? `Over ${totalLine}` : `Under ${totalLine}`;
  picks.push({
    tipo: "Total Goles",
    pick: overPick,
    confianza: Math.min(68, Math.abs(overProb - 50) + 48),
    odds_sugerido: overProb >= 55 ? "1.85" : "1.95",
    categoria: "totales",
    jugador: null,
    factores: [
      `Total proyectado: ${poisson.total}`,
      `Over ${totalLine}: ${poisson.pOver220}%`,
    ],
  });

  // 4. Primera mitad
  const halfTotal = (poisson.total / 2).toFixed(1);
  picks.push({
    tipo: "Primera Mitad",
    pick: `Over ${halfTotal}`,
    confianza: Math.min(65, Math.abs(poisson.total / 2 - 56) + 48),
    odds_sugerido: "1.90",
    categoria: "mitad",
    jugador: null,
    factores: [`1H proyectado: ${halfTotal} pts total`],
  });

  // 5. Top player props
  const allPlayers = [
    ...(topPlayers?.home || []).map(p => ({ ...p, team: homeName })),
    ...(topPlayers?.away || []).map(p => ({ ...p, team: awayName })),
  ];

  // Extract player name from { name: "Fname Lname", player: { firstname, lastname } }
  const getPlayerName = (p) => {
    if (p.name) return p.name;
    if (p.player) return `${p.player.first_name || p.player.firstname || ''} ${p.player.last_name || p.player.lastname || ''}`.trim();
    return "Jugador";
  };

  // Filter out injured players
  const injuredNames = new Set((injuries || []).map(i => i.name?.toLowerCase()));
  const availablePlayers = allPlayers.filter(p => !injuredNames.has(getPlayerName(p).toLowerCase()));

  // Points props — handle both avg (pre-computed) and raw totals
  const getAvg = (p, field) => {
    const val = parseFloat(p[field]);
    if (p.games && val < 50) return val; // already avg
    return val / p.games;
  };

  const topScorers = availablePlayers
    .sort((a, b) => getAvg(b, 'pts') - getAvg(a, 'pts'))
    .slice(0, 2);

  for (const pl of topScorers) {
    if (pl.pts && pl.games > 0) {
      const avgPts = getAvg(pl, 'pts').toFixed(1);
      const overLine = Math.round(getAvg(pl, 'pts'));
      const displayName = getPlayerName(pl);
      picks.push({
        tipo: "Jugador Puntos",
        pick: `Over ${overLine} pts — ${displayName}`,
        confianza: Math.min(65, 50 + (getAvg(pl, 'pts') > 20 ? 10 : 5)),
        odds_sugerido: "1.90",
        categoria: "jugador",
        jugador: displayName,
        factores: [`Promedio: ${avgPts} pts en ${pl.games} partidos`],
      });
    }
  }

  // Triple double detection
  const tdCandidates = availablePlayers.filter(p => {
    const pts = getAvg(p, 'pts');
    const reb = getAvg(p, 'reb');
    const ast = getAvg(p, 'ast');
    return pts >= 15 && reb >= 7 && ast >= 7;
  });

  if (tdCandidates.length > 0) {
    const td = tdCandidates[0];
    const tdName = getPlayerName(td);
    picks.push({
      tipo: "Triple Doble",
      pick: `${tdName} — Si/No`,
      confianza: 55,
      odds_sugerido: "2.50",
      categoria: "jugador",
      jugador: tdName,
      factores: [`Promedio: ${getAvg(td,'pts').toFixed(1)}pts ${getAvg(td,'reb').toFixed(1)}reb ${getAvg(td,'ast').toFixed(1)}ast`],
    });
  }

  // Sort by confidence
  return picks.sort((a, b) => b.confianza - a.confianza);
}

// ── Alertas ──
function generateNBAAlerts(poisson, injuries, homeName, awayName) {
  const alerts = [];

  if (injuries && injuries.length > 0) {
    for (const inj of injuries) {
      alerts.push(`⚠️ ${inj.name} (${inj.team}) — ${inj.reason} [${inj.status}]`);
    }
  }

  if (Math.abs(poisson.spread) <= 3) {
    alerts.push("⚖️ Partido muy parejo — spread menor a 3 pts. Considerar evitar moneyline.");
  }

  if (poisson.total >= 230) {
    alerts.push("🔥 Proyección de alta puntuacion — Over 230+ pts");
  } else if (poisson.total <= 205) {
    alerts.push("🐢 Proyeccion de baja puntuacion — Under 205 pts");
  }

  return alerts;
}

// ── Main handler ──
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const {
    homeTeam, awayTeam,
    homeStats, awayStats,
    h2hData, oddsData, splitsData,
    injuries, topPlayers
  } = req.body;

  if (!homeStats || !awayStats) {
    return res.status(400).json({ error: "homeStats y awayStats requeridos" });
  }

  // Parse odds
  const parsedOdds = parseNBAOdds(oddsData);

  // Calculate Poisson
  const poisson = calcNBAPoisson(homeStats, awayStats, parsedOdds?.marketTotal, parsedOdds?.marketSpread);
  if (!poisson) return res.status(500).json({ error: "Error calculando modelo NBA" });

  // Edges
  const edges = calcNBAEdges(poisson, parsedOdds, homeTeam, awayTeam);

  // Picks
  const picks = buildNBAPicks(poisson, edges, homeTeam, awayTeam, injuries, topPlayers, h2hData);

  // Alerts
  const alerts = generateNBAAlerts(poisson, injuries, homeTeam, awayTeam);

  // Summary
  const summary = `Modelo proyecta ${homeTeam} ${poisson.xPtsHome}-${poisson.xPtsAway} ${awayTeam} (total: ${poisson.total}, spread: ${poisson.spread > 0 ? '+' : ''}${poisson.spread}). ${homeTeam} ${poisson.pHome}% | ${awayTeam} ${poisson.pAway}%.`;

  const response = {
    resumen: summary,
    ganadorProbable: poisson.pHome > poisson.pAway ? homeTeam : awayTeam,
    probabilidades: { home: poisson.pHome, away: poisson.pAway },
    prediccionMarcador: `${Math.round(poisson.xPtsHome)}-${Math.round(poisson.xPtsAway)}`,
    apuestasDestacadas: picks,
    recomendaciones: picks.slice(0, 3).map(p => ({
      mercado: p.tipo,
      seleccion: p.pick,
      confianza: Math.round(p.confianza),
      razonamiento: p.factores.join('. '),
    })),
    alertas: alerts,
    tendencias: {
      puntosEsperados: poisson.total,
      spreadEsperado: poisson.spread,
      over225Prob: poisson.pOver225,
    },
    contextoExtra: {
      homeOffense: poisson.hOff,
      homeDefense: poisson.hDef,
      awayOffense: poisson.aOff,
      awayDefense: poisson.aDef,
    },
    edgesDetalle: edges.slice(0, 5),
    _model: 'nba-poisson-normal',
    _version: '1.0',
  };

  return res.status(200).json(response);
}
