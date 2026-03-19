// api/nba-injuries.js — ESPN injuries filtradas correctamente por equipo

const NBA_ID_TO_ESPN = {
  1:"1",2:"2",3:"17",4:"30",5:"4",6:"5",7:"6",8:"7",9:"8",10:"9",
  11:"10",12:"11",13:"12",14:"13",15:"29",16:"14",17:"15",18:"16",
  19:"3",20:"18",21:"25",22:"19",23:"20",24:"21",25:"22",26:"23",
  27:"24",28:"28",29:"26",30:"27",38:"17",41:"30",
};

// ESPN team IDs → team names (para filtrar correctamente)
const ESPN_ID_TO_NAME = {
  "1":"Atlanta Hawks","2":"Boston Celtics","17":"Brooklyn Nets","30":"Charlotte Hornets",
  "4":"Chicago Bulls","5":"Cleveland Cavaliers","6":"Dallas Mavericks","7":"Denver Nuggets",
  "8":"Detroit Pistons","9":"Golden State Warriors","10":"Houston Rockets","11":"Indiana Pacers",
  "12":"Los Angeles Clippers","13":"Los Angeles Lakers","29":"Memphis Grizzlies","14":"Miami Heat",
  "15":"Milwaukee Bucks","16":"Minnesota Timberwolves","3":"New Orleans Pelicans","18":"New York Knicks",
  "25":"Oklahoma City Thunder","19":"Orlando Magic","20":"Philadelphia 76ers","21":"Phoenix Suns",
  "22":"Portland Trail Blazers","23":"Sacramento Kings","24":"San Antonio Spurs","28":"Toronto Raptors",
  "26":"Utah Jazz","27":"Washington Wizards",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { teamId, teamName } = req.query;
  if (!teamId) return res.status(400).json({ error: "Falta teamId" });

  const espnId = NBA_ID_TO_ESPN[parseInt(teamId)];
  if (!espnId) return res.status(200).json({ injuries: [] });

  const expectedTeamName = ESPN_ID_TO_NAME[espnId] || teamName || "";

  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/json",
    "Referer": "https://www.espn.com/",
  };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(
      `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/teams/${espnId}/injuries?limit=50`,
      { headers, signal: ctrl.signal }
    );
    clearTimeout(t);
    if (!r.ok) return res.status(200).json({ injuries: [] });

    const data = await r.json();
    const items = data.items || [];
    if (items.length === 0) return res.status(200).json({ injuries: [] });

    // Resolver $ref en paralelo
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

          // Resolver nombre del atleta
          let athleteName = null;
          let athleteTeam = null;

          if (d.athlete?.displayName) {
            athleteName = d.athlete.displayName;
            athleteTeam = d.athlete.team?.displayName || d.athlete.team?.name;
          } else if (d.athlete?.["$ref"]) {
            try {
              const ctrl3 = new AbortController();
              const t3 = setTimeout(() => ctrl3.abort(), 4000);
              const ar = await fetch(d.athlete["$ref"], { headers, signal: ctrl3.signal });
              clearTimeout(t3);
              const ad = await ar.json();
              athleteName = ad.displayName || ad.fullName || ad.shortName;
              // El equipo del atleta está en su $ref también
              if (ad.team?.["$ref"]) {
                try {
                  const tr = await fetch(ad.team["$ref"], { headers });
                  const td = await tr.json();
                  athleteTeam = td.displayName || td.name;
                } catch { }
              }
            } catch { }
          }

          if (!athleteName) return null;

          // Filtrar: solo jugadores del equipo correcto
          if (athleteTeam && expectedTeamName) {
            const normTeam = s => s?.toLowerCase().replace(/[^a-z]/g,"") || "";
            const teamMatch = normTeam(athleteTeam).includes(normTeam(expectedTeamName.split(" ").pop())) ||
                             normTeam(expectedTeamName).includes(normTeam(athleteTeam.split(" ").pop()));
            if (!teamMatch) return null; // jugador de otro equipo — descartar
          }

          return {
            name: athleteName,
            reason: d.details?.returnDate
              ? `${d.details?.type || "Lesión"} — Regreso: ${d.details.returnDate}`
              : (d.details?.type || d.type?.text || d.longComment || "Lesión"),
            status: d.status || "Out",
            team: teamName || expectedTeamName,
          };
        } catch { return null; }
      })
    );

    const injuries = resolved
      .filter(r => r.status === "fulfilled" && r.value !== null)
      .map(r => r.value);

    return res.status(200).json({ injuries, source: "espn", total: items.length });

  } catch(e) {
    return res.status(200).json({ injuries: [], error: e.message });
  }
}
