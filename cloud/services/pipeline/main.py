"""
BetAnalytics — Real-Time Pipeline

Consumes line updates from Kinesis, runs the full quant engine,
and publishes EV+ opportunities to SNS for alerts.

Flow:
  Kinesis line update
    → Aggregate by event (Redis)
    → Run ensemble model (Poisson + MC + ML)
    → Calculate EV for every market × book
    → Run decision engine (risk + Kelly)
    → If approved → publish to SNS + store in DB
"""
import asyncio
import json
import os
import time

import boto3
import redis
import psycopg2
import structlog

logger = structlog.get_logger()

# ── Config ──
KINESIS_STREAM = os.getenv("KINESIS_STREAM", "betanalytics-production-lines")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
DATABASE_URL = os.getenv("DATABASE_URL", "")
SNS_TOPIC_ARN = os.getenv("SNS_TOPIC_ARN", "")
EV_THRESHOLD = float(os.getenv("EV_THRESHOLD", "3.0"))

# Add quant engine to path
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "quant"))

from models.poisson import MLBPoissonModel, PitcherProfile, TeamProfile, GameContext
from models.montecarlo import MonteCarloEngine
from models.ml_model import MLBMLModel
from models.ensemble import EnsembleModel
from market.ev import EVCalculator
from market.kelly import KellyCalculator
from market.clv import CLVTracker
from market.sharp import SharpMoneyDetector
from risk.manager import RiskManager
from decision.engine import DecisionEngine


