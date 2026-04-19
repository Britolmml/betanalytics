"""
BetAnalytics — Risk Manager

Guards against:
  1. Bad data / suspicious lines
  2. Contradictory signals
  3. Small sample sizes
  4. Over-exposure to correlated bets
  5. Model overconfidence

Every pick passes through risk checks before the decision engine approves it.
"""
from dataclasses import dataclass, field
from typing import Optional

from ..config import (
    EV_MAX_THRESHOLD,
    MAX_CORRELATION_EXPOSURE,
    MAX_DAILY_BETS,
    MIN_EDGE_PERCENT,
    CONFIDENCE_DECAY_SMALL_SAMPLE,
)


@dataclass
class RiskFlag:
    code: str                    # e.g., "SUSPICIOUS_EV", "CONTRADICTORY"
    severity: str                # "warning", "block"
    description: str
    confidence_penalty: float    # reduce confidence by this factor (0-1)


@dataclass
class RiskAssessment:
    approved: bool
    flags: list[RiskFlag]
    adjusted_confidence: float   # after penalties
    max_bet_multiplier: float    # 1.0 = normal, 0.5 = halved, 0 = blocked
    reason: str


class RiskManager:
    """
    Pre-bet risk screening.

    Every pick gets a RiskAssessment that either:
      - Approves with full confidence
      - Approves with reduced confidence (and reduced Kelly)
      - Blocks entirely
    """

    def __init__(self):
        self.daily_bets = 0
        self.active_bets: list[dict] = []  # currently open positions

    def assess(
        self,
        ev: float,
        edge_pct: float,
        model_confidence: float,
        model_agreement: float,
        home_team: str,
        away_team: str,
        market: str,
        selection: str,
        pitcher_ip: float = 0.0,
        sharp_signals: list = None,
    ) -> RiskAssessment:
        """Run all risk checks on a potential pick."""
        flags = []
        confidence = model_confidence

        # ── Check 1: Suspicious EV (likely bad data) ──
        if ev > EV_MAX_THRESHOLD:
            flags.append(RiskFlag(
                code="SUSPICIOUS_EV",
                severity="block",
                description=f"EV of {ev*100:.1f}% is suspiciously high — likely stale/bad odds",
                confidence_penalty=0.0,
            ))

        # ── Check 2: Edge too small ──
        if edge_pct < MIN_EDGE_PERCENT:
            flags.append(RiskFlag(
                code="LOW_EDGE",
                severity="block",
                description=f"Edge {edge_pct:.1f}% below minimum {MIN_EDGE_PERCENT}%",
                confidence_penalty=0.0,
            ))

        # ── Check 3: Model disagreement ──
        if model_agreement < 0.4:
            flags.append(RiskFlag(
                code="MODEL_DISAGREEMENT",
                severity="warning",
                description=f"Models disagree (agreement={model_agreement:.2f})",
                confidence_penalty=0.3,
            ))

        # ── Check 4: Small sample (pitcher with few innings) ──
        if 0 < pitcher_ip < 30:
            flags.append(RiskFlag(
                code="SMALL_SAMPLE",
                severity="warning",
                description=f"Pitcher only has {pitcher_ip:.0f} IP this season — unreliable stats",
                confidence_penalty=1 - CONFIDENCE_DECAY_SMALL_SAMPLE,
            ))

        # ── Check 5: Contradictory signals ──
        contradictions = self._check_contradictions(
            ev, edge_pct, market, selection, sharp_signals or []
        )
        flags.extend(contradictions)

        # ── Check 6: Correlated exposure ──
        corr_flag = self._check_correlation(home_team, away_team, market)
        if corr_flag:
            flags.append(corr_flag)

        # ── Check 7: Daily bet limit ──
        if self.daily_bets >= MAX_DAILY_BETS:
            flags.append(RiskFlag(
                code="DAILY_LIMIT",
                severity="block",
                description=f"Daily bet limit ({MAX_DAILY_BETS}) reached",
                confidence_penalty=0.0,
            ))

        # ── Apply penalties ──
        for f in flags:
            if f.severity == "block":
                return RiskAssessment(
                    approved=False,
                    flags=flags,
                    adjusted_confidence=0,
                    max_bet_multiplier=0,
                    reason=f.description,
                )
            confidence *= (1 - f.confidence_penalty)

        # ── Compute bet multiplier ──
        multiplier = 1.0
        warning_count = sum(1 for f in flags if f.severity == "warning")
        if warning_count >= 3:
            multiplier = 0.3
        elif warning_count >= 2:
            multiplier = 0.5
        elif warning_count >= 1:
            multiplier = 0.75

        return RiskAssessment(
            approved=True,
            flags=flags,
            adjusted_confidence=round(confidence, 3),
            max_bet_multiplier=round(multiplier, 2),
            reason="Approved" + (f" with {warning_count} warnings" if warning_count else ""),
        )

    def record_bet(self, home_team: str, away_team: str, market: str, selection: str):
        """Record a bet was placed (for correlation tracking)."""
        self.daily_bets += 1
        self.active_bets.append({
            "home": home_team,
            "away": away_team,
            "market": market,
            "selection": selection,
        })

    def reset_daily(self):
        """Reset daily counters."""
        self.daily_bets = 0

    # ═══════════════════════════════════════════

    def _check_contradictions(
        self,
        ev: float,
        edge_pct: float,
        market: str,
        selection: str,
        sharp_signals: list,
    ) -> list[RiskFlag]:
        """Detect contradictory signals."""
        flags = []

        # Sharp money going the opposite direction
        for signal in sharp_signals:
            sig_dir = getattr(signal, "direction", "")
            if market == "moneyline":
                if (selection == "home" and sig_dir == "away") or \
                   (selection == "away" and sig_dir == "home"):
                    flags.append(RiskFlag(
                        code="SHARP_CONTRA",
                        severity="warning",
                        description=f"Sharp money detected on opposite side ({sig_dir})",
                        confidence_penalty=0.25,
                    ))
            elif market == "total":
                if (selection == "over" and sig_dir == "under") or \
                   (selection == "under" and sig_dir == "over"):
                    flags.append(RiskFlag(
                        code="SHARP_CONTRA",
                        severity="warning",
                        description=f"Sharp money on opposite total direction ({sig_dir})",
                        confidence_penalty=0.20,
                    ))

        return flags

    def _check_correlation(
        self, home: str, away: str, market: str
    ) -> Optional[RiskFlag]:
        """Check if we already have correlated bets on this game."""
        same_game = [
            b for b in self.active_bets
            if b["home"] == home and b["away"] == away
        ]
        if len(same_game) >= MAX_CORRELATION_EXPOSURE:
            return RiskFlag(
                code="CORRELATED_EXPOSURE",
                severity="warning",
                description=f"Already {len(same_game)} bets on this game — high correlation risk",
                confidence_penalty=0.2,
            )
        return None
