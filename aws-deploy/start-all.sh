#!/bin/bash
# Start all AeroLink AWS services (RDS, EC2 Kafka, ECS services)
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"
source "$SCRIPT_DIR/.env.deploy"

echo "=== Starting AeroLink Services ==="

# ── RDS ────────────────────────────────────────────────────────────────────
echo "Starting RDS instance..."
RDS_STATE=$(aws rds describe-db-instances \
  --db-instance-identifier "${PROJECT}-postgres" \
  --query "DBInstances[0].DBInstanceStatus" \
  --output text --region "$AWS_REGION" 2>/dev/null || echo "not-found")

if [ "$RDS_STATE" = "available" ]; then
  echo "  RDS already running"
else
  if [ "$RDS_STATE" = "stopping" ]; then
    echo "  RDS still stopping — waiting for it to fully stop..."
    until aws rds describe-db-instances \
      --db-instance-identifier "${PROJECT}-postgres" \
      --query "DBInstances[0].DBInstanceStatus" \
      --output text --region "$AWS_REGION" 2>/dev/null | grep -q "^stopped$"; do
      echo -n "."; sleep 10
    done
    echo " stopped."
  fi
  aws rds start-db-instance \
    --db-instance-identifier "${PROJECT}-postgres" \
    --region "$AWS_REGION" --no-cli-pager > /dev/null
  echo "  RDS starting (takes ~2-3 min)..."
fi

# ── EC2 Kafka ──────────────────────────────────────────────────────────────
echo "Starting EC2 Kafka instance..."
KAFKA_INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=${PROJECT}-kafka" "Name=instance-state-name,Values=stopped,running" \
  --query "Reservations[0].Instances[0].InstanceId" \
  --output text --region "$AWS_REGION" 2>/dev/null | grep -v None | grep -v "^$" || true)

if [ -z "$KAFKA_INSTANCE_ID" ]; then
  echo "  WARNING: Kafka EC2 instance not found. Check AWS Console."
else
  EC2_STATE=$(aws ec2 describe-instances \
    --instance-ids "$KAFKA_INSTANCE_ID" \
    --query "Reservations[0].Instances[0].State.Name" \
    --output text --region "$AWS_REGION")

  if [ "$EC2_STATE" = "stopped" ]; then
    aws ec2 start-instances --instance-ids "$KAFKA_INSTANCE_ID" \
      --region "$AWS_REGION" --no-cli-pager > /dev/null
    echo "  EC2 Kafka starting (instance: $KAFKA_INSTANCE_ID)..."
  elif [ "$EC2_STATE" = "running" ]; then
    echo "  EC2 Kafka already running"
  else
    echo "  EC2 Kafka status: $EC2_STATE"
  fi
fi

# ── Wait for RDS ───────────────────────────────────────────────────────────
echo "Waiting for RDS to become available..."
for i in {1..24}; do
  RDS_STATE=$(aws rds describe-db-instances \
    --db-instance-identifier "${PROJECT}-postgres" \
    --query "DBInstances[0].DBInstanceStatus" \
    --output text --region "$AWS_REGION" 2>/dev/null || echo "checking")
  if [ "$RDS_STATE" = "available" ]; then
    echo "  RDS is available"
    break
  fi
  echo "  RDS status: $RDS_STATE (${i}/24, waiting 15s...)"
  sleep 15
done

# ── Wait for EC2 to be running ─────────────────────────────────────────────
if [ -n "$KAFKA_INSTANCE_ID" ]; then
  echo "Waiting for EC2 Kafka to reach running state..."
  for i in {1..12}; do
    EC2_STATE=$(aws ec2 describe-instances \
      --instance-ids "$KAFKA_INSTANCE_ID" \
      --query "Reservations[0].Instances[0].State.Name" \
      --output text --region "$AWS_REGION")
    if [ "$EC2_STATE" = "running" ]; then
      echo "  EC2 Kafka is running"
      break
    fi
    echo "  EC2 status: $EC2_STATE (waiting 10s...)"
    sleep 10
  done

  # Give Kafka/Zookeeper ~30s to start inside the instance before ECS connects
  echo "  Giving Kafka 30s to start inside the instance..."
  sleep 30
fi

# ── ECS Services ───────────────────────────────────────────────────────────
echo "Starting ECS services (desired count = 1)..."
for SVC in auth-service flight-service booking-service baggage-service api-gateway; do
  aws ecs update-service \
    --cluster "${PROJECT}-cluster" \
    --service "$SVC" \
    --desired-count 1 \
    --region "$AWS_REGION" --no-cli-pager > /dev/null
  echo "  Started: $SVC"
done

echo ""
echo "=== All services starting ==="
echo ""
echo "  RDS:         $RDS_ENDPOINT"
echo "  API Gateway: http://${ALB_DNS}:3000"
echo ""
echo "ECS tasks take ~2 min to reach RUNNING state."
echo "Check status:"
echo "  aws ecs list-tasks --cluster ${PROJECT}-cluster --region ${AWS_REGION}"
echo ""
echo "Quick health check (run after ~2 min):"
echo "  curl http://${ALB_DNS}:3000/health"
echo "  curl http://${ALB_DNS}:3000/flights"
