## ──────────────────────────────────────────────
## BetAnalytics Cloud — Main Infrastructure
## AWS: VPC → ECS Fargate → Kinesis → Redis → RDS → SNS
## ──────────────────────────────────────────────

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "betanalytics-tf-state"
    key            = "infra/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "betanalytics-tf-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

locals {
  prefix = "${var.project_name}-${var.environment}"
}

## ══════════════════════════════════════════════
## 1. NETWORKING — VPC + Subnets + NAT
## ══════════════════════════════════════════════

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags = { Name = "${local.prefix}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.prefix}-igw" }
}

resource "aws_subnet" "public" {
  count                   = length(var.public_subnets)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnets[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true
  tags = { Name = "${local.prefix}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = length(var.private_subnets)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnets[count.index]
  availability_zone = var.availability_zones[count.index]
  tags = { Name = "${local.prefix}-private-${count.index}" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.prefix}-nat-eip" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${local.prefix}-nat" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${local.prefix}-public-rt" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
  tags = { Name = "${local.prefix}-private-rt" }
}

resource "aws_route_table_association" "public" {
  count          = length(var.public_subnets)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = length(var.private_subnets)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

## ══════════════════════════════════════════════
## 2. SECURITY GROUPS
## ══════════════════════════════════════════════

resource "aws_security_group" "ecs_tasks" {
  name   = "${local.prefix}-ecs-tasks-sg"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
    description = "Allow inter-service communication"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound (scraping, APIs)"
  }

  tags = { Name = "${local.prefix}-ecs-sg" }
}

resource "aws_security_group" "redis" {
  name   = "${local.prefix}-redis-sg"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  tags = { Name = "${local.prefix}-redis-sg" }
}

resource "aws_security_group" "rds" {
  name   = "${local.prefix}-rds-sg"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  tags = { Name = "${local.prefix}-rds-sg" }
}

## ══════════════════════════════════════════════
## 3. ECR — Container Registries
## ══════════════════════════════════════════════

resource "aws_ecr_repository" "services" {
  for_each = toset(["scraper", "pipeline", "alerts", "tracker"])

  name                 = "${local.prefix}-${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  lifecycle_policy {
    policy = jsonencode({
      rules = [{
        rulePriority = 1
        description  = "Keep last 10 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = { type = "expire" }
      }]
    })
  }
}

## ══════════════════════════════════════════════
## 4. ECS CLUSTER + FARGATE SERVICES
## ══════════════════════════════════════════════

resource "aws_ecs_cluster" "main" {
  name = "${local.prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_iam_role" "ecs_task_execution" {
  name = "${local.prefix}-ecs-exec-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "ecs_task" {
  name = "${local.prefix}-ecs-task-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task_policy" {
  name = "${local.prefix}-ecs-task-policy"
  role = aws_iam_role.ecs_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "kinesis:PutRecord",
          "kinesis:PutRecords",
          "kinesis:GetRecords",
          "kinesis:GetShardIterator",
          "kinesis:DescribeStream",
          "kinesis:ListShards"
        ]
        Resource = aws_kinesis_stream.lines.arn
      },
      {
        Effect = "Allow"
        Action = [
          "sns:Publish"
        ]
        Resource = aws_sns_topic.alerts.arn
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = aws_secretsmanager_secret.app_secrets.arn
      },
      {
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricData"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "services" {
  for_each          = toset(["scraper", "pipeline", "alerts", "tracker"])
  name              = "/ecs/${local.prefix}-${each.key}"
  retention_in_days = 30
}

# ── Scraper Service ──
resource "aws_ecs_task_definition" "scraper" {
  family                   = "${local.prefix}-scraper"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.scraper_cpu
  memory                   = var.scraper_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name  = "scraper"
    image = "${aws_ecr_repository.services["scraper"].repository_url}:latest"
    essential = true

    environment = [
      { name = "KINESIS_STREAM",       value = aws_kinesis_stream.lines.name },
      { name = "AWS_REGION",           value = var.aws_region },
      { name = "REDIS_URL",            value = "redis://${aws_elasticache_cluster.redis.cache_nodes[0].address}:6379" },
      { name = "SCRAPE_INTERVAL",      value = tostring(var.scraper_interval_seconds) },
      { name = "SECRETS_ARN",          value = aws_secretsmanager_secret.app_secrets.arn }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.services["scraper"].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "scraper"
      }
    }
  }])
}

