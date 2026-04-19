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

// ══════════════════════════════════════════════════════════════
// MLB League Constants (v4.0)
// ══════════════════════════════════════════════════════════════
const MLB_LEAGUE = {
  RUNS_PER_GAME: 4.52,    // 2024-2025 MLB average
  ERA: 4.17,
  WHIP: 1.28,
  K_PER_9: 8.58,
  BB_PER_9: 3.22,
  HOME_ADV: 1.024,        // ~2.4% home win% boost (historical MLB)
  KBB_RATE: 0.145,        // league avg K%-BB%
  PRIOR_KBB: 60,          // IP worth of prior for K-BB% shrinkage
};

// Bayesian shrinkage prior weights
const SHRINKAGE_PRIORS = {
  OFFENSE_IP: 200,   // plate appearances worth of prior (~50 games × 4 PA)
  DEFENSE_IP: 200,
  PITCHER_IP: 50,    // innings pitched worth of prior
};

// Market prior weights (how much to trust the market vs model)
const MARKET_PRIOR_WEIGHTS = {
  moneyline: 0.35,   // 35% model, 65% market for ML
};

/**
 * Bayesian shrinkage: blend observed rating toward league average
 * based on sample size. More data → trust observed more.
 * @param {number} observed - raw observed rating
 * @param {number} sampleSize - games or IP
 * @param {number} leagueAvg - league average (prior mean)
 * @param {number} priorWeight - how many units of sample = 50/50 blend
 * @returns {number} shrunk rating
 */
function shrunkRating(observed, sampleSize, leagueAvg, priorWeight) {
  if (!sampleSize || sampleSize <= 0) return leagueAvg;
  const weight = sampleSize / (sampleSize + priorWeight);
  return observed * weight + leagueAvg * (1 - weight);
}

/**
 * Cap lambda (expected runs) to realistic MLB range.
 * 2.5 = elite pitcher + weak offense floor
 * 7.5 = worst pitcher + elite offense ceiling
 */
function capLambda(lambda) {
  return Math.max(2.5, Math.min(7.5, lambda));
}

/**
 * Blend model probability with devigged market implied probability.
 * @param {number} modelProb - model's P(home) as proportion 0-1
 * @param {number} homeDecimal - decimal odds for home
 * @param {number} awayDecimal - decimal odds for away
 * @param {number} modelWeight - weight for model (0-1), rest goes to market
 * @returns {number} blended probability 0-1
 */
function marketPriorBlend(modelProb, homeDecimal, awayDecimal, modelWeight) {
  if (!homeDecimal || homeDecimal <= 1 || !awayDecimal || awayDecimal <= 1) return modelProb;
  // Devig: remove vig using multiplicative method
  const impliedHome = 1 / homeDecimal;
  const impliedAway = 1 / awayDecimal;
  const totalImplied = impliedHome + impliedAway;
  if (totalImplied <= 0) return modelProb;
  const deviggedHome = impliedHome / totalImplied;
  // Blend
  return modelProb * modelWeight + deviggedHome * (1 - modelWeight);
}

// ══════════════════════════════════════════════════════════════
// MLB Park Factors 2024-2026 (5-year regressed)
// Source: FanGraphs park factors
// Value > 1.00 = hitter-friendly, < 1.00 = pitcher-friendly
// ══════════════════════════════════════════════════════════════
const PARK_FACTORS = {
  'COL': 1.25, 'CIN': 1.08, 'BOS': 1.09, 'NYY': 1.06, 'TEX': 1.04,
  'TOR': 1.04, 'PHI': 1.03, 'BAL': 1.02, 'CHC': 1.02, 'HOU': 1.01,
  'WSN': 1.01, 'ARI': 1.00, 'ATL': 1.00, 'CHW': 1.00, 'MIL': 1.00,
  'MIN': 1.00, 'STL': 0.99, 'KC':  0.98, 'NYM': 0.97, 'LAA': 0.97,
  'CLE': 0.97, 'TB':  0.96, 'PIT': 0.95, 'OAK': 0.95, 'DET': 0.95,
  'MIA': 0.94, 'SD':  0.94, 'SF':  0.93, 'LAD': 0.93, 'SEA': 0.91,
};

