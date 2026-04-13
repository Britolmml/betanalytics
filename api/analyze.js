// api/analyze.js — Modelo estadistico puro (reemplaza Claude API)
// Poisson + Kelly Criterion + Edge detection + analisis contextual basado en datos

const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'https://betanalyticsIA.com';

// ── Poisson ──────────────────────────────────────────────────────
function poissonProb(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

// ── Odds conversion ─────────────────────────────────────────────
function americanToDecimal(price) {
  if (Math.abs(price) <= 10) return price; // ya es decimal
  return price > 0 ? (price / 100) + 1 : (100 / Math.abs(price)) + 1;
}

function americanToImplied(price) {
  if (Math.abs(price) <= 10) return 1 / price; // ya es decimal
  return price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100);
}

function decimalToAmerican(dec) {
  if (dec >= 2) return '+' + Math.round((dec - 1) * 100);
  return '-' + Math.round(100 / (dec - 1));
}

// ── Parse odds from api-sports format ───────────────────────────
function parseOdds(oddsData, homeName, awayName) {
  if (!oddsData) return null;
  const bookmaker = oddsData.bookmakers?.[0];
  if (!bookmaker?.bets?.length) return null;

  const result = { h2h: null, totals: null, btts: null };

  for (const bet of bookmaker.bets) {
    const name = bet.name?.toLowerCase() || '';
    if ((name === 'match winner' || name === 'home/away') && bet.values?.length) {
      result.h2h = bet.values.map(v => ({
        name: v.value === 'Home' ? homeName : v.value === 'Away' ? awayName : 'Draw',
        price: parseFloat(v.odd),
      })).filter(v => !isNaN(v.price));
    }
    if ((name === 'goals over/under' || name === 'over/under' || name === 'total') && bet.values?.length) {
      const over = bet.values.find(v => String(v.value).startsWith('Over'));
      const under = bet.values.find(v => String(v.value).startsWith('Under'));
      if (over && under) {
        const point = parseFloat(String(over.value).split(' ')[1] || '2.5');
        result.totals = {
          point,
          over: { price: parseFloat(over.odd) },
          under: { price: parseFloat(under.odd) },
        };
      }
    }
    if ((name === 'both teams score' || name === 'btts') && bet.values?.length) {
      result.btts = bet.values.filter(v => !isNaN(parseFloat(v.odd))).map(v => ({
        name: v.value,
        price: parseFloat(v.odd),
      }));
    }
  }
  return result.h2h || result.totals || result.btts ? result : null;
}

// ── Parse Owls splits ──────────────────────────────────────────
function parseSplits(splits) {
  if (!splits) return null;
  return {
    ml: splits.moneyline || null,
    tot: splits.total || null,
  };
}

// ── H2H analysis ───────────────────────────────────────────────
function analyzeH2H(h2hMatches) {
  if (!h2hMatches?.length) return null;
  const hHome = h2hMatches.filter(m => { const d = getData(m); return d.home === m.home; });
  const wins = h2hMatches.filter(m => { const d = getData(m); return d.homeGoals > d.awayGoals; }).length;
  const draws = h2hMatches.filter(m => { const d = getData(m); return d.homeGoals === d.awayGoals; }).length;
  const hAway = h2hMatches.length - wins - draws;
  const totalGoals = h2hMatches.reduce((s, m) => { const d = getData(m); return s + d.homeGoals + d.awayGoals; }, 0);
  const btts = h2hMatches.filter(m => { const d = getData(m); return d.homeGoals > 0 && d.awayGoals > 0; }).length;
  const avgTotal = totalGoals / h2hMatches.length;

  return {
    matches: h2hMatches.length,
    homeWins: wins,
    draws,
    awayWins: hAway,
    homeWinPct: Math.round((wins / h2hMatches.length) * 100),
    avgTotal: +avgTotal.toFixed(1),
    bttsRate: Math.round((btts / h2hMatches.length) * 100),
    over25Rate: Math.round((h2hMatches.filter(m => { const d = getData(m); return d.homeGoals + d.awayGoals > 2.5; }).length / h2hMatches.length) * 100),
    dominator: wins > hAway + draws ? h2hMatches[0]?.teams?.home?.name : hAway > wins ? h2hMatches[0]?.teams?.away?.name : null,
  };
}

