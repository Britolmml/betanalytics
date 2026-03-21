// api/nba-injuries.js — BallDontLie NBA injuries (confiable)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { teamId, teamName } = req.query;
  if (!teamName) return res.status(400).json({ error: "Falta teamName" });

  const apiKey = process.env.BALLDONTLIE_API_KEY;
  if (!apiKey) return res.status(200).json({ injuries: [], note: "No API key" });

  try {
    const r = await fetch("https://api.balldontlie.io/v1/player_injuries", {
      headers: { "Authorization": apiKey }
    });

    if (!r.ok) return res.status(200).json({ injuries: [], error: `HTTP ${r.status}` });

    const data = await r.json();
    const all = data.data || [];

    // Filtrar por equipo usando el nombre
    const teamLower = (teamName || "").toLowerCase();
    const lastWord = teamLower.split(" ").pop(); // ej: "timberwolves"

    const injuries = all
      .filter(p => {
        const pTeam = (p.team?.full_name || p.team?.name || "").toLowerCase();
        return pTeam.includes(lastWord) || pTeam === teamLower;
      })
      .map(p => ({
        name: `${p.player?.first_name || ""} ${p.player?.last_name || ""}`.trim(),
        reason: p.description ? p.description.slice(0, 80) : "Lesión",
        status: p.status || "Out",
        team: teamName,
        return_date: p.return_date || null,
      }))
      .filter(p => p.name);

    return res.status(200).json({ injuries, source: "balldontlie", total: injuries.length });
  } catch(e) {
    return res.status(200).json({ injuries: [], error: e.message });
  }
}
