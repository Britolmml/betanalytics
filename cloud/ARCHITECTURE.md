# BetAnalytics — Quant Betting System Architecture

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          DATA INGESTION                             │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────���┐           │
│  │DraftKings│  │ FanDuel  │  │ Pinnacle │  │ Odds API │  ...       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘           │
│       │              │              │              │                 │
│       └──────────────┴──────┬───────┴──────────────┘                │
│                             │                                       │
���                    ┌────────▼────────┐                              │
│                    │    Scraper      │  Python async + aiohttp       │
│                    │  Orchestrator   │  Circuit breaker per book     │
│                    │  (ECS Fargate)  │  Proxy rotation               │
│                    └────────┬────────┘                              │
│                             │ Normalized OddsLine                   │
└─────────────────────────────┼───────────────────────────────────────┘
                              │
                     ┌────────▼────────┐
                     │     Kinesis     │  Real-time streaming
                     │  (2 shards)    │  Partition by event_id
                     └────────┬────────┘
                              │
┌─────────────────────────────┼───────────────────────────────────────┐
│                      PROCESSING PIPELINE                            │
│                             │                                       │
│                    ┌────────▼────────┐                              │
│                    │    Pipeline     │  Consumes Kinesis records     │
│                    │  (ECS Fargate)  │  Groups by event              │
│                    └────────┬────────┘                              │
│                             │                                       │
│            ┌────────────────┼────────────────┐                      │
│            │                │                │                      │
│   ┌────────▼──────┐ ┌──────▼───────┐ ┌──────▼──────┐              │
│   │    Poisson    │ │ Monte Carlo  │ │   LightGBM  │              │
│   │   Advanced    │ │  15K sims    │ │   ML Model  │              │
│   │ (pitcher adj, │ │ (neg binom,  │ │ (50+ feats, │              │
│   │  park, form)  │ │  inning-by-  │ │  auto-train │              │
│   │              │ │   inning)    │ │  calibrated) │              │
│   └────────┬──────┘ └──────┬───────┘ └──────┬──────┘              │
│            │                │                │                      │
│            └────────────────┼────────────────┘                      │
│                             │                                       │
│                    ┌────────▼────────┐                              │
│                    │    Ensemble     │  Dynamic weights              │
│                    │    Combiner     ���  Poisson 25% + MC 30% + ML 45│
│                    └────────┬────────┘                              │
│                             │                                       │
│               ┌─────────────┼─────────────┐                        │
│               │             │             │                         │
│      ┌────────▼──────┐ ┌───▼────┐ ┌──────▼──────┐                 │
│      │  EV Calculator│ │ Sharp  │ │    Risk     │                  │
│      │  (devig, edge)│ │Detector│ │  Manager    │                  │
│      └────────┬──────┘ └───┬────┘ └──────┬──────┘                 │
│               │             │             │                         │
│               └─────────────┼─────────────┘                        │
│                             │                                       │
│                    ┌────────▼────────┐                              │
│                    │    Decision     │  Filters: EV>2%, Edge>3%     │
│                    │    Engine       │  Kelly sizing (25% fractional)│
│                    │                 │  Grade: A+ to C              │
│                    └────────┬────────┘                              │
│                             │ Approved Picks                        │
└─────────────────────────────┼───────────────────────────────────────┘
                              │
               ┌───��──────────┼──────────────┐
               │              │              │
      ┌────────▼──────┐ ┌────▼─────┐ ┌──────▼──────┐
      │   PostgreSQL  │ │   SNS    │ │   Redis     │
      │  (picks, CLV, │ │ (alerts) │ │  (cache,    │
      │   stats, ML)  │ │          │ │   lines)    │
      └───────────────┘ └────┬─────┘ └─────────────┘
                             │
               ┌─────────────┼─────────────┐
               │             │             │
      ┌────────▼──────┐ ┌───▼────┐ ┌──────▼──────┐
      │   Telegram    │ │Discord │ │  Webhooks   │
      └───────────────┘ └────────┘ └─────────────┘