class Pipeline:
    """
    Real-time processing pipeline.
    Consumes Kinesis records and runs the full quant stack.
    """

    def __init__(self):
        self.kinesis = boto3.client("kinesis", region_name=AWS_REGION)
        self.sns = boto3.client("sns", region_name=AWS_REGION)
        self.redis = redis.from_url(REDIS_URL, decode_responses=True)
        self.db = self._connect_db()

        # Quant engine
        self.poisson = MLBPoissonModel()
        self.mc = MonteCarloEngine(n_sims=15000)
        self.ml = MLBMLModel()
        self.ensemble = EnsembleModel()
        self.decision = DecisionEngine(bankroll=10000)
        self.clv = CLVTracker()
        self.sharp = SharpMoneyDetector()

        self.running = False

    def start(self):
        """Start consuming from Kinesis."""
        logger.info("pipeline_starting")
        self.running = True

        # Get shard iterators
        stream_desc = self.kinesis.describe_stream(StreamName=KINESIS_STREAM)
        shards = stream_desc["StreamDescription"]["Shards"]

        iterators = []
        for shard in shards:
            resp = self.kinesis.get_shard_iterator(
                StreamName=KINESIS_STREAM,
                ShardId=shard["ShardId"],
                ShardIteratorType="LATEST",
            )
            iterators.append(resp["ShardIterator"])

        logger.info("kinesis_connected", shards=len(shards))

        while self.running:
            for i, iterator in enumerate(iterators):
                try:
                    resp = self.kinesis.get_records(
                        ShardIterator=iterator,
                        Limit=100,
                    )
                    iterators[i] = resp["NextShardIterator"]

                    records = resp.get("Records", [])
                    if records:
                        self._process_batch(records)

                except Exception as e:
                    logger.error("kinesis_read_error", shard=i, error=str(e))

            time.sleep(1)  # Poll every second

    def _process_batch(self, records: list):
        """Process a batch of Kinesis records."""
        # Group lines by event
        events = {}
        for record in records:
            try:
                data = json.loads(record["Data"])
                event_id = data.get("event_id", "")
                if event_id:
                    events.setdefault(event_id, []).append(data)
            except Exception as e:
                logger.error("record_parse_error", error=str(e))

        # Process each event
        for event_id, lines in events.items():
            try:
                self._process_event(event_id, lines)
            except Exception as e:
                logger.error("event_process_error", event_id=event_id, error=str(e))

    def _process_event(self, event_id: str, lines: list[dict]):
        """
        Full analysis pipeline for one event.

        1. Aggregate lines by market
        2. Load team/pitcher data from Redis/DB
        3. Run Poisson → Monte Carlo → ML → Ensemble
        4. Run decision engine
        5. Publish approved picks
        """
        if not lines:
            return

        first = lines[0]
        home = first.get("home_team", "")
        away = first.get("away_team", "")
        sport = first.get("sport", "mlb")

        # Record lines for sharp detection
        for line in lines:
            if line.get("market") == "moneyline" and line.get("selection") == "home":
                self.sharp.record_line(event_id, line["book"], line["odds_decimal"])

        # Aggregate odds by market and book
        book_odds = self._aggregate_odds(lines)

        # Load team + pitcher data from cache
        team_data = self._load_team_data(home, away)
        if not team_data:
            return

        home_team, away_team, home_pitcher, away_pitcher, context = team_data

        # ── Run models ──
        poisson_out = self.poisson.project(home_team, away_team, home_pitcher, away_pitcher, context)
        mc_out = self.mc.simulate(home_team, away_team, home_pitcher, away_pitcher, context)

        # ML (if trained)
        ml_features = MLBMLModel.build_features(
            home_team=self._team_to_dict(home_team),
            away_team=self._team_to_dict(away_team),
            home_pitcher=self._pitcher_to_dict(home_pitcher),
            away_pitcher=self._pitcher_to_dict(away_pitcher),
            market=self._get_market_data(book_odds, event_id),
            poisson_output={
                "home_win_prob": poisson_out.home_win_prob,
                "expected_total": poisson_out.expected_total,
            },
        )
        ml_out = self.ml.predict(ml_features)

        # ── Ensemble ──
        ensemble_out = self.ensemble.combine(poisson_out, mc_out, ml_out)

        # ── Decision engine ──
        picks = self.decision.evaluate_game(
            event_id=event_id,
            home_team=home,
            away_team=away,
            ensemble=ensemble_out,
            book_odds=book_odds,
            market_data=self._get_market_data(book_odds, event_id),
        )

        if picks:
            logger.info(
                "picks_generated",
                event=f"{away} @ {home}",
                count=len(picks),
                best_ev=f"{picks[0].ev_percent:.1f}%",
                best_grade=picks[0].grade,
            )

            for pick in picks:
                self._store_pick(pick)
                self._publish_alert(pick)
                self.clv.record_pick(
                    pick.pick_id, pick.best_book, pick.market,
                    pick.selection, pick.odds_decimal,
                )

    def _aggregate_odds(self, lines: list[dict]) -> dict:
        """
        Convert flat line list into structured book_odds dict for DecisionEngine.
        """
        result = {}

        for line in lines:
            market = line.get("market", "")
            selection = line.get("selection", "")
            book = line.get("book", "")
            odds = line.get("odds_decimal", 0)

            if market == "moneyline":
                result.setdefault("moneyline", {}).setdefault(selection, {})[book] = odds
            elif market == "total":
                total_line = line.get("line")
                if total_line:
                    result.setdefault("total", {"line": total_line})
                    result["total"].setdefault(selection, {})[book] = odds
            elif market == "spread":
                spread_line = line.get("line")
                if spread_line:
                    key = f"{'home' if selection == 'home' else 'away'}_{spread_line:+.1f}"
                    result.setdefault("run_line", {})[key] = result.get("run_line", {}).get(key, {})
                    result["run_line"][key][book] = odds

        return result

    def _load_team_data(self, home: str, away: str):
        """Load team + pitcher profiles from Redis cache."""
        try:
            home_data = self.redis.hgetall(f"ba:team:{home}")
            away_data = self.redis.hgetall(f"ba:team:{away}")
            hp_data = self.redis.hgetall(f"ba:pitcher:{home}:starter")
            ap_data = self.redis.hgetall(f"ba:pitcher:{away}:starter")

            if not home_data or not away_data:
                # Use defaults
                home_data = {"runs_per_game": "4.5", "ops": "0.72", "wrc_plus": "100"}
                away_data = {"runs_per_game": "4.5", "ops": "0.72", "wrc_plus": "100"}

            home_team = TeamProfile(
                name=home,
                runs_per_game=float(home_data.get("runs_per_game", 4.5)),
                ops=float(home_data.get("ops", 0.72)),
                wrc_plus=float(home_data.get("wrc_plus", 100)),
                woba=float(home_data.get("woba", 0.31)),
                iso=float(home_data.get("iso", 0.15)),
                win_pct_last10=float(home_data.get("win_pct_last10", 0.5)),
                bullpen_era=float(home_data.get("bullpen_era", 4.0)),
                nrfi_pct=float(home_data.get("nrfi_pct", 0.5)),
            )

            away_team = TeamProfile(
                name=away,
                runs_per_game=float(away_data.get("runs_per_game", 4.5)),
                ops=float(away_data.get("ops", 0.72)),
                wrc_plus=float(away_data.get("wrc_plus", 100)),
                woba=float(away_data.get("woba", 0.31)),
                iso=float(away_data.get("iso", 0.15)),
                win_pct_last10=float(away_data.get("win_pct_last10", 0.5)),
                bullpen_era=float(away_data.get("bullpen_era", 4.0)),
                nrfi_pct=float(away_data.get("nrfi_pct", 0.5)),
            )

            home_pitcher = PitcherProfile(
                name=hp_data.get("name", "Unknown"),
                era=float(hp_data.get("era", 4.2)),
                whip=float(hp_data.get("whip", 1.28)),
                k_per_9=float(hp_data.get("k_per_9", 8.5)),
                fip=float(hp_data.get("fip", 4.1)),
                ip_season=float(hp_data.get("ip_season", 50)),
            )

            away_pitcher = PitcherProfile(
                name=ap_data.get("name", "Unknown"),
                era=float(ap_data.get("era", 4.2)),
                whip=float(ap_data.get("whip", 1.28)),
                k_per_9=float(ap_data.get("k_per_9", 8.5)),
                fip=float(ap_data.get("fip", 4.1)),
                ip_season=float(ap_data.get("ip_season", 50)),
            )

            context = GameContext(
                park_factor=float(self.redis.get(f"ba:park:{home}") or 1.0),
            )

            return home_team, away_team, home_pitcher, away_pitcher, context

        except Exception as e:
            logger.error("team_data_load_error", error=str(e))
            return None

    def _store_pick(self, pick):
        """Store approved pick in PostgreSQL."""
        if not self.db:
            return
        try:
            cur = self.db.cursor()
            cur.execute("""
                INSERT INTO picks (
                    pick_id, event_id, sport, home_team, away_team,
                    market, selection, line, book, odds_decimal, odds_american,
                    model_prob, implied_prob, ev, ev_percent, edge_percent,
                    kelly_pct, bet_size_usd, confidence, grade, sharp_direction,
                    created_at
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()
                )
            """, (
                pick.pick_id, pick.event_id, pick.sport,
                pick.home_team, pick.away_team,
                pick.market, pick.selection, pick.line,
                pick.best_book, pick.odds_decimal, pick.odds_american,
                pick.model_prob, pick.implied_prob,
                pick.ev, pick.ev_percent, pick.edge_percent,
                pick.kelly_pct, pick.bet_size_usd,
                pick.confidence, pick.grade, pick.sharp_direction,
            ))
            self.db.commit()
        except Exception as e:
            logger.error("db_store_error", error=str(e))
            self.db.rollback()

    def _publish_alert(self, pick):
        """Publish EV+ opportunity to SNS."""
        if not SNS_TOPIC_ARN:
            return

        message = {
            "type": "ev_opportunity",
            "pick": {
                "pick_id": pick.pick_id,
                "game": f"{pick.away_team} @ {pick.home_team}",
                "market": pick.market,
                "selection": pick.selection,
                "line": pick.line,
                "book": pick.best_book,
                "odds": pick.odds_american,
                "ev": f"{pick.ev_percent:+.1f}%",
                "edge": f"{pick.edge_percent:.1f}%",
                "kelly": f"{pick.kelly_pct:.1f}%",
                "bet_size": f"${pick.bet_size_usd:.0f}",
                "grade": pick.grade,
                "confidence": pick.confidence,
                "sharp": pick.sharp_direction,
            },
        }

        try:
            self.sns.publish(
                TopicArn=SNS_TOPIC_ARN,
                Message=json.dumps(message),
                Subject=f"[{pick.grade}] {pick.market.upper()} {pick.selection} — {pick.away_team} @ {pick.home_team}",
            )
        except Exception as e:
            logger.error("sns_publish_error", error=str(e))

    def _get_market_data(self, book_odds: dict, event_id: str) -> dict:
        """Build market data dict for ML features."""
        # Get best home ML odds
        home_odds = book_odds.get("moneyline", {}).get("home", {})
        away_odds = book_odds.get("moneyline", {}).get("away", {})
        best_home = max(home_odds.values()) if home_odds else 1.9
        best_away = max(away_odds.values()) if away_odds else 1.9

        total_data = book_odds.get("total", {})
        total_line = total_data.get("line", 9.0)

        return {
            "home_ml": best_home,
            "away_ml": best_away,
            "total": total_line,
            "opening_home_ml": float(self.redis.get(f"ba:opening:{event_id}:home_ml") or best_home),
            "opening_total": float(self.redis.get(f"ba:opening:{event_id}:total") or total_line),
            "public_pct_home": float(self.redis.get(f"ba:public:{event_id}:home") or 0.5),
            "park_factor": 1.0,
            "weather_factor": 1.0,
        }

    def _connect_db(self):
        if not DATABASE_URL:
            return None
        try:
            return psycopg2.connect(DATABASE_URL)
        except Exception as e:
            logger.error("db_connect_error", error=str(e))
            return None

    @staticmethod
    def _team_to_dict(t: TeamProfile) -> dict:
        return {k: v for k, v in t.__dict__.items()}

    @staticmethod
    def _pitcher_to_dict(p: PitcherProfile) -> dict:
        return {k: v for k, v in p.__dict__.items()}


if __name__ == "__main__":
    pipeline = Pipeline()
    pipeline.start()