function getData(match) {
  // Handle both api-sports and local data formats
  if (match.homeGoals !== undefined) {
    return {
      home: match.home,
      away: match.away,
      homeGoals: match.homeGoals,
      awayGoals: match.awayGoals,
    };
  }
  // api-sports format
  return {
    home: match.teams?.home?.name || '',
    away: match.teams?.away?.name || '',
    homeGoals: match.goals?.home ?? 0,
    awayGoals: match.goals?.away ?? 0,
  };
}

// ── Main Poisson model ────────────────────────────────────────
function calcPoisson(homeStats, awayStats, h2h = null, referee = null, fatigue = null) {
  if (!homeStats || !awayStats) return null;

  const leagueAvgGoals = 1.35;
  const homeAdvantage = 1.1;

  // Attack/defense strength relative to league
  const homeAttack = homeStats.avgScored > 0 ? homeStats.avgScored / leagueAvgGoals : 1;
  const homeDefense = homeStats.avgConceded > 0 ? homeStats.avgConceded / leagueAvgGoals : 1;
  const awayAttack = awayStats.avgScored > 0 ? awayStats.avgScored / leagueAvgGoals : 1;
  const awayDefense = awayStats.avgConceded > 0 ? awayStats.avgConceded / leagueAvgGoals : 1;

  // xG base
  let xgHome = leagueAvgGoals * homeAttack * awayDefense * homeAdvantage;
  let xgAway = leagueAvgGoals * awayAttack * homeDefense;

  // Form adjustment
  xgHome = xgHome * (0.85 + 0.3 * (homeStats.wins / 5));
  xgAway = xgAway * (0.85 + 0.3 * (awayStats.wins / 5));

  // Shots on target xG adjustment
  if (homeStats.avgShotsOn && homeStats.avgShotsOn > 0) {
    const shotXg = homeStats.avgShotsOn * 0.1;
    xgHome = (xgHome + shotXg) / 2;
  }
  if (awayStats.avgShotsOn && awayStats.avgShotsOn > 0) {
    const shotXg = awayStats.avgShotsOn * 0.1;
    xgAway = (xgAway + shotXg) / 2;
  }

  // H2H influence (blend with Poisson, max 20% influence)
  if (h2h && h2h.matches >= 3) {
    const h2hHomePct = h2h.homeWinPct / 100;
    const h2hAwayPct = h2h.awayWins / h2h.matches;
    const h2hBlend = Math.min(h2h.matches / 10, 0.2); // up to 20%
    xgHome = xgHome * (1 - h2hBlend) + leagueAvgGoals * h2hHomePct * 2 * h2hBlend;
    xgAway = xgAway * (1 - h2hBlend) + leagueAvgGoals * h2hAwayPct * 2 * h2hBlend;
  }

  // Fatigue adjustment
  if (fatigue) {
    if (fatigue.homeDaysRest !== undefined) {
      const fatigueFactor = Math.max(0.85, 1 - (Math.max(0, 5 - fatigue.homeDaysRest) * 0.03));
      xgHome *= fatigueFactor;
    }
    if (fatigue.awayDaysRest !== undefined) {
      const fatigueFactor = Math.max(0.85, 1 - (Math.max(0, 5 - fatigue.awayDaysRest) * 0.03));
      xgAway *= fatigueFactor;
    }
  }

  // Referee adjustment (cards)
  const refereeCardFactor = referee?.cardsPerMatch ? (referee.cardsPerMatch - 3.5) * 0.1 : 0;

  xgHome = Math.max(0.3, Math.min(4.0, xgHome));
  xgAway = Math.max(0.3, Math.min(4.0, xgAway));

  // Probability distribution
  const MAX = 6;
  let pHome = 0, pDraw = 0, pAway = 0, pBTTS = 0, pOver15 = 0, pOver25 = 0, pOver35 = 0, pOver45 = 0;
  let expectedGoals = 0, expectedCorners = 0;
  const scores = [];

  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      const p = poissonProb(xgHome, h) * poissonProb(xgAway, a);
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
      if (h > 0 && a > 0) pBTTS += p;
      if (h + a > 1.5) pOver15 += p;
      if (h + a > 2.5) pOver25 += p;
      if (h + a > 3.5) pOver35 += p;
      if (h + a > 4.5) pOver45 += p;
      expectedGoals += (h + a) * p;
      scores.push({ h, a, p });
    }
  }

  const topScores = scores
    .sort((a, b) => b.p - a.p)
    .slice(0, 6)
    .map(s => ({ score: `${s.h}-${s.a}`, prob: Math.round(s.p * 100) }));

  return {
    xgHome: +xgHome.toFixed(2),
    xgAway: +xgAway.toFixed(2),
    homeAttack: +homeAttack.toFixed(2),
    awayAttack: +awayAttack.toFixed(2),
    homeDefense: +homeDefense.toFixed(2),
    awayDefense: +awayDefense.toFixed(2),
    pHome: Math.round(pHome * 100),
    pDraw: Math.round(pDraw * 100),
    pAway: Math.round(pAway * 100),
    pBTTS: Math.round(pBTTS * 100),
    pOver15: Math.round(pOver15 * 100),
    pOver25: Math.round(pOver25 * 100),
    pOver35: Math.round(pOver35 * 100),
    pOver45: Math.round(pOver45 * 100),
    expectedGoals: +expectedGoals.toFixed(2),
    topScores,
    totalProbCheck: Math.round((pHome + pDraw + pAway) * 100),
  };
}

