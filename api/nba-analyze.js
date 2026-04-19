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
function calcNBAPoisson(hStats, aStats, marketTotal = null, injuries = null, topPlayers = null) {
  if (!hStats || !aStats) return null;

  const leagueAvg = 113.5;
  const homeAdv = 1.018;

  const hOff = parseFloat(hStats.avgPts) / leagueAvg;
  const hDef = parseFloat(hStats.avgPtsCon) / leagueAvg;
  const aOff = parseFloat(aStats.avgPts) / leagueAvg;
  const aDef = parseFloat(aStats.avgPtsCon) / leagueAvg;

  let xPtsHome = 0.4 * (leagueAvg * hOff * aDef * homeAdv) + 0.6 * parseFloat(hStats.avgPts);
  let xPtsAway = 0.4 * (leagueAvg * aOff * hDef) + 0.6 * parseFloat(aStats.avgPts);

  // Injury impact adjustment
  if (injuries && topPlayers) {
    const getPlayerName = (p) => {
      if (p.name) return p.name;
      if (p.player) return `${p.player.first_name || p.player.firstname || ''} ${p.player.last_name || p.player.lastname || ''}`.trim();
      return "";
    };
    const getAvg = (p) => {
      if (!p.pts) return 0;
      const v = parseFloat(p.pts);
      return (v < 50) ? v : v / p.games;
    };
    const allP = [
      ...(topPlayers.home || []).map(p => ({ ...p, team: 'home' })),
      ...(topPlayers.away || []).map(p => ({ ...p, team: 'away' })),
    ];
    const injuredNames = new Set((injuries || []).map(i => i.name?.toLowerCase()));
    let homeInjuryPts = 0, awayInjuryPts = 0;
    for (const pl of allP) {
      if (injuredNames.has(getPlayerName(pl).toLowerCase())) {
        if (pl.team === 'home') homeInjuryPts += getAvg(pl);
        else awayInjuryPts += getAvg(pl);
      }
    }
    // Scale injury impact: ~40% of lost points (team redistributes)
    xPtsHome -= homeInjuryPts * 0.4;
    xPtsAway -= awayInjuryPts * 0.4;
  }

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
    xPtsAway: +xPtsAway.toFixed(1),
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
  if (!oddsData) return null;

  // Frontend sends { h2h: { key:"h2h", outcomes:[...] }, totals: { key:"totals", outcomes:[...] } }
  if (!Array.isArray(oddsData)) {
    const mlMarket = oddsData.h2h || null;
    const totalsObj = oddsData.totals || null;
    const totals = totalsObj?.outcomes || [];
    const overOutcome = totals.find(o => o.name === "Over");
    const marketTotal = overOutcome?.point ? parseFloat(overOutcome.point) : null;
    const underOutcome = totals.find(o => o.name === "Under");

    return {
      marketTotal, marketSpread: null,
      mlOutcomes: mlMarket?.outcomes || [],
      spreads: [], totals,
      overOutcome, underOutcome,
    };
  }

  // Array format (raw from odds API)
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
  const stdDevSpread = 11.5;
  const edges = [];

  const addEdge = (market, pick, ourProb, price) => {
    if (!ourProb) return;
    const p = parseFloat(price);
    if (!p && p !== 0) return;
    const implied = p > 0 ? 100 / (p + 100) : Math.abs(p) / (Math.abs(p) + 100);
    const edge = ourProb - implied;
    const dec = p > 0 ? (p / 100 + 1) : (100 / Math.abs(p) + 1);
    const kelly = edge > 0 ? Math.max(0, Math.min(15, parseFloat(((edge / (dec - 1)) * 100).toFixed(1)))) : 0;
    edges.push({
      market, pick,
      ourProb: +((Math.round(ourProb * 1000) / 1000) * 100).toFixed(1),
      impliedProb: +(implied * 100).toFixed(1),
      edge: +(edge * 100).toFixed(1),
      kelly,
      decimal: +dec.toFixed(2),
      american: toAm(p),
      hasValue: edge > 0.02,
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

  // Injury impact notes
  const injuryNotes = [];
  const allPforInjuries = [
    ...(topPlayers?.home || []).map(p => ({ ...p, team: homeName })),
    ...(topPlayers?.away || []).map(p => ({ ...p, team: awayName })),
  ];
  for (const pl of allPforInjuries) {
    if (injuredNames.has(getPlayerName(pl).toLowerCase())) {
      const avgPts = getAvg(pl, 'pts');
      injuryNotes.push(`${getPlayerName(pl)} (${pl.team}) — Prom ${avgPts.toFixed(1)} pts afectado [Out/QTD]`);
    }
  }

  // Trends
  const h2hRecent = (h2h || []).filter(g => g.hPts != null).slice(0, 3);
  const trends = [];
  if (h2hRecent.length > 0) {
    // H2H: determine winner by name, not home/away position
    const hWinCount = h2hRecent.filter(g => {
      return (g.hPts > g.aPts && g.home === homeName) || (g.aPts > g.hPts && g.away === homeName);
    }).length;
    const team = hWinCount >= 2 ? homeName : (h2hRecent.length - hWinCount) >= 2 ? awayName : null;
    if (team) trends.push(`${team} domina H2H reciente (${team === homeName ? hWinCount : h2hRecent.length - hWinCount}-${team === homeName ? h2hRecent.length - hWinCount : hWinCount})`);
    const avgH2HTotal = h2hRecent.reduce((s, g) => s + g.hPts + g.aPts, 0) / h2hRecent.length;
    if (avgH2HTotal > 230) trends.push(`H2H alta puntuacion: promedio ${avgH2HTotal.toFixed(0)} pts`);
    else if (avgH2HTotal < 210) trends.push(`H2H baja puntuacion: promedio ${avgH2HTotal.toFixed(0)} pts`);
  }
  if (poisson.total >= 230) trends.push("ProYECCION de alta puntuacion");
  else if (poisson.total <= 205) trends.push("ProYECCION de baja puntuacion");

  // Form trends from stats
  if (parseFloat(topPlayers?.home?.[0]?.results?.split(',').length || 0) > 0) {
    // results format like "WWWLW"
  }

  // ── PICK 1: Moneyline ──
  const bestML = edges.find(e => e.market === "Moneyline");
  if (bestML && Math.abs(bestML.edge) > 2) {
    picks.push({
      tipo: "Moneyline", pick: bestML.pick,
      confianza: Math.min(75, 52 + Math.abs(bestML.edge) * 1.2),
      odds_sugerido: bestML.decimal > 1.8 ? bestML.american : bestML.decimal.toString(),
      categoria: "principal", jugador: null,
      razon: `${bestML.pick} con ${bestML.ourProb}% de probabilidad real vs ${bestML.impliedProb}% implicita del mercado. Edge de +${bestML.edge}% con Kelly ${bestML.kelly}%. ${poisson.pHome >= poisson.pAway ? homeName : awayName} muestra ventaja en xPts (${poisson.xPtsHome}-${poisson.xPtsAway})${trends.length ? ' y ' + trends.slice(0,1)[0] : ''}.`,
      factores: [
        `xPts: ${homeName} ${poisson.xPtsHome} - ${awayName} ${poisson.xPtsAway}`,
        `Prob: ${bestML.ourProb}% vs implicita ${bestML.impliedProb}%`,
        `Edge: ${bestML.edge > 0 ? '+' : ''}${bestML.edge}% | Kelly: ${bestML.kelly}%`,
      ].concat(trends.slice(0, 1)),
    });
  } else {
    const mlWinner = poisson.pHome >= 50 ? homeName : awayName;
    const mlEdge = edges.find(e => e.market === "Moneyline" && e.pick === mlWinner);
    const why = poisson.pHome >= poisson.pAway
      ? `${homeName} con ventaja ofensiva (${poisson.hOff}x) y local`
      : `${awayName} mejor defensa (${poisson.aDef}x) compensa factor cancha`;
    picks.push({
      tipo: "Moneyline", pick: mlWinner,
      confianza: 50 + Math.abs(poisson.pHome - 50) * 0.5,
      odds_sugerido: mlEdge?.american || "-150",
      categoria: "principal", jugador: null,
      razon: `${mlWinner} proyectado ${Math.max(poisson.pHome, poisson.pAway)}%. ${why}. Diferencia xPts: ${Math.abs(poisson.xPtsHome - poisson.xPtsAway).toFixed(1)}. ${trends.length ? trends[0] + '.' : ''}${injuryNotes.length ? ' ' + injuryNotes.slice(0, 2).join('; ') : ''}`,
      factores: [
        `${homeName} ${poisson.pHome}% | ${awayName} ${poisson.pAway}%`,
        `Modelo: ${poisson.xPtsHome}-${poisson.xPtsAway}`,
      ].concat(trends.slice(0, 1)),
    });
  }

  // ── PICK 2: Spread ──
  if (Math.abs(poisson.spread) >= 1.5) {
    const spreadAbs = Math.abs(poisson.spread).toFixed(1);
    const spreadFav = poisson.spread > 0 ? homeName : awayName;
    const spreadPick = poisson.spread > 0 ? `${homeName} -${spreadAbs}` : `${awayName} -${spreadAbs}`;
    const spreadWhy = poisson.spread > 0
      ? `${homeName} proyecta ganar por ${poisson.spread.toFixed(1)}`
      : `${awayName} proyecta ganar por ${Math.abs(poisson.spread).toFixed(1)}`;
    picks.push({
      tipo: "Spread", pick: spreadPick,
      confianza: Math.min(68, 48 + Math.abs(poisson.spread) * 1.8),
      odds_sugerido: "-110",
      categoria: "principal", jugador: null,
      razon: `${spreadWhy}. Spread del modelo ${spreadFav} -${spreadAbs}. ${poisson.pHome >= poisson.pAway ? homeName : awayName} cubre ${Math.max(poisson.pHome, poisson.pAway)}% de las simulaciones.`,
      factores: [
        `Spread del modelo: ${poisson.spread > 0 ? '+' : ''}${poisson.spread}`,
        `Diferencia xPts: ${Math.abs(poisson.xPtsHome - poisson.xPtsAway).toFixed(1)}`,
      ],
    });
  }

  // ── PICK 3: Total (Over/Under) ──
  const totalEdge = edges.find(e => e.market === "Total");
  const marketLine = totalEdge ? parseFloat(totalEdge.pick.replace(/[^0-9.]/g, '')) : poisson.total;
  const overProb = totalEdge?.ourProb || 50;
  const overPick = overProb >= 50 ? `Over ${marketLine}` : `Under ${marketLine}`;
  const totalDiff = (poisson.total - marketLine).toFixed(1);

  picks.push({
    tipo: "Total", pick: overPick,
    confianza: Math.min(68, 45 + Math.abs(overProb - 50) * 1.5),
    odds_sugerido: totalEdge?.american || "-110",
    categoria: "totales", jugador: null,
    razon: `Modelo proyecta ${poisson.total} pts, mercado ${marketLine} pts. Diferencia de ${totalDiff} pts. ${poisson.total >= 230 ? 'Alta puntuacion por strengths ofensivos' : poisson.total <= 205 ? 'Baja puntuacion por defensas solidas' : 'Puntuacion normal'}. ${trends.find(t => t.includes('H2H')) || ''}`,
    factores: [
      `ProYECCION modelo: ${poisson.total} pts | Linea mercado: ${marketLine}`,
      `Diferencia: ${totalDiff > 0 ? '+' : ''}${totalDiff} pts`,
      `${overPick}: ${overProb.toFixed(1)}% (${overProb > 50 ? 'Value' : 'Sin value'})`,
    ],
  });

  // ── PICK 4: Primera Mitad ──
  const halfTotal = (poisson.total * 0.54).toFixed(1);
  picks.push({
    tipo: "Primera Mitad", pick: `Over ${halfTotal}`,
    confianza: Math.min(65, 47 + Math.abs(overProb - 50) * 0.8),
    odds_sugerido: "-110",
    categoria: "mitad", jugador: null,
    razon: `Historicamente 54% del scoring ocurre en 1H. 54% de ${poisson.total} = ${halfTotal} pts. ${poisson.total >= 225 ? 'Partido rapido esperable desde inicio.' : ''}`,
    factores: [`1H proyectado: ${halfTotal} pts (54% del total de ${poisson.total})`],
  });

  // ── PICK 5: Doble Oportunidad ──
  const strongFav = poisson.pHome >= 55 ? homeName : poisson.pAway >= 55 ? awayName : null;
  if (strongFav) {
    picks.push({
      tipo: "Doble Oportunidad",
      pick: `${strongFav} ML o Spread corto`,
      confianza: Math.min(65, 55 + Math.max(0, poisson.pHome - 55) * 0.5),
      odds_sugerido: "-125",
      categoria: "alternativo", jugador: null,
      razon: `Seguridad: ${strongFav} cubre en ML si gana o en spread corto si pierde por poco. Modelo da ${Math.max(poisson.pHome, poisson.pAway)}% a ${strongFav}. Riesgo bajo.`,
      factores: [
        `${homeName} ${poisson.pHome}% | ${awayName} ${poisson.pAway}%`,
        `xPts: ${poisson.xPtsHome}-${poisson.xPtsAway}`,
      ],
    });
  }

  // ── PICK 6: Player Points ──
  const topScorers = availablePlayers
    .sort((a, b) => getAvg(b, 'pts') - getAvg(a, 'pts'))
    .slice(0, 2);

  for (const pl of topScorers) {
    if (pl.pts && pl.games > 0) {
      const avgPts = getAvg(pl, 'pts');
      const overLine = Math.round(avgPts);
      const name = getPlayerName(pl);
      picks.push({
        tipo: "Player Points",
        pick: `Over ${overLine} pts — ${name}`,
        confianza: Math.min(65, 48 + (avgPts > 18 ? 12 : avgPts > 14 ? 5 : 0)),
        odds_sugerido: "-110",
        categoria: "player", jugador: name,
        razon: `${name} promedia ${avgPts.toFixed(1)} pts en ${pl.games} partidos. Linea ${overLine} pts debajo de su promedio. Consistente con roles ofensivos actuales.`,
        factores: [
          `Prom: ${avgPts.toFixed(1)} pts en ${pl.games} partidos`,
          `Reb: ${getAvg(pl, 'reb').toFixed(1)} | Ast: ${getAvg(pl, 'ast').toFixed(1)}`,
        ],
      });
    }
  }

  // ── PICK 7: Player Assists ──
  const topAssists = availablePlayers
    .filter(p => getAvg(p, 'ast') > 5)
    .sort((a, b) => getAvg(b, 'ast') - getAvg(a, 'ast'))
    .slice(0, 1);

  for (const pl of topAssists) {
    if (pl.ast && pl.games > 0) {
      const avgAst = getAvg(pl, 'ast');
      const overLine = Math.round(avgAst);
      const name = getPlayerName(pl);
      picks.push({
        tipo: "Player Assists",
        pick: `Over ${overLine} ast — ${name}`,
        confianza: Math.min(62, 45 + avgAst * 1.2),
        odds_sugerido: "-110",
        categoria: "player", jugador: name,
        razon: `${name} promedia ${avgAst.toFixed(1)} asistencias. Distribuidor principal en ${pl.team}. Ritmo alto (${poisson.total.toFixed(0)} pts totales) favorece asistencias.`,
        factores: [`Prom: ${avgAst.toFixed(1)} asistencias en ${pl.games} partidos`],
      });
    }
  }

  // ── PICK 8: Player Rebounds ──
  const topReb = availablePlayers
    .filter(p => getAvg(p, 'reb') > 6)
    .sort((a, b) => getAvg(b, 'reb') - getAvg(a, 'reb'))
    .slice(0, 1);

  for (const pl of topReb) {
    if (pl.reb && pl.games > 0) {
      const avgReb = getAvg(pl, 'reb');
      const overLine = Math.round(avgReb);
      const name = getPlayerName(pl);
      picks.push({
        tipo: "Player Rebounds",
        pick: `Over ${overLine} reb — ${name}`,
        confianza: Math.min(60, 45 + avgReb * 0.8),
        odds_sugerido: "-110",
        categoria: "player", jugador: name,
        razon: `${name} promedia ${avgReb.toFixed(1)} rebotes. ${pl.team} con ritmo de ${poisson.total.toFixed(0)} pts = mas posesiones = mas rebotes.`,
        factores: [`Prom: ${avgReb.toFixed(1)} rebotes en ${pl.games} partidos`],
      });
    }
  }

  // ── PICK 9: Triple Doble ──
  const tdCandidates = availablePlayers.filter(p => {
    const pts = getAvg(p, 'pts');
    const reb = getAvg(p, 'reb');
    const ast = getAvg(p, 'ast');
    return pts >= 15 && reb >= 7 && ast >= 7;
  });

  if (tdCandidates.length > 0) {
    const td = tdCandidates[0];
    const tdName = getPlayerName(td);
    const tdPts = getAvg(td, 'pts'), tdReb = getAvg(td, 'reb'), tdAst = getAvg(td, 'ast');
    picks.push({
      tipo: "Triple Doble",
      pick: `Sí — ${tdName}`,
      confianza: Math.min(58, 45 + (tdPts >= 20 ? 8 : 4) + (tdReb >= 8 ? 5 : 2) + (tdAst >= 8 ? 5 : 2)),
      odds_sugerido: "2.50",
      categoria: "player", jugador: tdName,
      razon: `${tdName} promedia ${tdPts.toFixed(1)}pts/${tdReb.toFixed(1)}reb/${tdAst.toFixed(1)}ast. Juego rapido (${poisson.total.toFixed(0)} pts) favorece. Riesgo alto pero upside real.`,
      factores: [`Prom: ${tdPts.toFixed(1)}pts ${tdReb.toFixed(1)}reb ${tdAst.toFixed(1)}ast en ${td.games} partidos`],
    });
  }

  // ── PICK 10: Fade al Publico ──
  if (splits) {
    const ml = splits.moneyline;
    if (ml && ml.home_handle_pct > ml.home_bets_pct + 15) {
      picks.push({
        tipo: "Fade al publico",
        pick: awayName,
        confianza: Math.min(60, 48 + (ml.home_handle_pct - ml.home_bets_pct) * 0.5),
        odds_sugerido: (edges.find(e => e.pick === awayName)?.american) || "+130",
        categoria: "alternativo", jugador: null,
        razon: `Handle ${ml.home_handle_pct}% vs Tickets ${ml.home_bets_pct}% en ${homeName}. Dinero inteligente en ${awayName} — los sharps respaldan al underdog.`,
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
        razon: `Handle ${ml.away_handle_pct}% vs Tickets ${ml.away_bets_pct}% en ${awayName}. Sharps respaldan ${homeName} contra la public opinion.`,
        factores: [`Handle ${ml.away_handle_pct}% vs Tickets ${ml.away_bets_pct}% en ${awayName}`],
      });
    }

    // Total fades
    const tot = splits.total;
    if (tot && tot.over_handle_pct > tot.over_bets_pct + 20) {
      picks.push({
        tipo: "Fade al publico - Total",
        pick: `Over ${marketLine}`,
        confianza: Math.min(58, 47 + (tot.over_handle_pct - tot.over_bets_pct) * 0.4),
        odds_sugerido: "-110",
        categoria: "alternativo", jugador: null,
        razon: `Handle Over ${tot.over_handle_pct}% vs Tickets ${tot.over_bets_pct}%. Sharps en Over, publico en Under. Modelo: ${poisson.total.toFixed(1)} pts vs linea ${marketLine}.`,
        factores: [`Over handle ${tot.over_handle_pct}% vs Over tickets ${tot.over_bets_pct}%`],
      });
    }
    if (tot && tot.under_handle_pct > tot.under_bets_pct + 20) {
      picks.push({
        tipo: "Fade al publico - Total",
        pick: `Under ${marketLine}`,
        confianza: Math.min(58, 47 + (tot.under_handle_pct - tot.under_bets_pct) * 0.4),
        odds_sugerido: "-110",
        categoria: "alternativo", jugador: null,
        razon: `Handle Under ${tot.under_handle_pct}% vs Tickets ${tot.under_bets_pct}%. Sharps en Under con dinero pesado.`,
        factores: [`Under handle ${tot.under_handle_pct}% vs Under tickets ${tot.under_bets_pct}%`],
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
  if (poisson.total >= 230) alerts.push("🔥 ProYECCION alta puntuacion — ritmos ofensivos favorecen OVER.");
  else if (poisson.total <= 205) alerts.push("🐢 ProYECCION baja puntuacion — defensas dominantes.");
  return alerts;
}

// ── Detect line errors ──
function detectLineErrors(poisson, parsedOdds, homeName, awayName) {
  const errors = [];
  if (!parsedOdds) return errors;

  // Total line disagreement
  if (parsedOdds.marketTotal > 5 && Math.abs(poisson.total - parsedOdds.marketTotal) > 8) {
    const dir = poisson.total > parsedOdds.marketTotal ? "alto" : "bajo";
    errors.push({
      descripcion: `Modelo proyecta ${poisson.total} pts vs linea de mercado ${parsedOdds.marketTotal}. Diferencia de ${Math.abs(poisson.total - parsedOdds.marketTotal).toFixed(1)} pts. El mercado esta ${dir}.`,
      mercado: "Total",
      contradiccion: `Poisson dice ${poisson.total}, mercado ${parsedOdds.marketTotal}`,
    });
  }

  // Moneyline disagreement
  if (parsedOdds.mlOutcomes.length >= 2) {
    const homePrice = parsedOdds.mlOutcomes[0]?.price;
    if (homePrice) {
      const impliedProb = homePrice > 0 ? 100 / (homePrice + 100) : Math.abs(homePrice) / (Math.abs(homePrice) + 100);
      const modelProb = poisson.pHome / 100;
      const diff = Math.abs(modelProb - impliedProb);
      if (diff > 0.1) {
        const side = modelProb > impliedProb ? homeName : awayName;
        errors.push({
          descripcion: `${side} tiene ${diff * 100}% de discrepancia entre modelo (${(modelProb * 100).toFixed(0)}%) y mercado (${(impliedProb * 100).toFixed(0)}%). Posible error de linea.`,
          mercado: "Moneyline",
          contradiccion: `Modelo: ${(modelProb * 100).toFixed(0)}% vs Mercado: ${(impliedProb * 100).toFixed(0)}%`,
        });
      }
    }
  }

  // Spread disagreement
  if (parsedOdds.marketSpread !== null) {
    const diff = Math.abs(poisson.spread - parsedOdds.marketSpread);
    if (diff > 5) {
      errors.push({
        descripcion: `Spread del modelo (${poisson.spread.toFixed(1)}) difiere ${diff.toFixed(1)} pts del mercado (${parsedOdds.marketSpread}). Posible value en spread side opuesto.`,
        mercado: "Spread",
        contradiccion: `Modelo: ${poisson.spread.toFixed(1)} vs Mercado: ${parsedOdds.marketSpread}`,
      });
    }
  }

  return errors;
}

// ── Determine value bet ──
function detectValueBet(edges, poisson, splits, homeName, awayName) {
  if (!edges || edges.length === 0) {
    return { existe: false, mensaje: "Sin edges detectados — mercado bien calibrado" };
  }
  // Best edge
  const best = edges[0];
  if (best.hasValue) {
    return {
      existe: true,
      mercado: best.market,
      explicacion: `${best.pick} tiene ${best.ourProb}% de probabilidad real vs ${best.impliedProb}% implicita del mercado. Edge de +${best.edge}% con Kelly ${best.kelly}%. ${best.market === 'Moneyline' ? 'La mejor oportunidad del partido.' : splits && splits.moneyline ? ` Splits confirman ${splits.moneyline.home_handle_pct > splits.moneyline.home_bets_pct ? homeName : awayName} con dinero inteligente.` : ''}`,
      oddsRecomendado: best.american || best.decimal.toString(),
      edge: best.edge,
      mercadoOriginal: best.market,
    };
  }
  // Any edge > 0
  const anyPos = edges.find(e => e.edge > 0);
  if (anyPos) {
    return {
      existe: true,
      mercado: anyPos.market,
      explicacion: `${anyPos.pick} con edge ligero de +${anyPos.edge}%. Modelo ${poisson.total.toFixed(1)} pts vs mercado ${anyPos.ourProb}%.`,
      oddsRecomendado: anyPos.american || anyPos.decimal.toString(),
      edge: anyPos.edge,
      mercadoOriginal: anyPos.market,
    };
  }
  return { existe: false, mensaje: "Sin value bets — mercado eficiente" };
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
  const poisson = calcNBAPoisson(homeStats, awayStats, parsedOdds?.marketTotal, injuries, topPlayers);
  if (!poisson) return res.status(500).json({ error: "Error calculando modelo NBA" });

  const edges = calcNBAEdges(poisson, parsedOdds, homeTeam, awayTeam);
  const picks = buildNBAPicks(poisson, edges, homeTeam, awayTeam, injuries, topPlayers, h2hData, splitsData);
  const alerts = generateNBAAlerts(poisson, injuries, homeTeam, awayTeam);
  const lineErrors = detectLineErrors(poisson, parsedOdds, homeTeam, awayTeam);
  const valueBet = detectValueBet(edges, poisson, splitsData, homeTeam, awayTeam);

  // Trends detection for frontend
  const tendenciasDetectadas = [];
  if (poisson.total >= 230) tendenciasDetectadas.push("Alta puntuacion proyectada — ambos equipos ofensivos");
  else if (poisson.total <= 205) tendenciasDetectadas.push("Baja puntuacion proyectada — defensas dominantes");
  if (poisson.pHome >= 60) tendenciasDetectadas.push(`${homeTeam} fuerte favorito local`);
  if (poisson.pAway >= 60) tendenciasDetectadas.push(`${awayTeam} favorito a pesar de jugar fuera`);
  if (Math.abs(poisson.spread) <= 3) tendenciasDetectadas.push("Partido parejo — spread < 3 en modelo");
  if (h2hData && h2hData.length > 0) {
    // H2H: determine winner by team name, not by home/away position
    const hWinCount = h2hData.filter(g => {
      const homeTeamWon = g.hPts > g.aPts;
      const winnerName = homeTeamWon ? g.home : g.away;
      return winnerName === homeTeam;
    }).length;
    const recent = h2hData.slice(0, 3);
    const avgH2HTotal = recent.reduce((s, g) => s + (g.hPts || 0) + (g.aPts || 0), 0) / recent.length;
    if (hWinCount >= 2) tendenciasDetectadas.push(`${homeTeam} domina H2H (${hWinCount}-${recent.length - hWinCount} ultimos)`);
    else if (recent.length - hWinCount >= 2) tendenciasDetectadas.push(`${awayTeam} domina H2H (${recent.length - hWinCount}-${hWinCount} ultimos)`);
    if (avgH2HTotal > 230) tendenciasDetectadas.push(`H2H historico de alta puntuacion (~${avgH2HTotal.toFixed(0)} pts)`);
    else if (avgH2HTotal < 215) tendenciasDetectadas.push(`H2H historico de baja puntuacion (~${avgH2HTotal.toFixed(0)} pts)`);
  }
  if (injuries && injuries.length > 0) {
    tendenciasDetectadas.push(`${injuries.length} baja(s) reportada(s) — ajustar expectativas`);
  }

  // Confidence level
  const maxEdge = edges.length > 0 ? Math.max(...edges.map(e => Math.abs(e.edge))) : 0;
  let nivelConfianza, razonConfianza;
  if (maxEdge > 10) {
    nivelConfianza = "ALTO";
    razonConfianza = `Edge maximo de +${maxEdge.toFixed(1)}%. Modelo claro vs mercado. Datos solidos de ${homeTeam} vs ${awayTeam}.`;
  } else if (maxEdge > 5) {
    nivelConfianza = "MEDIO";
    razonConfianza = `Edge moderado de +${maxEdge.toFixed(1)}%. Modelo levemente sobre mercado. Confirmar con alineaciones antes de apostar.`;
  } else {
    nivelConfianza = "BAJO";
    razonConfianza = "Mercado bien calibrado. Edges menores a 5%. Preferir观望 o apuestas en vivo con mas datos.";
  }

  // Rich resume
  const favTeam = poisson.pHome > poisson.pAway ? homeTeam : awayTeam;
  const injuryContext = (injuries && injuries.length > 0)
    ? ` Bajas notables: ${injuries.slice(0, 3).map(i => `${i.name} [${i.status}]`).join(', ')}.`
    : '';
  const trendContext = tendenciasDetectadas.length > 0 ? ` Tendencia clave: ${tendenciasDetectadas[0]}.` : '';
  const summary = `Modelo proyecta ${homeTeam} ${poisson.xPtsHome}-${poisson.xPtsAway} ${awayTeam} (total: ${poisson.total}, spread: ${poisson.spread > 0 ? '+' : ''}${poisson.spread}). ${favTeam} tiene ${Math.max(poisson.pHome, poisson.pAway)}% de victoria.${injuryContext}${trendContext} ${poisson.total >= 230 ? 'Alta puntuacion esperable.' : poisson.total <= 205 ? 'Defensas dominantes esperables.' : ''}`;

  // ── Full Poisson detail ──
  const overLines = [200, 205, 210, 215, 220, 225, 230, 235, 240, 245, 250];
  const poissonDetalle = {
    xPtsHome: poisson.xPtsHome, xPtsAway: poisson.xPtsAway,
    total: poisson.total, spread: poisson.spread,
    hOff: poisson.hOff, hDef: poisson.hDef,
    aOff: poisson.aOff, aDef: poisson.aDef,
    pHome: poisson.pHome, pAway: poisson.pAway,
  };
  overLines.forEach(l => { poissonDetalle[`pOver${l}`] = poisson[`pOver${l}`] || null; });

  // ── Stats detail ──
  const statsDetalle = {
    home: {
      avgPts: homeStats.avgPts, avgPtsCon: homeStats.avgPtsCon,
      wins: homeStats.wins, games: homeStats.games,
      form: homeStats.results || '',
    },
    away: {
      avgPts: awayStats.avgPts, avgPtsCon: awayStats.avgPtsCon,
      wins: awayStats.wins, games: awayStats.games,
      form: awayStats.results || '',
    },
  };

  // ── H2H detail ──
  const h2hResumen = (h2hData && h2hData.length > 0) ? (() => {
    const recent = h2hData.slice(0, 5);
    const hWins = recent.filter(g => (g.hPts > g.aPts && g.home === homeTeam) || (g.aPts > g.hPts && g.away === homeTeam)).length;
    const avgTotal = recent.reduce((s, g) => s + (g.hPts || 0) + (g.aPts || 0), 0) / recent.length;
    return {
      partidos: recent.length,
      victorias: { home: hWins, away: recent.length - hWins },
      promedioTotal: +avgTotal.toFixed(0),
      dominador: hWins >= 3 ? homeTeam : (recent.length - hWins >= 3) ? awayTeam : null,
      overRate: Math.round((recent.filter(g => (g.hPts || 0) + (g.aPts || 0) > 220).length / recent.length) * 100),
      detalle: recent.map(g => ({ date: g.date || '', home: g.home, away: g.away, hPts: g.hPts, aPts: g.aPts })),
    };
  })() : null;

  return res.status(200).json({
    resumen: summary,
    ganadorProbable: favTeam,
    probabilidades: { home: poisson.pHome, away: poisson.pAway },
    prediccionMarcador: `${Math.round(poisson.xPtsHome)}-${Math.round(poisson.xPtsAway)}`,
    apuestasDestacadas: picks,
    recomendaciones: picks.slice(0, 5).map(p => ({
      mercado: p.tipo, seleccion: p.pick,
      confianza: Math.round(p.confianza),
      razonamiento: p.razon || p.factores?.join('. ') || '',
    })),
    alertas: alerts,
    tendencias: {
      puntosEsperados: poisson.total,
      spreadEsperado: poisson.spread,
      over225Prob: poisson.pOver225,
    },
    tendenciasDetectadas: tendenciasDetectadas.length > 0 ? tendenciasDetectadas : ["Sin tendencias detectadas"],
    contextoExtra: {
      homeOffense: poisson.hOff, homeDefense: poisson.hDef,
      awayOffense: poisson.aOff, awayDefense: poisson.aDef,
    },
    poissonDetalle,
    statsDetalle,
    h2hResumen,
    edgesDetalle: edges.slice(0, 10),
    valueBet,
    erroresLinea: lineErrors.length > 0 ? lineErrors : [],
    nivelConfianza,
    razonConfianza,
    _model: 'nba-poisson-normal',
    _version: '4.0',
  });
}
