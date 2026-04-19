"""
BetAnalytics — Kelly Criterion Bet Sizing

Full Kelly: f* = (bp - q) / b
  where b = decimal_odds - 1, p = model_prob, q = 1 - p

We use fractional Kelly (25%) to reduce variance while still
capturing most of the edge.

Additional features:
  - Simultaneous Kelly for multiple bets (portfolio-aware)
  - Bankroll management
  - Max exposure limits
"""
from dataclasses import dataclass
from typing import Optional

from ..config import KELLY_FRACTION, KELLY_MAX_BET, KELLY_MIN_BET


@dataclass
class KellyResult:
    full_kelly: float            # optimal fraction (0-1)
    fractional_kelly: float      # reduced fraction
    bet_size_pct: float          # final recommended % of bankroll
    bet_size_usd: float          # dollar amount given bankroll
    edge: float
    is_bet: bool                 # should we bet?
    reason: str                  # why or why not


class KellyCalculator:
    """
    Kelly criterion with fractional sizing and risk limits.

    Key decisions:
      - fraction=0.25 (quarter Kelly) reduces drawdown by ~75% vs full Kelly
        while capturing ~50% of the growth rate. Good for sports where
        model error is significant.
      - max_bet=5% prevents any single bet from being too large
      - min_bet=0.5% prevents dust bets that aren't worth the effort
    """

    def __init__(
        self,
        fraction: float = KELLY_FRACTION,
        max_bet: float = KELLY_MAX_BET,
        min_bet: float = KELLY_MIN_BET,
    ):
        self.fraction = fraction
        self.max_bet = max_bet
        self.min_bet = min_bet

    def calculate(
        self,
        model_prob: float,
        decimal_odds: float,
        bankroll: float = 10000.0,
        confidence: float = 1.0,
    ) -> KellyResult:
        """
        Calculate optimal bet size.

        confidence: model confidence (0-1), further reduces Kelly
        """
        b = decimal_odds - 1  # net odds
        p = model_prob
        q = 1 - p

        if b <= 0 or p <= 0 or p >= 1:
            return KellyResult(
                full_kelly=0, fractional_kelly=0, bet_size_pct=0,
                bet_size_usd=0, edge=0, is_bet=False,
                reason="Invalid odds or probability",
            )

        # Edge
        edge = (b * p - q) / b if b > 0 else 0

        # Full Kelly
        full_kelly = max(0, (b * p - q) / b)

        if full_kelly <= 0:
            return KellyResult(
                full_kelly=0, fractional_kelly=0, bet_size_pct=0,
                bet_size_usd=0, edge=round(edge * 100, 2), is_bet=False,
                reason="Negative EV — no bet",
            )

        # Fractional Kelly * confidence
        frac = full_kelly * self.fraction * min(1.0, confidence)

        # Apply limits
        bet_pct = max(0, min(self.max_bet, frac))

        # Check minimum
        if bet_pct < self.min_bet:
            return KellyResult(
                full_kelly=round(full_kelly, 4),
                fractional_kelly=round(frac, 4),
                bet_size_pct=0,
                bet_size_usd=0,
                edge=round(edge * 100, 2),
                is_bet=False,
                reason=f"Edge too small ({edge*100:.1f}%) — below minimum bet threshold",
            )

        bet_usd = round(bankroll * bet_pct, 2)

        return KellyResult(
            full_kelly=round(full_kelly, 4),
            fractional_kelly=round(frac, 4),
            bet_size_pct=round(bet_pct * 100, 2),
            bet_size_usd=bet_usd,
            edge=round(edge * 100, 2),
            is_bet=True,
            reason=f"EV+ edge {edge*100:.1f}% — {self.fraction*100:.0f}% Kelly = {bet_pct*100:.2f}% bankroll",
        )

    def portfolio_kelly(
        self,
        bets: list[dict],
        bankroll: float = 10000.0,
        max_total_exposure: float = 0.25,
    ) -> list[KellyResult]:
        """
        Simultaneous Kelly for multiple bets.

        Reduces individual sizing when total exposure exceeds max.

        bets: [{"model_prob": 0.55, "decimal_odds": 2.10, "confidence": 0.8}, ...]
        """
        results = []
        for bet in bets:
            r = self.calculate(
                model_prob=bet["model_prob"],
                decimal_odds=bet["decimal_odds"],
                bankroll=bankroll,
                confidence=bet.get("confidence", 1.0),
            )
            results.append(r)

        # Check total exposure
        total_exposure = sum(r.bet_size_pct for r in results if r.is_bet) / 100
        if total_exposure > max_total_exposure:
            scale = max_total_exposure / total_exposure
            results_scaled = []
            for r in results:
                if r.is_bet:
                    new_pct = r.bet_size_pct * scale
                    if new_pct / 100 < self.min_bet:
                        r = KellyResult(
                            full_kelly=r.full_kelly,
                            fractional_kelly=r.fractional_kelly,
                            bet_size_pct=0, bet_size_usd=0,
                            edge=r.edge, is_bet=False,
                            reason=f"Dropped — portfolio scaling reduced below minimum",
                        )
                    else:
                        r = KellyResult(
                            full_kelly=r.full_kelly,
                            fractional_kelly=r.fractional_kelly,
                            bet_size_pct=round(new_pct, 2),
                            bet_size_usd=round(bankroll * new_pct / 100, 2),
                            edge=r.edge, is_bet=True,
                            reason=f"{r.reason} (scaled {scale:.0%} for portfolio)",
                        )
                results_scaled.append(r)
            return results_scaled

        return results
