"""
BetAnalytics Quant Engine — Global Configuration
"""
import os


# ── MLB League Averages (updated seasonally) ──
MLB_LEAGUE_AVG = {
    "runs_per_game": 4.52,
    "era": 4.17,
    "whip": 1.27,
    "k_per_9": 8.58,
    "bb_per_9": 3.22,
    "babip": 0.295,
    "hr_per_9": 1.32,
    "ops": 0.718,
    "slg": 0.405,
    "obp": 0.313,
    "iso": 0.157,           # isolated power
    "woba": 0.312,
    "wrc_plus_avg": 100,
    "fip_avg": 4.15,
}

# ── Home field advantage ──
HOME_ADVANTAGE = 0.038      # ~3.8% win% boost (historical MLB)

# ── Monte Carlo ──
MC_SIMULATIONS = 15_000
MC_SEED = 42

# ── ML ──
ML_RETRAIN_DAYS = 7
ML_MIN_SAMPLES = 500
ML_ROLLING_WINDOW_DAYS = 365
ML_ENSEMBLE_WEIGHTS = {
    "poisson": 0.25,
    "montecarlo": 0.30,
    "ml": 0.45,
}

# ── EV Thresholds ──
EV_MIN_THRESHOLD = 0.02     # 2% minimum EV to consider
EV_STRONG_THRESHOLD = 0.05  # 5% = strong signal
EV_MAX_THRESHOLD = 0.20     # >20% likely bad data, flag it

# ── Kelly ──
KELLY_FRACTION = 0.25       # quarter-Kelly
KELLY_MAX_BET = 0.05        # 5% max bankroll per bet
KELLY_MIN_BET = 0.005       # 0.5% minimum to bother

# ── Risk ──
MAX_CORRELATION_EXPOSURE = 3    # max correlated bets per slate
MAX_DAILY_BETS = 15
MIN_EDGE_PERCENT = 3.0          # minimum edge % to place
CONFIDENCE_DECAY_SMALL_SAMPLE = 0.7

# ── CLV ──
CLV_POSITIVE_THRESHOLD = 1.5   # 1.5 cents = good CLV
CLV_WINDOW_HOURS = 4           # how long before close to capture CLV

# ── Redis keys ──
REDIS_PREFIX = "ba:"
REDIS_LINES_KEY = f"{REDIS_PREFIX}lines"
REDIS_EV_CACHE_KEY = f"{REDIS_PREFIX}ev_cache"
REDIS_PICKS_KEY = f"{REDIS_PREFIX}active_picks"
REDIS_TTL = 3600

# ── DB ──
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://betadmin:password@localhost:5432/betanalytics")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
