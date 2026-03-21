// api/nba-injuries.js — BallDontLie NBA injuries

// Mapa api-sports teamId → BallDontLie team name keywords
const TEAM_NAME_MAP = {
  1:"Atlanta Hawks", 2:"Boston Celtics", 3:"New Orleans Pelicans", 4:"Chicago Bulls",
  5:"Cleveland Cavaliers", 6:"Dallas Mavericks", 7:"Denver Nuggets", 8:"Detroit Pistons",
  9:"Golden State Warriors", 10:"Houston Rockets", 11:"Indiana Pacers", 12:"LA Clippers",
  13:"Los Angeles Lakers", 14:"Memphis Grizzlies", 15:"Miami Heat", 16:"Minnesota Timberwolves",
  17:"Milwaukee Bucks", 18:"New York Knicks", 19:"Orlando Magic", 20:"Philadelphia 76ers",
  21:"Phoenix Suns", 22:"Portland Trail Blazers", 23:"Sacramento Kings", 24:"San Antonio Spurs",
  25:"Oklahoma City Thunder", 26:"Utah Jazz", 27:"Washington Wizards", 28:"Toronto Raptors",
  30:"Brooklyn Nets", 38:"Brooklyn Nets", 41:"Charlotte Hornets",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { teamId, teamName } = req.query;
  if (!teamId) return res.status(400).json({ error: "Falta teamId" });

  const apiKey = process.env.BALLDONTLIE_API_KEY;
  if (!apiKey) return res.status(200).json({ injuries: [], note: "No API key" });

  const expectedTeam = TEAM_NAME_MAP[parseInt(teamId)] || teamName || "";

  try {
    const r = await fetch("https://api.balldontlie.io/v1/player_injuries", {
      headers: { "Authorization": apiKey }
    });

    if (!r.ok) return res.status(200).json({ injuries: [], error: `HTTP ${r.status}` });

    const data = await r.json();
    const all = data.data || [];

    // Filtrar por equipo
    const teamLower = expectedTeam.toLowerCase();
    const lastWord = teamLower.split(" ").pop();

    const injuries = all
      .filter(p => {
        const pTeam = (p.team?.full_name || p.team?.name || "").toLowerCase();
        return pTeam.includes(lastWord) || pTeam === teamLower;
      })
      .map(p => ({
        name: p.player?.first_name + " " + p.player?.last_name || "",
        reason: p.description || "Lesión",
        status: p.status || "Out",
        team: teamName || expectedTeam,
      }))
      .filter(p => p.name.trim());

    return res.status(200).json({ injuries, source: "balldontlie", total: injuries.length });
  } catch(e) {
    return res.status(200).json({ injuries: [], error: e.message });
  }
}
