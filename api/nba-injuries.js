// api/nba-injuries.js — ClearSports + ESPN fallback (forzando https)

const API_SPORTS_TO_CLEARSPORTS = {
  1:"nba_atl", 2:"nba_bos", 3:"nba_no", 4:"nba_chi", 5:"nba_cle",
  6:"nba_dal", 7:"nba_den", 8:"nba_det", 9:"nba_gs", 10:"nba_hou",
  11:"nba_ind", 12:"nba_lac", 13:"nba_lal", 14:"nba_mem", 15:"nba_mia",
  16:"nba_min", 17:"nba_mil", 18:"nba_ny", 19:"nba_orl", 20:"nba_phi",
  21:"nba_phx", 22:"nba_por", 23:"nba_sac", 24:"nba_sa", 25:"nba_okc",
  26:"nba_utah", 27:"nba_wsh", 28:"nba_tor", 29:"nba_mem", 30:"nba_bkn",
  38:"nba_bkn", 41:"nba_cha",
};

const NBA_ID_TO_ESPN = {
  1:"1",2:"2",3:"17",4:"30",5:"4",6:"5",7:"6",8:"7",9:"8",10:"9",
  11:"10",12:"11",13:"12",14:"13",15:"29",16:"14",17:"15",18:"16",
  19:"3",20:"18",21:"25",22:"19",23:"20",24:"21",25:"22",26:"23",
  27:"24",28:"28",29:"26",30:"27",38:"17",41:"30",
};

const toHttps = url => url ? url.replace(/^http:\/\//, "https://") : url;

const espnHeaders = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "Accept": "application/json",
};

async function fromClearSports(teamId, teamName, apiKey) {
  const csTeamId = API_SPORTS_TO_CLEARSPORTS[parseInt(teamId)];
  if (!csTeamId || !apiKey) return [];
  const r = await fetch("https://api.clearsportsapi.com/api/v1/nba/injury-stats", {
    headers: { "Authorization": `Bearer ${apiKey}` }
  });
  const data = await r.json();
  const all = Array.isArray(data) ? data : (data.injury_game_stats || []);
  return all
    .filter(p => p.team_id === csTeamId)
    .map(p => ({
      name: p.player_name || "Jugador",
      reason: p.injury_type || p.status_description || "Lesión",
      status: p.status || "Out",
      team: teamName || "",
    }))
    .filter(p => p.name !== "Jugador");
}

async function fromESPN(teamId, teamName) {
  const espnId = NBA_ID_TO_ESPN[parseInt(teamId)];
  if (!espnId) return [];

  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 8000);

  const r = await fetch(
    `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/teams/${espnId}/injuries?limit=50`,
    { headers: espnHeaders, signal: ctrl.signal }
  );
  if (!r.ok) return [];
  const data = await r.json();
  const items = (data.items || []).slice(0, 15);
  if (!items.length) return [];

  const resolved = await Promise.allSettled(
    items.map(async (item) => {
      try {
        const refUrl = toHttps(item["$ref"]);
        if (!refUrl) return null;

        const ctrl2 = new AbortController();
        setTimeout(() => ctrl2.abort(), 5000);
        const rr = await fetch(refUrl, { headers: espnHeaders, signal: ctrl2.signal });
        if (!rr.ok) return null;
        const d = await rr.json();

        let athleteName = null;
        if (d.athlete?.displayName) {
          athleteName = d.athlete.displayName;
        } else if (d.athlete?.["$ref"]) {
          const ctrl3 = new AbortController();
          setTimeout(() => ctrl3.abort(), 4000);
          const ar = await fetch(toHttps(d.athlete["$ref"]), { headers: espnHeaders, signal: ctrl3.signal });
          if (!ar.ok) return null;
          const ad = await ar.json();
          athleteName = ad.displayName || ad.fullName || ad.shortName;
        }
        if (!athleteName) return null;

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

  return resolved
    .filter(r => r.status === "fulfilled" && r.value)
    .map(r => r.value);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { teamId, teamName } = req.query;
  if (!teamId) return res.status(400).json({ error: "Falta teamId" });

  const apiKey = process.env.CLEARSPORTS_API_KEY;

  try {
    // 1. ClearSports primero
    let injuries = await fromClearSports(teamId, teamName, apiKey);
    let source = "clearsports";

    // 2. ESPN fallback si no hay datos
    if (!injuries.length) {
      injuries = await fromESPN(teamId, teamName);
      source = "espn";
    }

    return res.status(200).json({ injuries, source, total: injuries.length });
  } catch(e) {
    try {
      const injuries = await fromESPN(teamId, teamName);
      return res.status(200).json({ injuries, source: "espn", total: injuries.length });
    } catch {
      return res.status(200).json({ injuries: [], error: e.message });
    }
  }
}
