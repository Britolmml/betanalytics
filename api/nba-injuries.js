// api/nba-injuries.js — Proxy hacia ESPN injuries
const NBA_ID_TO_ESPN = {
  1:"1",2:"2",3:"17",4:"30",5:"4",6:"5",7:"6",8:"7",9:"8",10:"9",
  11:"10",12:"11",13:"12",14:"13",15:"29",16:"14",17:"15",18:"16",
  19:"3",20:"18",21:"25",22:"19",23:"20",24:"21",25:"22",26:"23",
  27:"24",28:"28",29:"26",30:"27",38:"17",41:"30",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { teamId, teamName } = req.query;
  if (!teamId) return res.status(400).json({ error: "Falta teamId" });

  const espnId = NBA_ID_TO_ESPN[parseInt(teamId)];
  if (!espnId) return res.status(200).json({ injuries: [] });

  const headers = {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.espn.com/",
    "Origin": "https://www.espn.com",
  };

  // Intentar múltiples URLs de ESPN
  const urls = [
    `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnId}/injuries`,
    `https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnId}/injuries`,
    `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/teams/${espnId}/injuries?limit=25`,
  ];

  for (const url of urls) {
    try {
      const apiRes = await fetch(url, { headers });
      if (!apiRes.ok) continue;
      const data = await apiRes.json();

      // Formato site.api.espn.com
      if (data.injuries && data.injuries.length > 0) {
        const injuries = data.injuries.map(p => ({
          name: p.athlete?.displayName || p.athlete?.fullName || "Jugador",
          reason: p.details?.returnDate
            ? `${p.details?.type || "Lesión"} — Regreso: ${p.details.returnDate}`
            : (p.details?.type || p.details?.detail || p.longComment || "Lesión"),
          status: p.status || "Out",
          team: teamName || "",
        }));
        return res.status(200).json({ injuries, source: url });
      }

      // Formato sports.core.api.espn.com — devuelve $ref que hay que resolver
      if (data.items && data.items.length > 0) {
        const resolved = await Promise.all(
          data.items.slice(0, 8).map(async (item) => {
            try {
              const refUrl = item["$ref"] || item.ref;
              if (!refUrl) return null;
              const r = await fetch(refUrl, { headers });
              if (!r.ok) return null;
              const d = await r.json();
              // Resolver también el atleta si es otro $ref
              let athleteName = "Jugador";
              if (d.athlete) {
                if (d.athlete.displayName) {
                  athleteName = d.athlete.displayName;
                } else if (d.athlete["$ref"]) {
                  try {
                    const ar = await fetch(d.athlete["$ref"], { headers });
                    const ad = await ar.json();
                    athleteName = ad.displayName || ad.fullName || ad.shortName || "Jugador";
                  } catch { }
                }
              }
              return {
                name: athleteName,
                reason: d.details?.returnDate
                  ? `${d.details?.type || d.type?.text || "Lesión"} — Regreso: ${d.details.returnDate}`
                  : (d.details?.type || d.type?.text || d.longComment || d.shortComment || "Lesión"),
                status: d.status || d.type?.name || "Out",
                team: teamName || "",
              };
            } catch { return null; }
          })
        );
        const injuries = resolved.filter(Boolean);
        if (injuries.length > 0) {
          return res.status(200).json({ injuries, source: "espn-core-resolved" });
        }
      }
    } catch(e) { continue; }
  }

  // Si ESPN no funciona, devolver array vacío con debug info
  return res.status(200).json({ injuries: [], debug: `ESPN ID: ${espnId} — no injuries found or API unavailable` });
}
