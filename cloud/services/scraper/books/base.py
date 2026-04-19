"""
BetAnalytics — Base Sportsbook Scraper
Abstract class defining the interface + shared utilities.
"""
import asyncio
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

import aiohttp
import structlog

logger = structlog.get_logger()


class OddsFormat(str, Enum):
    AMERICAN = "american"
    DECIMAL = "decimal"
    FRACTIONAL = "fractional"


@dataclass
class OddsLine:
    """Normalized odds line — universal format across all books."""
    book: str
    sport: str
    league: str
    event_id: str
    event_name: str             # "Lakers vs Celtics"
    home_team: str
    away_team: str
    market: str                 # moneyline, spread, total, team_total, prop
    selection: str              # home, away, over, under, etc.
    line: Optional[float]       # spread/total value (None for moneyline)
    odds_decimal: float         # always decimal
    odds_american: int          # always american
    timestamp: float = field(default_factory=time.time)
    period: str = "full"        # full, 1h, 1q, f5
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "book": self.book,
            "sport": self.sport,
            "league": self.league,
            "event_id": self.event_id,
            "event_name": self.event_name,
            "home_team": self.home_team,
            "away_team": self.away_team,
            "market": self.market,
            "selection": self.selection,
            "line": self.line,
            "odds_decimal": self.odds_decimal,
            "odds_american": self.odds_american,
            "timestamp": self.timestamp,
            "period": self.period,
            "metadata": self.metadata,
        }


class CircuitBreaker:
    """Prevents hammering a book that's consistently failing."""

    def __init__(self, failure_threshold: int = 5, recovery_timeout: int = 60):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.failures = 0
        self.last_failure_time = 0.0
        self.state = "closed"  # closed = healthy, open = broken

    def record_failure(self):
        self.failures += 1
        self.last_failure_time = time.time()
        if self.failures >= self.failure_threshold:
            self.state = "open"
            logger.warning("circuit_breaker_opened", failures=self.failures)

    def record_success(self):
        self.failures = 0
        self.state = "closed"

    def can_execute(self) -> bool:
        if self.state == "closed":
            return True
        elapsed = time.time() - self.last_failure_time
        if elapsed >= self.recovery_timeout:
            self.state = "half-open"
            return True
        return False


class BaseSportsbook(ABC):
    """
    Abstract base for all sportsbook scrapers.
    Each book implements fetch_lines() for its specific API/HTML.
    """

    name: str = "base"
    base_url: str = ""

    def __init__(self, session: aiohttp.ClientSession, proxy: Optional[str] = None):
        self.session = session
        self.proxy = proxy
        self.circuit_breaker = CircuitBreaker()
        self._rate_limit_delay = 1.0  # seconds between requests

    @abstractmethod
    async def fetch_lines(self, sport: str) -> list[OddsLine]:
        """Fetch all available lines for a sport. Must be implemented by each book."""
        ...

    async def safe_fetch(self, sport: str) -> list[OddsLine]:
        """Wraps fetch_lines with circuit breaker + error handling."""
        if not self.circuit_breaker.can_execute():
            logger.info("circuit_breaker_skip", book=self.name, sport=sport)
            return []

        try:
            lines = await self.fetch_lines(sport)
            self.circuit_breaker.record_success()
            logger.info("scrape_ok", book=self.name, sport=sport, lines=len(lines))
            return lines
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.circuit_breaker.record_failure()
            logger.error("scrape_fail", book=self.name, sport=sport, error=str(e))
            return []

    async def _get(self, url: str, headers: dict = None, params: dict = None) -> dict:
        """HTTP GET with proxy + rate limiting."""
        await asyncio.sleep(self._rate_limit_delay)
        async with self.session.get(
            url,
            headers=headers or {},
            params=params,
            proxy=self.proxy,
            timeout=aiohttp.ClientTimeout(total=15)
        ) as resp:
            resp.raise_for_status()
            return await resp.json()

    # ── Odds conversion helpers ──

    @staticmethod
    def american_to_decimal(american: int) -> float:
        if american > 0:
            return round(1 + american / 100, 4)
        return round(1 + 100 / abs(american), 4)

    @staticmethod
    def decimal_to_american(decimal_odds: float) -> int:
        if decimal_odds >= 2.0:
            return int(round((decimal_odds - 1) * 100))
        return int(round(-100 / (decimal_odds - 1)))

    @staticmethod
    def implied_probability(decimal_odds: float) -> float:
        return round(1 / decimal_odds, 4) if decimal_odds > 0 else 0
