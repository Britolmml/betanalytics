"""
BetAnalytics — MLB Machine Learning Model

LightGBM gradient boosted trees for win probability + total prediction.
Auto-retrains on rolling window. Calibrated via isotonic regression.

Features:
  - Pitcher quality metrics (ERA, WHIP, K/9, FIP, recent form)
  - Offensive metrics (wRC+, OPS, ISO, wOBA)
  - Market signals (opening odds, line movement, public %)
  - Historical CLV performance
  - Situational (home/away, park factor, rest days)

Target: binary (win/loss) and regression (total runs)
"""
import os
import pickle
import warnings
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import numpy as np

from ..config import ML_MIN_SAMPLES, ML_ROLLING_WINDOW_DAYS, ML_RETRAIN_DAYS

warnings.filterwarnings("ignore", category=UserWarning)

# Lazy imports — these are heavy
_lgb = None
_sklearn = None


def _import_lgb():
    global _lgb
    if _lgb is None:
        import lightgbm as lgb
        _lgb = lgb
    return _lgb


def _import_sklearn():
    global _sklearn
    if _sklearn is None:
        import sklearn
        _sklearn = sklearn
    return _sklearn


# ── Feature definitions ──

FEATURE_COLUMNS = [
    # Pitcher (home starter)
    "hp_era", "hp_whip", "hp_k9", "hp_fip", "hp_bb9", "hp_hr9",
    "hp_ip_season", "hp_era_last5", "hp_is_lhp",
    # Pitcher (away starter)
    "ap_era", "ap_whip", "ap_k9", "ap_fip", "ap_bb9", "ap_hr9",
    "ap_ip_season", "ap_era_last5", "ap_is_lhp",
    # Offense (home)
    "h_rpg", "h_ops", "h_wrc_plus", "h_iso", "h_woba", "h_k_rate", "h_bb_rate",
    "h_rpg_last10", "h_win_pct_last10",
    # Offense (away)
    "a_rpg", "a_ops", "a_wrc_plus", "a_iso", "a_woba", "a_k_rate", "a_bb_rate",
    "a_rpg_last10", "a_win_pct_last10",
    # Bullpen
    "h_bp_era", "h_bp_whip", "a_bp_era", "a_bp_whip",
    # Situational
    "park_factor", "weather_factor",
    # Market signals
    "market_home_ml", "market_away_ml", "market_total",
    "opening_home_ml", "opening_total",
    "line_movement_ml", "line_movement_total",
    "public_pct_home",
    # Derived
    "pitcher_delta_era", "pitcher_delta_k9",
    "offense_delta_wrc", "offense_delta_ops",
    "model_home_prob",    # Poisson model probability
    "model_expected_total",
]


@dataclass
class MLPrediction:
    home_win_prob: float
    away_win_prob: float
    expected_total: float
    confidence: float           # model confidence (0-1)
    feature_importance: dict
    calibrated: bool
    model_version: str
    metadata: dict = field(default_factory=dict)


