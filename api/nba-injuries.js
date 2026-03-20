// api/nba-injuries.js — NBA injuries via ClearSports API
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { teamId, teamName } = req.query;
  if (!teamId) return res.status(400).json({ error: "Falta teamId" });

  const apiKey = process.env.CLEARSPORTS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key no configurada" });

  try {
    // ClearSports usa sus propios team IDs — primero obtenemos los equipos NBA
    // para mapear el teamId de api-sports al de ClearSports
    const teamsRes = await fetch("https://api.clearsportsapi.com/api/v1/nba/teams", {
      headers: { "Authorization": `Bearer ${apiKey}` }
    });
    const teamsData = await teamsRes.json();
    const teams = Array.isArray(teamsData) ? teamsData : (teamsData.teams || []);

    // Buscar por nombre del equipo
    const teamNameLower = (teamName || "").toLowerCase();
    const lastWord = teamNameLower.split(" ").pop();
    const match = teams.find(t => {
      const n = (t.name || t.full_name || t.display_name || "").toLowerCase();
      return n.includes(lastWord) || n.includes(teamNameLower);
    });

    if (!match) {
      return res.status(200).json({ injuries: [], note: "Team not found in ClearSports" });
    }

    // Obtener injuries con el ID de ClearSports
    const injRes = await fetch(
      `https://api.clearsportsapi.com/api/v1/nba/injury-stats?team_id=${match.id || match.team_id}`,
      { headers: { "Authorization": `Bearer ${apiKey}` } }
    );
    const injData = await injRes.json();
    const rawInjuries = Array.isArray(injData) ? injData : (injData.injuries || injData.data || []);

    const injuries = rawInjuries.map(p => ({
      name: p.player_name || p.name || p.full_name || "Jugador",
      reason: p.injury_type || p.injury || p.description || "Lesión",
      status: p.status || p.injury_status || "Out",
      team: teamName || "",
    })).filter(p => p.name !== "Jugador");

    return res.status(200).json({ injuries, source: "clearsports", total: injuries.length });
  } catch(e) {
    return res.status(200).json({ injuries: [], error: e.message });
  }
}
