// api/nba-injuries.js — Bajas NBA: NBA CDN (primaria) + ESPN (fallback)

// Mapeo nombre de equipo NBA → ID numérico ESPN (fallback)
const NBA_ID_TO_ESPN = {
  1:"1",2:"2",3:"17",4:"30",5:"4",6:"5",7:"6",8:"7",9:"8",10:"9",
  11:"10",12:"11",13:"12",14:"13",15:"29",16:"14",17:"15",18:"16",
  19:"3",20:"18",21:"25",22:"19",23:"20",24:"21",25:"22",26:"23",
  27:"24",28:"28",29:"26",30:"27",38:"17",41:"30",
};

// Mapeo team name de NBA CDN → ID de api-sports
const NBA_TEAM_NAMES = {
  "Atlanta Hawks":1,"Boston Celtics":2,"Brooklyn Nets":3,"Charlotte Hornets":4,
  "Chicago Bulls":5,"Cleveland Cavaliers":6,"Dallas Mavericks":7,"Denver Nuggets":8,
  "Detroit Pistons":9,"Golden State Warriors":10,"Houston Rockets":11,"Indiana Pacers":12,
  "Los Angeles Clippers":13,"Los Angeles Lakers":14,"Memphis Grizzlies":15,"Miami Heat":16,
  "Milwaukee Bucks":17,"Minnesota Timberwolves":18,"New Orleans Pelicans":19,"New York Knicks":20,
  "Oklahoma City Thunder":21,"Orlando Magic":22,"Philadelphia 76ers":23,"Phoenix Suns":24,
  "Portland Trail Blazers":25,"Sacramento Kings":26,"San Antonio Spurs":27,"Toronto Raptors":28,
  "Utah Jazz":29,"Washington Wizards":30,
};

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.nba.com/",
  "Origin": "https://www.nba.com",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { teamId, teamName } = req.query;
  if (!teamId) return res.status(400).json({ error: "Falta teamId" });

  const tid = parseInt(teamId);

  // ── FUENTE 1: NBA CDN (oficial, más rápido) ──────────────────
  try {
    const nbaCDN = await fetch(
      "https://cdn.nba.com/static/json/liveData/injuryreport/injuryreport.json",
      { headers: BROWSER_HEADERS }
    );
    if (nbaCDN.ok) {
      const data = await nbaCDN.json();
      const allPlayers = data?.InjuryReport?.InjuredPlayers || [];
      if (allPlayers.length > 0) {
        // Filtrar por equipo — comparar con nombre del equipo
        const teamInjuries = allPlayers.filter(p => {
          const pTeamId = NBA_TEAM_NAMES[p.TeamName];
          return pTeamId === tid;
        });
        if (teamInjuries.length > 0 || allPlayers.length > 50) {
          // NBA CDN respondió con datos válidos
          const injuries = teamInjuries.map(p => ({
            name: `${p.FirstName} ${p.LastName}`.trim() || "Jugador",
            reason: p.Reason || p.InjuryDescription || "Lesión",
            status: p.CurrentStatus || "Out",
            team: teamName || p.TeamName || "",
          })).slice(0, 8);
          return res.status(200).json({ injuries, source: "nba-cdn" });
        }
      }
    }
  } catch(e) { /* fallback a ESPN */ }

  // ── FUENTE 2: ESPN (fallback) ─────────────────────────────────
  const espnId = NBA_ID_TO_ESPN[tid];
  if (!espnId) return res.status(200).json({ injuries: [] });

  const espnHeaders = {
    ...BROWSER_HEADERS,
    "Referer": "https://www.espn.com/",
    "Origin": "https://www.espn.com",
  };

  const urls = [
    `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnId}/injuries`,
    `https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnId}/injuries`,
    `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/teams/${espnId}/injuries?limit=25`,
  ];

  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: espnHeaders });
      if (!r.ok) continue;
      const data = await r.json();

      // Formato site.api.espn.com
      if (data.injuries?.length > 0) {
        const injuries = data.injuries.map(p => ({
          name: p.athlete?.displayName || p.athlete?.fullName || "Jugador",
          reason: p.details?.returnDate
            ? `${p.details?.type || "Lesión"} — Regreso: ${p.details.returnDate}`
            : (p.details?.type || p.details?.detail || p.longComment || "Lesión"),
          status: p.status || "Out",
          team: teamName || "",
        }));
        return res.status(200).json({ injuries, source: "espn" });
      }

      // Formato sports.core.api — resuelve $ref
      if (data.items?.length > 0) {
        const resolved = await Promise.all(
          data.items.slice(0, 8).map(async item => {
            try {
              const refUrl = item["$ref"];
              if (!refUrl) return null;
              const rr = await fetch(refUrl, { headers: espnHeaders });
              if (!rr.ok) return null;
              const d = await rr.json();
              let athleteName = "Jugador";
              if (d.athlete?.displayName) {
                athleteName = d.athlete.displayName;
              } else if (d.athlete?.["$ref"]) {
                const ar = await fetch(d.athlete["$ref"], { headers: espnHeaders });
                const ad = await ar.json();
                athleteName = ad.displayName || ad.fullName || "Jugador";
              }
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
        const injuries = resolved.filter(Boolean);
        if (injuries.length > 0) {
          return res.status(200).json({ injuries, source: "espn-core" });
        }
      }
    } catch { continue; }
  }

  return res.status(200).json({ injuries: [], source: "none" });
}