class MLBMLModel:
    """
    LightGBM-based MLB prediction model.

    Two sub-models:
      1. Classifier: P(home_win) — binary
      2. Regressor: Expected total runs

    Training pipeline:
      - Rolling window (365 days)
      - 5-fold time-series CV
      - Early stopping on validation loss
      - Isotonic regression calibration
    """

    MODEL_DIR = Path("models/trained")
    VERSION = "1.0.0"

    def __init__(self, model_dir: Optional[str] = None):
        self.model_dir = Path(model_dir) if model_dir else self.MODEL_DIR
        self.model_dir.mkdir(parents=True, exist_ok=True)

        self.classifier = None
        self.regressor = None
        self.calibrator = None
        self.feature_cols = FEATURE_COLUMNS
        self.last_trained = None
        self._load_models()

    # ═══════════════════════════════════════════
    # Prediction
    # ═══════════════════════════════════════════

    def predict(self, features: dict) -> MLPrediction:
        """
        Generate prediction from feature dict.
        Falls back to Poisson-only if ML model not trained yet.
        """
        if not self._is_ready():
            return MLPrediction(
                home_win_prob=features.get("model_home_prob", 0.5),
                away_win_prob=1 - features.get("model_home_prob", 0.5),
                expected_total=features.get("model_expected_total", 9.0),
                confidence=0.3,
                feature_importance={},
                calibrated=False,
                model_version="fallback",
            )

        lgb = _import_lgb()
        X = self._features_to_array(features)

        # Classifier
        raw_prob = float(self.classifier.predict(X)[0])

        # Calibrate
        calibrated = False
        if self.calibrator is not None:
            try:
                raw_prob = float(self.calibrator.predict(np.array([[raw_prob]]))[0])
                calibrated = True
            except Exception:
                pass

        home_prob = max(0.15, min(0.85, raw_prob))

        # Regressor
        expected_total = float(self.regressor.predict(X)[0])
        expected_total = max(4.0, min(18.0, expected_total))

        # Confidence = based on how decisive the prediction is + model depth
        confidence = self._compute_confidence(home_prob, features)

        # Feature importance
        importance = self._get_feature_importance()

        return MLPrediction(
            home_win_prob=round(home_prob, 4),
            away_win_prob=round(1 - home_prob, 4),
            expected_total=round(expected_total, 2),
            confidence=round(confidence, 3),
            feature_importance=importance,
            calibrated=calibrated,
            model_version=self.VERSION,
        )

    # ═══════════════════════════════════════════
    # Training
    # ═══════════════════════════════════════════

    def train(self, dataset: list[dict], force: bool = False):
        """
        Train on historical game data.

        dataset: list of dicts with all FEATURE_COLUMNS + 'home_win' (0/1) + 'total_runs'
        """
        lgb = _import_lgb()
        sklearn = _import_sklearn()
        from sklearn.isotonic import IsotonicRegression
        from sklearn.model_selection import TimeSeriesSplit

        if not force and not self._needs_retrain():
            return

        if len(dataset) < ML_MIN_SAMPLES:
            return

        # Filter to rolling window
        cutoff = datetime.now() - timedelta(days=ML_ROLLING_WINDOW_DAYS)
        dataset = [d for d in dataset if d.get("game_date", datetime.now()) >= cutoff]

        if len(dataset) < ML_MIN_SAMPLES:
            return

        # Build arrays
        X = np.array([self._features_to_array_from_dict(d) for d in dataset])
        y_class = np.array([d["home_win"] for d in dataset])
        y_reg = np.array([d["total_runs"] for d in dataset])

        # ── Classifier ──
        clf_params = {
            "objective": "binary",
            "metric": "binary_logloss",
            "num_leaves": 31,
            "learning_rate": 0.05,
            "feature_fraction": 0.8,
            "bagging_fraction": 0.8,
            "bagging_freq": 5,
            "min_child_samples": 20,
            "reg_alpha": 0.1,
            "reg_lambda": 0.5,
            "verbose": -1,
            "n_estimators": 1000,
        }

        # Time series CV
        tscv = TimeSeriesSplit(n_splits=5)
        best_clf = None
        best_score = float("inf")

        for train_idx, val_idx in tscv.split(X):
            X_train, X_val = X[train_idx], X[val_idx]
            y_train, y_val = y_class[train_idx], y_class[val_idx]

            clf = lgb.LGBMClassifier(**clf_params)
            clf.fit(
                X_train, y_train,
                eval_set=[(X_val, y_val)],
                callbacks=[lgb.early_stopping(50, verbose=False)],
            )

            score = clf.best_score_["valid_0"]["binary_logloss"]
            if score < best_score:
                best_score = score
                best_clf = clf

        self.classifier = best_clf

        # ── Regressor ──
        reg_params = {
            "objective": "regression",
            "metric": "rmse",
            "num_leaves": 31,
            "learning_rate": 0.05,
            "feature_fraction": 0.8,
            "bagging_fraction": 0.8,
            "bagging_freq": 5,
            "min_child_samples": 20,
            "reg_alpha": 0.1,
            "reg_lambda": 0.5,
            "verbose": -1,
            "n_estimators": 1000,
        }

        best_reg = None
        best_reg_score = float("inf")

        for train_idx, val_idx in tscv.split(X):
            X_train, X_val = X[train_idx], X[val_idx]
            y_train, y_val = y_reg[train_idx], y_reg[val_idx]

            reg = lgb.LGBMRegressor(**reg_params)
            reg.fit(
                X_train, y_train,
                eval_set=[(X_val, y_val)],
                callbacks=[lgb.early_stopping(50, verbose=False)],
            )

            score = reg.best_score_["valid_0"]["rmse"]
            if score < best_reg_score:
                best_reg_score = score
                best_reg = reg

        self.regressor = best_reg

        # ── Calibration (isotonic regression on out-of-fold predictions) ──
        oof_probs = np.zeros(len(dataset))
        for train_idx, val_idx in tscv.split(X):
            oof_probs[val_idx] = self.classifier.predict_proba(X[val_idx])[:, 1]

        mask = oof_probs > 0
        if mask.sum() > 50:
            self.calibrator = IsotonicRegression(out_of_bounds="clip")
            self.calibrator.fit(oof_probs[mask].reshape(-1, 1), y_class[mask])

        self.last_trained = datetime.now()
        self._save_models()

    # ═══════════════════════════════════════════
    # Feature engineering
    # ═══════════════════════════════════════════

    @staticmethod
    def build_features(
        home_team: dict,
        away_team: dict,
        home_pitcher: dict,
        away_pitcher: dict,
        market: dict,
        poisson_output: dict,
    ) -> dict:
        """
        Build feature dict from raw data sources.
        This is the single place where all features are computed.
        """
        f = {}

        # Pitcher features
        for prefix, p in [("hp", home_pitcher), ("ap", away_pitcher)]:
            f[f"{prefix}_era"] = p.get("era", 4.5)
            f[f"{prefix}_whip"] = p.get("whip", 1.3)
            f[f"{prefix}_k9"] = p.get("k_per_9", 8.0)
            f[f"{prefix}_fip"] = p.get("fip", 4.2)
            f[f"{prefix}_bb9"] = p.get("bb_per_9", 3.2)
            f[f"{prefix}_hr9"] = p.get("hr_per_9", 1.3)
            f[f"{prefix}_ip_season"] = p.get("ip_season", 0)
            f[f"{prefix}_era_last5"] = p.get("era_last5", p.get("era", 4.5))
            f[f"{prefix}_is_lhp"] = 1 if p.get("left_handed", False) else 0

        # Offense features
        for prefix, t in [("h", home_team), ("a", away_team)]:
            f[f"{prefix}_rpg"] = t.get("runs_per_game", 4.5)
            f[f"{prefix}_ops"] = t.get("ops", 0.72)
            f[f"{prefix}_wrc_plus"] = t.get("wrc_plus", 100)
            f[f"{prefix}_iso"] = t.get("iso", 0.15)
            f[f"{prefix}_woba"] = t.get("woba", 0.31)
            f[f"{prefix}_k_rate"] = t.get("k_rate", 0.22)
            f[f"{prefix}_bb_rate"] = t.get("bb_rate", 0.08)
            f[f"{prefix}_rpg_last10"] = t.get("runs_per_game_last10", t.get("runs_per_game", 4.5))
            f[f"{prefix}_win_pct_last10"] = t.get("win_pct_last10", 0.5)

        # Bullpen
        f["h_bp_era"] = home_team.get("bullpen_era", 4.0)
        f["h_bp_whip"] = home_team.get("bullpen_whip", 1.3)
        f["a_bp_era"] = away_team.get("bullpen_era", 4.0)
        f["a_bp_whip"] = away_team.get("bullpen_whip", 1.3)

        # Situational
        f["park_factor"] = market.get("park_factor", 1.0)
        f["weather_factor"] = market.get("weather_factor", 1.0)

        # Market
        f["market_home_ml"] = market.get("home_ml", 1.9)
        f["market_away_ml"] = market.get("away_ml", 1.9)
        f["market_total"] = market.get("total", 9.0)
        f["opening_home_ml"] = market.get("opening_home_ml", market.get("home_ml", 1.9))
        f["opening_total"] = market.get("opening_total", market.get("total", 9.0))
        f["line_movement_ml"] = f["market_home_ml"] - f["opening_home_ml"]
        f["line_movement_total"] = f["market_total"] - f["opening_total"]
        f["public_pct_home"] = market.get("public_pct_home", 0.5)

        # Derived deltas
        f["pitcher_delta_era"] = f["hp_era"] - f["ap_era"]
        f["pitcher_delta_k9"] = f["hp_k9"] - f["ap_k9"]
        f["offense_delta_wrc"] = f["h_wrc_plus"] - f["a_wrc_plus"]
        f["offense_delta_ops"] = f["h_ops"] - f["a_ops"]

        # Model outputs
        f["model_home_prob"] = poisson_output.get("home_win_prob", 0.5)
        f["model_expected_total"] = poisson_output.get("expected_total", 9.0)

        return f

    # ═══════════════════════════════════════════
    # Internal helpers
    # ═══════════════════════════════════════════

    def _features_to_array(self, features: dict) -> np.ndarray:
        row = [features.get(col, 0.0) for col in self.feature_cols]
        return np.array([row])

    def _features_to_array_from_dict(self, d: dict) -> list:
        return [d.get(col, 0.0) for col in self.feature_cols]

    def _compute_confidence(self, prob: float, features: dict) -> float:
        """Confidence = how decisive * data quality."""
        decisiveness = abs(prob - 0.5) * 2  # 0 at 0.5, 1 at 0.0/1.0
        ip_home = features.get("hp_ip_season", 0)
        ip_away = features.get("ap_ip_season", 0)
        data_quality = min(1.0, (ip_home + ip_away) / 100)
        return decisiveness * 0.6 + data_quality * 0.4

    def _is_ready(self) -> bool:
        return self.classifier is not None and self.regressor is not None

    def _needs_retrain(self) -> bool:
        if self.last_trained is None:
            return True
        return (datetime.now() - self.last_trained).days >= ML_RETRAIN_DAYS

    def _get_feature_importance(self) -> dict:
        if self.classifier is None:
            return {}
        importance = self.classifier.feature_importances_
        pairs = sorted(
            zip(self.feature_cols, importance),
            key=lambda x: -x[1]
        )
        return {k: int(v) for k, v in pairs[:15]}

    def _save_models(self):
        path = self.model_dir / "mlb_model.pkl"
        data = {
            "classifier": self.classifier,
            "regressor": self.regressor,
            "calibrator": self.calibrator,
            "last_trained": self.last_trained,
            "version": self.VERSION,
            "feature_cols": self.feature_cols,
        }
        with open(path, "wb") as f:
            pickle.dump(data, f)

    def _load_models(self):
        path = self.model_dir / "mlb_model.pkl"
        if not path.exists():
            return
        try:
            with open(path, "rb") as f:
                data = pickle.load(f)
            self.classifier = data["classifier"]
            self.regressor = data["regressor"]
            self.calibrator = data.get("calibrator")
            self.last_trained = data.get("last_trained")
        except Exception:
            pass
