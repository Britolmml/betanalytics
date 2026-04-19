"""
BetAnalytics — FanDuel Scraper

FanDuel uses a similar public API pattern to DraftKings.
"""
import time
import aiohttp
from typing import Optional

from .base import BaseSportsbook, OddsLine

SPORT_MAP = {
    "mlb": "mlb",
    "nba": "nba",
    "nfl": "nfl",
    "nhl": "nhl",
}


class FanDuelScraper(BaseSportsbook):
    """
    Scrapes FanDuel odds via their sportsbook API.
    """

    name = "fanduel"
    base_url = "https://sbapi.nj.sportsbook.fanduel.com/api"

    def __init__(self, session: aiohttp.ClientSession, proxy: Optional[str] = None):
        super().__init__(session, proxy)
        self._rate_limit_delay = 2.0

    async def fetch_lines(self, sport: str) -> list[OddsLine]:
        sport_key = SPORT_MAP.get(sport)
        if not sport_key:
            return []

        url = f"{self.base_url}/content-managed-page"
        params = {
            "page": f"CUSTOM-{sport_key.upper()}",
            "customPageId": sport_key,
            "_ak": "FhMFpcPWXMeyZxOx",  # public app key
            "timezone": "America/New_York",
        }
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
        }

        try:
            data = await self._get(url, headers=headers, params=params)
        except Exception:
            return []

        lines = []
        attachments = data.get("attachments", {})
        events = attachments.get("events", {})
        markets_data = attachments.get("markets", {})
        runners_data = attachments.get("runners", {})  # outcomes

        for event_id, event in events.items():
            event_name = event.get("name", "")
            home, away = self._parse_teams(event_name)
            if not home:
                continue

            market_ids = event.get("markets", [])
            for mid in market_ids:
                market = markets_data.get(str(mid), {})
                market_type = self._classify_market(market.get("marketType", ""))
                runner_ids = market.get("runners", [])

                for rid in runner_ids:
                    runner = runners_data.get(str(rid), {})
                    name = runner.get("runnerName", "")
                    handicap = runner.get("handicap")
                    win_running = runner.get("winRunnerOdds", {})
                    decimal_odds = win_running.get("trueOdds", {}).get("decimalOdds", {}).get("decimalOdds", 0)
                    american_odds_str = win_running.get("americanDisplayOdds", {}).get("americanOdds", "")

                    if not decimal_odds or decimal_odds <= 1.0:
                        continue

                    try:
                        american = int(str(american_odds_str).replace("+", ""))
                    except (ValueError, TypeError):
                        american = self.decimal_to_american(decimal_odds)

                    selection = self._map_selection(name, home, away)

                    lines.append(OddsLine(
                        book="fanduel",
                        sport=sport,
                        league=sport.upper(),
                        event_id=f"fd_{event_id}",
                        event_name=event_name,
                        home_team=home,
                        away_team=away,
                        market=market_type,
                        selection=selection,
                        line=float(handicap) if handicap is not None else None,
                        odds_decimal=round(decimal_odds, 4),
                        odds_american=american,
                        timestamp=time.time(),
                        metadata={"source": "fanduel"},
                    ))

        return lines

    @staticmethod
    def _parse_teams(event_name: str) -> tuple[str, str]:
        for sep in [" @ ", " vs ", " v "]:
            if sep in event_name:
                parts = event_name.split(sep)
                if len(parts) == 2:
                    return parts[1].strip(), parts[0].strip()
        return "", ""

    @staticmethod
    def _classify_market(market_type: str) -> str:
        mt = market_type.lower()
        if "moneyline" in mt or "money_line" in mt or "winner" in mt:
            return "moneyline"
        if "spread" in mt or "handicap" in mt or "run_line" in mt:
            return "spread"
        if "total" in mt or "over_under" in mt:
            return "total"
        return market_type

    @staticmethod
    def _map_selection(name: str, home: str, away: str) -> str:
        nl = name.lower()
        if name == home or home.lower() in nl:
            return "home"
        if name == away or away.lower() in nl:
            return "away"
        if "over" in nl:
            return "over"
        if "under" in nl:
            return "under"
        return nl
