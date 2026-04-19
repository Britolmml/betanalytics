"""
BetAnalytics — Monte Carlo Simulation Engine

Runs 15,000+ game simulations per matchup using negative binomial
distributions (accounts for overdispersion that Poisson misses).

Each simulation independently generates:
  - Inning-by-inning scoring (models NRFI, F5, full game)
  - Starter vs bullpen transition (pitch count / innings limit)
  - Run environment shifts mid-game

Output: empirical probability distributions for every market.
"""
import numpy as np
from dataclasses import dataclass, field
from typing import Optional

from ..config import MC_SIMULATIONS, MC_SEED
from .poisson import PitcherProfile, TeamProfile, GameContext, MLBPoissonModel


@dataclass
class MCOutput:
    n_sims: int
    # Full game
    home_win_prob: float
    away_win_prob: float
    expected_home_runs: float
    expected_away_runs: float
    expected_total: float
    over_probs: dict             # {total_line: prob_over}
    under_probs: dict
    # Run line
    home_minus_1_5: float
    away_plus_1_5: float
    home_minus_2_5: float
    # F5 (first 5 innings)
    f5_home_win_prob: float
    f5_away_win_prob: float
    f5_expected_total: float
    f5_over_probs: dict
    # NRFI
    nrfi_prob: float
    yrfi_prob: float
    # Score distribution (top 10 most likely)
    top_scores: list
    # Spread distribution
    spread_distribution: dict
    # Confidence interval
    total_ci_90: tuple           # 5th and 95th percentile
    metadata: dict = field(default_factory=dict)


