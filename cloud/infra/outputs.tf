## ──────────────────────────────────────────────
## BetAnalytics Cloud — Outputs
## ──────────────────────────────────────────────

output "vpc_id" {
  value = aws_vpc.main.id
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "kinesis_stream_name" {
  value = aws_kinesis_stream.lines.name
}

output "kinesis_stream_arn" {
  value = aws_kinesis_stream.lines.arn
}

output "redis_endpoint" {
  value = aws_elasticache_cluster.redis.cache_nodes[0].address
}

output "rds_endpoint" {
  value = aws_db_instance.main.endpoint
}

output "sns_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "ecr_repositories" {
  value = { for k, v in aws_ecr_repository.services : k => v.repository_url }
}

output "secrets_arn" {
  value = aws_secretsmanager_secret.app_secrets.arn
}