// ── Edge & Kelly detection ─────────────────────────────────────
function calcEdges(poissonResult, oddsParsed) {
  if (!poissonResult || !oddsParsed) return [];
  const edges = [];

  const addEdge = (market, pick, ourProb, price, label) => {
    if (!price || price <= 0 || !ourProb) return;
    const implied = 1 / price;
    if (implied <= 0 || implied > 1) return;
    const edge = ((ourProb - implied) * 100).toFixed(1);
    const kelly = ourProb > implied && (price - 1) > 0 ? ((ourProb - implied) / (price - 1)) * 100 : 0;

    edges.push({
      market,
      pick,
      label,
      ourProb: +(+ourProb * 100).toFixed(1),
      impliedProb: +(implied * 100).toFixed(1),
      edge: +edge,
      decimal: +price.toFixed(2),
      american: decimalToAmerican(price),
      kelly: +kelly.toFixed(1),
      hasValue: +edge > 3 && +edge < 12,
    });
  };

  if (oddsParsed.h2h) {
    const homeO = oddsParsed.h2h.find(o => !o.name.toLowerCase().includes('draw'));
    const drawO = oddsParsed.h2h.find(o => o.name.toLowerCase().includes('draw'));
    const awayCandidates = oddsParsed.h2h.filter(o => !o.name.toLowerCase().includes('draw'));
    const awayO = awayCandidates[1];

    if (homeO) addEdge('1X2', 'Local', poissonResult.pHome / 100, homeO.price, 'Local');
    if (drawO) addEdge('1X2', 'Empate', poissonResult.pDraw / 100, drawO.price, 'Empate');
    if (awayO) addEdge('1X2', 'Visitante', poissonResult.pAway / 100, awayO.price, 'Visitante');
  }

  if (oddsParsed.totals) {
    addEdge('Total Goles', `Over ${oddsParsed.totals.point}`, poissonResult.pOver25 / 100, oddsParsed.totals.over.price, `Over ${oddsParsed.totals.point}`);
    addEdge('Total Goles', `Under ${oddsParsed.totals.point}`, (100 - poissonResult.pOver25) / 100, oddsParsed.totals.under.price, `Under ${oddsParsed.totals.point}`);
  }

  if (oddsParsed.btts) {
    const yes = oddsParsed.btts.find(b => b.name === 'Yes' || b.name === 'yes');
    const no = oddsParsed.btts.find(b => b.name === 'No' || b.name === 'no');
    if (yes) addEdge('BTTS', 'Sí', poissonResult.pBTTS / 100, yes.price, 'BTTS Sí');
    if (no) addEdge('BTTS', 'No', (100 - poissonResult.pBTTS) / 100, no.price, 'BTTS No');
  }

  return edges.sort((a, b) => b.edge - a.edge);
}

