// api/nba-injuries.js — BallDontLie filtrando por team_ids en la API

const API_SPORTS_TO_BDL = {
  1:1, 2:2, 3:19, 4:5, 5:6, 6:7, 7:8, 8:9, 9:10, 10:11,
  11:12, 12:13, 13:14, 14:15, 15:16, 16:18, 17:17, 18:20,
  19:22, 20:23, 21:24, 22:25, 23:26, 24:27, 25:21, 26:29,
  27:30, 28:28, 30:3, 38:3, 41:4,
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
    // Filtrar directamente en la API por team_ids[]
    const url = `https://api.balldontlie.io/v1/player_injuries?team_ids[]=${bdlTeamId}`;
    const r = await fetch(url, {
      headers: { "Authorization": apiKey }
    });
    if (!r.ok) return res.status(200).json({ injuries: [], error: `HTTP ${r.status}` });

    const data = await r.json();
    const all = data.data || [];

    const injuries = all.map(p => ({
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
