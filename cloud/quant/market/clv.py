"""
BetAnalytics — Closing Line Value (CLV) Tracker

CLV = the #1 predictor of long-term sports betting profitability.

If you consistently beat the closing line, you're +EV by definition
(since closing lines are the most efficient).

CLV = (closing_implied_prob - opening_implied_prob) direction-adjusted
Positive CLV = you got a better price than the market settled at.
"""
import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class CLVRecord:
    pick_id: str
    book: str
    market: str                  # moneyline, spread, total
    selection: str               # home, away, over, under
    # At time of pick
    pick_odds_decimal: float
    pick_implied_prob: float
    pick_timestamp: float
    # At close
    close_odds_decimal: float = 0.0
    close_implied_prob: float = 0.0
    close_timestamp: float = 0.0
    # CLV
    clv_cents: float = 0.0       # in cents (e.g., 3.5 = 3.5 cents)
    clv_percent: float = 0.0     # as percentage
    is_resolved: bool = False


@dataclass
class CLVSummary:
    total_picks: int
    resolved_picks: int
    avg_clv_cents: float
    avg_clv_percent: float
    positive_clv_rate: float     # % of picks that beat the close
    total_clv_cents: float
    by_market: dict              # {"moneyline": avg_clv, "total": avg_clv}
    by_book: dict


class CLVTracker:
    """
    Tracks closing line value across all picks.

    Flow:
      1. When a pick is made → record pick odds + timestamp
      2. At game start (close) → record closing odds
      3. Compute CLV = close_implied - pick_implied (for favored side)

    A CLV of +2 cents means the line moved 2 cents in your direction.
    Consistent +CLV = consistent edge.
    """

    def __init__(self):
        self.records: list[CLVRecord] = []

    def record_pick(
        self,
        pick_id: str,
        book: str,
        market: str,
        selection: str,
        odds_decimal: float,
    ) -> CLVRecord:
        """Record odds at the time of pick."""
        implied = 1 / odds_decimal if odds_decimal > 1 else 1.0

        record = CLVRecord(
            pick_id=pick_id,
            book=book,
            market=market,
            selection=selection,
            pick_odds_decimal=odds_decimal,
            pick_implied_prob=implied,
            pick_timestamp=time.time(),
        )
        self.records.append(record)
        return record

    def record_close(self, pick_id: str, close_odds_decimal: float):
        """Record the closing line for a previously made pick."""
        record = self._find_record(pick_id)
        if not record:
            return

        close_implied = 1 / close_odds_decimal if close_odds_decimal > 1 else 1.0

        record.close_odds_decimal = close_odds_decimal
        record.close_implied_prob = close_implied
        record.close_timestamp = time.time()

        # CLV calculation
        # Positive CLV = you got better odds than the close
        # For a bet ON a selection: close_implied > pick_implied means line moved your way
        record.clv_cents = round((close_implied - record.pick_implied_prob) * 100, 2)
        record.clv_percent = round(
            (record.pick_odds_decimal / close_odds_decimal - 1) * 100
            if close_odds_decimal > 0 else 0, 2
        )
        record.is_resolved = True

    def get_summary(self) -> CLVSummary:
        """Compute aggregate CLV stats."""
        resolved = [r for r in self.records if r.is_resolved]

        if not resolved:
            return CLVSummary(
                total_picks=len(self.records),
                resolved_picks=0,
                avg_clv_cents=0, avg_clv_percent=0,
                positive_clv_rate=0, total_clv_cents=0,
                by_market={}, by_book={},
            )

        clvs = [r.clv_cents for r in resolved]
        clv_pcts = [r.clv_percent for r in resolved]

        # By market
        by_market = {}
        by_book = {}
        for r in resolved:
            by_market.setdefault(r.market, []).append(r.clv_cents)
            by_book.setdefault(r.book, []).append(r.clv_cents)

        return CLVSummary(
            total_picks=len(self.records),
            resolved_picks=len(resolved),
            avg_clv_cents=round(sum(clvs) / len(clvs), 2),
            avg_clv_percent=round(sum(clv_pcts) / len(clv_pcts), 2),
            positive_clv_rate=round(sum(1 for c in clvs if c > 0) / len(clvs), 3),
            total_clv_cents=round(sum(clvs), 2),
            by_market={k: round(sum(v) / len(v), 2) for k, v in by_market.items()},
            by_book={k: round(sum(v) / len(v), 2) for k, v in by_book.items()},
        )

    def _find_record(self, pick_id: str) -> Optional[CLVRecord]:
        for r in self.records:
            if r.pick_id == pick_id:
                return r
        return None