resource "aws_ecs_service" "scraper" {
  name            = "${local.prefix}-scraper"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.scraper.arn
  desired_count   = var.scraper_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.ecs_tasks.id]
  }
}

# ── Pipeline Service ──
resource "aws_ecs_task_definition" "pipeline" {
  family                   = "${local.prefix}-pipeline"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.pipeline_cpu
  memory                   = var.pipeline_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name  = "pipeline"
    image = "${aws_ecr_repository.services["pipeline"].repository_url}:latest"
    essential = true

    environment = [
      { name = "KINESIS_STREAM",  value = aws_kinesis_stream.lines.name },
      { name = "AWS_REGION",      value = var.aws_region },
      { name = "REDIS_URL",       value = "redis://${aws_elasticache_cluster.redis.cache_nodes[0].address}:6379" },
      { name = "DATABASE_URL",    value = "postgresql://${var.db_username}@${aws_db_instance.main.endpoint}/${var.db_name}" },
      { name = "SNS_TOPIC_ARN",   value = aws_sns_topic.alerts.arn },
      { name = "EV_THRESHOLD",    value = tostring(var.ev_threshold) }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.services["pipeline"].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "pipeline"
      }
    }
  }])
}

resource "aws_ecs_service" "pipeline" {
  name            = "${local.prefix}-pipeline"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.pipeline.arn
  desired_count   = var.pipeline_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.ecs_tasks.id]
  }
}

# ── Alerts Service ──
resource "aws_ecs_task_definition" "alerts" {
  family                   = "${local.prefix}-alerts"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.alerts_cpu
  memory                   = var.alerts_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name  = "alerts"
    image = "${aws_ecr_repository.services["alerts"].repository_url}:latest"
    essential = true

    environment = [
      { name = "AWS_REGION",    value = var.aws_region },
      { name = "SNS_TOPIC_ARN", value = aws_sns_topic.alerts.arn },
      { name = "SECRETS_ARN",   value = aws_secretsmanager_secret.app_secrets.arn },
      { name = "REDIS_URL",     value = "redis://${aws_elasticache_cluster.redis.cache_nodes[0].address}:6379" }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.services["alerts"].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "alerts"
      }
    }
  }])
}

resource "aws_ecs_service" "alerts" {
  name            = "${local.prefix}-alerts"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.alerts.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.ecs_tasks.id]
  }
}

# ── Tracker Service ──
resource "aws_ecs_task_definition" "tracker" {
  family                   = "${local.prefix}-tracker"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.tracker_cpu
  memory                   = var.tracker_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name  = "tracker"
    image = "${aws_ecr_repository.services["tracker"].repository_url}:latest"
    essential = true

    environment = [
      { name = "DATABASE_URL", value = "postgresql://${var.db_username}@${aws_db_instance.main.endpoint}/${var.db_name}" },
      { name = "REDIS_URL",    value = "redis://${aws_elasticache_cluster.redis.cache_nodes[0].address}:6379" },
      { name = "AWS_REGION",   value = var.aws_region }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.services["tracker"].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "tracker"
      }
    }
  }])
}

resource "aws_ecs_service" "tracker" {
  name            = "${local.prefix}-tracker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.tracker.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.ecs_tasks.id]
  }
}

## ══════════════════════════════════════════════
## 5. AUTO-SCALING
## ══════════════════════════════════════════════

