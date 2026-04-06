// scripts/analize-today.js
// Trae partidos de hoy, analiza con Poisson, encuentra value bets y guarda historial

const fs = require('fs');
const path = require('path');
const https = require('https');

const API_KEY = process.env.API_FOOTBALL_KEY;
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.json');

if (!API_KEY) {
  console.error('Falta API_FOOTBALL_KEY. Ponla en .env como API_FOOTBALL_KEY=tu-key');
  process.exit(1);
}

// ── Poisson model (mismo que api/analyze.js) ──
function poissonProb(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function calcPoisson(hStats, aStats) {
  const leagueAvgGoals = 1.35;
  const homeAdvantage = 1.1;

  const homeAttack  = hStats.avgScored   > 0 ? hStats.avgScored   / leagueAvgGoals : 1;
  const homeDefense = hStats.avgConceded > 0 ? hStats.avgConceded / leagueAvgGoals : 1;
  const awayAttack  = aStats.avgScored   > 0 ? aStats.avgScored   / leagueAvgGoals : 1;
  const awayDefense = aStats.avgConceded > 0 ? aStats.avgConceded / leagueAvgGoals : 1;

  let xgHome = leagueAvgGoals * homeAttack * awayDefense * homeAdvantage;
  let xgAway = leagueAvgGoals * awayAttack * homeDefense;

  xgHome *= (0.85 + 0.3 * (hStats.wins / 5));
  xgAway *= (0.85 + 0.3 * (aStats.wins / 5));

  if (hStats.avgShotsOn > 0) xgHome = (xgHome + hStats.avgShotsOn * 0.1) / 2;
  if (aStats.avgShotsOn > 0) xgAway = (xgAway + aStats.avgShotsOn * 0.1) / 2;

  xgHome = Math.max(0.3, Math.min(4.0, xgHome));
  xgAway = Math.max(0.3, Math.min(4.0, xgAway));

  const MAX = 6;
  let pHome = 0, pDraw = 0, pAway = 0, pBTTS = 0, pO25 = 0;
  const scores = [];

  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      const p = poissonProb(xgHome, h) * poissonProb(xgAway, a);
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
      if (h > 0 && a > 0) pBTTS += p;
      if (h + a > 2.5) pO25 += p;
      scores.push({ h, a, p });
    }
  }

  const topScores = scores.sort((a, b) => b.p - a.p).slice(0, 3).map(s => `${s.h}-${s.a}(${Math.round(s.p*100)}%)`);

  return { xgHome: +xgHome.toFixed(2), xgAway: +xgAway.toFixed(2), pHome: Math.round(pHome*100), pDraw: Math.round(pDraw*100), pAway: Math.round(pAway*100), pBTTS: Math.round(pBTTS*100), pO25: Math.round(pO25*100), topScores };
}