// ── Confidence calculation ─────────────────────────────────────
function calculateConfidence(poisson, edge, h2hData, homeStats, awayStats) {
  let conf = 50; // base

  // Poisson probability strength (normalized around center)
  const maxProb = Math.max(poisson.pHome, poisson.pDraw, poisson.pAway);
  if (maxProb >= 55) conf += 8;
  else if (maxProb >= 48) conf += 5;
  else if (maxProb >= 42) conf += 2;
  else conf -= 5;

  // Edge value
  if (edge > 5) conf += 10;
  else if (edge > 3) conf += 6;
  else if (edge > 0) conf += 3;
  else conf -= 3;

  // Form consistency
  const homeConsistent = homeStats?.results?.length === 5;
  const awayConsistent = awayStats?.results?.length === 5;
  if (homeConsistent && awayConsistent) conf += 3;
  if (!homeConsistent || !awayConsistent) conf -= 2;

  // H2H confirmation
  if (h2hData && h2hData.dominator && (h2hData.homeWinPct > 65 || h2hData.awayWins > h2hData.homeWins + h2hData.draws)) {
    conf += 3;
  }

  // Cap conservative
  conf = Math.max(45, Math.min(78, conf));
  return conf;
}

// ── Build picks ─────────────────────────────────────────────────
function buildPicks(poisson, edges, h2h, homeStats, awayStats, homeName, awayName) {
  const picks = [];
  const isEN = false; // can be parameterized

  // Best edge picks
  const valueEdges = edges.filter(e => e.hasValue);
  const allEdges = edges.filter(e => e.edge > -5);

  // 1. Resultado 1X2
  if (poisson.pHome >= 42 || poisson.pAway >= 42) {
    const best1X2 = allEdges.find(e => e.market === '1X2') || {
      market: '1X2',
      pick: poisson.pHome > poisson.pAway ? `${homeName}` : `${awayName}`,
      ourProb: Math.max(poisson.pHome, poisson.pAway),
      decimal: Math.max(poisson.pHome, poisson.pAway) > 45 ? 1.65 : 2.10,
      edge: 0,
      kelly: 0,
      hasValue: false,
    };
    const conf = calculateConfidence(poisson, best1X2.edge || 0, h2h, homeStats, awayStats);
    if (conf < 52 && !best1X2.hasValue) {
      picks.push({
        tipo: isEN ? '1X2 Result' : 'Resultado 1X2',
        pick: isEN ? 'No bet — too close' : 'PASO — Partido muy parejo',
        confianza: conf,
        odds_sugerido: "N/A",
        factores: [
          isEN ? 'Data does not support a clear side' : 'Los datos no favorecen claramente a ningún equipo',
          isEN ? 'Search value in alternative markets' : 'Buscar valor en mercados secundarios',
        ],
      });
    } else {
      picks.push({
        tipo: isEN ? '1X2 Result' : 'Resultado 1X2',
        pick: best1X2.pick,
        confianza: conf,
        odds_sugerido: best1X2.decimal?.toString() || (conf > 55 ? '1.75' : '2.00'),
        factores: [
          `${homeName} xG: ${poisson.xgHome} | ${awayName} xG: ${poisson.xgAway}`,
          `Forma: ${homeStats.avgScored || '?'} goles a favor · ${awayStats.avgScored || '?'} goles`,
          h2h?.dominator ? `H2H favorece: ${h2h.dominator}` : 'H2H: sin patrón claro',
        ],
      });
    }
  }

  // 2. Total Goles
  const overEdge = edges.find(e => e.pick?.includes('Over'));
  const underEdge = edges.find(e => e.pick?.includes('Under'));
  const totalEdge = overEdge?.edge > 0 ? overEdge : (underEdge?.edge > 0 ? underEdge : null);
  const totalLine = edges.find(e => e.pick?.includes('Over') || e.pick?.includes('Under'))?.pick?.split(' ')?.pop() || '2.5';

  if (totalEdge) {
    picks.push({
      tipo: isEN ? 'Total Goals' : 'Total Goles',
      pick: totalEdge.pick,
      confianza: Math.min(75, 50 + totalEdge.edge),
      odds_sugerido: totalEdge.decimal?.toString() || '1.85',
      factores: [
        `Expected total goals: ${poisson.expectedGoals}`,
        `Over ${totalLine} probability: ${poisson.pOver25}%`,
        `Edge vs market: ${totalEdge.edge > 0 ? '+' : ''}${totalEdge.edge}%`,
      ],
    });
  } else {
    // No odds available — use Poisson only
    const overPick = poisson.pOver25 >= 58 ? `Más de ${totalLine}` : poisson.pOver25 <= 42 ? `Menos de ${totalLine}` : null;
    if (overPick) {
      picks.push({
        tipo: isEN ? 'Total Goals' : 'Total Goles',
        pick: overPick,
        confianza: Math.abs(poisson.pOver25 - 50) + 45,
        odds_sugerido: poisson.pOver25 >= 55 ? '1.80' : '1.95',
        factores: [
          `Expected total goals: ${poisson.expectedGoals}`,
          `Over ${totalLine} probability: ${poisson.pOver25}%`,
          isEN ? 'No odds available — use estimated price' : 'Sin momios — precio estimado',
        ],
      });
    }
  }

  // 3. BTTS
  const bttsEdge = edges.find(e => e.market === 'BTTS' && e.pick === 'Sí');
  const bttsNoEdge = edges.find(e => e.market === 'BTTS' && e.pick === 'No');
  const bttsBest = (bttsEdge?.edge || 0) > (bttsNoEdge?.edge || 0) ? bttsEdge : bttsNoEdge;

  if (bttsBest || (poisson.pBTTS > 55 || poisson.pBTTS < 40)) {
    const isYes = bttsBest === bttsEdge || (!bttsBest && poisson.pBTTS >= 50);
    picks.push({
      tipo: 'BTTS',
      pick: isYes ? (isEN ? 'Sí' : 'Sí') : (isEN ? 'No' : 'No'),
      confianza: Math.min(70, 50 + (bttsBest ? bttsBest.edge : Math.abs(poisson.pBTTS - 50))),
      odds_sugerido: bttsBest?.decimal?.toString() || (isYes ? '1.75' : '2.10'),
      factores: [
        `BTTS probability: ${poisson.pBTTS}%`,
        isYes
          ? `${homeStats.avgScored || '?'} + ${awayStats.avgScored || '?'} = ambos anotan regularmente`
          : `Clean sheets frecuentes: ${homeStats.cleanSheets || 0}/5 + ${awayStats.cleanSheets || 0}/5`,
      ],
    });
  }

  // 4. Corners
  const cornerHome = homeStats.avgCorners || 0;
  const cornerAway = awayStats.avgCorners || 0;
  const cornerTotal = cornerHome + cornerAway;
  if (cornerTotal > 0) {
    const cornerLine = cornerTotal >= 10 ? 'Más de 9.5' : 'Menos de 9.5';
    const cornerConf = Math.min(65, Math.abs(cornerTotal - 9.5) * 8 + 48);
    picks.push({
      tipo: 'Corners',
      pick: cornerLine,
      confianza: +cornerConf.toFixed(0),
      odds_sugerido: cornerConf >= 55 ? '1.85' : '2.00',
      factores: [
        `Corners prom: ${homeName}=${cornerHome} | ${awayName}=${cornerAway}`,
        `Combo: ${cornerTotal.toFixed(1)} vs línea 9.5`,
      ],
    });
  }

  // 5. Tarjetas
  const cardsHome = homeStats.avgCards || 0;
  const cardsAway = awayStats.avgCards || 0;
  const cardsTotal = cardsHome + cardsAway;
  if (cardsTotal > 0) {
    const cardLine = cardsTotal >= 4 ? 'Más de 3.5' : 'Menos de 3.5';
    const cardConf = Math.min(65, Math.abs(cardsTotal - 3.5) * 7 + 48);
    picks.push({
      tipo: 'Tarjetas',
      pick: cardLine,
      confianza: +cardConf.toFixed(0),
      odds_sugerido: cardConf >= 55 ? '1.80' : '2.00',
      factores: [
        `Tarjetas prom: ${homeName}=${cardsHome} | ${awayName}=${cardsAway}`,
        `Combo: ${cardsTotal.toFixed(1)} vs línea 3.5`,
      ],
    });
  }

  // 6. Double Chance if main result is weak
  const mainPick = picks.find(p => p.tipo.includes('1X2'));
  if (mainPick && mainPick.pick.includes('PASO')) {
    // Find value in double chance
    picks.push({
      tipo: isEN ? 'Double Chance' : 'Doble Oportunidad',
      pick: `${homeName} o Empate`,
      confianza: Math.min(72, (poisson.pHome + poisson.pDraw) * 0.9),
      odds_sugerido: '1.35',
      factores: [
        `Local + Empate: ${poisson.pHome + poisson.pDraw}%`,
        `${homeName} no pierde en casa frecuentemente`,
      ],
    });
  }

  // Sort by confidence
  return picks.sort((a, b) => b.confianza - a.confianza);
}

