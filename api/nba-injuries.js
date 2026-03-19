// api/nba-injuries.js — Proxy hacia ESPN injuries (no requiere API key)
// ESPN bloquea CORS desde el browser — este proxy lo resuelve desde Vercel

// Mapeo: ID de v2.nba.api-sports.io → ID numérico ESPN
const NBA_ID_TO_ESPN = {
  1:  "1",   // Atlanta Hawks
  2:  "2",   // Boston Celtics
  3:  "17",  // Brooklyn Nets
  4:  "30",  // Charlotte Hornets
  5:  "4",   // Chicago Bulls
  6:  "5",   // Cleveland Cavaliers
  7:  "6",   // Dallas Mavericks
  8:  "7",   // Denver Nuggets
  9:  "8",   // Detroit Pistons
  10: "9",   // Golden State Warriors
  11: "10",  // Houston Rockets
  12: "11",  // Indiana Pacers
  13: "12",  // LA Clippers
  14: "13",  // Los Angeles Lakers
  15: "29",  // Memphis Grizzlies
  16: "14",  // Miami Heat
  17: "15",  // Milwaukee Bucks
  18: "16",  // Minnesota Timberwolves
  19: "3",   // New Orleans Pelicans
  20: "18",  // New York Knicks
  21: "25",  // Oklahoma City Thunder
  22: "19",  // Orlando Magic
  23: "20",  // Philadelphia 76ers
  24: "21",  // Phoenix Suns
  25: "22",  // Portland Trail Blazers
  26: "23",  // Sacramento Kings
  27: "24",  // San Antonio Spurs
  28: "28",  // Toronto Raptors
  29: "26",  // Utah Jazz
  30: "27",  // Washington Wizards
  38: "17",  // Brooklyn Nets (alt)
  41: "30",  // Charlotte Hornets (alt)
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { teamId, teamName } = req.query;
  if (!teamId) return res.status(400).json({ error: "Falta teamId" });

  const espnId = NBA_ID_TO_ESPN[parseInt(teamId)];
  if (!espnId) return res.status(200).json({ injuries: [] });

  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnId}/injuries`;
    const apiRes = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!apiRes.ok) {
      return res.status(200).json({ injuries: [], debug: `ESPN status: ${apiRes.status}` });
    }

    const data = await apiRes.json();
    const injuries = (data.injuries || []).map(p => ({
      name: p.athlete?.displayName || p.athlete?.fullName || "Jugador",
      reason: p.details?.returnDate
        ? `${p.details?.type || "Lesión"} — Regreso: ${p.details.returnDate}`
        : (p.details?.type || p.details?.detail || p.longComment || "Lesión"),
      status: p.status || "Out",
      team: teamName || "",
    }));

    return res.status(200).json({ injuries, debug: `ESPN ID: ${espnId}, found: ${injuries.length}` });
  } catch (e) {
    return res.status(200).json({ injuries: [], error: e.message });
  }
}
