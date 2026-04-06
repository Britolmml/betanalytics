// api/nba-injuries.js — BallDontLie con mapa correcto api-sports → BDL

// Mapa CORRECTO basado en IDs reales de api-sports basketball API
// api-sports_id: bdl_id
const API_SPORTS_TO_BDL = {
  1:1,   // Atlanta Hawks
  2:2,   // Boston Celtics
  4:3,   // Brooklyn Nets
  5:4,   // Charlotte Hornets
  6:5,   // Chicago Bulls
  7:6,   // Cleveland Cavaliers
  9:8,   // Denver Nuggets
  10:9,  // Detroit Pistons
  11:10, // Golden State Warriors
  14:11, // Houston Rockets
  16:13, // LA Clippers
  17:14, // Los Angeles Lakers
  19:15, // Memphis Grizzlies
  20:16, // Miami Heat
  21:17, // Milwaukee Bucks
  22:18, // Minnesota Timberwolves
  23:19, // New Orleans Pelicans
  24:20, // New York Knicks
  25:21, // Oklahoma City Thunder
  26:22, // Orlando Magic
  27:23, // Philadelphia 76ers
  28:24, // Phoenix Suns
  29:25, // Portland Trail Blazers
  30:26, // Sacramento Kings
  31:27, // San Antonio Spurs
  38:28, // Toronto Raptors
  40:29, // Utah Jazz
  41:30, // Washington Wizards
};

const BDL_TEAM_NAMES = {
  1:"Atlanta Hawks", 2:"Boston Celtics", 3:"Brooklyn Nets", 4:"Charlotte Hornets",
  5:"Chicago Bulls", 6:"Cleveland Cavaliers", 7:"Dallas Mavericks", 8:"Denver Nuggets",
  9:"Detroit Pistons", 10:"Golden State Warriors", 11:"Houston Rockets", 12:"Indiana Pacers",
  13:"LA Clippers", 14:"Los Angeles Lakers", 15:"Memphis Grizzlies", 16:"Miami Heat",
  17:"Milwaukee Bucks", 18:"Minnesota Timberwolves", 19:"New Orleans Pelicans",
  20:"New York Knicks", 21:"Oklahoma City Thunder", 22:"Orlando Magic",
  23:"Philadelphia 76ers", 24:"Phoenix Suns", 25:"Portland Trail Blazers",
  26:"Sacramento Kings", 27:"San Antonio Spurs", 28:"Toronto Raptors",
  29:"Utah Jazz", 30:"Washington Wizards",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_URL || 'https://betanalyticsIA.com');
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { teamId, teamName } = req.query;
  if (!teamId) return res.status(400).json({ error: "Falta teamId" });

  const apiKey = process.env.BALLDONTLIE_API_KEY;
  if (!apiKey) return res.status(200).json({ injuries: [], note: "No API key" });

  const bdlTeamId = API_SPORTS_TO_BDL[parseInt(teamId)];
  if (!bdlTeamId) return res.status(200).json({ injuries: [], note: `No mapping for teamId ${teamId}` });

  try {
    const url = `https://api.balldontlie.io/v1/player_injuries?team_ids[]=${bdlTeamId}`;
    const r = await fetch(url, { headers: { "Authorization": apiKey } });
    if (!r.ok) return res.status(200).json({ injuries: [], error: `HTTP ${r.status}` });

    const data = await r.json();
    const injuries = (data.data || []).map(p => ({
      name: `${p.player?.first_name || ""} ${p.player?.last_name || ""}`.trim(),
      reason: p.description ? p.description.split(".")[0].slice(0, 100) : "Lesión",
      status: p.status || "Out",
      team: BDL_TEAM_NAMES[bdlTeamId] || teamName || "",
      return_date: p.return_date || null,
    })).filter(p => p.name);

    return res.status(200).json({ injuries, source: "balldontlie", total: injuries.length });
  } catch(e) {
    return res.status(200).json({ injuries: [], error: e.message });
  }
}