// ── Build summary ──────────────────────────────────────────────
function buildSummary(poisson, picks, h2h, homeName, awayName, edges, splits) {
  const bestPick = picks[0];
  const bestPickText = bestPick ? `${bestPick.tipo}: ${bestPick.pick} (${bestPick.confianza}%)` : '';
  const valueCount = edges.filter(e => e.hasValue).length;

  let summary = `Modelo Poisson proyecta ${homeName} ${poisson.xgHome}-${poisson.xgAway} ${awayName} (xG ` +
    `${poisson.xgHome} vs ${poisson.xgAway}). ` +
    `${homeName} local ${poisson.pHome}% | Empate ${poisson.pDraw}% | ${awayName} ${poisson.pAway}%. `;

  if (bestPick) {
    summary += `Mejor oportunidad: ${bestPickText}. `;
  }

  if (valueCount > 0) {
    summary += `${valueCount} value bet(s) detectado(s) vs casas de apuestas. `;
  }

  if (h2h?.dominator) {
    summary += `H2H favorece a ${h2h.dominator} (${h2h.homeWinPct}% victorias locales). `;
  }

  if (splits?.ml) {
    const ml = splits.ml;
    const sharpSignal = ml.home_handle_pct > ml.home_bets_pct + 15
      ? `dinero sharp en ${homeName}`
      : ml.away_handle_pct > ml.away_bets_pct + 15
        ? `dinero sharp en ${awayName}`
        : '';
    if (sharpSignal) summary += `${sharpSignal}. `;
  }

  return summary.trim();
}

