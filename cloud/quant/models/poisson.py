"""
BetAnalytics — Advanced MLB Poisson Model

Core probability engine. Projects run-scoring rates using Poisson distribution
with pitcher-quality adjustments, park factors, platoon splits, and bullpen decay.

Unlike simple Poisson (lambda = avg runs), this model decomposes lambda into:
  lambda = offensive_factor * pitching_factor * park_factor * situational_adj

This gives us a context-aware run expectation per team per game.
"""
import math
from dataclasses import dataclass, field
from typing import Optional

from ..config import MLB_LEAGUE_AVG, HOME_ADVANTAGE


@dataclass
class PitcherProfile:
    name: str
    era: float
    whip: float
    k_per_9: float
    bb_per_9: float = 0.0
    ip_season: float = 0.0          # innings pitched this season
    fip: float = 0.0                # fielding independent pitching
    hr_per_9: float = 0.0
    left_handed: bool = False
    # Recent form (last 5 starts)
    era_last5: Optional[float] = None
    whip_last5: Optional[float] = None


@dataclass
class TeamProfile:
    name: str
    runs_per_game: float
    ops: float = 0.0
    slg: float = 0.0
    obp: float = 0.0
    woba: float = 0.0
    wrc_plus: float = 100.0
    iso: float = 0.0                # isolated power
    k_rate: float = 0.0            # strikeout rate
    bb_rate: float = 0.0           # walk rate
    # Splits
    ops_vs_lhp: float = 0.0
    ops_vs_rhp: float = 0.0
    # Form
    win_pct_last10: float = 0.5
    runs_per_game_last10: float = 0.0
    # Bullpen
    bullpen_era: float = 4.0
    bullpen_whip: float = 1.3
    # NRFI
    nrfi_pct: float = 0.5          # % of games with 0 runs in 1st inning


@dataclass
class GameContext:
    park_factor: float = 1.0        # >1 = hitter friendly, <1 = pitcher friendly
    weather_factor: float = 1.0     # wind, temp adjustments
    umpire_factor: float = 1.0      # umpire run-scoring tendencies
    is_day_game: bool = False
    market_total: Optional[float] = None


@dataclass
class PoissonOutput:
    home_lambda: float
    away_lambda: float
    home_win_prob: float
    away_win_prob: float
    over_probs: dict                # {total: probability}
    under_probs: dict
    score_matrix: list              # 15x15 score probability matrix
    expected_total: float
    run_line_home_prob: float       # home -1.5
    run_line_away_prob: float       # away +1.5
    f5_home_lambda: float
    f5_away_lambda: float
    f5_home_win_prob: float
    f5_over_probs: dict
    nrfi_prob: float
    yrfi_prob: float
    metadata: dict = field(default_factory=dict)


