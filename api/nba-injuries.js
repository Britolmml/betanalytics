// api/nba-injuries.js
// Usa v3.football.api-sports.io (mismo proxy que fútbol) — SÍ tiene injuries NBA
// League ID 12 = NBA en api-sports

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { teamId, teamName } = req.query;
  if (!teamId) return res.status(400).json({ error: "Falta teamId" });

  if (!process.env.API_FOOTBALL_KEY) {
    return res.status(500).json({ error: "API_FOOTBALL_KEY no configurada" });
  }

  const tid = parseInt(teamId);

  // Buscar injuries en v3.football.api-sports.io con league=12 (NBA)
  for (const season of [2024, 2025]) {
    try {
      const url = `https://v3.football.api-sports.io/injuries?league=12&season=${season}&team=${tid}`;
      const apiRes = await fetch(url, {
        headers: {
          "x-apisports-key": process.env.API_FOOTBALL_KEY,
          "Accept": "application/json",
        },
      });

      if (!apiRes.ok) continue;
      const data = await apiRes.json();

      if (data?.errors && Object.keys(data.errors).length > 0) {
        const errMsg = String(Object.values(data.errors)[0]);
        if (errMsg.includes("endpoint")) break; // endpoint no existe, ir a ESPN
        continue;
      }

      const list = data?.response || [];
      if (!list.length) continue;

      const injuries = list.map(p => ({
        name: p.player?.name || "Jugador",
        reason: p.reason || p.type || "Lesión",
        status: p.player?.type || "Out",
        team: teamName || p.team?.name || "",
      })).slice(0, 10);

      if (injuries.length > 0) {
        return res.status(200).json({ injuries, source: `api-sports-${season}` });
      }
    } catch { continue; }
  }

  // Fallback: ESPN con timeouts
  const NBA_ID_TO_ESPN = {
    1:"1",2:"2",3:"17",4:"30",5:"4",6:"5",7:"6",8:"7",9:"8",10:"9",
    11:"10",12:"11",13:"12",14:"13",15:"29",16:"14",17:"15",18:"16",
    19:"3",20:"18",21:"25",22:"19",23:"20",24:"21",25:"22",26:"23",
    27:"24",28:"28",29:"26",30:"27",38:"17",41:"30",
  };
  const espnId = NBA_ID_TO_ESPN[tid];
  if (!espnId) return res.status(200).json({ injuries: [] });

  const espnHeaders = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/json",
    "Referer": "https://www.espn.com/",
  };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(
      `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/teams/${espnId}/injuries?limit=25`,
      { headers: espnHeaders, signal: ctrl.signal }
    );
    clearTimeout(t);
    if (r.ok) {
      const data = await r.json();
      if (data.items?.length > 0) {
        const resolved = await Promise.all(
          data.items.slice(0, 20).map(async item => {
            try {
              const refUrl = item["$ref"];
              if (!refUrl) return null;
              const ctrl2 = new AbortController();
              const t2 = setTimeout(() => ctrl2.abort(), 4000);
              const rr = await fetch(refUrl, { headers: espnHeaders, signal: ctrl2.signal });
              clearTimeout(t2);
              if (!rr.ok) return null;
              const d = await rr.json();
              let athleteName = "Jugador";
              if (d.athlete?.displayName) {
                athleteName = d.athlete.displayName;
              } else if (d.athlete?.["$ref"]) {
                try {
                  const ctrl3 = new AbortController();
                  const t3 = setTimeout(() => ctrl3.abort(), 3000);
                  const ar = await fetch(d.athlete["$ref"], { headers: espnHeaders, signal: ctrl3.signal });
                  clearTimeout(t3);
                  const ad = await ar.json();
                  athleteName = ad.displayName || ad.fullName || "Jugador";
                } catch { }
              }
              if (athleteName === "Jugador") return null;
              return {
                name: athleteName,
                reason: d.details?.returnDate
                  ? `${d.details?.type || "Lesión"} — Regreso: ${d.details.returnDate}`
                  : (d.details?.type || d.type?.text || "Lesión"),
                status: d.status || "Out",
                team: teamName || "",
              };
            } catch { return null; }
          })
        );
        const injuries = resolved.filter(Boolean);
        if (injuries.length > 0) {
          return res.status(200).json({ injuries, source: "espn-fallback" });
        }
      }
    }
  } catch { }

  return res.status(200).json({ injuries: [], source: "none" });
}
