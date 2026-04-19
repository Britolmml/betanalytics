"""
BetAnalytics — Main Scraper Orchestrator

Runs all sportsbook scrapers in parallel on a configurable interval.
Publishes normalized lines to Kinesis for downstream processing.

Architecture:
  - Each book = independent async worker
  - Lines are deduped and normalized before publishing
  - Redis cache prevents publishing unchanged lines
  - Circuit breaker per book prevents hammering failing endpoints
"""
import asyncio
import json
import hashlib
import time
import signal
import sys
from typing import Optional

import aiohttp
import boto3
import redis.asyncio as aioredis
import structlog

from config import config
from books.base import OddsLine
from books.odds_api import OddsAPIScraper
from books.draftkings import DraftKingsScraper
from books.fanduel import FanDuelScraper
from books.pinnacle import PinnacleScraper

logger = structlog.get_logger()


class ScraperOrchestrator:
    """
    Main loop:
      1. For each enabled sport
      2. Run all book scrapers in parallel
      3. Normalize + dedup lines
      4. Publish changed lines to Kinesis
      5. Cache in Redis
      6. Sleep interval
      7. Repeat
    """

    def __init__(self):
        self.running = False
        self.session: Optional[aiohttp.ClientSession] = None
        self.redis: Optional[aioredis.Redis] = None
        self.kinesis = boto3.client("kinesis", region_name=config.aws_region)
        self.scrapers = []
        self.stats = {
            "cycles": 0,
            "total_lines": 0,
            "published_lines": 0,
            "errors": 0,
        }

    async def start(self):
        """Initialize and run the main scraping loop."""
        logger.info("scraper_starting", interval=config.scrape_interval)

        self.session = aiohttp.ClientSession()
        self.redis = aioredis.from_url(config.redis_url, decode_responses=True)

        # Load secrets (proxy keys, API keys)
        secrets = await self._load_secrets()

        # Initialize scrapers
        self.scrapers = self._init_scrapers(secrets)

        self.running = True

        # Handle graceful shutdown
        for sig in (signal.SIGTERM, signal.SIGINT):
            asyncio.get_event_loop().add_signal_handler(
                sig, lambda: asyncio.create_task(self.stop())
            )

        # Main loop
        while self.running:
            cycle_start = time.time()

            try:
                await self._run_cycle()
            except Exception as e:
                logger.error("cycle_error", error=str(e))
                self.stats["errors"] += 1

            # Sleep until next interval
            elapsed = time.time() - cycle_start
            sleep_time = max(1, config.scrape_interval - elapsed)
            logger.info(
                "cycle_complete",
                elapsed=f"{elapsed:.1f}s",
                next_in=f"{sleep_time:.0f}s",
                stats=self.stats,
            )
            await asyncio.sleep(sleep_time)

    async def stop(self):
        """Graceful shutdown."""
        logger.info("scraper_stopping")
        self.running = False
        if self.session:
            await self.session.close()
        if self.redis:
            await self.redis.aclose()

    async def _run_cycle(self):
        """One complete scraping cycle across all sports + books."""
        self.stats["cycles"] += 1

        for sport in config.enabled_sports:
            # Run all scrapers for this sport in parallel
            tasks = [scraper.safe_fetch(sport) for scraper in self.scrapers]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            # Flatten results
            all_lines = []
            for result in results:
                if isinstance(result, list):
                    all_lines.extend(result)
                elif isinstance(result, Exception):
                    logger.error("scraper_exception", error=str(result))
                    self.stats["errors"] += 1

            self.stats["total_lines"] += len(all_lines)

            if not all_lines:
                continue

            # Dedup + filter changed lines
            changed_lines = await self._filter_changed(all_lines)

            if changed_lines:
                # Publish to Kinesis
                await self._publish_to_kinesis(changed_lines, sport)
                self.stats["published_lines"] += len(changed_lines)

                # Update Redis cache
                await self._cache_lines(changed_lines)

                logger.info(
                    "lines_published",
                    sport=sport,
                    total=len(all_lines),
                    changed=len(changed_lines),
                )

    def _init_scrapers(self, secrets: dict) -> list:
        """Initialize all enabled sportsbook scrapers."""
        scrapers = []
        proxy = self._get_proxy()

        # The Odds API (most reliable — returns all books in one call)
        odds_api_key = secrets.get("ODDS_API_KEY", "")
        if odds_api_key:
            scrapers.append(OddsAPIScraper(self.session, odds_api_key, proxy))

        # Individual book scrapers (supplement Odds API data)
        if "draftkings" in config.enabled_books:
            scrapers.append(DraftKingsScraper(self.session, proxy))
        if "fanduel" in config.enabled_books:
            scrapers.append(FanDuelScraper(self.session, proxy))
        if "pinnacle" in config.enabled_books:
            scrapers.append(PinnacleScraper(self.session, proxy))

        logger.info("scrapers_initialized", count=len(scrapers))
        return scrapers

    async def _filter_changed(self, lines: list[OddsLine]) -> list[OddsLine]:
        """
        Only publish lines that have changed since last scrape.
        Uses Redis hash of (book, event, market, selection) → odds.
        """
        changed = []

        pipe = self.redis.pipeline()
        keys = []
        for line in lines:
            key = self._line_cache_key(line)
            keys.append(key)
            pipe.get(key)

        cached_values = await pipe.execute()

        for line, cached in zip(lines, cached_values):
            current_hash = self._line_hash(line)
            if cached != current_hash:
                changed.append(line)

        return changed

    async def _cache_lines(self, lines: list[OddsLine]):
        """Cache current line hashes in Redis."""
        pipe = self.redis.pipeline()
        for line in lines:
            key = self._line_cache_key(line)
            val = self._line_hash(line)
            pipe.set(key, val, ex=3600)  # 1hr TTL
        await pipe.execute()

    async def _publish_to_kinesis(self, lines: list[OddsLine], sport: str):
        """Publish lines to Kinesis stream in batches of 500."""
        records = []
        for line in lines:
            records.append({
                "Data": json.dumps(line.to_dict()),
                "PartitionKey": f"{line.event_id}_{line.book}",
            })

        # Kinesis PutRecords supports max 500 records per call
        for i in range(0, len(records), 500):
            batch = records[i:i + 500]
            try:
                self.kinesis.put_records(
                    StreamName=config.kinesis_stream,
                    Records=batch,
                )
            except Exception as e:
                logger.error("kinesis_publish_error", error=str(e), batch_size=len(batch))

    def _get_proxy(self) -> Optional[str]:
        """Get a proxy URL from the pool."""
        if config.proxy_pool:
            import random
            return random.choice(config.proxy_pool)
        if config.proxy_api_key:
            return f"http://customer-{config.proxy_api_key}:@pr.oxylabs.io:7777"
        return None

    async def _load_secrets(self) -> dict:
        """Load secrets from AWS Secrets Manager."""
        if not config.secrets_arn:
            return {
                "ODDS_API_KEY": "",
                "PROXY_API_KEY": config.proxy_api_key,
            }

        try:
            sm = boto3.client("secretsmanager", region_name=config.aws_region)
            response = sm.get_secret_value(SecretId=config.secrets_arn)
            return json.loads(response["SecretString"])
        except Exception as e:
            logger.error("secrets_load_error", error=str(e))
            return {}

    @staticmethod
    def _line_cache_key(line: OddsLine) -> str:
        return f"ba:line:{line.book}:{line.event_id}:{line.market}:{line.selection}"

    @staticmethod
    def _line_hash(line: OddsLine) -> str:
        raw = f"{line.odds_decimal}:{line.line}"
        return hashlib.md5(raw.encode()).hexdigest()[:12]


async def main():
    orchestrator = ScraperOrchestrator()
    try:
        await orchestrator.start()
    except KeyboardInterrupt:
        await orchestrator.stop()


if __name__ == "__main__":
    asyncio.run(main())