class MLBPoissonModel:
    """
    Advanced Poisson model for MLB run projection.

    Decomposition:
      raw_lambda = team_offensive_factor * opposing_pitcher_factor * park * situation
      adjusted_lambda = anchor(raw_lambda, market_total) if market available

    Score matrix: P(home=h, away=a) = P_poisson(h|lam_h) * P_poisson(a|lam_a)
    with overdispersion correction for variance underestimation.
    """

    MAX_RUNS = 15
    OVERDISPERSION = 1.12   # Poisson underestimates variance in baseball

    def __init__(self):
        self.lg = MLB_LEAGUE_AVG

    def project(
        self,
        home_team: TeamProfile,
        away_team: TeamProfile,
        home_pitcher: PitcherProfile,
        away_pitcher: PitcherProfile,
        context: GameContext = None,
    ) -> PoissonOutput:
        ctx = context or GameContext()

        # ── Step 1: Offensive strength (relative to league) ──
        home_off = self._offensive_factor(home_team)
        away_off = self._offensive_factor(away_team)

        # ── Step 2: Pitcher quality (suppression factor) ──
        home_pitch = self._pitcher_factor(away_pitcher, home_team)  # away pitcher faces home lineup
        away_pitch = self._pitcher_factor(home_pitcher, away_team)  # home pitcher faces away lineup

        # ── Step 3: Compose lambda ──
        base = self.lg["runs_per_game"]

        home_lambda_raw = base * home_off * home_pitch * (1 + HOME_ADVANTAGE)
        away_lambda_raw = base * away_off * away_pitch

        # ── Step 4: Park + weather + umpire ──
        home_lambda_raw *= ctx.park_factor * ctx.weather_factor * ctx.umpire_factor
        away_lambda_raw *= ctx.park_factor * ctx.weather_factor * ctx.umpire_factor

        # ── Step 5: Form adjustment (last 10 games) ──
        home_lambda_raw *= self._form_factor(home_team)
        away_lambda_raw *= self._form_factor(away_team)

        # ── Step 6: Bullpen decay (add runs for weak bullpens) ──
        home_lambda_raw += self._bullpen_leak(away_team)  # away bullpen leaks runs for home
        away_lambda_raw += self._bullpen_leak(home_team)  # home bullpen leaks runs for away

        # ── Step 7: Market anchoring (if available) ──
        if ctx.market_total and ctx.market_total > 0:
            home_lambda, away_lambda = self._anchor_to_market(
                home_lambda_raw, away_lambda_raw, ctx.market_total
            )
        else:
            home_lambda = home_lambda_raw
            away_lambda = away_lambda_raw

        # ── Step 8: Clamp ──
        home_lambda = max(1.5, min(9.5, home_lambda))
        away_lambda = max(1.5, min(9.5, away_lambda))

        # ── Step 9: Build score matrix ──
        matrix = self._build_score_matrix(home_lambda, away_lambda)

        # ── Step 10: Extract probabilities ──
        home_wp, away_wp = self._win_probabilities(matrix)
        over_probs, under_probs = self._total_probabilities(matrix)
        rl_home, rl_away = self._run_line_probs(matrix)

        # ── Step 11: F5 (first 5 innings) ──
        f5_factor = 0.58  # ~58% of runs scored in first 5 innings
        f5_home = home_lambda * f5_factor
        f5_away = away_lambda * f5_factor
        f5_matrix = self._build_score_matrix(f5_home, f5_away, max_runs=10)
        f5_home_wp, _ = self._win_probabilities(f5_matrix)
        f5_over_probs, _ = self._total_probabilities(f5_matrix)

        # ── Step 12: NRFI/YRFI ──
        nrfi = self._nrfi_probability(home_team, away_team, home_pitcher, away_pitcher)

        return PoissonOutput(
            home_lambda=round(home_lambda, 3),
            away_lambda=round(away_lambda, 3),
            home_win_prob=round(home_wp, 4),
            away_win_prob=round(away_wp, 4),
            over_probs={k: round(v, 4) for k, v in over_probs.items()},
            under_probs={k: round(v, 4) for k, v in under_probs.items()},
            score_matrix=matrix,
            expected_total=round(home_lambda + away_lambda, 2),
            run_line_home_prob=round(rl_home, 4),
            run_line_away_prob=round(rl_away, 4),
            f5_home_lambda=round(f5_home, 3),
            f5_away_lambda=round(f5_away, 3),
            f5_home_win_prob=round(f5_home_wp, 4),
            f5_over_probs={k: round(v, 4) for k, v in f5_over_probs.items()},
            nrfi_prob=round(nrfi, 4),
            yrfi_prob=round(1 - nrfi, 4),
            metadata={
                "home_off_factor": round(home_off, 3),
                "away_off_factor": round(away_off, 3),
                "home_pitcher_factor": round(away_pitch, 3),
                "away_pitcher_factor": round(home_pitch, 3),
                "park_factor": ctx.park_factor,
                "overdispersion": self.OVERDISPERSION,
            },
        )

    # ═══════════════════════════════════════════
    # Factor decomposition
    # ═══════════════════════════════════════════

    def _offensive_factor(self, team: TeamProfile) -> float:
        """
        How much stronger/weaker than league average is this offense?
        Uses wRC+ as primary (already park/league adjusted), with OPS fallback.
        """
        if team.wrc_plus and team.wrc_plus > 0:
            return team.wrc_plus / 100.0

        if team.ops > 0:
            return team.ops / self.lg["ops"]

        if team.runs_per_game > 0:
            return team.runs_per_game / self.lg["runs_per_game"]

        return 1.0

    def _pitcher_factor(self, pitcher: PitcherProfile, facing_team: TeamProfile) -> float:
        """
        Pitcher suppression factor. <1 = pitcher suppresses runs, >1 = gives up more.

        Uses FIP when available (more predictive than ERA), with platoon adjustments.
        """
        # Primary: FIP-based (fielding independent)
        if pitcher.fip > 0:
            base_factor = pitcher.fip / self.lg["fip_avg"]
        elif pitcher.era > 0:
            base_factor = pitcher.era / self.lg["era"]
        else:
            return 1.0

        # WHIP modifier
        if pitcher.whip > 0:
            whip_mod = pitcher.whip / self.lg["whip"]
            base_factor = base_factor * 0.65 + whip_mod * 0.35

        # K/9 modifier (high K suppresses further)
        if pitcher.k_per_9 > 0:
            k_mod = self.lg["k_per_9"] / max(pitcher.k_per_9, 3.0)
            base_factor *= (0.85 + 0.15 * k_mod)

        # Platoon split: LHP vs lineup OPS splits
        if pitcher.left_handed and facing_team.ops_vs_lhp > 0:
            platoon = facing_team.ops_vs_lhp / self.lg["ops"]
            base_factor *= (0.8 + 0.2 * platoon)
        elif not pitcher.left_handed and facing_team.ops_vs_rhp > 0:
            platoon = facing_team.ops_vs_rhp / self.lg["ops"]
            base_factor *= (0.8 + 0.2 * platoon)

        # Recent form weight (last 5 starts)
        if pitcher.era_last5 is not None and pitcher.era_last5 > 0:
            recent_factor = pitcher.era_last5 / self.lg["era"]
            base_factor = base_factor * 0.6 + recent_factor * 0.4

        # Innings pitched reliability — low IP = regress toward league avg
        if 0 < pitcher.ip_season < 40:
            reliability = pitcher.ip_season / 40.0
            base_factor = base_factor * reliability + 1.0 * (1 - reliability)

        return max(0.5, min(2.0, base_factor))

    def _form_factor(self, team: TeamProfile) -> float:
        """Recent form adjustment. Capped at ±8%."""
        if team.win_pct_last10 <= 0:
            return 1.0
        deviation = team.win_pct_last10 - 0.5
        return 1.0 + max(-0.08, min(0.08, deviation * 0.15))

    def _bullpen_leak(self, team: TeamProfile) -> float:
        """Extra runs added from weak bullpen (last ~4 innings)."""
        if team.bullpen_era <= 0:
            return 0.0
        bullpen_diff = (team.bullpen_era - self.lg["era"]) / self.lg["era"]
        leak = bullpen_diff * 0.4  # bullpen covers ~4 of 9 innings
        return max(0.0, min(0.8, leak))

    def _anchor_to_market(
        self, home_lam: float, away_lam: float, market_total: float
    ) -> tuple[float, float]:
        """
        Blend model total with market total.
        Market is efficient but not perfect — 60% market, 40% model.
        Preserve the home/away ratio from the model.
        """
        model_total = home_lam + away_lam
        if model_total <= 0:
            return home_lam, away_lam

        blended_total = model_total * 0.40 + market_total * 0.60
        ratio = home_lam / model_total

        return blended_total * ratio, blended_total * (1 - ratio)

    # ═══════════════════════════════════════════
    # Probability calculations
    # ═══════════════════════════════════════════

    def _poisson_pmf(self, k: int, lam: float) -> float:
        """P(X = k) with overdispersion adjustment via negative binomial approx."""
        # Standard Poisson
        p = (lam ** k) * math.exp(-lam) / math.factorial(k)
        # Overdispersion: spread mass slightly toward tails
        if self.OVERDISPERSION > 1.0 and k > 0:
            r = lam / (self.OVERDISPERSION - 1)
            nb_p = r / (r + lam)
            # Negative binomial PMF
            try:
                from math import lgamma
                log_p = (
                    lgamma(k + r) - lgamma(k + 1) - lgamma(r)
                    + r * math.log(nb_p) + k * math.log(1 - nb_p)
                )
                p_nb = math.exp(log_p)
                p = p * 0.5 + p_nb * 0.5  # blend
            except (ValueError, OverflowError):
                pass
        return p

    def _build_score_matrix(
        self, home_lam: float, away_lam: float, max_runs: int = None
    ) -> list[list[float]]:
        n = max_runs or self.MAX_RUNS
        home_pmf = [self._poisson_pmf(i, home_lam) for i in range(n)]
        away_pmf = [self._poisson_pmf(i, away_lam) for i in range(n)]

        matrix = []
        for h in range(n):
            row = []
            for a in range(n):
                row.append(home_pmf[h] * away_pmf[a])
            matrix.append(row)
        return matrix

    def _win_probabilities(self, matrix: list) -> tuple[float, float]:
        n = len(matrix)
        home_win = 0.0
        away_win = 0.0
        draw = 0.0
        for h in range(n):
            for a in range(n):
                if h > a:
                    home_win += matrix[h][a]
                elif a > h:
                    away_win += matrix[h][a]
                else:
                    draw += matrix[h][a]
        # Redistribute draws (no ties in MLB)
        total_decisive = home_win + away_win
        if total_decisive > 0:
            home_win += draw * (home_win / total_decisive)
            away_win += draw * (away_win / total_decisive)
        return home_win, away_win

    def _total_probabilities(self, matrix: list) -> tuple[dict, dict]:
        n = len(matrix)
        total_dist = {}
        for h in range(n):
            for a in range(n):
                t = h + a
                total_dist[t] = total_dist.get(t, 0) + matrix[h][a]

        # Generate over/under for common lines
        over_probs = {}
        under_probs = {}
        max_total = max(total_dist.keys()) if total_dist else 20

        for line_x2 in range(10, min(max_total * 2 + 1, 40)):
            line = line_x2 / 2.0
            over = sum(p for t, p in total_dist.items() if t > line)
            under = sum(p for t, p in total_dist.items() if t < line)
            over_probs[line] = over
            under_probs[line] = under

        return over_probs, under_probs

    def _run_line_probs(self, matrix: list) -> tuple[float, float]:
        """Home -1.5 / Away +1.5"""
        n = len(matrix)
        home_cover = 0.0
        for h in range(n):
            for a in range(n):
                if h - a >= 2:  # home wins by 2+
                    home_cover += matrix[h][a]
        return home_cover, 1 - home_cover

    def _nrfi_probability(
        self,
        home_team: TeamProfile,
        away_team: TeamProfile,
        home_pitcher: PitcherProfile,
        away_pitcher: PitcherProfile,
    ) -> float:
        """
        NRFI = No Runs First Inning.
        Model: P(NRFI) = P(home_pitcher_clean) * P(away_pitcher_clean)

        Each pitcher's clean-inning prob is based on:
        - Team NRFI historical rate
        - Pitcher K/9 (higher K = more likely clean)
        - Pitcher ERA quality
        """
        def pitcher_clean_prob(pitcher: PitcherProfile, facing: TeamProfile) -> float:
            base = facing.nrfi_pct if facing.nrfi_pct > 0 else 0.5

            # K/9 boost
            if pitcher.k_per_9 > 0:
                k_mod = min(1.15, pitcher.k_per_9 / self.lg["k_per_9"])
                base *= (0.7 + 0.3 * k_mod)

            # ERA quality
            if pitcher.era > 0:
                era_mod = self.lg["era"] / max(pitcher.era, 1.5)
                base *= (0.6 + 0.4 * min(1.3, era_mod))

            return max(0.3, min(0.9, base))

        p_clean_top = pitcher_clean_prob(home_pitcher, away_team)
        p_clean_bot = pitcher_clean_prob(away_pitcher, home_team)

        return p_clean_top * p_clean_bot
