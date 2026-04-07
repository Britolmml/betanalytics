// api/nba-analyze.js — Modelo estadistico NBA (Poisson + Normal approximation + edge detection)
// Reemplaza Claude API para analisis de partidos NBA

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

// ── NBA Poisson Model ──
function calcNBAPoisson(hStats, aStats, marketTotal = null) {
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

  // Wider limits
  xPtsHome = Math.max(95, Math.min(140, xPtsHome));
  xPtsAway = Math.max(95, Math.min(140, xPtsAway));

  let total = xPtsHome + xPtsAway;

  // Market anchor (wider weights — trust model more)
  if (marketTotal && marketTotal > 200) {
    total = 0.35 * total + 0.65 * marketTotal;
    const ratio = xPtsHome / (xPtsHome + xPtsAway);
    xPtsHome = total * ratio;
    xPtsAway = total * (1 - ratio);
  }

  const spread = xPtsHome - xPtsAway;
  const stdDevSpread = 11.5;
  const stdDevTotal = 13.0;

  const zSpread = spread / stdDevSpread;
  const pHome = Math.min(85, Math.max(15, Math.round(normCDF(zSpread) * 100)));

  const calcOverProb = (line) => {
    const z = (total - line) / stdDevTotal;
    return Math.min(70, Math.max(30, Math.round(normCDF(z) * 100)));
  };

  return {
    xPtsHome: +xPtsHome.toFixed(1),
    xPtsAway: +xAway.toFixed(1),
    total: +total.toFixed(1),
    spread: +spread.toFixed(1),
    hOff: +(hOff * 100).toFixed(0),
    hDef: +(hDef * 100).toFixed(0),
    aOff: +(aOff * 100).toFixed(0),
    aDef: +(aDef * 100).toFixed(0),
    pHome, pAway: 100 - pHome,
    pOver200: calcOverProb(200),
    pOver205: calcOverProb(205),
    pOver210: calcOverProb(210),
    pOver215: calcOverProb(215),
    pOver220: calcOverProb(220),
    pOver225: calcOverProb(225),
    pOver230: calcOverProb(230),
    pOver235: calcOverProb(235),
    pOver240: calcOverProb(240),
    pOver245: calcOverProb(245),
    pOver250: calcOverProb(250),
    pOver255: calcOverProb(255),
    pOver260: calcOverProb(260),
  };
}

// ── Parse NBA odds ──
function parseNBAOdds(oddsData) {
  if (!oddsData || !Array.isArray(oddsData)) return null;
  const mlMarket = oddsData.find(m => m.key === "h2h");
  const spreads = oddsData.find(m => m.key === "spreads")?.outcomes || [];
  const totals = oddsData.find(m => m.key === "totals")?.outcomes || [];

  let marketTotal = null;
  const overOutcome = totals.find(o => o.name === "Over");
  if (overOutcome?.point) marketTotal = parseFloat(overOutcome.point);

  let underOutcome = totals.find(o => o.name === "Under");
  let marketSpread = null;
  const spreadOutcome = spreads.find(s => s.name === "Home");
  if (spreadOutcome?.point) marketSpread = parseFloat(spreadOutcome.point);

  return {
    marketTotal, marketSpread,
    mlOutcomes: mlMarket?.outcomes || [],
    spreads, totals,
    overOutcome, underOutcome,
  };
}

