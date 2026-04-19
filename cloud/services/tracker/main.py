"""
BetAnalytics — Performance Tracker

Tracks all picks and computes:
  - ROI (overall and by market/grade/book)
  - CLV (closing line value)
  - Sharpe ratio
  - Win rate by confidence band
  - Model calibration (predicted vs actual)

Runs on a schedule to resolve picks and update stats.
"""
import json
import os
import time
from datetime import datetime, timedelta

import psycopg2
import psycopg2.extras
import redis
import structlog

logger = structlog.get_logger()

DATABASE_URL = os.getenv("DATABASE_URL", "")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")


class Tracker:
    def __init__(self):
        self.db = psycopg2.connect(DATABASE_URL) if DATABASE_URL else None
        self.redis = redis.from_url(REDIS_URL, decode_responses=True)

    def resolve_picks(self):
        """Check completed games and resolve pending picks."""
        if not self.db:
            return

        cur = self.db.cursor(cursor_factory=psycopg2.extras.DictCursor)

        # Get pending picks
        cur.execute("""
            SELECT * FROM picks
            WHERE status = 'pending'
            AND created_at < NOW() - INTERVAL '4 hours'
        """)
        pending = cur.fetchall()

        for pick in pending:
            result = self._get_game_result(pick["event_id"])
            if not result:
                continue

            won = self._evaluate_pick(pick, result)

            # Calculate actual profit/loss
            if won:
                profit = pick["bet_size_usd"] * (pick["odds_decimal"] - 1)
            else:
                profit = -pick["bet_size_usd"]

            cur.execute("""
                UPDATE picks SET
                    status = %s,
                    result_profit = %s,
                    actual_score_home = %s,
                    actual_score_away = %s,
                    resolved_at = NOW()
                WHERE pick_id = %s
            """, (
                "won" if won else "lost",
                profit,
                result.get("home_score", 0),
                result.get("away_score", 0),
                pick["pick_id"],
            ))

        self.db.commit()
        logger.info("picks_resolved", count=len(pending))

    def compute_stats(self) -> dict:
        """Compute comprehensive performance statistics."""
        if not self.db:
            return {}

        cur = self.db.cursor(cursor_factory=psycopg2.extras.DictCursor)

        # Overall stats
        cur.execute("""
            SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'won') as won,
                COUNT(*) FILTER (WHERE status = 'lost') as lost,
                COUNT(*) FILTER (WHERE status = 'pending') as pending,
                COALESCE(SUM(result_profit), 0) as total_profit,
                COALESCE(SUM(bet_size_usd), 0) as total_wagered,
                COALESCE(AVG(ev_percent), 0) as avg_ev,
                COALESCE(AVG(edge_percent), 0) as avg_edge,
                COALESCE(AVG(confidence), 0) as avg_confidence
            FROM picks
        """)
        overall = dict(cur.fetchone())

        total_resolved = overall["won"] + overall["lost"]
        overall["win_rate"] = overall["won"] / total_resolved if total_resolved > 0 else 0
        overall["roi"] = (overall["total_profit"] / overall["total_wagered"] * 100) if overall["total_wagered"] > 0 else 0

        # By grade
        cur.execute("""
            SELECT
                grade,
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'won') as won,
                COALESCE(SUM(result_profit), 0) as profit,
                COALESCE(SUM(bet_size_usd), 0) as wagered,
                COALESCE(AVG(ev_percent), 0) as avg_ev
            FROM picks
            WHERE status IN ('won', 'lost')
            GROUP BY grade
            ORDER BY grade
        """)
        by_grade = {}
        for row in cur.fetchall():
            r = dict(row)
            resolved = r["total"]
            by_grade[r["grade"]] = {
                "total": resolved,
                "won": r["won"],
                "win_rate": r["won"] / resolved if resolved > 0 else 0,
                "profit": float(r["profit"]),
                "roi": float(r["profit"]) / float(r["wagered"]) * 100 if r["wagered"] > 0 else 0,
                "avg_ev": float(r["avg_ev"]),
            }

        # By market
        cur.execute("""
            SELECT
                market,
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'won') as won,
                COALESCE(SUM(result_profit), 0) as profit,
                COALESCE(SUM(bet_size_usd), 0) as wagered
            FROM picks
            WHERE status IN ('won', 'lost')
            GROUP BY market
        """)
        by_market = {}
        for row in cur.fetchall():
            r = dict(row)
            resolved = r["total"]
            by_market[r["market"]] = {
                "total": resolved,
                "won": r["won"],
                "win_rate": r["won"] / resolved if resolved > 0 else 0,
                "profit": float(r["profit"]),
                "roi": float(r["profit"]) / float(r["wagered"]) * 100 if r["wagered"] > 0 else 0,
            }

        # Sharpe ratio (daily returns)
        cur.execute("""
            SELECT
                DATE(created_at) as day,
                COALESCE(SUM(result_profit), 0) as daily_profit
            FROM picks
            WHERE status IN ('won', 'lost')
            GROUP BY DATE(created_at)
            ORDER BY day
        """)
        daily_profits = [float(row["daily_profit"]) for row in cur.fetchall()]
        sharpe = self._compute_sharpe(daily_profits)

        stats = {
            "overall": overall,
            "by_grade": by_grade,
            "by_market": by_market,
            "sharpe_ratio": sharpe,
            "computed_at": datetime.now().isoformat(),
        }

        # Cache in Redis
        self.redis.set("ba:stats:latest", json.dumps(stats, default=str), ex=3600)

        return stats

    def _evaluate_pick(self, pick: dict, result: dict) -> bool:
        """Determine if a pick won or lost."""
        market = pick["market"]
        selection = pick["selection"]
        home_score = result.get("home_score", 0)
        away_score = result.get("away_score", 0)
        total = home_score + away_score

        if market == "moneyline":
            if selection == "home":
                return home_score > away_score
            return away_score > home_score

        if market == "total":
            line = pick.get("line", 0)
            if selection == "over":
                return total > line
            return total < line

        if market == "run_line":
            line = pick.get("line", 0)
            spread = home_score - away_score
            if selection == "home":
                return spread > abs(line)
            return spread < -abs(line)

        if market == "nrfi":
            first_inning_runs = result.get("first_inning_runs", 0)
            if selection == "nrfi":
                return first_inning_runs == 0
            return first_inning_runs > 0

        return False

    def _get_game_result(self, event_id: str) -> dict:
        """Fetch game result from Redis cache or API."""
        cached = self.redis.get(f"ba:result:{event_id}")
        if cached:
            return json.loads(cached)
        return None

    @staticmethod
    def _compute_sharpe(daily_profits: list, risk_free_rate: float = 0.0) -> float:
        """Annualized Sharpe ratio."""
        if len(daily_profits) < 10:
            return 0.0

        import numpy as np
        returns = np.array(daily_profits)
        mean_return = np.mean(returns) - risk_free_rate / 365
        std_return = np.std(returns)

        if std_return == 0:
            return 0.0

        return round(float(mean_return / std_return * (365 ** 0.5)), 2)


def main():
    tracker = Tracker()

    while True:
        try:
            tracker.resolve_picks()
            stats = tracker.compute_stats()

            if stats:
                overall = stats.get("overall", {})
                logger.info(
                    "stats_computed",
                    total=overall.get("total", 0),
                    win_rate=f"{overall.get('win_rate', 0):.1%}",
                    roi=f"{overall.get('roi', 0):.1f}%",
                    sharpe=stats.get("sharpe_ratio", 0),
                )

        except Exception as e:
            logger.error("tracker_error", error=str(e))

        time.sleep(300)  # Every 5 minutes


if __name__ == "__main__":
    main()
