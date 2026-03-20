// api/nba-injuries.js — NBA injuries via ClearSports API
// Mapa directo: api-sports teamId → ClearSports team_id string
const API_SPORTS_TO_CLEARSPORTS = {
  1:"nba_atl", 2:"nba_bos", 3:"nba_no", 4:"nba_chi", 5:"nba_cle",
  6:"nba_dal", 7:"nba_den", 8:"nba_det", 9:"nba_gs", 10:"nba_hou",
  11:"nba_ind", 12:"nba_lac", 13:"nba_lal", 14:"nba_mem", 15:"nba_mia",
  16:"nba_min", 17:"nba_mil", 18:"nba_ny", 19:"nba_orl", 20:"nba_phi",
  21:"nba_phx", 22:"nba_por", 23:"nba_sac", 24:"nba_sa", 25:"nba_okc",
  26:"nba_utah", 27:"nba_wsh", 28:"nba_tor", 29:"nba_mem", 30:"nba_bkn",
  38:"nba_bkn", 41:"nba_cha",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { teamId, teamName } = req.query;
  if (!teamId) return res.status(400).json({ error: "Falta teamId" });

  const apiKey = process.env.CLEARSPORTS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key no configurada" });

  const csTeamId = API_SPORTS_TO_CLEARSPORTS[parseInt(teamId)];
  if (!csTeamId) return res.status(200).json({ injuries: [], note: "No mapping" });

  try {
    // Traer todas las injuries y filtrar por team_id
    const r = await fetch(
      `https://api.clearsportsapi.com/api/v1/nba/injury-stats`,
      { headers: { "Authorization": `Bearer ${apiKey}` } }
    );
    const data = await r.json();
    const all = Array.isArray(data) ? data : (data.injury_game_stats || []);

    const injuries = all
      .filter(p => p.team_id === csTeamId)
      .map(p => ({
        name: p.player_name || p.name || "Jugador",
        reason: p.injury_type || p.injury || p.status_description || "Lesión",
        status: p.status || p.injury_status || "Out",
        team: teamName || "",
      }))
      .filter(p => p.name !== "Jugador");

    return res.status(200).json({ injuries, source: "clearsports", total: injuries.length });
  } catch(e) {
    return res.status(200).json({ injuries: [], error: e.message });
  }
}
