// api/odds.js — Proxy momios: api-sports primero, The Odds API como fallback

// Mapa sport key → api-sports bookmaker league params
const SPORT_TO_APISPORTS = {
  // Fútbol
  "soccer_epl":              { type: "football", league: 39 },
  "soccer_spain_la_liga":    { type: "football", league: 140 },
  "soccer_germany_bundesliga":{ type: "football", league: 78 },
  "soccer_italy_serie_a":    { type: "football", league: 135 },
  "soccer_france_ligue_one": { type: "football", league: 61 },
  "soccer_uefa_champs_league":{ type: "football", league: 2 },
  "soccer_mexico_ligamx":    { type: "football", league: 262 },
  "soccer_usa_mls":          { type: "football", league: 253 },
  // NBA
  "basketball_nba":          { type: "basketball", league: 12 },
  // MLB
  "baseball_mlb":            { type: "baseball", league: 1 },
};

async function getApiSportsOdds(sport, season = 2026) {
  const mapping = SPORT_TO_APISPORTS[sport];
  if (!mapping) return null;

  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) return null;

  const baseUrl = mapping.type === "football"
    ? "https://v3.football.api-sports.io"
    : mapping.type === "basketball"
    ? "https://v2.basketball.api-sports.io"
    : "https://v1.baseball.api-sports.io";

  const seasonParam = mapping.type === "basketball" ? 2025 : season;

  try {
    const r = await fetch(
      `${baseUrl}/odds?league=${mapping.league}&season=${seasonParam}&bookmaker=8`,
      { headers: { "x-apisports-key": apiKey } }
    );
    const data = await r.json();
    const fixtures = data.response || [];
    if (!fixtures.length) return null;

    // Convertir formato api-sports → formato The Odds API
    return fixtures.map(f => {
      const fixture = f.fixture || f.game || f;
      const bookmakers = f.bookmakers || [];
      const bm = bookmakers[0];
      if (!bm) return null;

      const h2hBet = bm.bets?.find(b => b.name === "Match Winner" || b.name === "Home/Away");
      const totalsBet = bm.bets?.find(b => b.name === "Goals Over/Under" || b.name === "Over/Under");

      const home = f.teams?.home?.name || f.teams?.home;
      const away = f.teams?.away?.name || f.teams?.away;
      if (!home || !away) return null;

      const bookmaker = {
        key: "api-sports",
        title: bm.name || "Bet365",
        markets: []
      };

      if (h2hBet?.values) {
        bookmaker.markets.push({
          key: "h2h",
          outcomes: h2hBet.values.map(v => ({
            name: v.value === "Home" ? home : v.value === "Away" ? away : "Draw",
            price: parseFloat(v.odd)
          }))
        });
      }

      if (totalsBet?.values) {
        const overVal = totalsBet.values.find(v => v.value?.startsWith("Over"));
        const underVal = totalsBet.values.find(v => v.value?.startsWith("Under"));
        if (overVal && underVal) {
          const point = parseFloat(overVal.value.split(" ")[1] || "2.5");
          bookmaker.markets.push({
            key: "totals",
            outcomes: [
              { name: "Over", price: parseFloat(overVal.odd), point },
              { name: "Under", price: parseFloat(underVal.odd), point },
            ]
          });
        }
      }

      return {
        id: String(fixture.id || ""),
        home_team: home,
        away_team: away,
        commence_time: fixture.date || fixture.timestamp,
        bookmakers: [bookmaker],
        source: "api-sports"
      };
    }).filter(Boolean);
  } catch(e) {
    console.warn("api-sports odds error:", e.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { sport, markets = "h2h", regions = "eu", dateFormat = "iso" } = req.query;
  if (!sport) return res.status(400).json({ error: "Falta parámetro sport" });

  // 1. Intentar The Odds API primero
  const ODDS_API_KEY = process.env.ODDS_API_KEY;
  if (ODDS_API_KEY) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?apiKey=${ODDS_API_KEY}&regions=${regions}&markets=${markets}&dateFormat=${dateFormat}&oddsFormat=decimal`;
      const r = await fetch(url);
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) {
        return res.status(200).json(data);
      }
      if (data.error_code === "OUT_OF_USAGE_CREDITS") {
        console.warn("The Odds API: sin créditos, usando api-sports");
      }
    } catch(e) {
      console.warn("The Odds API error:", e.message);
    }
  }

  // 2. Fallback: api-sports
  const apiSportsData = await getApiSportsOdds(sport);
  if (apiSportsData && apiSportsData.length > 0) {
    return res.status(200).json(apiSportsData);
  }

  return res.status(200).json([]);
}