// ── Value bet detection ────────────────────────────────────────
function detectValueBets(edges) {
  const valueBets = edges.filter(e => e.hasValue);
  return {
    existe: valueBets.length > 0,
    count: valueBets.length,
    best: valueBets.length > 0 ? {
      mercado: valueBets[0].market,
      pick: valueBets[0].pick,
      cuotaReal: valueBets[0].decimal,
      probImplicita: valueBets[0].impliedProb + '%',
      probCalculada: valueBets[0].ourProb + '%',
      valorEdge: valueBets[0].edge + '%',
    } : null,
  };
}

// ── Alertas dinamicas ──────────────────────────────────────────
function generateAlerts(poisson, homeStats, awayStats, h2h) {
  const alerts = [];

  if (poisson.pDraw >= 33) {
    alerts.push('⚠️ Empate muy prob (' + poisson.pDraw + '%). Considerar doble oportunidad o Asian Handicap.');
  }
  if (Math.abs(poisson.pHome - poisson.pAway) < 10 && poisson.pOver25 < 45) {
    alerts.push('⚠️ Partido muy parejo con pocas goles. BTTS No o Under puede ser mejor opcion que resultado.');
  }
  if (homeStats.cleanSheets >= 3) {
    alerts.push('🛡️ ' + homeStats.cleanSheets + '/5 clean sheets en casa. Defensa solida local.');
  }
  if (awayStats.cleanSheets >= 3) {
    alerts.push('🛡️ ' + awayStats.cleanSheets + '/5 clean sheets visitante. Defensa solida visitante.');
  }
  if (poisson.pBTTS >= 65) {
    alerts.push('⚽ BTTS (' + poisson.pBTTS + '%) — ambos equipos anotan con frecuencia.');
  }
  if (poisson.pBTTS <= 30) {
    alerts.push('🔴 BTTS bajo (' + poisson.pBTTS + '%) — al menos un equipo no anota regularmente.');
  }
  if (h2h && h2h.bttsRate >= 70) {
    alerts.push('📊 H2H: BTTS ocurrio en ' + h2h.bttsRate + '% de duelos directos.');
  }
  if ((homeStats.results?.filter(r => r === 'L').length >= 3) || (awayStats.results?.filter(r => r === 'L').length >= 3)) {
    alerts.push('📉 Equipo en racha perdedora. Momentum negativo puede afectar rendimiento.');
  }

  return alerts;
}