```

## Module Breakdown

### `/cloud/quant/` — Quantitative Engine (Python)

| Module | File | Purpose |
|--------|------|---------|
| **Poisson** | `models/poisson.py` | Advanced Poisson with pitcher quality, park factors, bullpen decay, overdispersion |
| **Monte Carlo** | `models/montecarlo.py` | 15K inning-by-inning simulations using negative binomial |
| **ML Model** | `models/ml_model.py` | LightGBM classifier + regressor, 50+ features, isotonic calibration |
| **Ensemble** | `models/ensemble.py` | Dynamic-weighted combination of all three models |
| **EV** | `market/ev.py` | Expected value, devigging, multi-book comparison |
| **Kelly** | `market/kelly.py` | Fractional Kelly (25%), portfolio-aware sizing |
| **CLV** | `market/clv.py` | Closing line value tracking and aggregation |
| **Sharp** | `market/sharp.py` | Reverse line movement, steam moves, sharp vs public |
| **Risk** | `risk/manager.py` | Contradiction detection, correlation limits, sample size flags |
| **Decision** | `decision/engine.py` | Final pick selection with grading (A+ to C) |

### `/cloud/services/` — Microservices

| Service | Runtime | Purpose |
|---------|---------|---------|
| **Scraper** | Python/Fargate | Multi-book parallel scraping (DK, FD, Pinnacle, Odds API) |
| **Pipeline** | Python/Fargate | Kinesis consumer → full quant stack → pick generation |
| **Alerts** | Python/Fargate | SNS → Telegram/Discord/Webhook delivery |
| **Tracker** | Python/Fargate | Pick resolution, ROI/CLV stats, Sharpe ratio |

### `/cloud/infra/` — Infrastructure (Terraform)

- VPC with public/private subnets + NAT
- ECS Fargate cluster (4 services)
- Kinesis (2 shards) for line streaming
- ElastiCache Redis for caching
- RDS PostgreSQL for persistence
- SNS for alert fan-out
- Secrets Manager for API keys
- Auto-scaling (CPU-based) for scraper + pipeline
- CloudWatch alarms for errors + latency

## Data Flow

```
1. Scraper polls books every 30s
2. New/changed lines → Kinesis
3. Pipeline groups by event → runs models
4. EV+ picks pass risk checks → Decision Engine
5. Approved picks → PostgreSQL + SNS
6. Alert service → Telegram/Discord
7. Tracker resolves picks → computes stats
```

## Key Design Decisions

1. **Negative Binomial over Poisson**: Baseball has overdispersion (variance > mean). Pure Poisson underestimates blowout probability by ~12%.

2. **Ensemble with dynamic weights**: ML gets 45% weight when trained and confident, drops to 0% early season. Poisson/MC carry the load until ML has data.

3. **Quarter Kelly**: Full Kelly is too aggressive for sports (model error is real). 25% Kelly captures ~50% of growth rate with ~75% less drawdown.

4. **Pinnacle as CLV benchmark**: Pinnacle is the sharpest book (lowest vig, doesn't limit). Their closing line is the best proxy for "true" probability.

5. **Redis for line dedup**: Only publish changed lines to Kinesis. A typical scrape cycle returns 500+ lines but only 20-50 actually changed.

6. **Kinesis over SQS**: Need ordered, replayable stream. If pipeline crashes, can replay from any point. SQS would lose ordering.

## Deployment

### Local Development
```bash
cd cloud
make dev          # Start all services with LocalStack
make logs         # Follow logs
make test-models  # Quick model sanity check
make db-shell     # Connect to Postgres
```

### AWS Production
```bash
cd cloud
make init         # Terraform init (first time)
make plan         # Review changes
make deploy       # Apply infrastructure
make push         # Build + push Docker images to ECR
```

### Environment Variables

| Variable | Where | Purpose |
|----------|-------|---------|
| `ODDS_API_KEY` | Secrets Manager | The Odds API key |
| `TELEGRAM_BOT_TOKEN` | Secrets Manager | Telegram bot |
| `TELEGRAM_CHAT_ID` | Secrets Manager | Telegram chat |
| `DISCORD_WEBHOOK_URL` | Secrets Manager | Discord webhook |
| `EV_THRESHOLD` | Pipeline env | Minimum EV% (default: 3.0) |
| `SCRAPE_INTERVAL` | Scraper env | Seconds between scrapes (default: 30) |

## Performance Targets

| Metric | Target |
|--------|--------|
| Scrape latency | < 5s per cycle |
| Pipeline latency | < 3s per event |
| Alert delivery | < 2s from detection |
| CLV tracking | > 95% resolution rate |
| Model retraining | Weekly (automatic) |
| System uptime | 99.5% |

## Cost Estimate (AWS)

| Component | Monthly Cost |
|-----------|-------------|
| ECS Fargate (4 services) | ~$50-100 |
| RDS t4g.micro | ~$15 |
| ElastiCache t4g.micro | ~$12 |
| Kinesis (2 shards) | ~$30 |
| NAT Gateway | ~$35 |
| **Total** | **~$140-190/mo** |