const TEAM_NAME_TO_ABBR = {
  'Arizona Diamondbacks': 'ARI', 'Atlanta Braves': 'ATL',
  'Baltimore Orioles': 'BAL', 'Boston Red Sox': 'BOS',
  'Chicago Cubs': 'CHC', 'Chicago White Sox': 'CHW',
  'Cincinnati Reds': 'CIN', 'Cleveland Guardians': 'CLE',
  'Colorado Rockies': 'COL', 'Detroit Tigers': 'DET',
  'Houston Astros': 'HOU', 'Kansas City Royals': 'KC',
  'Los Angeles Angels': 'LAA', 'Los Angeles Dodgers': 'LAD',
  'Miami Marlins': 'MIA', 'Milwaukee Brewers': 'MIL',
  'Minnesota Twins': 'MIN', 'New York Mets': 'NYM',
  'New York Yankees': 'NYY', 'Oakland Athletics': 'OAK',
  'Philadelphia Phillies': 'PHI', 'Pittsburgh Pirates': 'PIT',
  'San Diego Padres': 'SD', 'San Francisco Giants': 'SF',
  'Seattle Mariners': 'SEA', 'St. Louis Cardinals': 'STL',
  'Tampa Bay Rays': 'TB', 'Texas Rangers': 'TEX',
  'Toronto Blue Jays': 'TOR', 'Washington Nationals': 'WSN',
};

function getTeamAbbr(teamName) {
  if (!teamName) return null;
  // Direct match
  if (TEAM_NAME_TO_ABBR[teamName]) return TEAM_NAME_TO_ABBR[teamName];
  // Fuzzy: match by last word (e.g. "Yankees" → NYY)
  const last = teamName.split(' ').pop().toLowerCase();
  for (const [name, abbr] of Object.entries(TEAM_NAME_TO_ABBR)) {
    if (name.toLowerCase().endsWith(last)) return abbr;
  }
  return null;
}

function getParkFactor(homeTeamName) {
  const abbr = getTeamAbbr(homeTeamName);
  return abbr ? (PARK_FACTORS[abbr] || 1.00) : 1.00;
}

/**
 * Apply half park factor (team plays 50% home, 50% away).
 * Only applied to total runs, not individual team ratings.
 */
function applyParkFactor(expectedTotal, homeTeamName) {
  const pf = getParkFactor(homeTeamName);
  const halfPF = 1 + (pf - 1) * 0.5;
  return expectedTotal * halfPF;
}

// ══════════════════════════════════════════════════════════════
// K-BB% Pitcher Model (replaces ERA-primary approach)
// K-BB% explains 19% of future ERA variance vs ERA's 8%
// ══════════════════════════════════════════════════════════════

/**
 * Calculate K-BB% from pitcher stats.
 * More predictive of future ERA than ERA itself (R²=0.19 vs 0.08).
 */
function calcKBBRate(pitcher) {
  if (!pitcher?.stats) return null;
  const stats = pitcher.stats;
  const k9 = parseFloat(stats.k9);
  const bb9 = parseFloat(stats.bb9);
  if (isNaN(k9)) return null;
  // Convert per-9 to rate: rate ≈ per_9 / 37 (typical BF per 9 IP)
  const kRate = k9 / 37;
  const bbRate = (!isNaN(bb9) && bb9 > 0) ? bb9 / 37 : MLB_LEAGUE.BB_PER_9 / 37;
  return kRate - bbRate;
}

/**
 * Pitcher quality index using K-BB% as primary signal.
 * Falls back to ERA if K-BB% unavailable.
 * Returns multiplier: < 1.0 = suppresses runs, > 1.0 = allows more.
 */
