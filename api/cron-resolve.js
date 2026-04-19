// api/cron-resolve.js — Paper Trading Cron
// Runs on schedule to:
//   1. Capture closing odds for today's games (before they start)
//   2. Resolve finished games (won/lost)
//   3. Compute CLV
//
// Vercel Cron: runs every hour
// Can also be called manually: GET /api/cron-resolve?secret=xxx

import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

const MLB_BASE = "https://statsapi.mlb.com/api/v1";
const OWLS_BASE = "https://api.owlsinsight.com/api/v1";

export default async function handler(req, res) {
  // Verify cron secret (fail-closed: block if not configured)
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
    // ── Step 1: Capture closing odds for pending picks ──
    await captureClosingOdds(sb, results);

    // ── Step 2: Resolve finished games ──
    await resolveFinishedGames(sb, results);

    // ── Step 3: Compute CLV for picks that have closing odds ──
    await computeCLV(sb, results);

  } catch (e) {
    results.errors.push(e.message);
  }

  console.log("Cron results:", JSON.stringify(results));
  return res.status(200).json(results);
}

// ══════════════════════════════════════════════
// Step 1: Capture closing odds
// ══════════════════════════════════════════════

async function captureClosingOdds(sb, results) {
  // Get pending picks that don't have closing odds yet
  const { data: pending, error } = await sb
    .from("paper_trades")
    .select("id, game_id, home_team, away_team, market, selection, odds_at_pick, odds_decimal")
    .eq("status", "pending")
    .is("odds_at_close", null)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error || !pending?.length) return;

  // Fetch current MLB odds from Owls Insight
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

  // Group pending picks by game teams
  const now = new Date();
  for (const pick of pending) {
    try {
      // Find matching game in odds data
      const game = findMatchingGame(oddsData, pick.home_team, pick.away_team);
      if (!game) continue;

      // Only capture closing odds if the game has NOT started yet
      // Use commence_time from odds API, fall back to game_date
      const startStr = game.commence_time || game.commenceTime || game.start_time || pick.game_date;
      if (startStr) {
        const gameStart = new Date(startStr);
        const minutesUntilStart = (gameStart - now) / 1000 / 60;
        if (minutesUntilStart < 5) {
          continue; // game already started or about to — skip, odds are stale/gone
        }
      }

      // Extract the relevant odds for this pick's market
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
    // Flexible matching — check if team name fragments match
    return (teams[0].includes(hn) || hn.includes(teams[0]) || teams[1].includes(an) || an.includes(teams[1]))
      && (teams[0].includes(hn) || teams[1].includes(an));
  });
}

function extractOddsForPick(game, pick) {
  const bookmakers = game.bookmakers || game.books || [];
  if (!bookmakers.length) return null;

  // Use first available book (or Pinnacle if available)
  const pinnacle = bookmakers.find(b => (b.key || b.name || "").toLowerCase().includes("pinnacle"));
  const book = pinnacle || bookmakers[0];
  const markets = book.markets || [];

  const market = pick.market?.toLowerCase() || "";
  const selection = pick.selection?.toLowerCase() || "";

  // Moneyline
  if (market.includes("moneyline") || market === "f5 moneyline" || market === "f5 ml") {
    const ml = markets.find(m => m.key === "h2h" || m.key === "moneyline");
    if (!ml) return null;
    const outcomes = ml.outcomes || [];
    // Match by team name
    const norm = s => (s || "").toLowerCase().replace(/[^a-z]/g, "");
    const outcome = outcomes.find(o => {
      const on = norm(o.name);
      return selection.split(" ").some(word => word.length > 3 && on.includes(norm(word)));
    });
    if (outcome?.price) {
      return { decimal: parsePrice(outcome.price) };
    }
  }

  // Total
  if (market.includes("total") || market.includes("f5 total")) {
    const tot = markets.find(m => m.key === "totals" || m.key === "total");
    if (!tot) return null;
    const outcomes = tot.outcomes || [];
    const isOver = selection.includes("over");
    const outcome = outcomes.find(o => isOver ? o.name === "Over" : o.name === "Under");
    if (outcome?.price) {
      return { decimal: parsePrice(outcome.price) };
    }
  }

  // Run Line / Spread
  if (market.includes("run line") || market.includes("alt run")) {
    const sp = markets.find(m => m.key === "spreads" || m.key === "spread");
    if (!sp) return null;
    const outcomes = sp.outcomes || [];
    const norm = s => (s || "").toLowerCase().replace(/[^a-z]/g, "");
    const outcome = outcomes.find(o =>
      selection.split(" ").some(word => word.length > 3 && norm(o.name).includes(norm(word)))
    );
    if (outcome?.price) {
      return { decimal: parsePrice(outcome.price) };
    }
  }

  // NRFI/YRFI — typically not in standard odds, use the pick odds as close
  if (market.includes("nrfi") || market.includes("yrfi") || market.includes("1st inning")) {
    if (pick.odds_decimal) return { decimal: pick.odds_decimal };
  }

  return null;
}

