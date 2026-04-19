#!/bin/bash
# Initialize LocalStack resources for local development

echo "Creating Kinesis stream..."
awslocal kinesis create-stream --stream-name betanalytics-production-lines --shard-count 2

echo "Creating SNS topic..."
awslocal sns create-topic --name betanalytics-alerts

echo "Creating SQS queue..."
awslocal sqs create-queue --queue-name betanalytics-alerts-queue

echo "Subscribing SQS to SNS..."
awslocal sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:000000000000:betanalytics-alerts \
  --protocol sqs \
  --notification-endpoint arn:aws:sqs:us-east-1:000000000000:betanalytics-alerts-queue

echo "Creating Secrets Manager secret..."
awslocal secretsmanager create-secret \
  --name betanalytics-secrets \
  --secret-string '{"ODDS_API_KEY":"","TELEGRAM_BOT_TOKEN":"","TELEGRAM_CHAT_ID":"","DISCORD_WEBHOOK_URL":""}'

echo "LocalStack initialization complete!"
