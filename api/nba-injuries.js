// api/nba-injuries.js
// ESPN injuries con paginación completa

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
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Referer": "https://www.espn.com/",
  };

  try {
    // Pedir más items con limit=50 para asegurar que traiga todos
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(
      `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/teams/${espnId}/injuries?limit=50`,
      { headers, signal: ctrl.signal }
    );
    clearTimeout(t);
    if (!r.ok) return res.status(200).json({ injuries: [], source: "espn-error" });

    const data = await r.json();
    const items = data.items || [];
    const total = data.count || items.length;

    if (items.length === 0) return res.status(200).json({ injuries: [], source: "espn-empty" });

    // Resolver todos los $ref en paralelo con timeout individual
    const resolved = await Promise.allSettled(
      items.map(async (item) => {
        try {
          const refUrl = item["$ref"];
          if (!refUrl) return null;

          const ctrl2 = new AbortController();
          const t2 = setTimeout(() => ctrl2.abort(), 5000);
          const rr = await fetch(refUrl, { headers, signal: ctrl2.signal });
          clearTimeout(t2);
          if (!rr.ok) return null;
          const d = await rr.json();

          // Resolver atleta
          let athleteName = null;
          if (d.athlete?.displayName) {
            athleteName = d.athlete.displayName;
          } else if (d.athlete?.fullName) {
            athleteName = d.athlete.fullName;
          } else if (d.athlete?.["$ref"]) {
            try {
              const ctrl3 = new AbortController();
              const t3 = setTimeout(() => ctrl3.abort(), 4000);
              const ar = await fetch(d.athlete["$ref"], { headers, signal: ctrl3.signal });
              clearTimeout(t3);
              const ad = await ar.json();
              athleteName = ad.displayName || ad.fullName || ad.shortName;
            } catch { }
          }

          if (!athleteName) return null;

          return {
            name: athleteName,
            reason: d.details?.returnDate
              ? `${d.details?.type || "Lesión"} — Regreso: ${d.details.returnDate}`
              : (d.details?.type || d.type?.text || d.longComment || "Lesión"),
            status: d.status || "Out",
            team: teamName || "",
          };
        } catch { return null; }
      })
    );

    const injuries = resolved
      .filter(r => r.status === "fulfilled" && r.value !== null)
      .map(r => r.value);

    return res.status(200).json({
      injuries,
      source: "espn",
      total,
      resolved: injuries.length,
    });

  } catch(e) {
    return res.status(200).json({ injuries: [], source: "error", error: e.message });
  }
}
