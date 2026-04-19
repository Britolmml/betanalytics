"""
BetAnalytics — The Odds API Scraper

Official API (https://the-odds-api.com) — provides odds from 40+ books.
This is the primary data source (reliable, structured, legal).

Rate limit: depends on plan (500-10000 requests/month).
"""
import time
import aiohttp
from typing import Optional

from .base import BaseSportsbook, OddsLine

# Sport keys for The Odds API
SPORT_MAP = {
    "mlb": "baseball_mlb",
    "nba": "basketball_nba",
    "nfl": "americanfootball_nfl",
    "nhl": "icehockey_nhl",
    "soccer_epl": "soccer_epl",
    "soccer_laliga": "soccer_spain_la_liga",
    "soccer_bundesliga": "soccer_germany_bundesliga",
}

# Markets we want
MARKETS = "h2h,spreads,totals"


class OddsAPIScraper(BaseSportsbook):
    """
    Scrapes The Odds API for multi-book odds.

    One API call returns odds from all available books for a sport,
    so we get DraftKings, FanDuel, BetMGM, etc. in a single request.
    """

    name = "odds_api"
    base_url = "https://api.the-odds-api.com/v4"

    def __init__(
        self,
        session: aiohttp.ClientSession,
        api_key: str,
        proxy: Optional[str] = None,
        bookmakers: list[str] = None,
    ):
        super().__init__(session, proxy)
        self.api_key = api_key
        self.bookmakers = bookmakers or [
            "draftkings", "fanduel", "betmgm", "pinnacle",
            "caesars", "bet365", "bovada", "betonlineag",
        ]
        self._rate_limit_delay = 0.5  # gentle on rate limits

    async def fetch_lines(self, sport: str) -> list[OddsLine]:
        sport_key = SPORT_MAP.get(sport)
        if not sport_key:
            return []

        url = f"{self.base_url}/sports/{sport_key}/odds"
        params = {
            "apiKey": self.api_key,
            "regions": "us,us2,eu",
            "markets": MARKETS,
            "oddsFormat": "decimal",
            "bookmakers": ",".join(self.bookmakers),
        }

        data = await self._get(url, params=params)
        if not isinstance(data, list):
            return []

        lines = []
        for event in data:
            event_id = event.get("id", "")
            home = event.get("home_team", "")
            away = event.get("away_team", "")
            event_name = f"{away} @ {home}"
            sport_title = event.get("sport_title", sport)

            for bookmaker in event.get("bookmakers", []):
                book_name = bookmaker.get("key", "unknown")

                for market in bookmaker.get("markets", []):
                    market_key = market.get("key", "")
                    outcomes = market.get("outcomes", [])

                    for outcome in outcomes:
                        name = outcome.get("name", "")
                        price = outcome.get("price", 0)
                        point = outcome.get("point")

                        if price <= 1.0:
                            continue

                        # Determine selection
                        selection = self._map_selection(name, home, away, market_key)
                        market_type = self._map_market(market_key)
                        line_val = point

                        american = self.decimal_to_american(price)

                        lines.append(OddsLine(
                            book=book_name,
                            sport=sport,
                            league=sport_title,
                            event_id=event_id,
                            event_name=event_name,
                            home_team=home,
                            away_team=away,
                            market=market_type,
                            selection=selection,
                            line=line_val,
                            odds_decimal=round(price, 4),
                            odds_american=american,
                            timestamp=time.time(),
                            period="full",
                            metadata={"source": "odds_api"},
                        ))

        return lines

    @staticmethod
    def _map_selection(name: str, home: str, away: str, market_key: str) -> str:
        if name == home:
            return "home"
        if name == away:
            return "away"
        lower = name.lower()
        if lower == "over":
            return "over"
        if lower == "under":
            return "under"
        if lower == "draw":
            return "draw"
        return name.lower()

    @staticmethod
    def _map_market(market_key: str) -> str:
        mapping = {
            "h2h": "moneyline",
            "spreads": "spread",
            "totals": "total",
        }
        return mapping.get(market_key, market_key)