function parsePrice(price) {
  if (typeof price === "number") {
    // If it looks like American odds
    if (Math.abs(price) > 10) {
      return price > 0 ? (price / 100 + 1) : (100 / Math.abs(price) + 1);
    }
    return price; // already decimal
  }
  const p = parseFloat(price);
  if (isNaN(p)) return null;
  if (Math.abs(p) > 10) {
    return p > 0 ? (p / 100 + 1) : (100 / Math.abs(p) + 1);
  }
  return p;
}

// ══════════════════════════════════════════════
// Step 2: Resolve finished games
// ══════════════════════════════════════════════

async function resolveFinishedGames(sb, results) {
  // Get pending picks older than 3 hours (game should be done)
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const { data: pending, error } = await sb
    .from("paper_trades")
    .select("*")
    .eq("status", "pending")
    .lt("created_at", threeHoursAgo)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error || !pending?.length) return;

  // Group by game_date to batch MLB API calls
  const byDate = {};
  for (const pick of pending) {
    const d = pick.game_date || "unknown";
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(pick);
  }

  for (const [date, picks] of Object.entries(byDate)) {
    if (date === "unknown") continue;

    // Fetch MLB schedule with scores
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

        // Check if game is final
        const status = game.status?.abstractGameState;
        if (status !== "Final") continue;

        const homeScore = game.teams?.home?.score ?? 0;
        const awayScore = game.teams?.away?.score ?? 0;
        const totalRuns = homeScore + awayScore;

        // Get first inning runs from linescore
        const innings = game.linescore?.innings || [];
        const firstInning = innings[0] || {};
        const firstInningRuns = (firstInning.home?.runs || 0) + (firstInning.away?.runs || 0);

        // F5 score (first 5 innings)
        let homeF5 = 0, awayF5 = 0;
        for (let i = 0; i < Math.min(5, innings.length); i++) {
          homeF5 += innings[i]?.home?.runs || 0;
          awayF5 += innings[i]?.away?.runs || 0;
        }

        const result = evaluatePick(pick, homeScore, awayScore, totalRuns, firstInningRuns, homeF5, awayF5);
        if (result === null) continue; // can't evaluate

        // Compute profit ($100 flat bet) — push = $0
        const decOdds = pick.odds_decimal || 1.91; // default -110
        const status = result === "push" ? "push" : (result ? "won" : "lost");
        const profit = result === "push" ? 0 : (result ? +((decOdds - 1) * 100).toFixed(2) : -100);

        await sb.from("paper_trades").update({
          status,
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
    // Match by checking if the key words overlap
    const homeMatch = hn.includes(gh.slice(-6)) || gh.includes(hn.slice(-6));
    const awayMatch = an.includes(ga.slice(-6)) || ga.includes(an.slice(-6));
    return homeMatch && awayMatch;
  });
}

function evaluatePick(pick, homeScore, awayScore, totalRuns, firstInningRuns, homeF5, awayF5) {
  const market = (pick.market || "").toLowerCase();
  const sel = (pick.selection || "").toLowerCase();
  const homeN = (pick.home_team || "").toLowerCase();

  // Moneyline
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

  // NRFI / YRFI
  if (market === "nrfi" || (market === "1st inning total" && sel.includes("under"))) {
    return firstInningRuns === 0;
  }
  if (market === "yrfi" || (market === "1st inning total" && sel.includes("over"))) {
    return firstInningRuns > 0;
  }

  // F5 Moneyline
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

  // Pitcher Strikeouts — can't resolve without detailed data, skip
  if (market.includes("strikeout") || market.includes("fade")) {
    return null;
  }

  return null;
}

// ══════════════════════════════════════════════
// Step 3: Compute CLV
// ══════════════════════════════════════════════

async function computeCLV(sb, results) {
  // Get picks that have closing odds but no CLV computed yet
  const { data: picks, error } = await sb
    .from("paper_trades")
    .select("id, odds_decimal, close_decimal, implied_prob, close_implied")
    .not("close_decimal", "is", null)
    .is("clv_cents", null)
    .limit(200);

  if (error || !picks?.length) return;

  for (const pick of picks) {
    if (!pick.close_decimal || !pick.implied_prob || !pick.close_implied) continue;

    // CLV cents = (close_implied - pick_implied) × 100
    // Positive = you got a better price than the closing line
    const clvCents = +((pick.close_implied - pick.implied_prob) * 100).toFixed(2);

    // CLV percent = (pick_decimal / close_decimal - 1) × 100
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
