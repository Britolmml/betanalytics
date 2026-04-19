import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = SUPABASE_URL && SUPABASE_ANON
  ? createClient(SUPABASE_URL, SUPABASE_ANON)
  : null;

// ─── GUARDAR TODAS LAS PICKS DE UN ANÁLISIS ────────────────

export async function saveAllPicks(userId, matchData, picks, sport = "football") {
  if (!supabase || !picks?.length) return;
  const rows = picks.map(pick => ({
    user_id: userId,
    sport,
    league: matchData.league,
    home_team: matchData.homeTeam,
    away_team: matchData.awayTeam,
    fixture_id: matchData.fixtureId || null,
    game_date: matchData.gameDate || null,
    game_id: matchData.gameId || null,
    predicted_score: matchData.score || null,
    pick: pick.pick,
    pick_type: pick.tipo || pick.type || "general",
    odds: pick.odds_sugerido || pick.odds || null,
    confidence: pick.confianza || pick.confidence || null,
    result: "pending",
    analysis: matchData.analysis || null,
    parlay: false,
  }));
  return supabase.from("predictions").insert(rows);
}

// ─── FÚTBOL (legacy — mantener compatibilidad) ─────────────

export async function savePrediction(userId, data) {
  if (!supabase) return { error: "Supabase no configurado" };
  return supabase.from("predictions").insert({
    user_id: userId,
    league: data.league,
    home_team: data.homeTeam,
    away_team: data.awayTeam,
    predicted_score: data.score,
    pick: data.pick,
    pick_type: data.pickType || "general",
    odds: data.odds,
    confidence: data.confidence,
    analysis: data.analysis,
    parlay: data.parlay || false,
    sport: "football",
    fixture_id: data.fixtureId || null,
    game_date: data.gameDate || null,
  });
}

export async function getPredictions(userId) {
  if (!supabase) return { data: [], error: "Supabase no configurado" };
  return supabase
    .from("predictions")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);
}

export async function updateResult(id, result) {
  if (!supabase) return { error: "Supabase no configurado" };
  return supabase.from("predictions").update({ result }).eq("id", id);
}

export async function updateResultBulk(ids, result) {
  if (!supabase || !ids?.length) return;
  return supabase.from("predictions").update({ result }).in("id", ids);
}

// ─── NBA ────────────────────────────────────────────────────

export async function saveNBAPrediction(userId, data) {
  if (!supabase) return { error: "Supabase no configurado" };
  // Save all picks if provided, else save single
  if (data.allPicks?.length) {
    return saveAllPicks(userId, {
      league: "NBA",
      homeTeam: data.homeTeam,
      awayTeam: data.awayTeam,
      gameDate: data.gameDate,
      gameId: data.gameId,
      score: data.predictedScore,
      analysis: data.analysis,
    }, data.allPicks, "nba");
  }
  return supabase.from("predictions").insert({
    user_id: userId,
    sport: "nba",
    league: "NBA",
    home_team: data.homeTeam,
    away_team: data.awayTeam,
    predicted_score: data.predictedScore || null,
    pick: data.pick,
    pick_type: data.pickType || "general",
    odds: data.odds || null,
    confidence: data.confidence,
    analysis: data.analysis,
    parlay: false,
    result: "pending",
    game_date: data.gameDate || null,
    game_id: data.gameId || null,
  });
}

// ─── OBTENER PREDICCIONES ──────────────────────────────────

export async function getAllPredictions(userId) {
  if (!supabase) return { data: [], error: "Supabase no configurado" };
  return supabase
    .from("predictions")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(500);
}

// ─── AUTO-RESOLVER RESULTADOS ──────────────────────────────
// Verifica resultados de partidos terminados via API-Football

