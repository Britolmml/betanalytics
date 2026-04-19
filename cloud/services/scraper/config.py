"""
BetAnalytics Scraper — Configuration
"""
import os
from pydantic import BaseModel

class ScraperConfig(BaseModel):
    # AWS
    kinesis_stream: str = os.getenv("KINESIS_STREAM", "betanalytics-production-lines")
    aws_region: str = os.getenv("AWS_REGION", "us-east-1")
    secrets_arn: str = os.getenv("SECRETS_ARN", "")

    # Redis
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379")

    # Scraping
    scrape_interval: int = int(os.getenv("SCRAPE_INTERVAL", "30"))
    request_timeout: int = int(os.getenv("REQUEST_TIMEOUT", "15"))
    max_retries: int = int(os.getenv("MAX_RETRIES", "3"))

    # Proxy
    proxy_api_key: str = os.getenv("PROXY_API_KEY", "")
    proxy_pool: list[str] = []

    # Circuit breaker
    cb_failure_threshold: int = 5
    cb_recovery_timeout: int = 60

    # Books to scrape
    enabled_books: list[str] = [
        "draftkings", "fanduel", "betmgm", "pinnacle",
        "caesars", "bet365"
    ]

    # Sports
    enabled_sports: list[str] = ["nba", "mlb", "nfl", "soccer"]

config = ScraperConfig()