class MonteCarloEngine:
    """
    Simulates MLB games inning-by-inning.

    Scoring model per half-inning:
      - Starter innings (1-5/6): lambda from pitcher quality
      - Bullpen innings (6-9): lambda from team bullpen ERA
      - First inning gets separate lambda (for NRFI)
      - Extra innings use modified Manfred runner rule

    Uses negative binomial to capture variance > mean (overdispersion).
    """

    def __init__(self, n_sims: int = MC_SIMULATIONS, seed: int = MC_SEED):
        self.n_sims = n_sims
        self.rng = np.random.default_rng(seed)
        self.poisson_model = MLBPoissonModel()

    def simulate(
        self,
        home_team: TeamProfile,
        away_team: TeamProfile,
        home_pitcher: PitcherProfile,
        away_pitcher: PitcherProfile,
        context: GameContext = None,
    ) -> MCOutput:
        ctx = context or GameContext()

        # Get base lambdas from Poisson model
        poisson_out = self.poisson_model.project(
            home_team, away_team, home_pitcher, away_pitcher, ctx
        )
        home_lam = poisson_out.home_lambda
        away_lam = poisson_out.away_lambda

        # Compute per-phase lambdas
        params = self._build_phase_params(
            home_lam, away_lam,
            home_team, away_team,
            home_pitcher, away_pitcher,
        )

        # ── Run simulations ──
        home_runs = np.zeros(self.n_sims)
        away_runs = np.zeros(self.n_sims)
        home_f5 = np.zeros(self.n_sims)
        away_f5 = np.zeros(self.n_sims)
        first_inning_runs = np.zeros(self.n_sims)

        for sim in range(self.n_sims):
            h_runs, a_runs, h_f5, a_f5, fi_runs = self._simulate_game(params)
            home_runs[sim] = h_runs
            away_runs[sim] = a_runs
            home_f5[sim] = h_f5
            away_f5[sim] = a_f5
            first_inning_runs[sim] = fi_runs

        totals = home_runs + away_runs
        f5_totals = home_f5 + away_f5
        spreads = home_runs - away_runs

        # ── Extract results ──
        home_wp = float(np.mean(home_runs > away_runs))
        away_wp = float(np.mean(away_runs > home_runs))
        ties = float(np.mean(home_runs == away_runs))
        # Redistribute ties
        if home_wp + away_wp > 0:
            home_wp += ties * home_wp / (home_wp + away_wp)
            away_wp += ties * away_wp / (home_wp + away_wp - ties * home_wp / (home_wp + away_wp))

        # Over/under for common lines
        over_probs = {}
        under_probs = {}
        for line_x2 in range(10, 40):
            line = line_x2 / 2.0
            over_probs[line] = float(np.mean(totals > line))
            under_probs[line] = float(np.mean(totals < line))

        # F5
        f5_home_wp = float(np.mean(home_f5 > away_f5))
        f5_away_wp = float(np.mean(away_f5 > home_f5))
        f5_over_probs = {}
        for line_x2 in range(6, 24):
            line = line_x2 / 2.0
            f5_over_probs[line] = float(np.mean(f5_totals > line))

        # Run lines
        home_m15 = float(np.mean(spreads >= 2))
        away_p15 = float(np.mean(spreads <= 0))  # away wins or push to +1.5
        home_m25 = float(np.mean(spreads >= 3))

        # NRFI
        nrfi_prob = float(np.mean(first_inning_runs == 0))

        # Score distribution
        score_pairs = {}
        for h, a in zip(home_runs.astype(int), away_runs.astype(int)):
            key = f"{h}-{a}"
            score_pairs[key] = score_pairs.get(key, 0) + 1
        top_scores = sorted(score_pairs.items(), key=lambda x: -x[1])[:10]
        top_scores = [{"score": s, "prob": round(c / self.n_sims, 4)} for s, c in top_scores]

        # Spread distribution
        spread_dist = {}
        for s in np.unique(spreads):
            spread_dist[float(s)] = float(np.mean(spreads == s))

        # 90% CI for total
        ci_5 = float(np.percentile(totals, 5))
        ci_95 = float(np.percentile(totals, 95))

        return MCOutput(
            n_sims=self.n_sims,
            home_win_prob=round(home_wp, 4),
            away_win_prob=round(away_wp, 4),
            expected_home_runs=round(float(np.mean(home_runs)), 2),
            expected_away_runs=round(float(np.mean(away_runs)), 2),
            expected_total=round(float(np.mean(totals)), 2),
            over_probs={k: round(v, 4) for k, v in over_probs.items()},
            under_probs={k: round(v, 4) for k, v in under_probs.items()},
            home_minus_1_5=round(home_m15, 4),
            away_plus_1_5=round(away_p15, 4),
            home_minus_2_5=round(home_m25, 4),
            f5_home_win_prob=round(f5_home_wp, 4),
            f5_away_win_prob=round(f5_away_wp, 4),
            f5_expected_total=round(float(np.mean(f5_totals)), 2),
            f5_over_probs={k: round(v, 4) for k, v in f5_over_probs.items()},
            nrfi_prob=round(nrfi_prob, 4),
            yrfi_prob=round(1 - nrfi_prob, 4),
            top_scores=top_scores,
            spread_distribution=spread_dist,
            total_ci_90=(round(ci_5, 1), round(ci_95, 1)),
            metadata={
                "home_lambda": home_lam,
                "away_lambda": away_lam,
            },
        )

    def _build_phase_params(
        self,
        home_lam: float,
        away_lam: float,
        home_team: TeamProfile,
        away_team: TeamProfile,
        home_pitcher: PitcherProfile,
        away_pitcher: PitcherProfile,
    ) -> dict:
        """
        Build per-inning lambda parameters for simulation.

        Phases:
          - First inning: separate (for NRFI model)
          - Starter innings (2-5): based on starting pitcher
          - Late innings (6-9): based on bullpen
        """
        lg_era = self.poisson_model.lg["era"]

        # Per-inning lambda = game_lambda / 9
        home_per_inning = home_lam / 9.0
        away_per_inning = away_lam / 9.0

        # First inning adjustment (starters are sharper in 1st)
        first_inning_suppress = 0.85

        # Starter fatigue: innings 4-5 lambda increases slightly
        fatigue_factor = 1.08

        # Bullpen transition: use bullpen ERA relative to league
        home_bp_factor = home_team.bullpen_era / lg_era if home_team.bullpen_era > 0 else 1.0
        away_bp_factor = away_team.bullpen_era / lg_era if away_team.bullpen_era > 0 else 1.0

        return {
            "home_per_inning": home_per_inning,
            "away_per_inning": away_per_inning,
            "first_suppress": first_inning_suppress,
            "fatigue": fatigue_factor,
            "home_bp_factor": home_bp_factor,
            "away_bp_factor": away_bp_factor,
            "overdispersion": 1.15,
        }

    def _simulate_game(self, params: dict) -> tuple:
        """
        Simulate one complete game inning-by-inning.
        Returns: (home_total, away_total, home_f5, away_f5, first_inning_runs)
        """
        home_total = 0
        away_total = 0
        home_f5 = 0
        away_f5 = 0
        first_inning_runs = 0

        od = params["overdispersion"]

        for inning in range(1, 10):
            # Determine lambda for this inning
            if inning == 1:
                h_lam = params["away_per_inning"] * params["first_suppress"]
                a_lam = params["home_per_inning"] * params["first_suppress"]
            elif inning <= 5:
                h_lam = params["away_per_inning"]
                a_lam = params["home_per_inning"]
                if inning >= 4:
                    h_lam *= params["fatigue"]
                    a_lam *= params["fatigue"]
            else:
                # Bullpen
                h_lam = params["away_per_inning"] * params["away_bp_factor"]
                a_lam = params["home_per_inning"] * params["home_bp_factor"]

            # Sample from negative binomial (overdispersed Poisson)
            h_runs_inn = self._sample_neg_binom(h_lam, od)
            a_runs_inn = self._sample_neg_binom(a_lam, od)

            home_total += h_runs_inn
            away_total += a_runs_inn

            if inning <= 5:
                home_f5 += h_runs_inn
                away_f5 += a_runs_inn

            if inning == 1:
                first_inning_runs = h_runs_inn + a_runs_inn

        # Extra innings if tied (simplified)
        extra = 0
        while home_total == away_total and extra < 5:
            extra += 1
            lam = (params["home_per_inning"] + params["away_per_inning"]) / 2 * 1.1
            home_total += self._sample_neg_binom(lam, od)
            away_total += self._sample_neg_binom(lam, od)

        # If still tied after 5 extras, coin flip weighted by lambda ratio
        if home_total == away_total:
            ratio = params["home_per_inning"] / (params["home_per_inning"] + params["away_per_inning"])
            if self.rng.random() < ratio:
                home_total += 1
            else:
                away_total += 1

        return home_total, away_total, home_f5, away_f5, first_inning_runs

    def _sample_neg_binom(self, lam: float, overdispersion: float) -> int:
        """Sample from negative binomial (overdispersed Poisson)."""
        if lam <= 0.01:
            return 0
        if overdispersion <= 1.0:
            return int(self.rng.poisson(lam))

        # Negative binomial parametrization: mean=lam, var=lam*overdispersion
        r = lam / (overdispersion - 1)
        p = r / (r + lam)
        try:
            return int(self.rng.negative_binomial(max(1, int(r)), min(0.999, max(0.001, p))))
        except ValueError:
            return int(self.rng.poisson(lam))
