// api/nba-injuries.js — ESPN injuries filtradas por equipo

const NBA_ID_TO_ESPN = {
  1:"1",2:"2",3:"17",4:"30",5:"4",6:"5",7:"6",8:"7",9:"8",10:"9",
  11:"10",12:"11",13:"12",14:"13",15:"29",16:"14",17:"15",18:"16",
  19:"3",20:"18",21:"25",22:"19",23:"20",24:"21",25:"22",26:"23",
  27:"24",28:"28",29:"26",30:"27",38:"17",41:"30",
};

const ESPN_TEAM_KEYWORDS = {
  "1":"hawks","2":"celtics","17":"nets","30":"hornets","4":"bulls",
  "5":"cavaliers","6":"mavericks","7":"nuggets","8":"pistons","9":"warriors",
  "10":"rockets","11":"pacers","12":"clippers","13":"lakers","29":"grizzlies",
  "14":"heat","15":"bucks","16":"timberwolves","3":"pelicans","18":"knicks",
  "25":"thunder","19":"magic","20":"76ers","21":"suns","22":"blazers",
  "23":"kings","24":"spurs","28":"raptors","26":"jazz","27":"wizards",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { teamId, teamName } = req.query;
  if (!teamId) return res.status(400).json({ error: "Falta teamId" });

  const espnId = NBA_ID_TO_ESPN[parseInt(teamId)];
  if (!espnId) return res.status(200).json({ injuries: [] });

  const teamKeyword = ESPN_TEAM_KEYWORDS[espnId] || "";
  const expectedLastWord = (teamName || "").split(" ").pop().toLowerCase();

  const headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/json",
    "Referer": "https://www.espn.com/",
  };

  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(
      `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/teams/${espnId}/injuries?limit=50`,
      { headers, signal: ctrl.signal }
    );
    if (!r.ok) return res.status(200).json({ injuries: [] });

    const data = await r.json();
    const items = data.items || [];
    if (!items.length) return res.status(200).json({ injuries: [] });

    const resolved = await Promise.allSettled(
      items.map(async (item) => {
        try {
          const refUrl = item["$ref"];
          if (!refUrl) return null;

          const ctrl2 = new AbortController();
          setTimeout(() => ctrl2.abort(), 5000);
          const rr = await fetch(refUrl, { headers, signal: ctrl2.signal });
          if (!rr.ok) return null;
          const d = await rr.json();

          // Resolver atleta
          let athleteName = null;
          let athleteTeamName = "";

          if (d.athlete?.displayName) {
            athleteName = d.athlete.displayName;
            athleteTeamName = d.athlete?.team?.displayName || d.athlete?.team?.name || "";
          } else if (d.athlete?.["$ref"]) {
            const ctrl3 = new AbortController();
            setTimeout(() => ctrl3.abort(), 4000);
            const ar = await fetch(d.athlete["$ref"], { headers, signal: ctrl3.signal });
            const ad = await ar.json();
            athleteName = ad.displayName || ad.fullName || ad.shortName;
            // Team info from athlete profile
            if (ad.team?.["$ref"]) {
              try {
                const tr = await fetch(ad.team["$ref"], { headers });
                const td = await tr.json();
                athleteTeamName = td.displayName || td.name || "";
              } catch { }
            }
          }

          if (!athleteName) return null;

          // Filtro estricto por equipo
          const athleteTeamLower = athleteTeamName.toLowerCase();
          const isCorrectTeam = 
            athleteTeamLower.includes(teamKeyword) ||
            athleteTeamLower.includes(expectedLastWord) ||
            (teamKeyword && athleteTeamLower.endsWith(teamKeyword));

          // Si tenemos info del equipo y NO coincide — descartar
          if (athleteTeamName && !isCorrectTeam) return null;

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

    return res.status(200).json({ injuries, source: "espn", total: items.length });

  } catch(e) {
    return res.status(200).json({ injuries: [], error: e.message });
  }
}
