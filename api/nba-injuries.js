// api/nba-injuries.js — Proxy hacia ESPN injuries (no requiere API key)
// ESPN tiene CORS bloqueado desde el browser, este proxy lo resuelve desde Vercel

// Mapeo de IDs de v2.nba.api-sports.io → abreviaturas ESPN
const NBA_ID_TO_ESPN = {
  1:  "atl", 2:  "bos", 3:  "bkn", 4:  "cha", 5:  "chi",
  6:  "cle", 7:  "dal", 8:  "den", 9:  "det", 10: "gsw",
  11: "hou", 12: "ind", 13: "lac", 14: "lal", 15: "mem",
  16: "mia", 17: "mil", 18: "min", 19: "no",  20: "ny",
  21: "okc", 22: "orl", 23: "phi", 24: "phx", 25: "por",
  26: "sac", 27: "sa",  28: "tor", 29: "utah", 30: "wsh",
  38: "bkn", 41: "cha",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { teamId, teamName } = req.query;
  if (!teamId) return res.status(400).json({ error: "Falta teamId" });

  const abbr = NBA_ID_TO_ESPN[parseInt(teamId)];
  if (!abbr) return res.status(200).json({ injuries: [] });

  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${abbr}/injuries`;
    const apiRes = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" },
    });

    if (!apiRes.ok) return res.status(200).json({ injuries: [] });

    const data = await apiRes.json();
    const injuries = (data.injuries || []).map(p => ({
      name: p.athlete?.displayName || p.athlete?.fullName || "Jugador",
      reason: p.details?.returnDate
        ? `${p.details?.type || "Lesión"} — Regreso: ${p.details.returnDate}`
        : (p.details?.type || p.details?.detail || p.longComment || "Lesión"),
      status: p.status || "Out",
      team: teamName || abbr.toUpperCase(),
    }));

    return res.status(200).json({ injuries });
  } catch (e) {
    return res.status(200).json({ injuries: [], error: e.message });
  }
}
