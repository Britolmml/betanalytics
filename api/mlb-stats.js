// api/mlb-stats.js — Proxy a MLB Stats API oficial (gratis, sin key)
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_URL || 'https://betanalyticsIA.com');
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { type, date, gamePk, playerId } = req.query;
  const BASE = "https://statsapi.mlb.com/api/v1";

  try {
    let url = "";

    if (type === "schedule") {
      // Partidos del día con pitcher probable y lineups
      url = `${BASE}/schedule?sportId=1&date=${date}&hydrate=probablePitcher(note),lineups,linescore`;
    } else if (type === "game") {
      // Datos completos de un partido específico
      url = `${BASE}/game/${gamePk}/linescore`;
    } else if (type === "boxscore") {
      // Boxscore con lineups confirmados
      url = `${BASE}/game/${gamePk}/boxscore`;
    } else if (type === "pitcher_stats") {
      // Stats del pitcher en la temporada actual
      url = `${BASE}/people/${playerId}/stats?stats=season&season=2026&group=pitching`;
    } else if (type === "batter_stats") {
      // Stats del bateador
      url = `${BASE}/people/${playerId}/stats?stats=season&season=2026&group=hitting`;
    } else {
      return res.status(400).json({ error: "Tipo inválido. Usa: schedule, game, boxscore, pitcher_stats, batter_stats" });
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
