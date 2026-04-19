"""
BetAnalytics — Ensemble Model

Combines Poisson, Monte Carlo, and ML predictions into a single
calibrated probability for each market.

Weighting strategy:
  - Early season (low ML samples): heavier on Poisson/MC
  - Mid season (ML trained): heavier on ML
  - Dynamic: if ML confidence is low, reduce its weight

Output: final probabilities for all markets.
"""
from dataclasses import dataclass, field
from typing import Optional

from ..config import ML_ENSEMBLE_WEIGHTS
from .poisson import PoissonOutput
from .montecarlo import MCOutput
from .ml_model import MLPrediction


@dataclass
class EnsembleOutput:
    """Final combined probabilities for all markets."""
    # Moneyline
    home_win_prob: float
    away_win_prob: float
    # Total
    expected_total: float
    over_probs: dict             # {line: prob}
    under_probs: dict
    # Run line
    home_minus_1_5: float
    away_plus_1_5: float
    # F5
    f5_home_win_prob: float
    f5_expected_total: float
    f5_over_probs: dict
    # NRFI
    nrfi_prob: float
    yrfi_prob: float
    # Confidence
    confidence: float            # 0-1
    model_agreement: float       # how much models agree (0-1)
    # Weights used
    weights_used: dict
    # Component outputs
    poisson: Optional[PoissonOutput] = None
    montecarlo: Optional[MCOutput] = None
    ml: Optional[MLPrediction] = None
    metadata: dict = field(default_factory=dict)


class EnsembleModel:
    """
    Weighted ensemble of Poisson + Monte Carlo + ML.

    Dynamic weighting:
      w_ml = base_w * ml_confidence
      w_poisson, w_mc rebalanced with remaining weight
    """

    def __init__(self, weights: dict = None):
        self.base_weights = weights or ML_ENSEMBLE_WEIGHTS

    def combine(
        self,
        poisson: PoissonOutput,
        mc: MCOutput,
        ml: Optional[MLPrediction] = None,
    ) -> EnsembleOutput:
        # ── Compute dynamic weights ──
        w = self._dynamic_weights(ml)

        # ── Moneyline ──
        home_wp = (
            poisson.home_win_prob * w["poisson"]
            + mc.home_win_prob * w["montecarlo"]
        )
        if ml and ml.confidence > 0.2:
            home_wp += ml.home_win_prob * w["ml"]
        else:
            # Redistribute ML weight
            total_non_ml = w["poisson"] + w["montecarlo"]
            home_wp = (
                poisson.home_win_prob * (w["poisson"] / total_non_ml)
                + mc.home_win_prob * (w["montecarlo"] / total_non_ml)
            )

        home_wp = max(0.10, min(0.90, home_wp))
        away_wp = 1 - home_wp

        # ── Total ──
        expected_total = (
            poisson.expected_total * w["poisson"]
            + mc.expected_total * w["montecarlo"]
        )
        if ml and ml.confidence > 0.2:
            expected_total += ml.expected_total * w["ml"]
        else:
            total_w = w["poisson"] + w["montecarlo"]
            expected_total = (
                poisson.expected_total * (w["poisson"] / total_w)
                + mc.expected_total * (w["montecarlo"] / total_w)
            )

        # ── Over/Under (blend Poisson + MC) ──
        over_probs = {}
        under_probs = {}
        all_lines = set(poisson.over_probs.keys()) | set(mc.over_probs.keys())
        for line in all_lines:
            p_over = poisson.over_probs.get(line, 0.5)
            mc_over = mc.over_probs.get(line, 0.5)
            blended = p_over * 0.4 + mc_over * 0.6  # MC better for totals (captures variance)
            over_probs[line] = round(blended, 4)
            under_probs[line] = round(1 - blended, 4)

        # ── Run line (MC more reliable for spread) ──
        home_m15 = poisson.run_line_home_prob * 0.35 + mc.home_minus_1_5 * 0.65

        # ── F5 ──
        f5_home_wp = poisson.f5_home_win_prob * 0.4 + mc.f5_home_win_prob * 0.6
        f5_total = (poisson.f5_home_lambda + poisson.f5_away_lambda) * 0.4 + mc.f5_expected_total * 0.6
        f5_over = {}
        f5_lines = set(poisson.f5_over_probs.keys()) | set(mc.f5_over_probs.keys())
        for line in f5_lines:
            p = poisson.f5_over_probs.get(line, 0.5)
            m = mc.f5_over_probs.get(line, 0.5)
            f5_over[line] = round(p * 0.4 + m * 0.6, 4)

        # ── NRFI ──
        nrfi = poisson.nrfi_prob * 0.4 + mc.nrfi_prob * 0.6

        # ── Confidence ──
        agreement = self._model_agreement(poisson, mc, ml)
        confidence = agreement * 0.6
        if ml and ml.confidence > 0:
            confidence += ml.confidence * 0.4

        return EnsembleOutput(
            home_win_prob=round(home_wp, 4),
            away_win_prob=round(away_wp, 4),
            expected_total=round(expected_total, 2),
            over_probs=over_probs,
            under_probs=under_probs,
            home_minus_1_5=round(home_m15, 4),
            away_plus_1_5=round(1 - home_m15, 4),
            f5_home_win_prob=round(f5_home_wp, 4),
            f5_expected_total=round(f5_total, 2),
            f5_over_probs=f5_over,
            nrfi_prob=round(nrfi, 4),
            yrfi_prob=round(1 - nrfi, 4),
            confidence=round(confidence, 3),
            model_agreement=round(agreement, 3),
            weights_used=w,
            poisson=poisson,
            montecarlo=mc,
            ml=ml,
        )

    def _dynamic_weights(self, ml: Optional[MLPrediction]) -> dict:
        w = dict(self.base_weights)

        if ml is None or ml.model_version == "fallback":
            # No ML — split between Poisson and MC
            w["ml"] = 0.0
            w["poisson"] = 0.40
            w["montecarlo"] = 0.60
        elif ml.confidence < 0.3:
            # Low confidence ML — reduce weight
            w["ml"] = w["ml"] * ml.confidence
            remaining = 1.0 - w["ml"]
            ratio = self.base_weights["poisson"] / (self.base_weights["poisson"] + self.base_weights["montecarlo"])
            w["poisson"] = remaining * ratio
            w["montecarlo"] = remaining * (1 - ratio)

        # Normalize
        total = sum(w.values())
        return {k: round(v / total, 3) for k, v in w.items()}

    def _model_agreement(
        self,
        poisson: PoissonOutput,
        mc: MCOutput,
        ml: Optional[MLPrediction],
    ) -> float:
        """
        How much do models agree on who wins? 1.0 = perfect agreement.
        """
        probs = [poisson.home_win_prob, mc.home_win_prob]
        if ml and ml.model_version != "fallback":
            probs.append(ml.home_win_prob)

        # All above 0.5 or all below 0.5 = high agreement
        above = sum(1 for p in probs if p > 0.5)
        all_agree = above == len(probs) or above == 0

        if not all_agree:
            return 0.3  # Disagreement

        # Measure spread
        spread = max(probs) - min(probs)
        return max(0.4, 1.0 - spread * 2)