// ── Claude AI analysis ────────────────────────────────────────
async function callClaudeAI(prompt, homeStats, awayStats) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return null;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const text = data?.content?.[0]?.text || "";

    // Parse JSON — handle markdown wrapping
    const jsonStr = text.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    try {
      const parsed = JSON.parse(jsonStr);
      parsed._model = "claude-sonnet-4-5-20250514";
      parsed._source = "anthropic-api";
      return parsed;
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        parsed._model = "claude-sonnet-4-5-20250514";
        parsed._source = "anthropic-api";
        return parsed;
      }
    }
  } catch (err) {
    console.warn("Claude AI error:", err.message);
  }
  return null;
}

// ── Main handler ───────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { homeTeam, awayTeam, homeStats, awayStats, h2hData, oddsData, splitsData, refereeData, fatigueData, prompt } = req.body;

  if (!homeStats || !awayStats) return res.status(400).json({ error: "homeStats y awayStats requeridos" });

  // If prompt is provided, try Claude AI first
  if (prompt) {
    const aiResult = await callClaudeAI(prompt, homeStats, awayStats);
    if (aiResult) {
      // Enrich with Poisson baseline
      const poisson = calcPoisson(homeStats, awayStats, analyzeH2H(h2hData), refereeData, fatigueData);
      if (poisson) {
        aiResult._poisson = poisson;
        if (!aiResult.probabilidades) {
          aiResult.probabilidades = { local: poisson.pHome, empate: poisson.pDraw, visitante: poisson.pAway };
        }
      }
      return res.status(200).json(aiResult);
    }
    // Claude failed — fall through to Poisson
  }

  // Parse inputs
  const h2h = analyzeH2H(h2hData);
  const oddsParsed = parseOdds(oddsData, homeTeam, awayTeam);
  const splits = parseSplits(splitsData);

  // Main Poisson calculation
  const poisson = calcPoisson(homeStats, awayStats, h2h, refereeData, fatigueData);
  if (!poisson) return res.status(500).json({ error: "Error calculando Poisson" });

  // Edge detection
  const edges = calcEdges(poisson, oddsParsed);

  // Build picks
  const picks = buildPicks(poisson, edges, h2h, homeStats, awayStats, homeTeam, awayTeam);

  // Summary
  const summary = buildSummary(poisson, picks, h2h, homeTeam, awayTeam, edges, splits);
  const valueBets = detectValueBets(edges);
  const alerts = generateAlerts(poisson, homeStats, awayStats, h2h);

  // Build full response matching the Claude API format
  const response = {
    resumen: summary,
    prediccionMarcador: poisson.topScores[0]?.score || '1-1',
    probabilidades: {
      local: poisson.pHome,
      empate: poisson.pDraw,
      visitante: poisson.pAway,
    },
    valueBet: valueBets,
    apuestasDestacadas: picks,
    recomendaciones: picks.slice(0, 3).map(p => ({
      mercado: p.tipo,
      seleccion: p.pick,
      confianza: p.confianza,
      razonamiento: `Basado en xG: ${poisson.xgHome}-${poisson.xgAway}, Poisson ${p.ourProb || poisson.pHome}%, Edge: ${p.edge || 0}%`,
    })),
    alertas: alerts,
    tendencias: {
      golesEsperados: poisson.expectedGoals,
      cornersEsperados: +((homeStats.avgCorners || 0) + (awayStats.avgCorners || 0)).toFixed(1),
      tarjetasEsperadas: +((homeStats.avgCards || 0) + (awayStats.avgCards || 0)).toFixed(1),
    },
    contextoExtra: {
      xgHome: poisson.xgHome,
      xgAway: poisson.xgAway,
      homeForm: homeStats.results?.join('-') || '',
      awayForm: awayStats.results?.join('-') || '',
      h2hDominator: h2h?.dominator || null,
      h2hAvgGoals: h2h?.avgTotal || null,
      bttsH2H: h2h?.bttsRate >= 50 || false,
    },
    edgesDetalle: edges.slice(0, 5),
    _model: 'poisson-kelly',
    _version: '1.0',
  };

  return res.status(200).json(response);
}