function pitcherQuality(stats) {
  if (!stats) return 1.0;

  const ip = parseFloat(stats.ip) || 0;

  // Try K-BB% first (more predictive)
  const k9 = parseFloat(stats.k9);
  const bb9 = parseFloat(stats.bb9);
  const era = parseFloat(stats.era);
  const whip = parseFloat(stats.whip);

  let kbbFactor = null;
  if (!isNaN(k9) && k9 > 0) {
    const kRate = k9 / 37;
    const bbRate = (!isNaN(bb9) && bb9 > 0) ? bb9 / 37 : MLB_LEAGUE.BB_PER_9 / 37;
    const kbbRaw = kRate - bbRate;
    // Shrink toward league avg based on IP
    const kbbShrunk = shrunkRating(kbbRaw, ip, MLB_LEAGUE.KBB_RATE, MLB_LEAGUE.PRIOR_KBB);
    // Convert to factor: each +1% K-BB% above avg → ~0.06 ERA reduction → ~0.014 fewer runs/game factor
    // league avg KBB = 0.145, so delta * 6.9 gives ERA-equivalent delta, then / leagueERA for factor
    const kbbDelta = kbbShrunk - MLB_LEAGUE.KBB_RATE;
    kbbFactor = 1.0 - (kbbDelta * 6.9 / MLB_LEAGUE.ERA);
  }

  // ERA fallback
  let eraFactor = null;
  if (!isNaN(era) && era > 0) {
    eraFactor = era / MLB_LEAGUE.ERA;
  }

  // WHIP modifier
  let whipFactor = 1.0;
  if (!isNaN(whip) && whip > 0) {
    whipFactor = whip / MLB_LEAGUE.WHIP;
  }

  // Combine: K-BB% primary (50%), ERA secondary (25%), WHIP tertiary (25%)
  // If K-BB% unavailable, ERA 60% + WHIP 40%
  let combined;
  if (kbbFactor != null && eraFactor != null) {
    combined = kbbFactor * 0.50 + eraFactor * 0.25 + whipFactor * 0.25;
  } else if (kbbFactor != null) {
    combined = kbbFactor * 0.65 + whipFactor * 0.35;
  } else if (eraFactor != null) {
    combined = eraFactor * 0.60 + whipFactor * 0.40;
  } else {
    return 1.0; // no data
  }

  // IP reliability: low IP → regress further toward 1.0
  if (ip > 0 && ip < 40) {
    const reliability = ip / 40;
    combined = combined * reliability + 1.0 * (1 - reliability);
  }

  return Math.max(0.55, Math.min(1.6, combined));
}

/**
 * Bullpen fatigue multiplier. Applied to expected runs in late innings.
 * Returns factor > 1.0 when bullpen is tired (more runs expected).
 * TODO: integrate when bullpen data is available in request
 */
function bullpenFatigueFactor(bullpenData) {
  if (!bullpenData) return 1.0;
  const ipLast3Days = bullpenData.ipLast3Days || 0;
  const closerRested = bullpenData.closerAvailable !== false;
  let factor = 1.0;
  if (ipLast3Days > 11) factor += 0.08;
  else if (ipLast3Days > 9.5) factor += 0.04;
  if (!closerRested) factor += 0.05;
  return Math.min(factor, 1.20);
}

// ══════════════════════════════════════════════════════════════
// Monte Carlo Engine — Negative Binomial inning-by-inning
// NB allows variance > mean (MLB real: var ≈ 2× mean)
// 10,000 simulations per game
// ══════════════════════════════════════════════════════════════
const MC_SIMS = 10000;

// Log-gamma via Stirling approximation (accurate to ~1e-8 for x > 5)
function logGamma(x) {
  if (x <= 0) return 0;
  if (x < 7) {
    // Shift up to avoid inaccuracy for small x
    let shift = 0;
    let xx = x;
    while (xx < 7) { shift += Math.log(xx); xx += 1; }
    return logGamma(xx) - shift;
  }
  return (x - 0.5) * Math.log(x) - x + 0.9189385332046727
    + 1 / (12 * x) - 1 / (360 * x * x * x);
}

/**
 * Sample from Negative Binomial distribution using Gamma-Poisson mixture.
 * Mean = lambda, Variance = lambda * overdispersion.
 * For MLB runs: overdispersion ≈ 2.1 (variance ≈ 2.1× mean).
 */
