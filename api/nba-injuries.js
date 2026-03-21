// api/nba-injuries.js — BallDontLie NBA injuries
// Mapa api-sports teamId → BallDontLie team id
const API_SPORTS_TO_BDL = {
  1:1,   // Atlanta Hawks
  2:2,   // Boston Celtics
  3:19,  // New Orleans Pelicans
  4:5,   // Chicago Bulls
  5:6,   // Cleveland Cavaliers
  6:7,   // Dallas Mavericks
  7:8,   // Denver Nuggets
  8:9,   // Detroit Pistons
  9:10,  // Golden State Warriors
  10:11, // Houston Rockets
  11:12, // Indiana Pacers
  12:13, // LA Clippers
  13:14, // Los Angeles Lakers
  14:15, // Memphis Grizzlies
  15:16, // Miami Heat
  16:18, // Minnesota Timberwolves
  17:17, // Milwaukee Bucks
  18:20, // New York Knicks
  19:22, // Orlando Magic
  20:23, // Philadelphia 76ers
  21:24, // Phoenix Suns
  22:25, // Portland Trail Blazers
  23:26, // Sacramento Kings
  24:27, // San Antonio Spurs
  25:21, // Oklahoma City Thunder
  26:29, // Utah Jazz
  27:30, // Washington Wizards
  28:28, // Toronto Raptors
  30:3,  // Brooklyn Nets
  38:3,  // Brooklyn Nets
  41:4,  // Charlotte Hornets
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { teamId, teamName } = req.query;
  if (!teamId) return res.status(400).json({ error: "Falta teamId" });

  const apiKey = process.env.BALLDONTLIE_API_KEY;
  if (!apiKey) return res.status(200).json({ injuries: [], note: "No API key" });

  const bdlTeamId = API_SPORTS_TO_BDL[parseInt(teamId)];
  if (!bdlTeamId) return res.status(200).json({ injuries: [] });

  try {
    const r = await fetch("https://api.balldontlie.io/v1/player_injuries", {
      headers: { "Authorization": apiKey }
    });
    if (!r.ok) return res.status(200).json({ injuries: [], error: `HTTP ${r.status}` });

    const data = await r.json();
    const all = data.data || [];

    const injuries = all
      .filter(p => p.player?.team_id === bdlTeamId)
      .map(p => ({
        name: `${p.player?.first_name || ""} ${p.player?.last_name || ""}`.trim(),
        reason: p.description ? p.description.split(".")[0].slice(0, 100) : "Lesión",
        status: p.status || "Out",
        team: teamName || "",
        return_date: p.return_date || null,
      }))
      .filter(p => p.name);

    return res.status(200).json({ injuries, source: "balldontlie", total: injuries.length });
  } catch(e) {
    return res.status(200).json({ injuries: [], error: e.message });
  }
}
