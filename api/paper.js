// api/paper.js — Paper Trading: resolve cron + stats dashboard
// Merged from cron-resolve.js + paper-stats.js to stay within Vercel 12-function limit
//
// Routes:
//   GET  /api/paper → CLV dashboard (public, CORS)
//   POST /api/paper → Capture closing odds, resolve games, compute CLV (auth required)
//
// Vercel Cron: runs once daily at 12:00 UTC (fallback)
// Primary hourly trigger via external service (cron-job.org)

import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

const MLB_BASE = "https://statsapi.mlb.com/api/v1";
const OWLS_BASE = "https://api.owlsinsight.com/api/v1";
const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'https://betanalyticsIA.com';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return handleStats(req, res);
  }

  if (req.method === "POST") {
    return handleResolve(req, res);
  }

  return res.status(405).json({ error: "Method Not Allowed. GET=stats, POST=resolve" });
}

// ══════════════════════════════════════════════════════════════
// ACTION: resolve — Capture closing odds, resolve games, CLV
// ══════════════════════════════════════════════════════════════

async function handleResolve(req, res) {
  // Auth: fail-closed
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: "CRON_SECRET not configured" });
  }
  if (authHeader !== `Bearer ${cronSecret}` && req.query.secret !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sb = getSupabase();
  if (!sb) return res.status(500).json({ error: "Supabase not configured" });

  const results = { closing_odds: 0, resolved: 0, clv_computed: 0, errors: [] };

  try {
    await captureClosingOdds(sb, results);
    await resolveFinishedGames(sb, results);
    await computeCLV(sb, results);
  } catch (e) {
    results.errors.push(e.message);
  }

  console.log("Paper resolve results:", JSON.stringify(results));
  return res.status(200).json(results);
}

// ══════════════════════════════════════════════════════════════
// ACTION: stats — CLV dashboard
// ══════════════════════════════════════════════════════════════

