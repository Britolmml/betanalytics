"""
BetAnalytics — Pinnacle Scraper

Pinnacle is the sharpest book (lowest vig, doesn't limit winners).
Their closing lines are the gold standard for CLV measurement.
"""
import time
import aiohttp
from typing import Optional

from .base import BaseSportsbook, OddsLine

SPORT_MAP = {
    "mlb": 246,
    "nba": 487,
    "nfl": 889,
    "nhl": 1456,
    "soccer": 29,
}


class PinnacleScraper(BaseSportsbook):
    """
    Scrapes Pinnacle odds via their public odds feed.
    Pinnacle lines are used as the benchmark for CLV.
    """

    name = "pinnacle"
    base_url = "https://guest.api.arcadia.pinnacle.com/0.1"

    def __init__(self, session: aiohttp.ClientSession, proxy: Optional[str] = None):
        super().__init__(session, proxy)
        self._rate_limit_delay = 3.0  # conservative

    async def fetch_lines(self, sport: str) -> list[OddsLine]:
        sport_id = SPORT_MAP.get(sport)
        if not sport_id:
            return []

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Accept": "application/json",
            "X-API-Key": "CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R",  # public guest key
            "Referer": "https://www.pinnacle.com/",
        }

        # Fetch matchups
        try:
            matchups_url = f"{self.base_url}/sports/{sport_id}/matchups"
            matchups_data = await self._get(matchups_url, headers=headers)
        except Exception:
            return []

        if not isinstance(matchups_data, list):
            return []

        lines = []

        for matchup in matchups_data:
            if matchup.get("type") != "matchup":
                continue

            matchup_id = matchup.get("id", "")
            participants = matchup.get("participants", [])
            if len(participants) < 2:
                continue

            home = ""
            away = ""
            for p in participants:
                if p.get("alignment") == "home":
                    home = p.get("name", "")
                elif p.get("alignment") == "away":
                    away = p.get("name", "")

            if not home or not away:
                continue

            event_name = f"{away} @ {home}"

            # Fetch odds for this matchup
            try:
                odds_url = f"{self.base_url}/matchups/{matchup_id}/markets/related/straight"
                odds_data = await self._get(odds_url, headers=headers)
            except Exception:
                continue

            if not isinstance(odds_data, list):
                continue

            for market in odds_data:
                market_key = market.get("key", "")
                market_type = self._classify_market(market_key)
                prices = market.get("prices", [])

                for price in prices:
                    designation = price.get("designation", "")
                    decimal_odds = price.get("price", 0)
                    points = price.get("points")

                    if not decimal_odds or decimal_odds <= 1.0:
                        continue

                    selection = self._map_designation(designation)
                    american = self.decimal_to_american(decimal_odds)

                    lines.append(OddsLine(
                        book="pinnacle",
                        sport=sport,
                        league=sport.upper(),
                        event_id=f"pin_{matchup_id}",
                        event_name=event_name,
                        home_team=home,
                        away_team=away,
                        market=market_type,
                        selection=selection,
                        line=float(points) if points is not None else None,
                        odds_decimal=round(decimal_odds, 4),
                        odds_american=american,
                        timestamp=time.time(),
                        metadata={"source": "pinnacle", "pinnacle_key": market_key},
                    ))

        return lines

    @staticmethod
    def _classify_market(key: str) -> str:
        kl = key.lower()
        if "moneyline" in kl or "s;0;m" in kl:
            return "moneyline"
        if "spread" in kl or "s;0;s" in kl:
            return "spread"
        if "total" in kl or "s;0;ou" in kl:
            return "total"
        return key

    @staticmethod
    def _map_designation(designation: str) -> str:
        d = designation.lower()
        if d == "home":
            return "home"
        if d == "away":
            return "away"
        if d == "over":
            return "over"
        if d == "under":
            return "under"
        return d