// ── Edge calculation ──
function calcNBAEdges(poisson, parsedOdds, homeName, awayName) {
  if (!poisson || !parsedOdds) return [];
  const edges = [];

  const addEdge = (market, pick, ourProb, price) => {
    if (!price || !ourProb) return;
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

  // Totals edges — compute for actual market line
  if (parsedOdds.overOutcome) {
    const line = parsedOdds.overOutcome.point;
    const overKey = `pOver${Math.round(line)}`;
    const ourProb = (poisson[overKey] || 50) / 100;
    addEdge("Total", `Over ${line}`, ourProb, parsedOdds.overOutcome?.price);
    // Under with underOutcome
    if (parsedOdds.underOutcome) {
      addEdge("Total", `Under ${line}`, 1 - ourProb, parsedOdds.underOutcome?.price);
    }
  }

  // Spread edge
  if (parsedOdds.marketSpread !== null) {
    const diff = poisson.spread - parsedOdds.marketSpread;
    const z = diff / stdDevSpread;
    const spreadProb = normCDF(z);
    const spreadPrice = parsedOdds.spreads[0]?.price;
    if (spreadPrice) {
      const spreadPick = parsedOdds.marketSpread > 0 ? `${homeName} +${parsedOdds.marketSpread}` : `${homeName} ${parsedOdds.marketSpread}`;
      addEdge("Spread", spreadPick, spreadProb, spreadPrice);
    }
  }

  return edges.sort((a, b) => b.edge - a.edge);
}

// ── Build picks ──
function buildNBAPicks(poisson, edges, homeName, awayName, injuries, topPlayers, h2h, splits) {
  const picks = [];

  const getPlayerName = (p) => {
    if (p.name) return p.name;
    if (p.player) return `${p.player.first_name || p.player.firstname || ''} ${p.player.last_name || p.player.lastname || ''}`.trim();
    return "Jugador";
  };

  const getAvg = (p, field) => {
    if (!p[field] || !p.games) return 0;
    const val = parseFloat(p[field]);
    return (val < 50) ? val : val / p.games;
  };

  const allPlayers = [
    ...(topPlayers?.home || []).map(p => ({ ...p, team: homeName })),
    ...(topPlayers?.away || []).map(p => ({ ...p, team: awayName })),
  ];

  const injuredNames = new Set((injuries || []).map(i => i.name?.toLowerCase()));
  const availablePlayers = allPlayers.filter(p => !injuredNames.has(getPlayerName(p).toLowerCase()));

  // Trends
  const h2hRecent = (h2h || []).filter(g => g.hPts != null).slice(0, 3);
  const trends = [];
  if (h2hRecent.length > 0) {
    const hWins = h2hRecent.filter(g => g.hPts > g.aPts).length;
    const team = hWins >= 2 ? homeName : (h2hRecent.length - hWins) >= 2 ? awayName : null;
    if (team) trends.push(`${team} domina H2H reciente (${team === homeName ? hWins : h2hRecent.length - hWins}-${team === homeName ? h2hRecent.length - hWins : hWins})`);

    // Total trends
    const avgH2HTotal = h2hRecent.reduce((s, g) => s + g.hPts + g.aPts, 0) / h2hRecent.length;
    if (avgH2HTotal > 230) trends.push(`H2H alta puntuacion: promedio ${avgH2HTotal.toFixed(0)} pts`);
    else if (avgH2HTotal < 200) trends.push(`H2H baja puntuacion: promedio ${avgH2HTotal.toFixed(0)} pts`);
  }
  if (poisson.total >= 230) trends.push("ProYECCION de alta puntuacion");
  else if (poisson.total <= 205) trends.push("ProYECCION de baja puntuacion");

  // ── PICK 1: Moneyline ──
  const bestML = edges.find(e => e.market === "Moneyline");
  if (bestML && Math.abs(bestML.edge) > 2) {
    picks.push({
      tipo: "Moneyline", pick: bestML.pick,
      confianza: Math.min(75, 52 + Math.abs(bestML.edge) * 1.2),
      odds_sugerido: bestML.decimal > 1.8 ? bestML.american : bestML.decimal.toString(),
      categoria: "principal", jugador: null,
      factores: [
        `xPts: ${homeName} ${poisson.xPtsHome} - ${awayName} ${poisson.xPtsAway}`,
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
      categoria: "principal", jugador: null,
      factores: [
        `${homeName} ${poisson.pHome}% | ${awayName} ${poisson.pAway}%`,
        `Modelo: ${poisson.xPtsHome}-${poisson.xPtsAway}`,
      ].concat(trends.slice(0, 1)),
    });
  }

  // ── PICK 2: Spread ──
  if (Math.abs(poisson.spread) >= 1.5) {
    const spreadAbs = Math.abs(poisson.spread).toFixed(1);
    const spreadPick = poisson.spread > 0 ? `${homeName} -${spreadAbs}` : `${awayName} -${spreadAbs}`;
    picks.push({
      tipo: "Spread", pick: spreadPick,
      confianza: Math.min(68, 48 + Math.abs(poisson.spread) * 1.8),
      odds_sugerido: "-110",
      categoria: "principal", jugador: null,
      factores: [
        `Spread del modelo: ${poisson.spread > 0 ? '+' : ''}${poisson.spread}`,
        `Diferencia xPts: ${Math.abs(poisson.xPtsHome - poisson.xPtsAway).toFixed(1)}`,
      ],
    });
  }

  // ── PICK 3: Total (Over/Under) — REAL market line ──
  const totalEdge = edges.find(e => e.market === "Total");
  const marketLine = totalEdge ? parseFloat(totalEdge.pick.replace(/[^0-9.]/g, '')) : poisson.total;
  const overProb = totalEdge?.ourProb || 50;
  const overPick = overProb >= 50 ? `Over ${marketLine}` : `Under ${marketLine}`;

  picks.push({
    tipo: "Total", pick: overPick,
    confianza: Math.min(68, 45 + Math.abs(overProb - 50) * 1.5),
    odds_sugerido: totalEdge?.american || "-110",
    categoria: "totales", jugador: null,
    factores: [
      `ProYECCION modelo: ${poisson.total} pts | Linea mercado: ${marketLine}`,
      `${overPick}: ${overProb.toFixed(1)}% (${overProb > 50 ? 'Value' : 'Sin value'})`,
    ],
  });

  // ── PICK 4: Primera Mitad (Q1-Q2 = 52-55% of total) ──
  const halfTotal = (poisson.total * 0.54).toFixed(1);
  picks.push({
    tipo: "Primera Mitad", pick: `Over ${halfTotal}`,
    confianza: Math.min(65, 47 + Math.abs(overProb - 50) * 0.8),
    odds_sugerido: "-110",
    categoria: "mitad", jugador: null,
    factores: [`1H proyectado: ${halfTotal} pts (54% del total de ${poisson.total})`],
  });

  // ── PICK 5: Top player props (Points) ──
  const topScorers = availablePlayers
    .sort((a, b) => getAvg(b, 'pts') - getAvg(a, 'pts'))
    .slice(0, 2);

  for (const pl of topScorers) {
    if (pl.pts && pl.games > 0) {
      const avgPts = getAvg(pl, 'pts');
      const overLine = Math.round(avgPts);
      picks.push({
        tipo: "Player Points",
        pick: `Over ${overLine} pts — ${getPlayerName(pl)}`,
        confianza: Math.min(65, 48 + (avgPts > 18 ? 12 : avgPts > 14 ? 5 : 0)),
        odds_sugerido: "-110",
        categoria: "player", jugador: getPlayerName(pl),
        factores: [
          `Prom: ${avgPts.toFixed(1)} pts en ${pl.games} partidos`,
          `Reb: ${getAvg(pl, 'reb').toFixed(1)} | Ast: ${getAvg(pl, 'ast').toFixed(1)}`,
        ],
      });
    }
  }

  // ── PICK 6: Player Assists ──
  const topAssists = availablePlayers
    .filter(p => getAvg(p, 'ast') > 5)
    .sort((a, b) => getAvg(b, 'ast') - getAvg(a, 'ast'))
    .slice(0, 1);

  for (const pl of topAssists) {
    if (pl.ast && pl.games > 0) {
      const avgAst = getAvg(pl, 'ast');
      const overLine = Math.round(avgAst);
      picks.push({
        tipo: "Player Assists",
        pick: `Over ${overLine} ast — ${getPlayerName(pl)}`,
        confianza: Math.min(62, 45 + avgAst * 1.2),
        odds_sugerido: "-110",
        categoria: "player", jugador: getPlayerName(pl),
        factores: [`Prom: ${avgAst.toFixed(1)} asistencias en ${pl.games} partidos`],
      });
    }
  }

  // ── PICK 7: Player Rebounds ──
  const topReb = availablePlayers
    .filter(p => getAvg(p, 'reb') > 6)
    .sort((a, b) => getAvg(b, 'reb') - getAvg(a, 'reb'))
    .slice(0, 1);

  for (const pl of topReb) {
    if (pl.reb && pl.games > 0) {
      const avgReb = getAvg(pl, 'reb');
      const overLine = Math.round(avgReb);
      picks.push({
        tipo: "Player Rebounds",
        pick: `Over ${overLine} reb — ${getPlayerName(pl)}`,
        confianza: Math.min(60, 45 + avgReb * 0.8),
        odds_sugerido: "-110",
        categoria: "player", jugador: getPlayerName(pl),
        factores: [`Prom: ${avgReb.toFixed(1)} rebotes en ${pl.games} partidos`],
      });
    }
  }

  // ── PICK 8: Triple Doble ──
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
      categoria: "player", jugador: tdName,
      factores: [`Prom: ${getAvg(td,'pts').toFixed(1)}pts ${getAvg(td,'reb').toFixed(1)}reb ${getAvg(td,'ast').toFixed(1)}ast`],
    });
  }

  // ── PICK 9: Fade al Publico (if splits) ──
  if (splits) {
    const ml = splits.moneyline;
    if (ml && ml.home_handle_pct > ml.home_bets_pct + 15) {
      picks.push({
        tipo: "Fade al publico",
        pick: awayName,
        confianza: Math.min(60, 48 + (ml.home_handle_pct - ml.home_bets_pct) * 0.5),
        odds_sugerido: (edges.find(e => e.pick === awayName)?.american) || "+130",
        categoria: "alternativo", jugador: null,
        factores: [
          `Handle ${ml.home_handle_pct}% vs Tickets ${ml.home_bets_pct}% en ${homeName}`,
          `Dinero inteligente en ${awayName}`,
        ],
      });
    }
    if (ml && ml.away_handle_pct > ml.away_bets_pct + 15) {
      picks.push({
        tipo: "Fade al publico",
        pick: homeName,
        confianza: Math.min(60, 48 + (ml.away_handle_pct - ml.away_bets_pct) * 0.5),
        odds_sugerido: (edges.find(e => e.pick === homeName)?.american) || "+130",
        categoria: "alternativo", jugador: null,
        factores: [`Handle ${ml.away_handle_pct}% vs Tickets ${ml.away_bets_pct}% en ${awayName}`],
      });
    }
  }

  return picks.sort((a, b) => b.confianza - a.confianza);
}

