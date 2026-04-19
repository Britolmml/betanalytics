# ══════════════════════════════════════════════
# BetAnalytics Cloud — Makefile
# ══════════════════════════════════════════════

.PHONY: dev stop build push deploy logs test clean

# ── Local Development ──

dev:                    ## Start all services locally
	docker compose up --build -d
	@echo "✓ Services running. Redis=6379 Postgres=5432 LocalStack=4566"

stop:                   ## Stop all services
	docker compose down

logs:                   ## Follow all service logs
	docker compose logs -f

logs-%:                 ## Follow logs for specific service (e.g., make logs-pipeline)
	docker compose logs -f $*

# ── Build & Push to ECR ──

AWS_REGION ?= us-east-1
AWS_ACCOUNT ?= $(shell aws sts get-caller-identity --query Account --output text)
ECR_PREFIX = $(AWS_ACCOUNT).dkr.ecr.$(AWS_REGION).amazonaws.com/betanalytics-production

build:                  ## Build all Docker images
	docker build -t ba-scraper  services/scraper/
	docker build -t ba-pipeline -f services/pipeline/Dockerfile .
	docker build -t ba-alerts   services/alerts/
	docker build -t ba-tracker  services/tracker/

push: build             ## Push images to ECR
	aws ecr get-login-password --region $(AWS_REGION) | docker login --username AWS --password-stdin $(ECR_PREFIX)-scraper
	docker tag ba-scraper  $(ECR_PREFIX)-scraper:latest  && docker push $(ECR_PREFIX)-scraper:latest
	docker tag ba-pipeline $(ECR_PREFIX)-pipeline:latest && docker push $(ECR_PREFIX)-pipeline:latest
	docker tag ba-alerts   $(ECR_PREFIX)-alerts:latest   && docker push $(ECR_PREFIX)-alerts:latest
	docker tag ba-tracker  $(ECR_PREFIX)-tracker:latest  && docker push $(ECR_PREFIX)-tracker:latest

# ── Terraform ──

init:                   ## Initialize Terraform
	cd infra && terraform init

plan:                   ## Terraform plan
	cd infra && terraform plan

deploy:                 ## Deploy infrastructure
	cd infra && terraform apply -auto-approve

destroy:                ## Destroy infrastructure (DANGER)
	cd infra && terraform destroy

# ── Testing ──

test:                   ## Run quant engine tests
	cd quant && python -m pytest tests/ -v

test-models:            ## Test models specifically
	cd quant && python -c "\
from models.poisson import MLBPoissonModel, TeamProfile, PitcherProfile; \
m = MLBPoissonModel(); \
out = m.project( \
  TeamProfile('Yankees', 5.2, ops=0.770, wrc_plus=115), \
  TeamProfile('Red Sox', 4.8, ops=0.740, wrc_plus=108), \
  PitcherProfile('Cole', 3.10, 1.05, 11.2, fip=3.05), \
  PitcherProfile('Sale', 3.45, 1.15, 10.8, fip=3.30), \
); \
print(f'NYY λ={out.home_lambda} BOS λ={out.away_lambda}'); \
print(f'NYY win={out.home_win_prob:.1%} BOS win={out.away_win_prob:.1%}'); \
print(f'Total={out.expected_total} NRFI={out.nrfi_prob:.1%}'); \
"

# ── Utils ──

clean:                  ## Remove containers, volumes, and images
	docker compose down -v --rmi local

db-shell:               ## Connect to PostgreSQL
	docker compose exec postgres psql -U betadmin -d betanalytics

redis-cli:              ## Connect to Redis
	docker compose exec redis redis-cli

help:                   ## Show this help
	@grep -E '^[a-zA-Z_%-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
