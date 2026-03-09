import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = SUPABASE_URL && SUPABASE_ANON
  ? createClient(SUPABASE_URL, SUPABASE_ANON)
  : null;

// Guardar predicción
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
  });
}

// Obtener predicciones del usuario
export async function getPredictions(userId) {
  if (!supabase) return { data: [], error: "Supabase no configurado" };
  return supabase
    .from("predictions")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
}

// Actualizar resultado
export async function updateResult(id, result) {
  if (!supabase) return { error: "Supabase no configurado" };
  return supabase.from("predictions").update({ result }).eq("id", id);
}