// ── Alertas ──
function generateNBAAlerts(poisson, injuries, homeName, awayName) {
  const alerts = [];
  if (injuries && injuries.length > 0) {
    for (const inj of injuries) alerts.push(`⚠️ ${inj.name} (${inj.team}) — ${inj.reason} [${inj.status}]`);
  }
  if (Math.abs(poisson.spread) <= 3) alerts.push("⚖️ Partido parejo — spread < 3 pts. Moneyline riesgoso.");
  if (poisson.total >= 230) alerts.push("🔥 ProYECCION alta puntuacion");
  else if (poisson.total <= 205) alerts.push("🐢 ProYECCION baja puntuacion");
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
    homeTeam, awayTeam, homeStats, awayStats,
    h2hData, oddsData, splitsData, injuries, topPlayers
  } = req.body;

  if (!homeStats || !awayStats) {
    return res.status(400).json({ error: "homeStats y awayStats requeridos" });
  }

  const parsedOdds = parseNBAOdds(oddsData);
  const poisson = calcNBAPoisson(homeStats, awayStats, parsedOdds?.marketTotal);
  if (!poisson) return res.status(500).json({ error: "Error calculando modelo NBA" });

  const edges = calcNBAEdges(poisson, parsedOdds, homeTeam, awayTeam);
  const picks = buildNBAPicks(poisson, edges, homeTeam, awayTeam, injuries, topPlayers, h2hData, splitsData);
  const alerts = generateNBAAlerts(poisson, injuries, homeTeam, awayTeam);

  // Resumen
  const summary = `Modelo proyecta ${homeTeam} ${poisson.xPtsHome}-${poisson.xPtsAway} ${awayTeam} (total: ${poisson.total}, spread: ${poisson.spread > 0 ? '+' : ''}${poisson.spread}). ${homeTeam} ${poisson.pHome}% | ${awayTeam} ${poisson.pAway}%.`;

  return res.status(200).json({
    resumen: summary,
    ganadorProbable: poisson.pHome > poisson.pAway ? homeTeam : awayTeam,
    probabilidades: { home: poisson.pHome, away: poisson.pAway },
    prediccionMarcador: `${Math.round(poisson.xPtsHome)}-${Math.round(poisson.xPtsAway)}`,
    apuestasDestacadas: picks,
    recomendaciones: picks.slice(0, 3).map(p => ({
      mercado: p.tipo, seleccion: p.pick,
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
      homeOffense: poisson.hOff, homeDefense: poisson.hDef,
      awayOffense: poisson.aOff, awayDefense: poisson.aDef,
    },
    edgesDetalle: edges.slice(0, 5),
    _model: 'nba-poisson-normal',
    _version: '2.0',
  });
}
