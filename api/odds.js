// api/odds.js — Proxy momios: The Odds API + api-sports fallback por fixture

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { sport, markets = "h2h", regions = "eu", dateFormat = "iso", fixture_id } = req.query;
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
    } catch(e) { console.warn("The Odds API error:", e.message); }
  }

  // 2. Fallback: api-sports por fixture_id
  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!API_KEY || !fixture_id) return res.status(200).json([]);

  try {
    // Determinar el tipo de deporte y URL base
    const isBasketball = sport.includes("basketball");
    const isBaseball = sport.includes("baseball");
    const baseUrl = isBasketball
      ? "https://v2.basketball.api-sports.io"
      : isBaseball
      ? "https://v1.baseball.api-sports.io"
      : "https://v3.football.api-sports.io";

    const endpoint = isBasketball || isBaseball ? "odds" : "odds";
    const fixtureParam = isBasketball ? "game" : isBaseball ? "game" : "fixture";

    const r = await fetch(
      `${baseUrl}/${endpoint}?${fixtureParam}=${fixture_id}&bookmaker=8`,
      { headers: { "x-apisports-key": API_KEY } }
    );
    const data = await r.json();
    const item = data.response?.[0];
    if (!item) return res.status(200).json([]);

    const bm = item.bookmakers?.[0];
    if (!bm) return res.status(200).json([]);

    const h2hBet = bm.bets?.find(b => b.name === "Match Winner" || b.name === "Home/Away");
    const totalsBet = bm.bets?.find(b => b.name === "Goals Over/Under" || b.name === "Over/Under" || b.name === "Total");

    // Obtener nombres de equipos del fixture
    const homeTeam = item.teams?.home?.name || item.fixture?.home || "";
    const awayTeam = item.teams?.away?.name || item.fixture?.away || "";

    const bookmaker = { key: "api-sports", title: bm.name || "Bet365", markets: [] };

    if (h2hBet?.values) {
      bookmaker.markets.push({
        key: "h2h",
        outcomes: h2hBet.values.map(v => ({
          name: v.value === "Home" ? homeTeam : v.value === "Away" ? awayTeam : "Draw",
          price: parseFloat(v.odd)
        }))
      });
    }

    if (totalsBet?.values) {
      const overVal = totalsBet.values.find(v => String(v.value).startsWith("Over"));
      const underVal = totalsBet.values.find(v => String(v.value).startsWith("Under"));
      if (overVal && underVal) {
        const point = parseFloat(String(overVal.value).split(" ")[1] || "2.5");
        bookmaker.markets.push({
          key: "totals",
          outcomes: [
            { name: "Over", price: parseFloat(overVal.odd), point },
            { name: "Under", price: parseFloat(underVal.odd), point },
          ]
        });
      }
    }

    return res.status(200).json([{
      id: String(fixture_id),
      home_team: homeTeam,
      away_team: awayTeam,
      bookmakers: [bookmaker],
      source: "api-sports"
    }]);
  } catch(e) {
    return res.status(200).json([]);
  }
}