// ── HTTP helper ──
function apiFetch(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `https://v3.football.api-sports.io${endpoint}`;
    https.get(url, { headers: { 'x-apisports-key': API_KEY, 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── Fetch leagues + fixtures ──
async function main() {
  console.log('══════════════════════════════════════════════════');
  console.log('  BETANALYTICS — ANALISIS DIARIO');
  console.log('  Fecha:', new Date().toISOString().split('T')[0]);
  console.log('══════════════════════════════════════════════════\n');

  // 1. Get today's fixtures for featured leagues
  const today = new Date().toISOString().split('T')[0]; // 2026-04-06
  const FEATURED_LEAGUES = [39, 140, 78, 135, 61, 2, 3, 13, 262, 71, 98, 307, 188];
  const SEASONS = [2026, 2025, 2024];

  // 2. Fetch fixtures for each league
  console.log('📡 Cargando fixtures de hoy...\n');

  let allMatches = [];
  const leagueCache = {};
  const teamCache = {};
  const teamStatsCache = {};

  for (const leagueId of FEATURED_LEAGUES) {
    for (const season of SEASONS) {
      try {
        const d = await apiFetch(`/fixtures?league=${leagueId}&season=${season}&date=${today}`);
        const fixtures = d.response || [];
        if (fixtures.length === 0) continue;

        // Get league info
        if (!leagueCache[leagueId]) {
          const ld = await apiFetch(`/leagues?id=${leagueId}`);
          leagueCache[leagueId] = ld.response?.[0]?.league?.name || 'Unknown';
        }

        // Get standings
        if (!leagueCache[leagueId + '_standings']) {
          try {
            const sd = await apiFetch(`/standings?league=${leagueId}&season=${season}`);
            leagueCache[leagueId + '_standings'] = sd.response?.[0]?.league?.standings?.[0] || [];
          } catch(e) {}
        }

        for (const f of fixtures) {
          const homeId = f.teams?.home?.id;
          const awayId = f.teams?.away?.id;
          const status = f.fixture?.status?.short;

          // Only analyze upcoming or live
          if (['FT', 'AET', 'PEN', 'PST', 'CANC', 'INT', 'ABD'].includes(status)) continue;

          // Fetch recent fixtures for both teams (last 5 played)
          const [homeData, awayData] = await Promise.all([
            getTeamRecent(homeId, teamStatsCache),
            getTeamRecent(awayId, teamStatsCache),
          ]);

          allMatches.push({
            fixtureId: f.fixture?.id,
            date: f.fixture?.date,
            league: leagueCache[leagueId],
            home: f.teams?.home?.name,
            away: f.teams?.away?.name,
            homeStats: homeData,
            awayStats: awayData,
          });
        }
      } catch(e) { /* skip league */ }
    }
  }

  console.log(`📋 ${allMatches.length} partidos encontrados para hoy.\n`);

  // 3. Analyze each match
  const results = [];
  for (const match of allMatches) {
    const p = calcPoisson(match.homeStats, match.awayStats);
    const edge = {
      home: Math.round((p.pHome/100 - 0.33) * 100), // rough implied baseline
      draw: Math.round((p.pDraw/100 - 0.28) * 100),
      away: Math.round((p.pAway/100 - 0.39) * 100),
      o25: Math.round((p.pO25/100 - 0.50) * 100),
      btts: Math.round((p.pBTTS/100 - 0.50) * 100),
    };

    const bestPick = [
      { market: '1X2 Local', edge: edge.home, prob: p.pHome },
      { market: 'Empate', edge: edge.draw, prob: p.pDraw },
      { market: '1X2 Visitante', edge: edge.away, prob: p.pAway },
      { market: 'Over 2.5', edge: edge.o25, prob: p.pO25 },
      { market: 'BTTS Si', edge: edge.btts, prob: p.pBTTS },
    ].sort((a, b) => b.edge - a.edge)[0];

    const confidence = bestPick.edge > 5 ? 'ALTA' : bestPick.edge > 0 ? 'MEDIA' : 'BAJA';

    results.push({
      ...match,
      prediction: p,
      edges: edge,
      bestPick,
      confidence,
      date: today,
    });
  }

  // 4. Display results
  console.log('\n══════════════════════════════════════════════════');
  console.log('  ANALISIS DE PARTIDOS HOY');
  console.log('══════════════════════════════════════════════════\n');

  const sorted = results.sort((a, b) => b.bestPick.edge - a.bestPick.edge);
  const highConfidence = sorted.filter(r => r.confidence === 'ALTA');
  const medConfidence = sorted.filter(r => r.confidence === 'MEDIA');

  if (highConfidence.length > 0) {
    console.log('🟢 VALUE BETS ALTA CONFIANZA:');
    for (const r of highConfidence) {
      console.log(`  ⚽ ${r.home} vs ${r.away} (${r.league})`);
      console.log(`     xG: ${r.prediction.xgHome}-${r.prediction.xgAway} | Mejor: ${r.bestPick.market} (Edge: +${r.bestPick.edge}%, Prob: ${r.bestPick.prob}%)`);
      console.log(`     ${r.prediction.topScores.join(' | ')}\n`);
    }
  }

  if (medConfidence.length > 0) {
    console.log('🟡 OPÇÕES MEDIA CONFIANZA:');
    for (const r of medConfidence) {
      console.log(`  ⚽ ${r.home} vs ${r.away} (${r.league})`);
      console.log(`     xG: ${r.prediction.xgHome}-${r.prediction.xgAway} | Mejor: ${r.bestPick.market} (Edge: +${r.bestPick.edge}%, Prob: ${r.bestPick.prob}%)`);
      console.log(`     ${r.prediction.topScores.join(' | ')}\n`);
    }
  }

  const lowConfidence = sorted.filter(r => r.confidence === 'BAJA');
  if (lowConfidence.length > 0) {
    console.log(`🔴 ${lowConfidence.length} partidos sin valor claro — mejor evitar:\n`);
    for (const r of lowConfidence.slice(0, 5)) {
      console.log(`  ${r.home} vs ${r.away} (${r.league}) — Mejor edge: ${r.bestPick.market} (${r.bestPick.edge}%)`);
    }
  }

  // 5. Save history
  await saveHistory(results);

  // 6. Show trends
  showTrends(results);
}

// ── Caching team stats ──
async function getTeamRecent(teamId, cache) {
  if (cache[teamId]) return cache[teamId];

  // Try to get recent fixtures
  let allPlayed = [];
  for (const season of [2026, 2025, 2024]) {
    try {
      const d = await apiFetch(`/fixtures?team=${teamId}&season=${season}`);
      const items = d.response || [];
      const played = items
        .filter(f => ['FT', 'AET', 'PEN'].includes(f.fixture?.status?.short))
        .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
      allPlayed.push(...played);
      if (allPlayed.length >= 10) break;
    } catch(e) {}
  }

  allPlayed = allPlayed.slice(0, 10);

  // Deduplicate
  const seen = new Set();
  allPlayed = allPlayed.filter(f => {
    if (seen.has(f.fixture?.id)) return false;
    seen.add(f.fixture?.id);
    return true;
  });

  const last5 = allPlayed.slice(0, 5);
  if (last5.length === 0) {
    cache[teamId] = { avgScored: 1.2, avgConceded: 1.2, wins: 2, avgShotsOn: 0, avgCorners: 5, avgCards: 2, results: ['W','L','D','W','L'], btts: 2, over25: 2, cleanSheets: 1 };
    return cache[teamId];
  }

  const ts = last5.map(f => {
    const isHome = f.teams?.home?.id === teamId;
    const goals = isHome ? (f.goals?.home ?? 0) : (f.goals?.away ?? 0);
    const conceded = isHome ? (f.goals?.away ?? 0) : (f.goals?.home ?? 0);
    return {
      goals,
      conceded,
      corners: isHome ? (f.statistics?.[0]?.corner_kicks ?? 5) : (f.statistics?.[1]?.corner_kicks ?? 5),
      cards: isHome ? (f.statistics?.[0]?.cards?.yellow ?? 2) : (f.statistics?.[1]?.cards?.yellow ?? 2),
      shotsOn: isHome ? (f.statistics?.[0]?.shots?.on_goal ?? 0) : (f.statistics?.[1]?.shots?.on_goal ?? 0),
    };
  });

  const results = ts.map(t => t.goals > t.conceded ? 'W' : t.goals === t.conceded ? 'D' : 'L');

  cache[teamId] = {
    avgScored: +(ts.reduce((s, t) => s + t.goals, 0) / ts.length).toFixed(2),
    avgConceded: +(ts.reduce((s, t) => s + t.conceded, 0) / ts.length).toFixed(2),
    wins: results.filter(r => r === 'W').length,
    avgShotsOn: ts.length > 0 && ts.some(t => t.shotsOn > 0) ? +(ts.reduce((s, t) => s + t.shotsOn, 0) / ts.length).toFixed(1) : null,
    avgCorners: +(ts.reduce((s, t) => s + t.corners, 0) / ts.length).toFixed(1),
    avgCards: +(ts.reduce((s, t) => s + t.cards, 0) / ts.length).toFixed(1),
    results,
    btts: ts.filter(t => t.goals > 0 && t.conceded > 0).length,
    over25: ts.filter(t => t.goals + t.conceded > 2.5).length,
    cleanSheets: ts.filter(t => t.conceded === 0).length,
  };
  return cache[teamId];
}

// ── History ──
async function saveHistory(results) {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) {}

  history.push({
    date: new Date().toISOString().split('T')[0],
    matches: results.map(r => ({
      home: r.home,
      away: r.away,
      league: r.league,
      xgHome: r.prediction.xgHome,
      xgAway: r.prediction.xgAway,
      bestPick: r.bestPick,
      confidence: r.confidence,
    })),
  });

  // Keep last 60 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  history = history.filter(h => h.date >= cutoff.toISOString().split('T')[0]);

  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  console.log('\n📊 Historial guardado en data/history.json');
}

// ── Trends ──
function showTrends(results) {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) {
    console.log('\n📈 Sin historial anterior — se empezara a registrar desde hoy.');
    return;
  }

  if (history.length < 2) return;

  console.log('\n══════════════════════════════════════════════════');
  console.log('  TENDENCIAS HISTORICAS');
  console.log('══════════════════════════════════════════════════\n');

  // Most consistent leagues
  const leagueStats = {};
  for (const h of history) {
    for (const m of h.matches) {
      const key = m.league;
      if (!leagueStats[key]) leagueStats[key] = { total: 0, alta: 0, media: 0, baja: 0 };
      leagueStats[key].total++;
      leagueStats[key][m.confidence.toLowerCase()]++;
    }
  }

  const leagues = Object.entries(leagueStats).sort((a, b) => b[1].total - a[1].total);
  console.log('Por liga (total analisis):');
  for (const [name, stats] of leagues) {
    const altaPct = stats.total > 0 ? ((stats.alta / stats.total) * 100).toFixed(0) : 0;
    console.log(`  ${name}: ${stats.total} partidos | ${altaPct}% ALTA | ${stats.media} MEDIA | ${stats.baja} BAJA`);
  }

  // Best edge markets
  const edges = [];
  for (const h of history) {
    for (const m of h.matches) {
      edges.push(m.bestPick.market);
    }
  }

  const marketCounts = {};
  edges.forEach(e => { marketCounts[e] = (marketCounts[e] || 0) + 1; });
  const topMarkets = Object.entries(marketCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  console.log('\nMercados con mas value detectado:');
  for (const [market, count] of topMarkets) {
    console.log(`  ${market}: ${count} veces (${((count / edges.length) * 100).toFixed(0)}% de las detecciones)`);
  }

  // Overall stats
  const totalMatches = history.reduce((s, h) => s + h.matches.length, 0);
  const totalHigh = history.reduce((s, h) => s + h.matches.filter(m => m.confidence === 'ALTA').length, 0);
  const totalMed = history.reduce((s, h) => s + h.matches.filter(m => m.confidence === 'MEDIA').length, 0);

  console.log(`\nTotales historico: ${totalMatches} partidos | ALTA: ${totalHigh} (${((totalHigh/totalMatches)*100).toFixed(0)}%) | MEDIA: ${totalMed} (${((totalMed/totalMatches)*100).toFixed(0)}%).`);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
