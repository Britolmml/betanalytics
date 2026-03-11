import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = SUPABASE_URL && SUPABASE_ANON
  ? createClient(SUPABASE_URL, SUPABASE_ANON)
  : null;

// ─── FÚTBOL ────────────────────────────────────────────────

export async function savePrediction(userId, data) {
  if (!supabase) return { error: "Supabase no configurado" };
  return supabase.from("predictions").insert({
    user_id: userId,
    league: data.league,
    home_team: data.homeTeam,
    away_team: data.awayTeam,
    predicted_score: data.score,
    pick: data.pick,
    odds: data.odds,
    confidence: data.confidence,
    analysis: data.analysis,
    parlay: data.parlay || false,
    sport: "football",
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

// ─── NBA ────────────────────────────────────────────────────

// Guarda el análisis completo de un partido NBA
export async function saveNBAPrediction(userId, data) {
  if (!supabase) return { error: "Supabase no configurado" };
  return supabase.from("predictions").insert({
    user_id: userId,
    sport: "nba",
    league: "NBA",
    home_team: data.homeTeam,
    away_team: data.awayTeam,
    predicted_score: data.predictedScore || null,
    pick: data.pick,           // pick principal resumido
    odds: data.odds || null,
    confidence: data.confidence,
    analysis: data.analysis,   // JSON completo del análisis IA
    parlay: false,
    result: "pending",
    game_date: data.gameDate || null,
    game_id: data.gameId || null,
  });
}

// Obtener todas las predicciones (fútbol + NBA)
export async function getAllPredictions(userId) {
  if (!supabase) return { data: [], error: "Supabase no configurado" };
  return supabase
    .from("predictions")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);
}

// Calcular estadísticas del usuario
export function calcStats(predictions) {
  const total = predictions.length;
  const resolved = predictions.filter(p => p.result === "won" || p.result === "lost");
  const won = resolved.filter(p => p.result === "won").length;
  const lost = resolved.filter(p => p.result === "lost").length;
  const pending = predictions.filter(p => p.result === "pending").length;
  const winRate = resolved.length > 0 ? ((won / resolved.length) * 100).toFixed(1) : null;

  // Por deporte
  const byNBA = predictions.filter(p => p.sport === "nba");
  const byFootball = predictions.filter(p => p.sport === "football" || !p.sport);
  const nbaResolved = byNBA.filter(p => p.result === "won" || p.result === "lost");
  const nbaWon = nbaResolved.filter(p => p.result === "won").length;
  const ftResolved = byFootball.filter(p => p.result === "won" || p.result === "lost");
  const ftWon = ftResolved.filter(p => p.result === "won").length;

  // Racha actual
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
