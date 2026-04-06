// api/odds.js — Owls Insight (primary) + api-sports (fallback)
// type=splits → Handle%/Ticket% | type=props → player props | default → odds
const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'https://betanalyticsIA.com';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { sport, markets = "h2h", regions = "eu", dateFormat = "iso", fixture_id, type, books, player, category, game_id } = req.query;

  const OWLS_KEY = process.env.OWLS_INSIGHT_API_KEY;
  const BASE = "https://api.owlsinsight.com/api/v1";
  const owlsHeaders = { "Authorization": `Bearer ${OWLS_KEY}`, "Accept": "application/json" };

  const SPORT_MAP = {
    "basketball_nba": "nba", "baseball_mlb": "mlb",
    "soccer_epl": "soccer", "soccer_spain_la_liga": "soccer",
    "soccer_germany_bundesliga": "soccer", "soccer_italy_serie_a": "soccer",
    "soccer_france_ligue_one": "soccer", "soccer_uefa_champs_league": "soccer",
    "soccer_uefa_europa_league": "soccer", "soccer_mexico_ligamx": "soccer",
    "soccer_usa_mls": "soccer", "soccer_brazil_campeonato": "soccer",
    "soccer_argentina_primera_division": "soccer", "soccer": "soccer",
    "americanfootball_nfl": "nfl",
    "nba": "nba", "mlb": "mlb", "nfl": "nfl",
  };

  // ── SPLITS (Handle % / Ticket %) ─────────────────────────────────────────
  if (type === "splits") {
    if (!sport) return res.status(400).json({ error: "Falta sport" });
    const owlsSport = SPORT_MAP[sport];
    if (!owlsSport || !OWLS_KEY) return res.status(200).json({ data: [] });
    try {
      const r = await fetch(`${BASE}/${owlsSport}/splits`, { headers: owlsHeaders });
      const data = await r.json();
      return res.status(200).json(data);
    } catch(e) { return res.status(200).json({ data: [] }); }
  }

  // ── PROPS ─────────────────────────────────────────────────────────────────
  if (type === "props") {
    const owlsSport = SPORT_MAP[sport];
    if (!owlsSport || !OWLS_KEY) return res.status(200).json({ data: [] });
    const params = new URLSearchParams();
    if (books) params.set("books", books);
    if (player) params.set("player", player);
    if (category) params.set("category", category);
    if (game_id) params.set("game_id", game_id);
    try {
      const r = await fetch(`${BASE}/${owlsSport}/props?${params}`, { headers: owlsHeaders });
      const data = await r.json();
      return res.status(200).json(data);
    } catch(e) { return res.status(200).json({ data: [] }); }
  }

  // ── ODDS (default) ────────────────────────────────────────────────────────
  if (!sport) return res.status(400).json({ error: "Falta parámetro sport" });

  // 1. Owls Insight primary
  if (OWLS_KEY) {
    try {
      const owlsSport = SPORT_MAP[sport];
      if (owlsSport) {
        const bookList = books || "pinnacle,draftkings,fanduel,betmgm,bet365,circa";
        const r = await fetch(`${BASE}/${owlsSport}/odds?books=${bookList}`, { headers: owlsHeaders });
        const data = await r.json();
        if (data.success && data.data) {
          const normalized = normalizeOwlsOdds(data.data);
          if (normalized.length > 0) return res.status(200).json(normalized);
        }
      }
    } catch(e) { console.warn("Owls Insight error:", e.message); }
  }

  // 2. The Odds API fallback
  const ODDS_API_KEY = process.env.ODDS_API_KEY;
  if (ODDS_API_KEY) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?apiKey=${ODDS_API_KEY}&regions=${regions}&markets=${markets}&dateFormat=${dateFormat}&oddsFormat=decimal`;
      const r = await fetch(url);
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) return res.status(200).json(data);
    } catch(e) { console.warn("The Odds API error:", e.message); }
  }

  // 3. api-sports fallback
  if (!fixture_id) return res.status(200).json([]);
  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!API_KEY) return res.status(200).json([]);

  try {
    const isBasketball = sport.includes("basketball");
    const isBaseball = sport.includes("baseball");
    const baseUrl = isBasketball ? "https://v2.basketball.api-sports.io"
      : isBaseball ? "https://v1.baseball.api-sports.io"
      : "https://v3.football.api-sports.io";
    const apiHeaders = { "x-apisports-key": API_KEY };
    const fixtureParam = (isBasketball || isBaseball) ? "game" : "fixture";
    const [fixtureRes, oddsRes] = await Promise.all([
      fetch(`${baseUrl}/fixtures?id=${fixture_id}`, { headers: apiHeaders }),
      fetch(`${baseUrl}/odds?${fixtureParam}=${fixture_id}&bookmaker=8`, { headers: apiHeaders }),
    ]);
    const fixtureData = await fixtureRes.json();
    const oddsData = await oddsRes.json();
    const fixture = fixtureData.response?.[0];
    const oddsItem = oddsData.response?.[0];
    if (!oddsItem) return res.status(200).json([]);
    const homeTeam = fixture?.teams?.home?.name || "";
    const awayTeam = fixture?.teams?.away?.name || "";
    const bm = oddsItem.bookmakers?.[0];
    if (!bm) return res.status(200).json([]);
    const h2hBet = bm.bets?.find(b => b.name === "Match Winner" || b.name === "Home/Away");
    const totalsBet = bm.bets?.find(b => b.name === "Goals Over/Under" || b.name === "Over/Under" || b.name === "Total");
    const bookmaker = { key: "api-sports", title: bm.name || "Bet365", markets: [] };
    if (h2hBet?.values) {
      bookmaker.markets.push({ key: "h2h", outcomes: h2hBet.values.map(v => ({ name: v.value === "Home" ? homeTeam : v.value === "Away" ? awayTeam : "Draw", price: parseFloat(v.odd) })) });
    }
    if (totalsBet?.values) {
      const overVal = totalsBet.values.find(v => String(v.value).startsWith("Over"));
      const underVal = totalsBet.values.find(v => String(v.value).startsWith("Under"));
      if (overVal && underVal) {
        const point = parseFloat(String(overVal.value).split(" ")[1] || "2.5");
        bookmaker.markets.push({ key: "totals", outcomes: [{ name: "Over", price: parseFloat(overVal.odd), point }, { name: "Under", price: parseFloat(underVal.odd), point }] });
      }
    }
    if (!bookmaker.markets.length) return res.status(200).json([]);
    return res.status(200).json([{ id: String(fixture_id), home_team: homeTeam, away_team: awayTeam, bookmakers: [bookmaker], source: "api-sports" }]);
  } catch(e) {
    return res.status(200).json([]);
  }
}

function normalizeOwlsOdds(owlsData) {
  if (!owlsData || typeof owlsData !== "object") return [];
  const gameMap = {};
  for (const [, events] of Object.entries(owlsData)) {
    if (!Array.isArray(events)) continue;
    for (const event of events) {
      const id = event.id || `${event.home_team}|${event.away_team}`;
      if (!gameMap[id]) {
        gameMap[id] = { id, sport_key: event.sport_key, commence_time: event.commence_time, home_team: event.home_team, away_team: event.away_team, bookmakers: [], league: event.league, country_code: event.country_code };
      }
      const bm = event.bookmakers?.[0];
      if (bm?.markets?.length && !gameMap[id].bookmakers.find(b => b.key === bm.key)) {
        gameMap[id].bookmakers.push({ key: bm.key, title: bm.title, last_update: bm.last_update, event_link: bm.event_link, markets: bm.markets });
      }
    }
  }
  return Object.values(gameMap).filter(g => g.bookmakers.length > 0);
}
