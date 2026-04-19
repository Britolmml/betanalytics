## ──────────────────────────────────────────────
## BetAnalytics Cloud — Variables
## ──────────────────────────────────────────────

variable "project_name" {
  default = "betanalytics"
}

variable "aws_region" {
  default = "us-east-1"
}

variable "environment" {
  default     = "production"
  description = "Environment name (production, staging)"
}

# ── Networking ──
variable "vpc_cidr" {
  default = "10.0.0.0/16"
}

variable "public_subnets" {
  default = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "private_subnets" {
  default = ["10.0.10.0/24", "10.0.11.0/24"]
}

variable "availability_zones" {
  default = ["us-east-1a", "us-east-1b"]
}

# ── ECS ──
variable "scraper_cpu" {
  default = 512
}

variable "scraper_memory" {
  default = 1024
}

variable "pipeline_cpu" {
  default = 1024
}

variable "pipeline_memory" {
  default = 2048
}

variable "alerts_cpu" {
  default = 256
}

variable "alerts_memory" {
  default = 512
}

variable "tracker_cpu" {
  default = 256
}

variable "tracker_memory" {
  default = 512
}

# ── RDS ──
variable "db_instance_class" {
  default = "db.t4g.micro"
}

variable "db_name" {
  default = "betanalytics"
}

variable "db_username" {
  default = "betadmin"
}

# ── Redis ──
variable "redis_node_type" {
  default = "cache.t4g.micro"
}

# ── Kinesis ──
variable "kinesis_shard_count" {
  default = 2
}

# ── Scraper ──
variable "scraper_interval_seconds" {
  default     = 30
  description = "How often scrapers poll sportsbooks"
}

variable "scraper_desired_count" {
  default = 2
}

variable "pipeline_desired_count" {
  default = 2
}

# ── Alerts ──
variable "ev_threshold" {
  default     = 3.0
  description = "Minimum EV% to trigger an alert"
}

variable "telegram_bot_token" {
  default   = ""
  sensitive = true
}

variable "telegram_chat_id" {
  default   = ""
  sensitive = true
}

variable "discord_webhook_url" {
  default   = ""
  sensitive = true
}

# ── Domain ──
variable "domain_name" {
  default = "betanalyticsIA.com"
}
