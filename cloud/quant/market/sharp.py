"""
BetAnalytics — Sharp Money Detection

Detects professional ("sharp") money vs public ("square") action.

Key signals:
  1. Reverse Line Movement (RLM): line moves opposite to public %
  2. Steam Moves: sudden, large line moves across multiple books
  3. Opening line respect: sharps bet early, public bets late

Sharp bettors are profitable long-term. When we detect sharp action
on a side, it's a positive signal for our model.
"""
import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class LineSnapshot:
    book: str
    odds_decimal: float
    timestamp: float
    implied_prob: float


@dataclass
class SharpSignal:
    signal_type: str             # "rlm", "steam", "sharp_consensus"
    direction: str               # "home", "away", "over", "under"
    strength: float              # 0-1 (how strong is the signal)
    description: str
    timestamp: float
    metadata: dict = field(default_factory=dict)


class SharpMoneyDetector:
    """
    Analyzes line movements and public betting percentages to detect
    where professional money is going.
    """

    # Thresholds
    RLM_PUBLIC_THRESHOLD = 0.65      # >65% public on one side
    RLM_MOVE_THRESHOLD = 0.03       # 3 cents of movement
    STEAM_MOVE_THRESHOLD = 0.05     # 5 cents across books
    STEAM_TIME_WINDOW = 300         # 5 minutes
    STEAM_MIN_BOOKS = 3             # movement at 3+ books

    def __init__(self):
        self.line_history: dict[str, list[LineSnapshot]] = {}  # event_id -> snapshots

    def record_line(
        self,
        event_id: str,
        book: str,
        odds_decimal: float,
    ):
        """Record a line observation for an event."""
        snapshot = LineSnapshot(
            book=book,
            odds_decimal=odds_decimal,
            timestamp=time.time(),
            implied_prob=1 / odds_decimal if odds_decimal > 1 else 1.0,
        )
        self.line_history.setdefault(event_id, []).append(snapshot)

    def detect_signals(
        self,
        event_id: str,
        public_pct_home: float = 0.5,
        public_pct_over: float = 0.5,
        opening_home_odds: float = 0.0,
        current_home_odds: float = 0.0,
        opening_total_odds: float = 0.0,
        current_total_odds: float = 0.0,
    ) -> list[SharpSignal]:
        """
        Detect all sharp signals for an event.
        """
        signals = []

        # 1. Reverse Line Movement (moneyline)
        rlm = self._detect_rlm(
            public_pct_home, opening_home_odds, current_home_odds, "moneyline"
        )
        if rlm:
            signals.append(rlm)

        # 2. Reverse Line Movement (total)
        rlm_total = self._detect_rlm_total(
            public_pct_over, opening_total_odds, current_total_odds
        )
        if rlm_total:
            signals.append(rlm_total)

        # 3. Steam moves
        steam = self._detect_steam(event_id)
        if steam:
            signals.extend(steam)

        return signals

    def get_sharp_lean(self, signals: list[SharpSignal]) -> dict:
        """
        Aggregate signals into a directional lean.
        Returns: {"direction": "home"/"away", "strength": 0-1, "signals": [...]}
        """
        if not signals:
            return {"direction": "none", "strength": 0, "signals": []}

        # Score each direction
        scores = {}
        for s in signals:
            scores[s.direction] = scores.get(s.direction, 0) + s.strength

        if not scores:
            return {"direction": "none", "strength": 0, "signals": signals}

        best = max(scores, key=scores.get)
        return {
            "direction": best,
            "strength": round(min(1.0, scores[best]), 3),
            "signals": [s for s in signals if s.direction == best],
        }

    # ═══════════════════════════════════════════
    # Detection methods
    # ═════════��═════════════════════════════════

    def _detect_rlm(
        self,
        public_pct_home: float,
        opening_odds: float,
        current_odds: float,
        market: str,
    ) -> Optional[SharpSignal]:
        """
        Reverse Line Movement: public on one side, line moves the other way.

        Example: 70% public on home, but home line goes from -150 to -140
        (getting worse for home) = sharp money on away.
        """
        if opening_odds <= 1 or current_odds <= 1:
            return None

        opening_implied = 1 / opening_odds
        current_implied = 1 / current_odds
        move = current_implied - opening_implied  # positive = home got more likely

        # Home RLM: public on home but line moves toward away
        if public_pct_home > self.RLM_PUBLIC_THRESHOLD and move < -self.RLM_MOVE_THRESHOLD:
            strength = min(1.0, abs(move) / 0.10 * (public_pct_home - 0.5) * 2)
            return SharpSignal(
                signal_type="rlm",
                direction="away",
                strength=round(strength, 3),
                description=f"RLM: {public_pct_home*100:.0f}% public on home but line moving to away ({move*100:+.1f} cents)",
                timestamp=time.time(),
                metadata={"public_pct": public_pct_home, "line_move": move},
            )

        # Away RLM
        public_pct_away = 1 - public_pct_home
        if public_pct_away > self.RLM_PUBLIC_THRESHOLD and move > self.RLM_MOVE_THRESHOLD:
            strength = min(1.0, abs(move) / 0.10 * (public_pct_away - 0.5) * 2)
            return SharpSignal(
                signal_type="rlm",
                direction="home",
                strength=round(strength, 3),
                description=f"RLM: {public_pct_away*100:.0f}% public on away but line moving to home ({move*100:+.1f} cents)",
                timestamp=time.time(),
                metadata={"public_pct": public_pct_away, "line_move": move},
            )

        return None

    def _detect_rlm_total(
        self,
        public_pct_over: float,
        opening_total: float,
        current_total: float,
    ) -> Optional[SharpSignal]:
        """RLM for totals: public on over but total drops (or vice versa)."""
        if opening_total <= 0 or current_total <= 0:
            return None

        move = current_total - opening_total

        if public_pct_over > self.RLM_PUBLIC_THRESHOLD and move < -0.25:
            strength = min(1.0, abs(move) / 1.0 * (public_pct_over - 0.5) * 2)
            return SharpSignal(
                signal_type="rlm",
                direction="under",
                strength=round(strength, 3),
                description=f"RLM Total: {public_pct_over*100:.0f}% public on over but total dropped {move:+.1f}",
                timestamp=time.time(),
            )

        public_pct_under = 1 - public_pct_over
        if public_pct_under > self.RLM_PUBLIC_THRESHOLD and move > 0.25:
            strength = min(1.0, abs(move) / 1.0 * (public_pct_under - 0.5) * 2)
            return SharpSignal(
                signal_type="rlm",
                direction="over",
                strength=round(strength, 3),
                description=f"RLM Total: {public_pct_under*100:.0f}% public on under but total rose {move:+.1f}",
                timestamp=time.time(),
            )

        return None

    def _detect_steam(self, event_id: str) -> list[SharpSignal]:
        """
        Steam move: sudden, synchronized line movement across 3+ books
        within a 5-minute window. Indicates large sharp action.
        """
        history = self.line_history.get(event_id, [])
        if len(history) < 6:
            return []

        signals = []
        now = time.time()
        recent = [s for s in history if now - s.timestamp <= self.STEAM_TIME_WINDOW]

        if len(recent) < self.STEAM_MIN_BOOKS:
            return []

        # Group by book, get the latest per book
        by_book = {}
        for s in sorted(recent, key=lambda x: x.timestamp):
            by_book[s.book] = s

        # Check if all books moved in same direction
        # Compare recent vs older snapshots
        older = [s for s in history if now - s.timestamp > self.STEAM_TIME_WINDOW]
        if not older:
            return []

        older_by_book = {}
        for s in older:
            older_by_book[s.book] = s

        moves = []
        for book, current in by_book.items():
            if book in older_by_book:
                move = current.implied_prob - older_by_book[book].implied_prob
                moves.append(move)

        if len(moves) < self.STEAM_MIN_BOOKS:
            return []

        # All positive or all negative?
        positive = sum(1 for m in moves if m > self.STEAM_MOVE_THRESHOLD)
        negative = sum(1 for m in moves if m < -self.STEAM_MOVE_THRESHOLD)

        if positive >= self.STEAM_MIN_BOOKS:
            avg_move = sum(m for m in moves if m > 0) / positive
            signals.append(SharpSignal(
                signal_type="steam",
                direction="home",
                strength=round(min(1.0, avg_move / 0.10), 3),
                description=f"Steam move: {positive} books moved toward home ({avg_move*100:+.1f} cents avg)",
                timestamp=now,
                metadata={"books_moved": positive, "avg_move": round(avg_move, 4)},
            ))

        if negative >= self.STEAM_MIN_BOOKS:
            avg_move = sum(m for m in moves if m < 0) / negative
            signals.append(SharpSignal(
                signal_type="steam",
                direction="away",
                strength=round(min(1.0, abs(avg_move) / 0.10), 3),
                description=f"Steam move: {negative} books moved toward away ({avg_move*100:+.1f} cents avg)",
                timestamp=now,
                metadata={"books_moved": negative, "avg_move": round(avg_move, 4)},
            ))

        return signals
