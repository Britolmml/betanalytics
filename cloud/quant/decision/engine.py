"""
BetAnalytics — Decision Engine

The final gatekeeper. Takes model outputs, market analysis, and risk assessment
to produce actionable picks with sizing.

Flow:
  1. Ensemble model → probabilities
  2. EV calculator → expected value per market/book
  3. Sharp detector → market signals
  4. Risk manager → approval + confidence adjustment
  5. Kelly → bet sizing
  6. Decision engine → final ranked picks

Only EV+ picks with risk approval pass through.
"""
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

from ..models.ensemble import EnsembleOutput
from ..market.ev import EVCalculator, EVResult
from ..market.kelly import KellyCalculator, KellyResult
from ..market.sharp import SharpMoneyDetector, SharpSignal
from ..risk.manager import RiskManager, RiskAssessment
from ..config import EV_MIN_THRESHOLD, MIN_EDGE_PERCENT


@dataclass
class Pick:
    """A fully evaluated, approved betting opportunity."""
    pick_id: str
    timestamp: float
    # Game info
    home_team: str
    away_team: str
    event_id: str
    sport: str
    # Pick details
    market: str                  # moneyline, spread, total, f5, nrfi
    selection: str               # home, away, over, under
    line: Optional[float]        # spread/total value
    # Book
    best_book: str
    odds_decimal: float
    odds_american: int
    # Model outputs
    model_prob: float
    implied_prob: float
    ev: float
    ev_percent: float
    edge_percent: float
    # Sizing
    kelly_pct: float
    bet_size_usd: float
    # Signals
    sharp_direction: str
    sharp_strength: float
    # Risk
    confidence: float
    model_agreement: float
    risk_flags: list[str]
    # Rating
    grade: str                   # A+, A, B+, B, C (based on EV + confidence + sharp alignment)
    priority: int                # 1 = highest (for ordering)
    metadata: dict = field(default_factory=dict)