export async function autoResolveFootball(userId) {
  if (!supabase) return { resolved: 0 };

  // Get pending football predictions with fixture_id
  const { data: pending } = await supabase
    .from("predictions")
    .select("*")
    .eq("user_id", userId)
    .eq("sport", "football")
    .eq("result", "pending")
    .not("fixture_id", "is", null);

  if (!pending?.length) return { resolved: 0 };

  // Group by fixture_id
  const byFixture = {};
  pending.forEach(p => {
    if (!byFixture[p.fixture_id]) byFixture[p.fixture_id] = [];
    byFixture[p.fixture_id].push(p);
  });

  let resolved = 0;

  for (const [fixtureId, picks] of Object.entries(byFixture)) {
    try {
      const res = await fetch(`/api/sports?sport=football&path=/fixtures&id=${fixtureId}`);
      const data = await res.json();
      const fixture = data?.response?.[0];
      if (!fixture) continue;

      const status = fixture.fixture?.status?.short;
      if (!["FT","AET","PEN"].includes(status)) continue; // not finished

      const hGoals = fixture.goals?.home ?? 0;
      const aGoals = fixture.goals?.away ?? 0;
      const homeWon = hGoals > aGoals;
      const awayWon = aGoals > hGoals;
      const isDraw = hGoals === aGoals;
      const totalGoals = hGoals + aGoals;
      const btts = hGoals > 0 && aGoals > 0;

      // Resolve each pick based on type
      for (const pick of picks) {
        const pickText = (pick.pick || "").toLowerCase();
        const pickType = (pick.pick_type || "").toLowerCase();
        let result = null;

        if (pickType === "resultado" || pickType === "result" || pickType === "moneyline") {
          const homeTeam = pick.home_team?.toLowerCase();
          if (pickText.includes(homeTeam?.split(" ")[0] || "home")) {
            result = homeWon ? "won" : "lost";
          } else if (pickText.includes("empate") || pickText.includes("draw")) {
            result = isDraw ? "won" : "lost";
          } else {
            result = awayWon ? "won" : "lost";
          }
        } else if (pickType === "total goles" || pickText.includes("más") || pickText.includes("over")) {
          const line = parseFloat(pickText.match(/(\d+\.?\d*)/)?.[1] || "2.5");
          const isOver = pickText.includes("más") || pickText.includes("over");
          result = isOver ? (totalGoals > line ? "won" : "lost") : (totalGoals < line ? "won" : "lost");
        } else if (pickType === "btts" || pickText.includes("btts") || pickText.includes("ambos")) {
          const pickedYes = pickText.includes("sí") || pickText.includes("si") || pickText.includes("yes");
          result = pickedYes ? (btts ? "won" : "lost") : (!btts ? "won" : "lost");
        }

        if (result) {
          await updateResult(pick.id, result);
          resolved++;
        }
      }
    } catch(e) { console.warn("Auto-resolve error:", e.message); }
  }

  return { resolved };
}

// Auto-resolve NBA predictions
export async function autoResolveNBA(userId) {
  if (!supabase) return { resolved: 0 };

  const { data: pending } = await supabase
    .from("predictions")
    .select("*")
    .eq("user_id", userId)
    .eq("sport", "nba")
    .eq("result", "pending")
    .not("game_id", "is", null);

  if (!pending?.length) return { resolved: 0 };

  const byGame = {};
  pending.forEach(p => {
    if (!byGame[p.game_id]) byGame[p.game_id] = [];
    byGame[p.game_id].push(p);
  });

  let resolved = 0;

  for (const [gameId, picks] of Object.entries(byGame)) {
    try {
      const NBA_PROXY = "https://nba-proxy-snowy.vercel.app/api/basketball";
      const res = await fetch(`${NBA_PROXY}?path=${encodeURIComponent("/games?id=" + gameId)}`);
      const data = await res.json();
      const game = data?.response?.[0];
      if (!game || game.status?.short !== 3) continue; // not finished

      const hPts = game.scores?.home?.points ?? 0;
      const aPts = game.scores?.visitors?.points ?? 0;
      const total = hPts + aPts;
      const homeName = game.teams?.home?.name?.toLowerCase();

      for (const pick of picks) {
        const pickText = (pick.pick || "").toLowerCase();
        const pickType = (pick.pick_type || pick.tipo || "").toLowerCase();
        let result = null;

        if (pickType === "moneyline") {
          const pickedHome = pickText.includes(homeName?.split(" ").pop() || "home");
          result = pickedHome ? (hPts > aPts ? "won" : "lost") : (aPts > hPts ? "won" : "lost");
        } else if (pickType === "over/under" || pickText.includes("over") || pickText.includes("under") || pickText.includes("más") || pickText.includes("menos")) {
          const line = parseFloat(pickText.match(/(\d+\.?\d*)/)?.[1] || "220");
          const isOver = pickText.includes("over") || pickText.includes("más");
          result = isOver ? (total > line ? "won" : "lost") : (total < line ? "won" : "lost");
        } else if (pickType === "spread") {
          const spread = parseFloat(pickText.match(/[+-]?\d+\.?\d*/)?.[0] || "0");
          const pickedHome = pickText.includes(homeName?.split(" ").pop() || "home");
          result = pickedHome
            ? (hPts + spread > aPts ? "won" : "lost")
            : (aPts - spread > hPts ? "won" : "lost");
        }

        if (result) {
          await updateResult(pick.id, result);
          resolved++;
        }
      }
    } catch(e) { console.warn("NBA auto-resolve error:", e.message); }
  }

  return { resolved };
}

