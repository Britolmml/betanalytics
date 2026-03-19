// api/nba-injuries.js
// Injuries NBA via v3.football.api-sports.io (league=12)
// Busca por nombre de equipo para evitar problemas de mapeo de IDs

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { teamId, teamName } = req.query;
  if (!teamName) return res.status(400).json({ error: "Falta teamName" });

  if (!process.env.API_FOOTBALL_KEY) {
    return res.status(500).json({ error: "API_FOOTBALL_KEY no configurada" });
  }

  try {
    // Buscar el equipo por nombre en api-football league=12 (NBA)
    const teamsRes = await fetch(
      `https://v3.football.api-sports.io/teams?league=12&season=2024&search=${encodeURIComponent(teamName)}`,
      { headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY } }
    );
    const teamsData = await teamsRes.json();
    const team = teamsData?.response?.[0]?.team;

    if (!team?.id) {
      return res.status(200).json({ injuries: [], source: "no-team-found", teamName });
    }

    // Buscar injuries con el ID encontrado
    const injRes = await fetch(
      `https://v3.football.api-sports.io/injuries?league=12&season=2024&team=${team.id}`,
      { headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY } }
    );
    const injData = await injRes.json();

    if (injData?.errors && Object.keys(injData.errors).length > 0) {
      return res.status(200).json({ injuries: [], source: "api-error", error: Object.values(injData.errors)[0] });
    }

    const list = injData?.response || [];
    const injuries = list.map(p => ({
      name: p.player?.name || "Jugador",
      reason: p.reason || p.type || "Lesión",
      status: p.player?.type || "Out",
      team: teamName,
    })).slice(0, 10);

    return res.status(200).json({ injuries, source: `api-football-${team.id}`, total: list.length });

  } catch(e) {
    return res.status(200).json({ injuries: [], error: e.message });
  }
}