class DecisionEngine:
    """
    Orchestrates the full decision pipeline for a single game.

    Input: game data + odds from multiple books
    Output: list of approved Picks, sorted by priority
    """

    def __init__(self, bankroll: float = 10000.0):
        self.ev_calc = EVCalculator(min_ev=EV_MIN_THRESHOLD)
        self.kelly_calc = KellyCalculator()
        self.risk_mgr = RiskManager()
        self.sharp_detector = SharpMoneyDetector()
        self.bankroll = bankroll

    def evaluate_game(
        self,
        event_id: str,
        home_team: str,
        away_team: str,
        ensemble: EnsembleOutput,
        book_odds: dict,
        market_data: dict = None,
    ) -> list[Pick]:
        """
        Evaluate all markets for a game and return approved picks.

        book_odds format:
        {
            "moneyline": {
                "home": {"draftkings": 1.85, "fanduel": 1.90, ...},
                "away": {"draftkings": 2.05, "fanduel": 2.00, ...}
            },
            "total": {
                "line": 8.5,
                "over": {"draftkings": 1.90, "fanduel": 1.87, ...},
                "under": {"draftkings": 1.90, "fanduel": 1.93, ...}
            },
            "run_line": {
                "home_-1.5": {"draftkings": 2.20, ...},
                "away_+1.5": {"draftkings": 1.70, ...}
            },
            ...
        }
        """
        mkt = market_data or {}
        picks = []

        # Detect sharp signals
        sharp_signals = self.sharp_detector.detect_signals(
            event_id=event_id,
            public_pct_home=mkt.get("public_pct_home", 0.5),
            public_pct_over=mkt.get("public_pct_over", 0.5),
            opening_home_odds=mkt.get("opening_home_ml", 0),
            current_home_odds=mkt.get("current_home_ml", 0),
            opening_total_odds=mkt.get("opening_total", 0),
            current_total_odds=mkt.get("current_total", 0),
        )
        sharp_lean = self.sharp_detector.get_sharp_lean(sharp_signals)

        # ── Evaluate each market ──

        # 1. Moneyline
        if "moneyline" in book_odds:
            picks.extend(self._eval_moneyline(
                event_id, home_team, away_team, ensemble,
                book_odds["moneyline"], sharp_lean, sharp_signals, mkt,
            ))

        # 2. Total
        if "total" in book_odds:
            picks.extend(self._eval_total(
                event_id, home_team, away_team, ensemble,
                book_odds["total"], sharp_lean, sharp_signals, mkt,
            ))

        # 3. Run line
        if "run_line" in book_odds:
            picks.extend(self._eval_run_line(
                event_id, home_team, away_team, ensemble,
                book_odds["run_line"], sharp_signals, mkt,
            ))

        # 4. F5
        if "f5" in book_odds:
            picks.extend(self._eval_f5(
                event_id, home_team, away_team, ensemble,
                book_odds["f5"], sharp_signals, mkt,
            ))

        # 5. NRFI
        if "nrfi" in book_odds:
            picks.extend(self._eval_nrfi(
                event_id, home_team, away_team, ensemble,
                book_odds["nrfi"], mkt,
            ))

        # Sort by priority (grade → EV)
        picks.sort(key=lambda p: (p.priority, -p.ev_percent))

        # Portfolio Kelly adjustment
        if len(picks) > 1:
            bet_inputs = [
                {"model_prob": p.model_prob, "decimal_odds": p.odds_decimal, "confidence": p.confidence}
                for p in picks
            ]
            portfolio = self.kelly_calc.portfolio_kelly(bet_inputs, self.bankroll)
            for pick, kr in zip(picks, portfolio):
                pick.kelly_pct = kr.bet_size_pct
                pick.bet_size_usd = kr.bet_size_usd

        return picks

    # ═══════════════════════════════════════════
    # Market evaluators
    # ═══════════════════════════════════════════

    def _eval_moneyline(
        self, event_id, home, away, ens, ml_odds, sharp_lean, sharp_signals, mkt,
    ) -> list[Pick]:
        picks = []
        for side, prob in [("home", ens.home_win_prob), ("away", ens.away_win_prob)]:
            if side not in ml_odds:
                continue

            best_book, ev_result = self.ev_calc.best_odds_across_books(prob, ml_odds[side])
            if not ev_result or not ev_result.is_value:
                continue

            risk = self.risk_mgr.assess(
                ev=ev_result.ev, edge_pct=ev_result.edge_percent,
                model_confidence=ens.confidence, model_agreement=ens.model_agreement,
                home_team=home, away_team=away,
                market="moneyline", selection=side,
                pitcher_ip=mkt.get("pitcher_ip", 100),
                sharp_signals=sharp_signals,
            )
            if not risk.approved:
                continue

            kelly = self.kelly_calc.calculate(
                prob, ev_result.decimal_odds, self.bankroll, risk.adjusted_confidence
            )

            grade, priority = self._compute_grade(
                ev_result, risk, sharp_lean, side, "moneyline"
            )

            picks.append(Pick(
                pick_id=str(uuid.uuid4())[:8],
                timestamp=time.time(),
                home_team=home, away_team=away,
                event_id=event_id, sport="mlb",
                market="moneyline", selection=side, line=None,
                best_book=best_book,
                odds_decimal=ev_result.decimal_odds,
                odds_american=ev_result.american_odds,
                model_prob=ev_result.model_prob,
                implied_prob=ev_result.implied_prob,
                ev=ev_result.ev, ev_percent=ev_result.ev_percent,
                edge_percent=ev_result.edge_percent,
                kelly_pct=kelly.bet_size_pct,
                bet_size_usd=kelly.bet_size_usd,
                sharp_direction=sharp_lean["direction"],
                sharp_strength=sharp_lean["strength"],
                confidence=risk.adjusted_confidence,
                model_agreement=ens.model_agreement,
                risk_flags=[f.code for f in risk.flags],
                grade=grade, priority=priority,
            ))

        return picks

    def _eval_total(
        self, event_id, home, away, ens, total_odds, sharp_lean, sharp_signals, mkt,
    ) -> list[Pick]:
        picks = []
        line = total_odds.get("line", 0)
        if line <= 0:
            return []

        for side, probs_dict in [("over", ens.over_probs), ("under", ens.under_probs)]:
            if side not in total_odds:
                continue

            prob = probs_dict.get(line, 0.5)
            best_book, ev_result = self.ev_calc.best_odds_across_books(prob, total_odds[side])
            if not ev_result or not ev_result.is_value:
                continue

            risk = self.risk_mgr.assess(
                ev=ev_result.ev, edge_pct=ev_result.edge_percent,
                model_confidence=ens.confidence, model_agreement=ens.model_agreement,
                home_team=home, away_team=away,
                market="total", selection=side,
                sharp_signals=sharp_signals,
            )
            if not risk.approved:
                continue

            kelly = self.kelly_calc.calculate(
                prob, ev_result.decimal_odds, self.bankroll, risk.adjusted_confidence
            )

            grade, priority = self._compute_grade(
                ev_result, risk, sharp_lean, side, "total"
            )

            picks.append(Pick(
                pick_id=str(uuid.uuid4())[:8],
                timestamp=time.time(),
                home_team=home, away_team=away,
                event_id=event_id, sport="mlb",
                market="total", selection=side, line=line,
                best_book=best_book,
                odds_decimal=ev_result.decimal_odds,
                odds_american=ev_result.american_odds,
                model_prob=prob, implied_prob=ev_result.implied_prob,
                ev=ev_result.ev, ev_percent=ev_result.ev_percent,
                edge_percent=ev_result.edge_percent,
                kelly_pct=kelly.bet_size_pct, bet_size_usd=kelly.bet_size_usd,
                sharp_direction=sharp_lean["direction"],
                sharp_strength=sharp_lean["strength"],
                confidence=risk.adjusted_confidence,
                model_agreement=ens.model_agreement,
                risk_flags=[f.code for f in risk.flags],
                grade=grade, priority=priority,
            ))

        return picks

    def _eval_run_line(self, event_id, home, away, ens, rl_odds, sharp_signals, mkt) -> list[Pick]:
        picks = []
        for key, prob in [("home_-1.5", ens.home_minus_1_5), ("away_+1.5", ens.away_plus_1_5)]:
            if key not in rl_odds:
                continue
            side = "home" if "home" in key else "away"
            line = -1.5 if "home" in key else 1.5

            best_book, ev_result = self.ev_calc.best_odds_across_books(prob, rl_odds[key])
            if not ev_result or not ev_result.is_value:
                continue

            risk = self.risk_mgr.assess(
                ev=ev_result.ev, edge_pct=ev_result.edge_percent,
                model_confidence=ens.confidence, model_agreement=ens.model_agreement,
                home_team=home, away_team=away,
                market="run_line", selection=side,
                sharp_signals=sharp_signals,
            )
            if not risk.approved:
                continue

            kelly = self.kelly_calc.calculate(
                prob, ev_result.decimal_odds, self.bankroll, risk.adjusted_confidence
            )
            grade, priority = self._compute_grade(ev_result, risk, {"direction": "none", "strength": 0}, side, "run_line")

            picks.append(Pick(
                pick_id=str(uuid.uuid4())[:8], timestamp=time.time(),
                home_team=home, away_team=away, event_id=event_id, sport="mlb",
                market="run_line", selection=side, line=line,
                best_book=best_book, odds_decimal=ev_result.decimal_odds,
                odds_american=ev_result.american_odds,
                model_prob=prob, implied_prob=ev_result.implied_prob,
                ev=ev_result.ev, ev_percent=ev_result.ev_percent,
                edge_percent=ev_result.edge_percent,
                kelly_pct=kelly.bet_size_pct, bet_size_usd=kelly.bet_size_usd,
                sharp_direction="none", sharp_strength=0,
                confidence=risk.adjusted_confidence, model_agreement=ens.model_agreement,
                risk_flags=[f.code for f in risk.flags], grade=grade, priority=priority,
            ))
        return picks

    def _eval_f5(self, event_id, home, away, ens, f5_odds, sharp_signals, mkt) -> list[Pick]:
        picks = []
        # F5 moneyline
        for side, prob in [("home", ens.f5_home_win_prob), ("away", 1 - ens.f5_home_win_prob)]:
            key = f"ml_{side}"
            if key not in f5_odds:
                continue
            best_book, ev_result = self.ev_calc.best_odds_across_books(prob, f5_odds[key])
            if not ev_result or not ev_result.is_value:
                continue
            risk = self.risk_mgr.assess(
                ev=ev_result.ev, edge_pct=ev_result.edge_percent,
                model_confidence=ens.confidence * 0.9, model_agreement=ens.model_agreement,
                home_team=home, away_team=away, market="f5_ml", selection=side,
                sharp_signals=sharp_signals,
            )
            if not risk.approved:
                continue
            kelly = self.kelly_calc.calculate(prob, ev_result.decimal_odds, self.bankroll, risk.adjusted_confidence)
            grade, priority = self._compute_grade(ev_result, risk, {"direction": "none", "strength": 0}, side, "f5")

            picks.append(Pick(
                pick_id=str(uuid.uuid4())[:8], timestamp=time.time(),
                home_team=home, away_team=away, event_id=event_id, sport="mlb",
                market="f5_ml", selection=side, line=None,
                best_book=best_book, odds_decimal=ev_result.decimal_odds,
                odds_american=ev_result.american_odds,
                model_prob=prob, implied_prob=ev_result.implied_prob,
                ev=ev_result.ev, ev_percent=ev_result.ev_percent,
                edge_percent=ev_result.edge_percent,
                kelly_pct=kelly.bet_size_pct, bet_size_usd=kelly.bet_size_usd,
                sharp_direction="none", sharp_strength=0,
                confidence=risk.adjusted_confidence, model_agreement=ens.model_agreement,
                risk_flags=[f.code for f in risk.flags], grade=grade, priority=priority,
            ))
        return picks

    def _eval_nrfi(self, event_id, home, away, ens, nrfi_odds, mkt) -> list[Pick]:
        picks = []
        for side, prob in [("nrfi", ens.nrfi_prob), ("yrfi", ens.yrfi_prob)]:
            if side not in nrfi_odds:
                continue
            best_book, ev_result = self.ev_calc.best_odds_across_books(prob, nrfi_odds[side])
            if not ev_result or not ev_result.is_value:
                continue
            risk = self.risk_mgr.assess(
                ev=ev_result.ev, edge_pct=ev_result.edge_percent,
                model_confidence=ens.confidence * 0.85, model_agreement=ens.model_agreement,
                home_team=home, away_team=away, market="nrfi", selection=side,
            )
            if not risk.approved:
                continue
            kelly = self.kelly_calc.calculate(prob, ev_result.decimal_odds, self.bankroll, risk.adjusted_confidence)
            grade, _ = self._compute_grade(ev_result, risk, {"direction": "none", "strength": 0}, side, "nrfi")

            picks.append(Pick(
                pick_id=str(uuid.uuid4())[:8], timestamp=time.time(),
                home_team=home, away_team=away, event_id=event_id, sport="mlb",
                market="nrfi", selection=side, line=None,
                best_book=best_book, odds_decimal=ev_result.decimal_odds,
                odds_american=ev_result.american_odds,
                model_prob=prob, implied_prob=ev_result.implied_prob,
                ev=ev_result.ev, ev_percent=ev_result.ev_percent,
                edge_percent=ev_result.edge_percent,
                kelly_pct=kelly.bet_size_pct, bet_size_usd=kelly.bet_size_usd,
                sharp_direction="none", sharp_strength=0,
                confidence=risk.adjusted_confidence, model_agreement=ens.model_agreement,
                risk_flags=[f.code for f in risk.flags], grade=grade, priority=5,
            ))
        return picks

    # ═══════════════════════════════════════════
    # Grading
    # ═══════════════════════════════════════════

    def _compute_grade(
        self, ev_result: EVResult, risk: RiskAssessment,
        sharp_lean: dict, selection: str, market: str,
    ) -> tuple[str, int]:
        """
        Grade: A+ to C based on:
          - EV magnitude
          - Model confidence
          - Sharp money alignment
          - Risk flags
        """
        score = 0

        # EV contribution (0-40 points)
        score += min(40, ev_result.ev_percent * 4)

        # Confidence (0-30 points)
        score += risk.adjusted_confidence * 30

        # Sharp alignment (0-20 points)
        sharp_dir = sharp_lean.get("direction", "none")
        if sharp_dir == selection:
            score += sharp_lean.get("strength", 0) * 20
        elif sharp_dir != "none":
            score -= 10  # sharp against us

        # Risk penalty
        score -= len(risk.flags) * 5

        # Grade
        if score >= 70:
            return "A+", 1
        if score >= 55:
            return "A", 2
        if score >= 40:
            return "B+", 3
        if score >= 25:
            return "B", 4
        return "C", 5
