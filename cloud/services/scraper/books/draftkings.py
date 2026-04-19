"""
BetAnalytics — DraftKings Scraper

Uses DraftKings' sportsbook API endpoints.
These endpoints serve the DraftKings web/mobile app.

Note: DraftKings may change their API at any time.
This scraper includes retry logic and fallback handling.
"""
import time
import aiohttp
from typing import Optional

from .base import BaseSportsbook, OddsLine

# DraftKings category IDs
SPORT_CATEGORY = {
    "mlb": 84240,
    "nba": 42648,
    "nfl": 88808,
    "nhl": 42133,
}

# Subcategory IDs (market types)
SUBCATEGORY = {
    "moneyline": 0,  # Game Lines typically
    "total": 0,
    "spread": 0,
}


class DraftKingsScraper(BaseSportsbook):
    """
    Scrapes DraftKings odds via their public API.

    Endpoints:
      - /sportsbook/v1/categories/{sport}/subcategories — list subcategories
      - /sportsbook/v1/events — list events for a category

    DK's API returns offer catalogs with all markets per event.
    """

    name = "draftkings"
    base_url = "https://sportsbook-nash.draftkings.com/api/sportscontent/dkusnj/v1"

    def __init__(self, session: aiohttp.ClientSession, proxy: Optional[str] = None):
        super().__init__(session, proxy)
        self._rate_limit_delay = 2.0  # be conservative

    async def fetch_lines(self, sport: str) -> list[OddsLine]:
        category_id = SPORT_CATEGORY.get(sport)
        if not category_id:
            return []

        # Fetch events for this sport
        url = f"{self.base_url}/events/category/{category_id}"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
        }

        try:
            data = await self._get(url, headers=headers)
        except Exception:
            return []

        events = data.get("events", [])
        lines = []

        for event in events:
            event_id = str(event.get("eventId", ""))
            event_name = event.get("name", "")

            # Parse teams from event name "Away @ Home" or "Away vs Home"
            home, away = self._parse_teams(event_name)
            if not home or not away:
                continue

            # Extract offers (markets)
            for offer_category in event.get("offerCategories", []):
                for offer_subcategory in offer_category.get("offerSubcategoryDescriptors", []):
                    for offer in offer_subcategory.get("offerSubcategory", {}).get("offers", []):
                        for market_offer in offer:
                            parsed = self._parse_offer(
                                market_offer, event_id, event_name, home, away, sport
                            )
                            lines.extend(parsed)

        return lines

    def _parse_offer(
        self, offer: dict, event_id: str, event_name: str,
        home: str, away: str, sport: str,
    ) -> list[OddsLine]:
        """Parse a single DK offer into OddsLine objects."""
        lines = []
        label = offer.get("label", "").lower()

        # Determine market type
        market = "unknown"
        if "moneyline" in label or "money line" in label:
            market = "moneyline"
        elif "spread" in label or "run line" in label:
            market = "spread"
        elif "total" in label or "over/under" in label:
            market = "total"
        elif "nrfi" in label.lower():
            market = "nrfi"

        for outcome in offer.get("outcomes", []):
            name = outcome.get("label", "")
            odds_american = outcome.get("oddsAmerican", "")
            odds_decimal = outcome.get("oddsDecimal", 0)
            line_val = outcome.get("line")

            if not odds_decimal or odds_decimal <= 1.0:
                # Try to convert from American
                try:
                    american_int = int(odds_american.replace("+", ""))
                    odds_decimal = self.american_to_decimal(american_int)
                except (ValueError, TypeError):
                    continue

            try:
                american_int = int(str(odds_american).replace("+", ""))
            except (ValueError, TypeError):
                american_int = self.decimal_to_american(odds_decimal)

            selection = self._map_selection(name, home, away)

            lines.append(OddsLine(
                book="draftkings",
                sport=sport,
                league=f"{sport.upper()}",
                event_id=f"dk_{event_id}",
                event_name=event_name,
                home_team=home,
                away_team=away,
                market=market,
                selection=selection,
                line=float(line_val) if line_val is not None else None,
                odds_decimal=round(odds_decimal, 4),
                odds_american=american_int,
                timestamp=time.time(),
                metadata={"source": "draftkings"},
            ))

        return lines

    @staticmethod
    def _parse_teams(event_name: str) -> tuple[str, str]:
        for sep in [" @ ", " vs ", " v "]:
            if sep in event_name:
                parts = event_name.split(sep)
                if len(parts) == 2:
                    return parts[1].strip(), parts[0].strip()  # home, away
        return "", ""

    @staticmethod
    def _map_selection(name: str, home: str, away: str) -> str:
        name_lower = name.lower()
        if name == home or home.lower() in name_lower:
            return "home"
        if name == away or away.lower() in name_lower:
            return "away"
        if "over" in name_lower:
            return "over"
        if "under" in name_lower:
            return "under"
        if "no run" in name_lower or "nrfi" in name_lower:
            return "nrfi"
        if "yes run" in name_lower or "yrfi" in name_lower:
            return "yrfi"
        return name_lower