// ─── STATS ─────────────────────────────────────────────────

export function calcUserStats(predictions) {
  const total = predictions.length;
  const resolved = predictions.filter(p => p.result === "won" || p.result === "lost");
  const won = resolved.filter(p => p.result === "won").length;
  const lost = resolved.filter(p => p.result === "lost").length;
  const pending = predictions.filter(p => p.result === "pending").length;
  const winRate = resolved.length > 0 ? ((won / resolved.length) * 100).toFixed(1) : null;

  const byNBA = predictions.filter(p => p.sport === "nba");
  const byFootball = predictions.filter(p => p.sport === "football" || !p.sport);
  const nbaResolved = byNBA.filter(p => p.result === "won" || p.result === "lost");
  const nbaWon = nbaResolved.filter(p => p.result === "won").length;
  const ftResolved = byFootball.filter(p => p.result === "won" || p.result === "lost");
  const ftWon = ftResolved.filter(p => p.result === "won").length;

  let streak = 0; let streakType = null;
  for (const p of resolved) {
    if (!streakType) { streakType = p.result; streak = 1; }
    else if (p.result === streakType) streak++;
    else break;
  }

  return {
    total, won, lost, pending,
    winRate,
    nba: { total: byNBA.length, won: nbaWon, resolved: nbaResolved.length },
    football: { total: byFootball.length, won: ftWon, resolved: ftResolved.length },
    streak: { count: streak, type: streakType },
  };
}

// Keep old name for compatibility
export const calcStats = calcUserStats;

// ─── GUARDAR MEJOR PICK (1 por partido) ───────────────────
// Selecciona la pick con mayor confianza que tenga value, o la de mayor confianza

export async function saveBestPick(userId, matchData, picks, sport = "football") {
  if (!supabase || !picks?.length) return;

  // Seleccionar la mejor pick
  const withValue = picks.filter(p => p.hasValue || (p.confianza >= 60 && p.odds_sugerido));
  const pool = withValue.length > 0 ? withValue : picks;
  const best = pool.reduce((a, b) => (b.confianza || 0) > (a.confianza || 0) ? b : a);

  return supabase.from("predictions").insert({
    user_id: userId,
    sport,
    league: matchData.league,
    home_team: matchData.homeTeam,
    away_team: matchData.awayTeam,
    fixture_id: matchData.fixtureId || null,
    game_date: matchData.gameDate || null,
    game_id: matchData.gameId || null,
    predicted_score: matchData.score || null,
    pick: best.pick,
    pick_type: best.tipo || best.type || "general",
    odds: best.odds_sugerido || best.odds || null,
    confidence: best.confianza || best.confidence || null,
    result: "pending",
    analysis: matchData.analysis || null,
    parlay: false,
  });
}

// ─── LÍMITES DE USO ────────────────────────────────────────

const FREE_LIMIT  = 1;    // análisis gratis por día
const PRO_LIMIT   = 10;   // Pro: 10/día
const ELITE_LIMIT = 9999; // Elite: ilimitado

export async function getUserPlan(userId) {
  if (!supabase) return "free";
  try {
    const { data } = await supabase
      .from("user_plans")
      .select("plan")
      .eq("user_id", userId)
      .single();
    return data?.plan || "free";
  } catch { return "free"; }
}

export async function checkUsageLimit(userId) {
  try {
    const res = await fetch(`/api/sports?sport=football&action=check&userId=${userId}&_=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" }
    });
    if (!res.ok) return { allowed: false, used: 0, limit: FREE_LIMIT, plan: "free" };
    return await res.json();
  } catch(e) {
    console.warn("checkUsageLimit error:", e.message);
    return { allowed: false, used: 0, limit: FREE_LIMIT, plan: "free" };
  }
}

export async function incrementUsage(userId) {
  try {
    await fetch(`/api/sports?sport=football&action=increment&userId=${userId}&_=${Date.now()}`, {
      cache: "no-store"
    });
  } catch(e) { console.warn("incrementUsage error:", e.message); }
}
