"""
BetAnalytics — Expected Value Calculator

EV = (model_probability * decimal_odds) - 1

This is the core metric. Every bet must be EV+ to be considered.
We also compute edge%, no-vig probability, and value rating.
"""
from dataclasses import dataclass
from typing import Optional

from ..config import EV_MIN_THRESHOLD, EV_STRONG_THRESHOLD, EV_MAX_THRESHOLD


@dataclass
class EVResult:
    ev: float                    # expected value (-1 to +inf)
    ev_percent: float            # EV as percentage
    edge: float                  # model_prob - implied_prob
    edge_percent: float
    model_prob: float
    implied_prob: float          # from odds (with vig)
    no_vig_prob: float           # devigged
    decimal_odds: float
    american_odds: int
    is_value: bool               # EV > threshold
    value_rating: str            # "none", "marginal", "good", "strong", "suspicious"
    kelly_fraction: float        # recommended from Kelly
    expected_roi: float          # long-run ROI if this edge is real


class EVCalculator:
    """
    Computes Expected Value for any bet given model probability and market odds.

    Also handles devigging (removing the vig from both sides to get true implied).
    """

    def __init__(self, min_ev: float = EV_MIN_THRESHOLD):
        self.min_ev = min_ev

    def calculate(
        self,
        model_prob: float,
        decimal_odds: float,
        opposite_decimal_odds: Optional[float] = None,
    ) -> EVResult:
        """
        Calculate EV for a single selection.

        model_prob: our estimated probability (0-1)
        decimal_odds: what the book is offering
        opposite_decimal_odds: odds for the other side (for devigging)
        """
        # Basic EV
        ev = (model_prob * decimal_odds) - 1
        ev_pct = ev * 100

        # Implied probability (with vig)
        implied = 1 / decimal_odds if decimal_odds > 1 else 1.0

        # Devig (remove vig from both sides)
        if opposite_decimal_odds and opposite_decimal_odds > 1:
            no_vig = self._devig(decimal_odds, opposite_decimal_odds)
        else:
            no_vig = implied

        # Edge = model_prob - no_vig_prob
        edge = model_prob - no_vig
        edge_pct = edge * 100

        # American odds
        american = self._decimal_to_american(decimal_odds)

        # Value classification
        is_value = ev > self.min_ev and edge_pct >= 2.0
        rating = self._classify_value(ev, edge_pct)

        # Kelly (simplified — full version in kelly.py)
        b = decimal_odds - 1
        kelly = 0.0
        if b > 0:
            kelly = max(0, (b * model_prob - (1 - model_prob)) / b)

        # Expected long-run ROI
        expected_roi = ev * 100  # if you bet $1 repeatedly

        return EVResult(
            ev=round(ev, 4),
            ev_percent=round(ev_pct, 2),
            edge=round(edge, 4),
            edge_percent=round(edge_pct, 2),
            model_prob=round(model_prob, 4),
            implied_prob=round(implied, 4),
            no_vig_prob=round(no_vig, 4),
            decimal_odds=decimal_odds,
            american_odds=american,
            is_value=is_value,
            value_rating=rating,
            kelly_fraction=round(kelly, 4),
            expected_roi=round(expected_roi, 2),
        )

    def calculate_market(
        self,
        model_probs: dict,
        market_odds: dict,
    ) -> dict[str, EVResult]:
        """
        Calculate EV for an entire market (e.g., moneyline with home/away).

        model_probs: {"home": 0.58, "away": 0.42}
        market_odds: {"home": 1.85, "away": 2.05}
        """
        results = {}
        selections = list(model_probs.keys())

        for sel in selections:
            if sel not in market_odds:
                continue
            # Find opposite odds for devigging
            opposite_odds = None
            for other in selections:
                if other != sel and other in market_odds:
                    opposite_odds = market_odds[other]
                    break

            results[sel] = self.calculate(
                model_prob=model_probs[sel],
                decimal_odds=market_odds[sel],
                opposite_decimal_odds=opposite_odds,
            )

        return results

    def best_odds_across_books(
        self,
        model_prob: float,
        book_odds: dict[str, float],
    ) -> tuple[str, EVResult]:
        """
        Find the best EV across multiple sportsbooks.

        book_odds: {"draftkings": 1.90, "fanduel": 1.95, "pinnacle": 1.87}
        Returns: (best_book_name, ev_result)
        """
        best_book = None
        best_ev = None

        for book, odds in book_odds.items():
            result = self.calculate(model_prob, odds)
            if best_ev is None or result.ev > best_ev.ev:
                best_ev = result
                best_book = book

        return best_book, best_ev

    # ═══════════════════════════════════════════
    # Helpers
    # ═══════════════════════════════════════════

    def _devig(self, odds1: float, odds2: float) -> float:
        """
        Remove vig using multiplicative method (Shin's method simplified).

        Given two-way market odds, compute the true probability of side 1.
        """
        imp1 = 1 / odds1
        imp2 = 1 / odds2
        total = imp1 + imp2  # > 1 because of vig

        if total <= 0:
            return imp1

        return imp1 / total

    def _classify_value(self, ev: float, edge_pct: float) -> str:
        if ev <= 0 or edge_pct < 2.0:
            return "none"
        if ev > EV_MAX_THRESHOLD:
            return "suspicious"  # likely bad data
        if ev >= EV_STRONG_THRESHOLD:
            return "strong"
        if ev >= EV_MIN_THRESHOLD:
            return "good"
        return "marginal"

    @staticmethod
    def _decimal_to_american(decimal_odds: float) -> int:
        if decimal_odds >= 2.0:
            return int(round((decimal_odds - 1) * 100))
        if decimal_odds > 1.0:
            return int(round(-100 / (decimal_odds - 1)))
        return -100