resource "aws_appautoscaling_target" "scraper" {
  max_capacity       = 6
  min_capacity       = 1
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.scraper.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "scraper_cpu" {
  name               = "${local.prefix}-scraper-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.scraper.resource_id
  scalable_dimension = aws_appautoscaling_target.scraper.scalable_dimension
  service_namespace  = aws_appautoscaling_target.scraper.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 70.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_target" "pipeline" {
  max_capacity       = 10
  min_capacity       = 1
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.pipeline.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "pipeline_cpu" {
  name               = "${local.prefix}-pipeline-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.pipeline.resource_id
  scalable_dimension = aws_appautoscaling_target.pipeline.scalable_dimension
  service_namespace  = aws_appautoscaling_target.pipeline.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 30
  }
}

## ══════════════════════════════════════════════
## 6. KINESIS — Real-time line streaming
## ══════════════════════════════════════════════

resource "aws_kinesis_stream" "lines" {
  name             = "${local.prefix}-lines"
  shard_count      = var.kinesis_shard_count
  retention_period = 24

  stream_mode_details {
    stream_mode = "PROVISIONED"
  }

  tags = { Name = "${local.prefix}-lines-stream" }
}

## ══════════════════════════════════════════════
## 7. REDIS — ElastiCache
## ══════════════════════════════════════════════

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.prefix}-redis-subnet"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "${local.prefix}-redis"
  engine               = "redis"
  node_type            = var.redis_node_type
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]
}

## ══════════════════════════════════════════════
## 8. RDS — PostgreSQL
## ══════════════════════════════════════════════

resource "aws_db_subnet_group" "main" {
  name       = "${local.prefix}-db-subnet"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "main" {
  identifier             = "${local.prefix}-db"
  engine                 = "postgres"
  engine_version         = "16.1"
  instance_class         = var.db_instance_class
  allocated_storage      = 20
  max_allocated_storage  = 100
  db_name                = var.db_name
  username               = var.db_username
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  backup_retention_period = 7
  skip_final_snapshot     = false
  final_snapshot_identifier = "${local.prefix}-db-final"
  storage_encrypted       = true
  multi_az                = false

  tags = { Name = "${local.prefix}-db" }
}

## ══════════════════════════════════════════════
## 9. SNS — Alert topic
## ══════════════════════════════════════════════

resource "aws_sns_topic" "alerts" {
  name = "${local.prefix}-alerts"
}

## ══════════════════════════════════════════════
## 10. SECRETS MANAGER
## ══════════════════════════════════════════════

resource "aws_secretsmanager_secret" "app_secrets" {
  name                    = "${local.prefix}-secrets"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "app_secrets" {
  secret_id = aws_secretsmanager_secret.app_secrets.id
  secret_string = jsonencode({
    TELEGRAM_BOT_TOKEN  = var.telegram_bot_token
    TELEGRAM_CHAT_ID    = var.telegram_chat_id
    DISCORD_WEBHOOK_URL = var.discord_webhook_url
    DB_PASSWORD         = "CHANGE_ME_AFTER_DEPLOY"
    PROXY_API_KEY       = "CHANGE_ME"
    ODDS_API_KEY        = "CHANGE_ME"
  })
}

## ══════════════════════════════════════════════
## 11. CLOUDWATCH ALARMS
## ══════════════════════════════════════════════

resource "aws_cloudwatch_metric_alarm" "scraper_errors" {
  alarm_name          = "${local.prefix}-scraper-high-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ScraperErrors"
  namespace           = "BetAnalytics"
  period              = 300
  statistic           = "Sum"
  threshold           = 50
  alarm_description   = "Scraper error rate too high"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "pipeline_latency" {
  alarm_name          = "${local.prefix}-pipeline-high-latency"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "PipelineLatencyMs"
  namespace           = "BetAnalytics"
  period              = 60
  statistic           = "Average"
  threshold           = 5000
  alarm_description   = "Pipeline processing latency > 5s"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