function sampleNegBinom(lambda, overdispersion) {
  if (lambda <= 0.01) return 0;
  if (overdispersion <= 1.01) {
    // Fall back to Poisson
    let L = Math.exp(-lambda), k = 0, p = 1;
    do { k++; p *= Math.random(); } while (p > L);
    return k - 1;
  }
  // Gamma shape r = lambda / (overdispersion - 1)
  const r = lambda / (overdispersion - 1);
  // Sample from Gamma(r, 1) using Marsaglia-Tsang method
  const gamSample = sampleGamma(r);
  // Scale: Gamma(r, overdispersion-1)
  const rate = gamSample * (overdispersion - 1);
  // Sample from Poisson(rate)
  if (rate <= 0) return 0;
  let L = Math.exp(-Math.min(rate, 700)), k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L && k < 30);
  return k - 1;
}

// Marsaglia-Tsang Gamma sampler for shape >= 1
function sampleGamma(shape) {
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a+1) * U^(1/a)
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = normalRandom();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

// Box-Muller normal random
function normalRandom() {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Simulate a full MLB game inning-by-inning using Negative Binomial.
 *
 * Inning lambdas:
 *   1: λ × 0.85 (pitcher fresh, batters cold)
 *   2-5: λ × 1.0 (normal starter innings)
 *   6: λ × 0.95 (starter tiring or bullpen entry)
 *   7-9: λ × bullpenFactor (bullpen relief)
 *
 * Returns: { homeTotal, awayTotal, homeF5, awayF5, firstInningRuns }
 */
function simulateGame(homeLambda, awayLambda, overdispersion, bpFactorHome, bpFactorAway) {
  const INNING_MULTIPLIERS = [0.85, 1.0, 1.0, 1.0, 1.0, 0.95];
  // Per-inning lambda = game lambda / 9
  const hPerInning = homeLambda / 9;
  const aPerInning = awayLambda / 9;
  let homeTotal = 0, awayTotal = 0, homeF5 = 0, awayF5 = 0;

  for (let inn = 0; inn < 9; inn++) {
    let hMult, aMult;
    if (inn < 6) {
      hMult = INNING_MULTIPLIERS[inn];
      aMult = INNING_MULTIPLIERS[inn];
    } else {
      // Bullpen innings: opposing bullpen faces this team
      hMult = bpFactorAway;  // home team hits vs away bullpen
      aMult = bpFactorHome;  // away team hits vs home bullpen
    }
    const hRuns = sampleNegBinom(hPerInning * hMult, overdispersion);
    const aRuns = sampleNegBinom(aPerInning * aMult, overdispersion);
    homeTotal += hRuns;
    awayTotal += aRuns;
    if (inn < 5) { homeF5 += hRuns; awayF5 += aRuns; }
  }

  return {
    homeTotal, awayTotal,
    homeF5, awayF5,
    firstInningRuns: sampleNegBinom(hPerInning * 0.85, overdispersion)
                   + sampleNegBinom(aPerInning * 0.85, overdispersion),
  };
}

/**
 * Run N Monte Carlo simulations of a game.
 * Returns empirical probability distributions for all markets.
 */
function monteCarloSim(homeLambda, awayLambda, n = MC_SIMS) {
  const OD = 2.1; // overdispersion: MLB variance ≈ 2.1× mean
  const BP_HOME = 1.0; // TODO: use bullpenFatigueFactor when data available
  const BP_AWAY = 1.0;

  const totalCounts = new Array(30).fill(0);     // index = total runs
  const f5TotalCounts = new Array(20).fill(0);
  let homeWins = 0, awayWins = 0, ties = 0;
  let nrfiCount = 0;
  let f5HomeWins = 0;

  for (let i = 0; i < n; i++) {
    const g = simulateGame(homeLambda, awayLambda, OD, BP_HOME, BP_AWAY);
    const total = g.homeTotal + g.awayTotal;
    if (total < totalCounts.length) totalCounts[total]++;
    const f5Total = g.homeF5 + g.awayF5;
    if (f5Total < f5TotalCounts.length) f5TotalCounts[f5Total]++;
    if (g.homeTotal > g.awayTotal) homeWins++;
    else if (g.awayTotal > g.homeTotal) awayWins++;
    else ties++;
    if (g.firstInningRuns === 0) nrfiCount++;
    if (g.homeF5 > g.awayF5) f5HomeWins++;
  }

  // Over probabilities for common lines
  const overProbs = {};
  for (let line = 6; line <= 13; line += 0.5) {
    let over = 0;
    for (let t = Math.ceil(line + 0.01); t < totalCounts.length; t++) {
      over += totalCounts[t];
    }
    // If line is integer (e.g. 9), runs === line is a push, not over
    overProbs[`pOver${line}`] = Math.round((over / n) * 100);
  }

  // F5 over probs
  const f5OverProbs = {};
  for (let line = 3; line <= 8; line += 0.5) {
    let over = 0;
    for (let t = Math.ceil(line + 0.01); t < f5TotalCounts.length; t++) {
      over += f5TotalCounts[t];
    }
    f5OverProbs[`pF5Over${line}`] = Math.round((over / n) * 100);
  }

  return {
    overProbs,
    f5OverProbs,
    mcHomeWinPct: Math.round(((homeWins + ties * 0.5) / n) * 100),
    mcNrfiPct: Math.round((nrfiCount / n) * 100),
    mcF5HomeWinPct: Math.round((f5HomeWins / n) * 100),
    mcExpectedTotal: +(totalCounts.reduce((s, c, i) => s + c * i, 0) / n).toFixed(2),
  };
}

// ── MLB Poisson Model (Enhanced) ──
function calcMLBPoisson(hStats, aStats, marketTotal = null, pitchers = null, homeTeamName = null) {
  if (!hStats || !aStats) return null;

  const leagueAvg = MLB_LEAGUE.RUNS_PER_GAME;
  const homeAdv = MLB_LEAGUE.HOME_ADV;
  const hGames = parseInt(hStats.games) || 10;
  const aGames = parseInt(aStats.games) || 10;

  // Raw offensive/defensive ratings
  const rawHomeOff = parseFloat(hStats.runsPerGame || hStats.avgRuns || leagueAvg) / leagueAvg;
  const rawHomeDef = parseFloat(hStats.runsAgainstPerGame || hStats.avgRunsAgainst || leagueAvg) / leagueAvg;
  const rawAwayOff = parseFloat(aStats.runsPerGame || aStats.avgRuns || leagueAvg) / leagueAvg;
  const rawAwayDef = parseFloat(aStats.runsAgainstPerGame || aStats.avgRunsAgainst || leagueAvg) / leagueAvg;

  // Shrink toward league average based on sample size
  const shrunkHomeOff = shrunkRating(rawHomeOff, hGames, 1.0, SHRINKAGE_PRIORS.OFFENSE_IP / 4);
  const shrunkHomeDef = shrunkRating(rawHomeDef, hGames, 1.0, SHRINKAGE_PRIORS.DEFENSE_IP / 4);
  const shrunkAwayOff = shrunkRating(rawAwayOff, aGames, 1.0, SHRINKAGE_PRIORS.OFFENSE_IP / 4);
  const shrunkAwayDef = shrunkRating(rawAwayDef, aGames, 1.0, SHRINKAGE_PRIORS.DEFENSE_IP / 4);

  // Expose both raw and shrunk for downstream (backwards compat)
  const hOff = shrunkHomeOff;
  const hDef = shrunkHomeDef;
  const aOff = shrunkAwayOff;
  const aDef = shrunkAwayDef;

  const xRunsHomeRaw = leagueAvg * hOff * aDef * homeAdv;
  const xRunsAwayRaw = leagueAvg * aOff * hDef;

  // Pitcher quality adjustment (home pitcher suppresses away runs, vice versa)
  const homePQ = pitcherQuality(pitchers?.home?.stats);
  const awayPQ = pitcherQuality(pitchers?.away?.stats);
  let xRunsHome = xRunsHomeRaw * (0.5 + 0.5 * awayPQ);
  let xRunsAway = xRunsAwayRaw * (0.5 + 0.5 * homePQ);

  // Form adjustment
  const hWinRate = (hStats.wins || 0) / (hGames || 10);
  const aWinRate = (aStats.wins || 0) / (aGames || 10);
  xRunsHome *= (0.99 + 0.02 * hWinRate);
  xRunsAway *= (0.99 + 0.02 * aWinRate);

  // Cap lambda to realistic range
  xRunsHome = capLambda(xRunsHome);
  xRunsAway = capLambda(xRunsAway);

  let total = xRunsHome + xRunsAway;

  // Park factor adjustment (applied to total, preserving home/away ratio)
  const parkFactor = getParkFactor(homeTeamName);
  if (parkFactor !== 1.0) {
    const halfPF = 1 + (parkFactor - 1) * 0.5;
    const ratio = xRunsHome / total;
    total *= halfPF;
    xRunsHome = total * ratio;
    xRunsAway = total * (1 - ratio);
  }

  // Market anchor
  if (marketTotal && marketTotal > 5) {
    total = 0.3 * total + 0.7 * marketTotal;
    const ratio = xRunsHome / (xRunsHome + xRunsAway);
    xRunsHome = total * ratio;
    xRunsAway = total * (1 - ratio);
  }

  const spread = xRunsHome - xRunsAway;
  const stdDevSpread = 1.75;

  const zSpread = spread / stdDevSpread;
  const pHome = Math.min(80, Math.max(20, Math.round(normCDF(zSpread) * 100)));

  // ── Monte Carlo simulation (10K games, Negative Binomial, inning-by-inning) ──
  const mcStart = Date.now();
  const mc = monteCarloSim(xRunsHome, xRunsAway, MC_SIMS);
  const mcMs = Date.now() - mcStart;

  // Over probs from MC (replaces Normal CDF approximation)
  const overProbs = mc.overProbs;

  // F5 model — MC-derived
  const xRunsHomeF5 = +(xRunsHome * 0.55).toFixed(2);
  const xRunsAwayF5 = +(xRunsAway * 0.55).toFixed(2);
  const totalF5 = +(xRunsHomeF5 + xRunsAwayF5).toFixed(2);
  const spreadF5 = xRunsHomeF5 - xRunsAwayF5;
  const zSpreadF5 = spreadF5 / (stdDevSpread * 0.7);
  const pHomeF5 = Math.min(78, Math.max(22, mc.mcF5HomeWinPct || Math.round(normCDF(zSpreadF5) * 100)));

  // NRFI model — blend analytical + MC
  const homeNrfiPct = parseFloat(hStats.nrfiPct || 50);
  const awayNrfiPct = parseFloat(aStats.nrfiPct || 50);
  let nrfiBase = (homeNrfiPct + awayNrfiPct) / 200;
  const homeK9 = parseFloat(pitchers?.home?.stats?.k9 || 8);
  const awayK9 = parseFloat(pitchers?.away?.stats?.k9 || 8);
  const pitcherNrfiAdj = ((homeK9 / 9) + (awayK9 / 9)) / 2;
  const pitcherEraAdj = ((2 - homePQ) + (2 - awayPQ)) / 2;
  const analyticalNRFI = Math.min(0.78, Math.max(0.30, nrfiBase * 0.5 + pitcherNrfiAdj * 0.2 + pitcherEraAdj * 0.3));
  // Zero-inflation + MC blend: 40% analytical (with zero-inflation), 60% MC
  const ZERO_INFLATION_ADJUSTMENT = 0.08;
  const adjustedAnalytical = Math.min(analyticalNRFI + ZERO_INFLATION_ADJUSTMENT, 0.85);
  const mcNrfi = mc.mcNrfiPct / 100;
  const nrfiProb = Math.min(0.85, Math.max(0.25, adjustedAnalytical * 0.4 + mcNrfi * 0.6));
  const poissonNRFI = analyticalNRFI; // for logging

  // Save raw Poisson pHome before any market blend (applied in handler)
  const poissonPHome = pHome;

  console.log('[POISSON-V4] Calibrated calc:', {
    home_team_games: hGames,
    raw_home_off: +rawHomeOff.toFixed(3),
    shrunk_home_off: +shrunkHomeOff.toFixed(3),
    raw_away_off: +rawAwayOff.toFixed(3),
    shrunk_away_off: +shrunkAwayOff.toFixed(3),
    lambda_home_raw: +xRunsHomeRaw.toFixed(3),
    lambda_home_capped: +xRunsHome.toFixed(3),
    lambda_away_raw: +xRunsAwayRaw.toFixed(3),
    lambda_away_capped: +xRunsAway.toFixed(3),
    park_factor: parkFactor,
    home_pitcher_kbb: calcKBBRate(pitchers?.home) != null ? +(calcKBBRate(pitchers.home) * 100).toFixed(1) + '%' : 'N/A',
    away_pitcher_kbb: calcKBBRate(pitchers?.away) != null ? +(calcKBBRate(pitchers.away) * 100).toFixed(1) + '%' : 'N/A',
    home_pq: +homePQ.toFixed(3),
    away_pq: +awayPQ.toFixed(3),
    poisson_pHome: +poissonPHome.toFixed(1),
    mc_sims: MC_SIMS,
    mc_time_ms: mcMs,
    mc_expected_total: mc.mcExpectedTotal,
    mc_nrfi_pct: mc.mcNrfiPct,
    final_nrfi: +(nrfiProb * 100).toFixed(1),
    analytical_nrfi: +(poissonNRFI * 100).toFixed(1),
  });

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
    poissonPHome, // raw Poisson pHome before market blend
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

  // Log picks with excessive edge (likely model error, not real opportunity)
  const excessiveEdges = sorted.filter(p => (p.edge_percent || 0) > 15);
  if (excessiveEdges.length > 0) {
    console.log('[PICKS] Discarded picks with excessive edge (likely model error):',
      JSON.stringify(excessiveEdges.map(p => ({
        market: p.tipo,
        selection: p.pick,
        edge: p.edge_percent,
        ev: p.ev_percent
      })))
    );
  }

  // Filter: only EV+ picks with meaningful edge, cap at 15% (above = model error)
  const filtered = sorted.filter(p => {
    if (p.ev_percent == null || p.edge_percent == null) return false;
    return p.ev_percent >= 2 && p.edge_percent >= 3 && p.edge_percent <= 15;
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
    const poisson = calcMLBPoisson(homeStats, awayStats, parsedOdds?.marketTotal, pitchers, homeTeam);
    if (!poisson) return res.status(500).json({ error: "Error calculando modelo MLB" });

    // Market prior blend for moneyline ONLY (totals/NRFI markets are less efficient)
    if (parsedOdds?.mlOutcomes?.length >= 2) {
      const homePrice = parsedOdds.mlOutcomes[0]?.price;
      const awayPrice = parsedOdds.mlOutcomes[1]?.price;
      if (homePrice && awayPrice) {
        const homeDec = homePrice > 0 ? (homePrice / 100 + 1) : (100 / Math.abs(homePrice) + 1);
        const awayDec = awayPrice > 0 ? (awayPrice / 100 + 1) : (100 / Math.abs(awayPrice) + 1);
        const blended = marketPriorBlend(
          poisson.poissonPHome / 100,
          homeDec,
          awayDec,
          MARKET_PRIOR_WEIGHTS.moneyline
        );
        poisson.pHome = Math.min(80, Math.max(20, Math.round(blended * 100)));
        poisson.pAway = 100 - poisson.pHome;
        console.log('[POISSON-V4] Market blend:', {
          poissonPHome: poisson.poissonPHome,
          marketHomeDec: +homeDec.toFixed(3),
          marketAwayDec: +awayDec.toFixed(3),
          blendedPHome: poisson.pHome,
        });
      }
    }

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
            model_version: '4.0-fase3',
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
      _model: 'mlb-poisson-montecarlo',
      _version: '4.0-fase3',
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
