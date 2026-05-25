#!/bin/bash
# Stop all AeroLink AWS services to avoid charges when not in use.
# DynamoDB, SQS, Lambda, and CloudFront are serverless - no charge when idle.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"
source "$SCRIPT_DIR/.env.deploy"

echo "=== Stopping AeroLink Services ==="

# ── ECS services (scale to 0) ──────────────────────────────────────────────
echo "Scaling ECS services to 0..."
for SVC in auth-service flight-service booking-service baggage-service api-gateway frontend; do
  aws ecs update-service \
    --cluster "${PROJECT}-cluster" \
    --service "$SVC" \
    --desired-count 0 \
    --region "$AWS_REGION" --no-cli-pager > /dev/null 2>&1 || true
  echo "  Scaled to 0: $SVC"
done

# ── EC2 Kafka ──────────────────────────────────────────────────────────────
echo "Stopping EC2 Kafka instance..."
KAFKA_INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=${PROJECT}-kafka" "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].InstanceId" \
  --output text --region "$AWS_REGION" 2>/dev/null | grep -v None | grep -v "^$" || true)

if [ -n "$KAFKA_INSTANCE_ID" ]; then
  aws ec2 stop-instances --instance-ids "$KAFKA_INSTANCE_ID" \
    --region "$AWS_REGION" --no-cli-pager > /dev/null
  echo "  EC2 Kafka stopped (instance: $KAFKA_INSTANCE_ID)"
else
  echo "  EC2 Kafka not found or already stopped"
fi

# ── RDS ────────────────────────────────────────────────────────────────────
echo "Stopping RDS instance..."
RDS_STATE=$(aws rds describe-db-instances \
  --db-instance-identifier "${PROJECT}-postgres" \
  --query "DBInstances[0].DBInstanceStatus" \
  --output text --region "$AWS_REGION" 2>/dev/null || echo "not-found")

if [ "$RDS_STATE" = "available" ]; then
  aws rds stop-db-instance \
    --db-instance-identifier "${PROJECT}-postgres" \
    --region "$AWS_REGION" --no-cli-pager > /dev/null
  echo "  RDS stopping..."
else
  echo "  RDS status: $RDS_STATE (not stopped)"
fi

echo ""
echo "=== Done ==="
echo "Serverless services (DynamoDB, SQS, Lambda, CloudFront, ALB) remain active."
echo "ALB has a small hourly charge (~\$0.02/hr). Delete it to eliminate fully:"
echo "  aws elbv2 delete-load-balancer --load-balancer-arn $ALB_ARN --region $AWS_REGION"