async function handleStats(req, res) {
  const sb = getSupabase();
  if (!sb) return res.status(500).json({ error: "Supabase not configured" });

  try {
    const { data: trades, error } = await sb
      .from("paper_trades")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1000);

    if (error) return res.status(500).json({ error: error.message });
    if (!trades?.length) return res.status(200).json({ empty: true, message: "No paper trades yet" });

    const resolved = trades.filter(t => t.status === "won" || t.status === "lost");
    const won = resolved.filter(t => t.status === "won");
    const withCLV = trades.filter(t => t.clv_cents != null);
    const last100CLV = withCLV.slice(0, 100);

    // ── Overall stats ──
    const overall = {
      total_picks: trades.length,
      resolved: resolved.length,
      pending: trades.filter(t => t.status === "pending").length,
      won: won.length,
      lost: resolved.length - won.length,
      win_rate: resolved.length > 0 ? +(won.length / resolved.length * 100).toFixed(1) : null,
      total_profit: +resolved.reduce((s, t) => s + (t.profit || 0), 0).toFixed(2),
      roi_pct: resolved.length > 0
        ? +(resolved.reduce((s, t) => s + (t.profit || 0), 0) / (resolved.length * 100) * 100).toFixed(1)
        : null,
      avg_ev_percent: +(trades.reduce((s, t) => s + (t.ev_percent || 0), 0) / trades.length).toFixed(2),
      avg_edge_percent: +(trades.reduce((s, t) => s + (t.edge_percent || 0), 0) / trades.length).toFixed(2),
    };

    // ── CLV stats (THE KEY METRIC) ──
    const clv = {
      measured: withCLV.length,
      avg_clv_cents: withCLV.length > 0
        ? +(withCLV.reduce((s, t) => s + t.clv_cents, 0) / withCLV.length).toFixed(2)
        : null,
      positive_clv_pct: withCLV.length > 0
        ? +(withCLV.filter(t => t.clv_cents > 0).length / withCLV.length * 100).toFixed(1)
        : null,
      last_100_avg: last100CLV.length > 0
        ? +(last100CLV.reduce((s, t) => s + t.clv_cents, 0) / last100CLV.length).toFixed(2)
        : null,
      last_100_positive_pct: last100CLV.length > 0
        ? +(last100CLV.filter(t => t.clv_cents > 0).length / last100CLV.length * 100).toFixed(1)
        : null,
      distribution: {
        "strongly_positive (>3)": withCLV.filter(t => t.clv_cents > 3).length,
        "positive (1-3)": withCLV.filter(t => t.clv_cents > 1 && t.clv_cents <= 3).length,
        "slightly_positive (0-1)": withCLV.filter(t => t.clv_cents > 0 && t.clv_cents <= 1).length,
        "slightly_negative (-1-0)": withCLV.filter(t => t.clv_cents >= -1 && t.clv_cents <= 0).length,
        "negative (<-1)": withCLV.filter(t => t.clv_cents < -1).length,
      },
    };

    // ── Verdict ──
    let verdict = "NOT_ENOUGH_DATA";
    let verdictMsg = "Need 100+ picks with CLV measured to make a decision.";
    if (last100CLV.length >= 100) {
      const avgCLV = clv.last_100_avg;
      const posPct = clv.last_100_positive_pct;
      if (avgCLV >= 1.5 && posPct >= 52) {
        verdict = "GO";
        verdictMsg = `CLV avg ${avgCLV} cents, ${posPct}% positive. Model is beating closing lines. Ready for AWS.`;
      } else if (avgCLV >= 0.5) {
        verdict = "PROMISING";
        verdictMsg = `CLV avg ${avgCLV} cents. Positive but needs more data or model tuning.`;
      } else {
        verdict = "IMPROVE_MODEL";
        verdictMsg = `CLV avg ${avgCLV} cents. Model is NOT consistently beating closing lines. Fix models before scaling.`;
      }
    }

    // ── By market ──
    const byMarket = {};
    const marketGroups = {};
    for (const t of trades) {
      const m = t.market || "unknown";
      if (!marketGroups[m]) marketGroups[m] = [];
      marketGroups[m].push(t);
    }
    for (const [market, picks] of Object.entries(marketGroups)) {
      const mResolved = picks.filter(t => t.status === "won" || t.status === "lost");
      const mWon = mResolved.filter(t => t.status === "won");
      const mCLV = picks.filter(t => t.clv_cents != null);
      byMarket[market] = {
        total: picks.length,
        won: mWon.length,
        lost: mResolved.length - mWon.length,
        win_rate: mResolved.length > 0 ? +(mWon.length / mResolved.length * 100).toFixed(1) : null,
        profit: +mResolved.reduce((s, t) => s + (t.profit || 0), 0).toFixed(2),
        avg_ev: +(picks.reduce((s, t) => s + (t.ev_percent || 0), 0) / picks.length).toFixed(2),
        avg_clv: mCLV.length > 0 ? +(mCLV.reduce((s, t) => s + t.clv_cents, 0) / mCLV.length).toFixed(2) : null,
      };
    }

    // ── By edge band ──
    const byEdge = {
      "high (>8%)": statsForBand(resolved, t => (t.edge_percent || 0) > 8),
      "medium (4-8%)": statsForBand(resolved, t => (t.edge_percent || 0) > 4 && (t.edge_percent || 0) <= 8),
      "low (2-4%)": statsForBand(resolved, t => (t.edge_percent || 0) > 2 && (t.edge_percent || 0) <= 4),
      "negative (<2%)": statsForBand(resolved, t => (t.edge_percent || 0) <= 2),
    };

    // ── Recent picks (last 20) ──
    const recent = trades.slice(0, 20).map(t => ({
      id: t.id,
      created: t.created_at,
      game: `${t.away_team} @ ${t.home_team}`,
      market: t.market,
      selection: t.selection,
      odds: t.odds_at_pick,
      ev_pct: t.ev_percent,
      edge_pct: t.edge_percent,
      clv: t.clv_cents,
      status: t.status,
      profit: t.profit,
    }));

    return res.status(200).json({
      overall, clv, verdict, verdictMsg, byMarket, byEdge, recent,
      _generated: new Date().toISOString(),
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

function statsForBand(resolved, filterFn) {
  const picks = resolved.filter(filterFn);
  const won = picks.filter(t => t.status === "won");
  return {
    count: picks.length,
    won: won.length,
    win_rate: picks.length > 0 ? +(won.length / picks.length * 100).toFixed(1) : null,
    profit: +picks.reduce((s, t) => s + (t.profit || 0), 0).toFixed(2),
  };
}

// ══════════════════════════════════════════════════════════════
// Resolve internals: capture closing odds
// ══════════════════════════════════════════════════════════════

async function captureClosingOdds(sb, results) {
  const { data: pending, error } = await sb
    .from("paper_trades")
    .select("id, game_id, home_team, away_team, market, selection, odds_at_pick, odds_decimal")
    .eq("status", "pending")
    .is("odds_at_close", null)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error || !pending?.length) return;

  const OWLS_KEY = process.env.OWLS_INSIGHT_API_KEY;
  if (!OWLS_KEY) return;

  let oddsData = [];
  try {
    const r = await fetch(`${OWLS_BASE}/mlb/odds`, {
      headers: { "Authorization": `Bearer ${OWLS_KEY}`, "Accept": "application/json" },
    });
    const json = await r.json();
    oddsData = json.data || json || [];
  } catch (e) {
    results.errors.push("Failed to fetch closing odds: " + e.message);
    return;
  }

  if (!Array.isArray(oddsData) || oddsData.length === 0) return;

  const now = new Date();
  for (const pick of pending) {
    try {
      const game = findMatchingGame(oddsData, pick.home_team, pick.away_team);
      if (!game) continue;

      // Only capture closing odds if the game has NOT started yet
      const startStr = game.commence_time || game.commenceTime || game.start_time || pick.game_date;
      if (startStr) {
        const gameStart = new Date(startStr);
        const minutesUntilStart = (gameStart - now) / 1000 / 60;
        if (minutesUntilStart < 5) {
          continue; // game already started or about to — skip, odds are stale/gone
        }
      }

      const closeOdds = extractOddsForPick(game, pick);
      if (!closeOdds) continue;

      const closeDec = closeOdds.decimal;
      const closeImp = closeDec > 1 ? 1 / closeDec : null;
      const closeAm = closeDec >= 2
        ? `+${Math.round((closeDec - 1) * 100)}`
        : `-${Math.round(100 / (closeDec - 1))}`;

      await sb.from("paper_trades").update({
        odds_at_close: closeAm,
        close_decimal: +closeDec.toFixed(4),
        close_implied: closeImp ? +closeImp.toFixed(4) : null,
        close_captured_at: new Date().toISOString(),
      }).eq("id", pick.id);

      results.closing_odds++;
    } catch (e) {
      results.errors.push(`Close odds error for ${pick.id}: ${e.message}`);
    }
  }
}

function findMatchingGame(oddsData, homeTeam, awayTeam) {
  const norm = s => (s || "").toLowerCase().replace(/[^a-z]/g, "");
  const hn = norm(homeTeam);
  const an = norm(awayTeam);

  return oddsData.find(game => {
    const teams = [
      norm(game.home_team || game.homeTeam || ""),
      norm(game.away_team || game.awayTeam || ""),
    ];
    return (teams[0].includes(hn) || hn.includes(teams[0]) || teams[1].includes(an) || an.includes(teams[1]))
      && (teams[0].includes(hn) || teams[1].includes(an));
  });
}

function extractOddsForPick(game, pick) {
  const bookmakers = game.bookmakers || game.books || [];
  if (!bookmakers.length) return null;

  const pinnacle = bookmakers.find(b => (b.key || b.name || "").toLowerCase().includes("pinnacle"));
  const book = pinnacle || bookmakers[0];
  const markets = book.markets || [];

  const market = pick.market?.toLowerCase() || "";
  const selection = pick.selection?.toLowerCase() || "";

  if (market.includes("moneyline") || market === "f5 moneyline" || market === "f5 ml") {
    const ml = markets.find(m => m.key === "h2h" || m.key === "moneyline");
    if (!ml) return null;
    const outcomes = ml.outcomes || [];
    const norm = s => (s || "").toLowerCase().replace(/[^a-z]/g, "");
    const outcome = outcomes.find(o => {
      const on = norm(o.name);
      return selection.split(" ").some(word => word.length > 3 && on.includes(norm(word)));
    });
    if (outcome?.price) return { decimal: parsePrice(outcome.price) };
  }

  if (market.includes("total") || market.includes("f5 total")) {
    const tot = markets.find(m => m.key === "totals" || m.key === "total");
    if (!tot) return null;
    const outcomes = tot.outcomes || [];
    const isOver = selection.includes("over");
    const outcome = outcomes.find(o => isOver ? o.name === "Over" : o.name === "Under");
    if (outcome?.price) return { decimal: parsePrice(outcome.price) };
  }

  if (market.includes("run line") || market.includes("alt run")) {
    const sp = markets.find(m => m.key === "spreads" || m.key === "spread");
    if (!sp) return null;
    const outcomes = sp.outcomes || [];
    const norm = s => (s || "").toLowerCase().replace(/[^a-z]/g, "");
    const outcome = outcomes.find(o =>
      selection.split(" ").some(word => word.length > 3 && norm(o.name).includes(norm(word)))
    );
    if (outcome?.price) return { decimal: parsePrice(outcome.price) };
  }

  if (market.includes("nrfi") || market.includes("yrfi") || market.includes("1st inning")) {
    if (pick.odds_decimal) return { decimal: pick.odds_decimal };
  }

  return null;
}

function parsePrice(price) {
  if (typeof price === "number") {
    if (Math.abs(price) > 10) {
      return price > 0 ? (price / 100 + 1) : (100 / Math.abs(price) + 1);
    }
    return price;
  }
  const p = parseFloat(price);
  if (isNaN(p)) return null;
  if (Math.abs(p) > 10) {
    return p > 0 ? (p / 100 + 1) : (100 / Math.abs(p) + 1);
  }
  return p;
}

// ══════════════════════════════════════════════════════════════
// Resolve internals: resolve finished games
// ══════════════════════════════════════════════════════════════

async function resolveFinishedGames(sb, results) {
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const { data: pending, error } = await sb
    .from("paper_trades")
    .select("*")
    .eq("status", "pending")
    .lt("created_at", threeHoursAgo)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error || !pending?.length) return;

  const byDate = {};
  for (const pick of pending) {
    const d = pick.game_date || "unknown";
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(pick);
  }

  for (const [date, picks] of Object.entries(byDate)) {
    if (date === "unknown") continue;

    let games = [];
    try {
      const r = await fetch(
        `${MLB_BASE}/schedule?sportId=1&date=${date}&hydrate=linescore`,
        { headers: { "Accept": "application/json", "User-Agent": "BetAnalyticsIA/1.0" } }
      );
      const data = await r.json();
      games = data.dates?.[0]?.games || [];
    } catch (e) {
      results.errors.push(`MLB schedule fetch error for ${date}: ${e.message}`);
      continue;
    }

    for (const pick of picks) {
      try {
        const game = findMLBGame(games, pick.home_team, pick.away_team);
        if (!game) continue;

        const gameState = game.status?.abstractGameState;
        if (gameState !== "Final") continue;

        const homeScore = game.teams?.home?.score ?? 0;
        const awayScore = game.teams?.away?.score ?? 0;
        const totalRuns = homeScore + awayScore;

        const innings = game.linescore?.innings || [];
        const firstInning = innings[0] || {};
        const firstInningRuns = (firstInning.home?.runs || 0) + (firstInning.away?.runs || 0);

        let homeF5 = 0, awayF5 = 0;
        for (let i = 0; i < Math.min(5, innings.length); i++) {
          homeF5 += innings[i]?.home?.runs || 0;
          awayF5 += innings[i]?.away?.runs || 0;
        }

        const result = evaluatePick(pick, homeScore, awayScore, totalRuns, firstInningRuns, homeF5, awayF5);
        if (result === null) continue;

        const decOdds = pick.odds_decimal || 1.91;
        const pickStatus = result === "push" ? "push" : (result ? "won" : "lost");
        const profit = result === "push" ? 0 : (result ? +((decOdds - 1) * 100).toFixed(2) : -100);

        await sb.from("paper_trades").update({
          status: pickStatus,
          actual_home_score: homeScore,
          actual_away_score: awayScore,
          profit,
          resolved_at: new Date().toISOString(),
        }).eq("id", pick.id);

        results.resolved++;
      } catch (e) {
        results.errors.push(`Resolve error ${pick.id}: ${e.message}`);
      }
    }
  }
}

function findMLBGame(games, homeTeam, awayTeam) {
  const norm = s => (s || "").toLowerCase().replace(/[^a-z]/g, "");
  const hn = norm(homeTeam);
  const an = norm(awayTeam);

  return games.find(g => {
    const gh = norm(g.teams?.home?.team?.name || "");
    const ga = norm(g.teams?.away?.team?.name || "");
    const homeMatch = hn.includes(gh.slice(-6)) || gh.includes(hn.slice(-6));
    const awayMatch = an.includes(ga.slice(-6)) || ga.includes(an.slice(-6));
    return homeMatch && awayMatch;
  });
}

function evaluatePick(pick, homeScore, awayScore, totalRuns, firstInningRuns, homeF5, awayF5) {
  const market = (pick.market || "").toLowerCase();
  const sel = (pick.selection || "").toLowerCase();
  const homeN = (pick.home_team || "").toLowerCase();

  if (market === "moneyline") {
    const pickedHome = sel.includes(homeN.split(" ").pop()) || sel.includes(homeN.split(" ")[0]);
    if (pickedHome) return homeScore > awayScore;
    return awayScore > homeScore;
  }

  // Total (Over/Under) — returns true/false/"push"
  if (market === "total" || market === "f5 total") {
    const lineMatch = sel.match(/([\d.]+)/);
    const line = lineMatch ? parseFloat(lineMatch[1]) : null;
    if (!line) return null;
    const relevantTotal = market === "f5 total" ? (homeF5 + awayF5) : totalRuns;
    if (relevantTotal === line) return "push";
    if (sel.includes("over")) return relevantTotal > line;
    if (sel.includes("under")) return relevantTotal < line;
    return null;
  }

  // Run Line — returns true/false/"push"
  if (market.includes("run line") || market.includes("alt run")) {
    const spread = homeScore - awayScore;
    const lineMatch = sel.match(/([+-]?[\d.]+)/);
    const line = lineMatch ? parseFloat(lineMatch[1]) : null;
    if (line === null) return null;
    const pickedHome = sel.includes(homeN.split(" ").pop()) || sel.includes(homeN.split(" ")[0]);
    const margin = pickedHome ? (spread + line) : (-spread + line);
    if (margin === 0) return "push";
    return margin > 0;
  }

  if (market === "nrfi" || (market === "1st inning total" && sel.includes("under"))) {
    return firstInningRuns === 0;
  }
  if (market === "yrfi" || (market === "1st inning total" && sel.includes("over"))) {
    return firstInningRuns > 0;
  }

  if (market === "f5 moneyline" || market === "f5 ml") {
    const pickedHome = sel.includes(homeN.split(" ").pop()) || sel.includes(homeN.split(" ")[0]);
    if (pickedHome) return homeF5 > awayF5;
    return awayF5 > homeF5;
  }

  // Team Total — returns true/false/"push"
  if (market === "team total") {
    const lineMatch = sel.match(/([\d.]+)/);
    const line = lineMatch ? parseFloat(lineMatch[1]) : null;
    if (!line) return null;
    const pickedHome = sel.includes(homeN.split(" ").pop()) || sel.includes(homeN.split(" ")[0]);
    const teamScore = pickedHome ? homeScore : awayScore;
    if (teamScore === line) return "push";
    if (sel.includes("over")) return teamScore > line;
    if (sel.includes("under")) return teamScore < line;
    return null;
  }

  if (market.includes("strikeout") || market.includes("fade")) {
    return null;
  }

  return null;
}

// ══════════════════════════════════════════════════════════════
// Resolve internals: compute CLV
// ══════════════════════════════════════════════════════════════

async function computeCLV(sb, results) {
  const { data: picks, error } = await sb
    .from("paper_trades")
    .select("id, odds_decimal, close_decimal, implied_prob, close_implied")
    .not("close_decimal", "is", null)
    .is("clv_cents", null)
    .limit(200);

  if (error || !picks?.length) return;

  for (const pick of picks) {
    if (!pick.close_decimal || !pick.implied_prob || !pick.close_implied) continue;

    const clvCents = +((pick.close_implied - pick.implied_prob) * 100).toFixed(2);
    const clvPercent = pick.close_decimal > 0
      ? +((pick.odds_decimal / pick.close_decimal - 1) * 100).toFixed(2)
      : 0;

    await sb.from("paper_trades").update({
      clv_cents: clvCents,
      clv_percent: clvPercent,
    }).eq("id", pick.id);

    results.clv_computed++;
  }
}
