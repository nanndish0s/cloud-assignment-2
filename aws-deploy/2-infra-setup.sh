#!/bin/bash
# Step 2 — Create AWS infrastructure: Security Groups, RDS, DynamoDB, SQS, EC2 Kafka, IAM
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"
source "$SCRIPT_DIR/.env.deploy"

echo "=== AeroLink Infrastructure Setup ==="

# ── VPC & Subnets ──────────────────────────────────────────────────────────
VPC_ID=$(aws ec2 describe-vpcs \
  --filters "Name=is-default,Values=true" \
  --query "Vpcs[0].VpcId" --output text --region "$AWS_REGION")
echo "VPC: $VPC_ID"

SUBNETS=($(aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --query "Subnets[0:2].SubnetId" --output text --region "$AWS_REGION"))
SUBNET_1="${SUBNETS[0]}"
SUBNET_2="${SUBNETS[1]}"
echo "Subnets: $SUBNET_1, $SUBNET_2"

# ── Security Groups ────────────────────────────────────────────────────────
create_sg() {
  local name=$1 desc=$2
  aws ec2 describe-security-groups \
    --filters "Name=group-name,Values=$name" "Name=vpc-id,Values=$VPC_ID" \
    --query "SecurityGroups[0].GroupId" --output text --region "$AWS_REGION" 2>/dev/null \
  | grep -v None \
  || aws ec2 create-security-group \
       --group-name "$name" --description "$desc" \
       --vpc-id "$VPC_ID" --region "$AWS_REGION" \
       --query "GroupId" --output text
}

allow_ingress() {
  aws ec2 authorize-security-group-ingress "$@" --region "$AWS_REGION" 2>/dev/null || true
}

echo "Creating security groups..."
ALB_SG=$(create_sg "aerolink-alb-sg" "AeroLink ALB")
SERVICES_SG=$(create_sg "aerolink-services-sg" "AeroLink ECS Services")
RDS_SG=$(create_sg "aerolink-rds-sg" "AeroLink RDS")
KAFKA_SG=$(create_sg "aerolink-kafka-sg" "AeroLink Kafka EC2")

# ALB: internet-facing HTTP on ports 80 and 3000
allow_ingress --group-id "$ALB_SG" --protocol tcp --port 80   --cidr 0.0.0.0/0
allow_ingress --group-id "$ALB_SG" --protocol tcp --port 3000 --cidr 0.0.0.0/0

# ECS services: allow from ALB and from each other
allow_ingress --group-id "$SERVICES_SG" --protocol -1 --source-group "$ALB_SG"
allow_ingress --group-id "$SERVICES_SG" --protocol -1 --source-group "$SERVICES_SG"

# RDS: allow from ECS services + current machine (for init.sql)
MY_IP=$(curl -s https://checkip.amazonaws.com)
allow_ingress --group-id "$RDS_SG" --protocol tcp --port 5432 --source-group "$SERVICES_SG"
allow_ingress --group-id "$RDS_SG" --protocol tcp --port 5432 --cidr "${MY_IP}/32"

# Kafka EC2: allow port 9092 from ECS services
allow_ingress --group-id "$KAFKA_SG" --protocol tcp --port 9092 --source-group "$SERVICES_SG"

echo "  ✓ ALB SG:      $ALB_SG"
echo "  ✓ Services SG: $SERVICES_SG"
echo "  ✓ RDS SG:      $RDS_SG"
echo "  ✓ Kafka SG:    $KAFKA_SG"

# ── RDS PostgreSQL ─────────────────────────────────────────────────────────
echo "Creating RDS PostgreSQL (db.t3.micro)..."
aws rds create-db-instance \
  --db-instance-identifier "${PROJECT}-postgres" \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --engine-version 14 \
  --master-username aerouser \
  --master-user-password "$DB_PASSWORD" \
  --db-name aerolink \
  --allocated-storage 20 \
  --no-multi-az \
  --publicly-accessible \
  --vpc-security-group-ids "$RDS_SG" \
  --region "$AWS_REGION" \
  --no-cli-pager 2>/dev/null || echo "  RDS already exists — skipping create"

echo "  Waiting for RDS to become available (may take 5–10 min)..."
aws rds wait db-instance-available \
  --db-instance-identifier "${PROJECT}-postgres" --region "$AWS_REGION"

RDS_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier "${PROJECT}-postgres" \
  --query "DBInstances[0].Endpoint.Address" --output text --region "$AWS_REGION")
echo "  ✓ RDS endpoint: $RDS_ENDPOINT"

# ── DynamoDB ───────────────────────────────────────────────────────────────
echo "Creating DynamoDB table..."
aws dynamodb create-table \
  --table-name BaggageStatus \
  --attribute-definitions AttributeName=BaggageId,AttributeType=S \
  --key-schema AttributeName=BaggageId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region "$AWS_REGION" --no-cli-pager 2>/dev/null || echo "  DynamoDB table already exists"
echo "  ✓ DynamoDB: BaggageStatus"

# ── SQS Queue ──────────────────────────────────────────────────────────────
echo "Creating SQS queue..."
SQS_URL=$(aws sqs create-queue \
  --queue-name "${PROJECT}-booking-notifications" \
  --region "$AWS_REGION" \
  --query "QueueUrl" --output text 2>/dev/null) \
|| SQS_URL=$(aws sqs get-queue-url \
     --queue-name "${PROJECT}-booking-notifications" \
     --region "$AWS_REGION" --query "QueueUrl" --output text)
SQS_ARN="arn:aws:sqs:${AWS_REGION}:${AWS_ACCOUNT_ID}:${PROJECT}-booking-notifications"
echo "  ✓ SQS: $SQS_URL"

# ── EC2 Kafka (t2.micro — free tier) ──────────────────────────────────────
echo "Launching Kafka EC2 instance..."
AMI_ID=$(aws ec2 describe-images \
  --owners amazon \
  --filters "Name=name,Values=amzn2-ami-hvm-*-x86_64-gp2" "Name=state,Values=available" \
  --query "sort_by(Images, &CreationDate)[-1].ImageId" \
  --output text --region "$AWS_REGION")

# base64-encode user-data (avoids file:// path issues on Windows Git Bash)
KAFKA_USER_DATA=$(base64 -w0 < "$SCRIPT_DIR/kafka-init.sh")

KAFKA_INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=${PROJECT}-kafka" "Name=instance-state-name,Values=running,pending" \
  --query "Reservations[0].Instances[0].InstanceId" --output text --region "$AWS_REGION" 2>/dev/null \
  | grep -v None) \
|| KAFKA_INSTANCE_ID=$(aws ec2 run-instances \
     --image-id "$AMI_ID" \
     --instance-type t3.micro \
     --key-name "$KEY_PAIR_NAME" \
     --security-group-ids "$KAFKA_SG" \
     --subnet-id "$SUBNET_1" \
     --user-data "$KAFKA_USER_DATA" \
     --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${PROJECT}-kafka}]" \
     --region "$AWS_REGION" \
     --query "Instances[0].InstanceId" --output text --no-cli-pager)

echo "  Waiting for Kafka EC2 ($KAFKA_INSTANCE_ID) to start..."
aws ec2 wait instance-running --instance-ids "$KAFKA_INSTANCE_ID" --region "$AWS_REGION"

KAFKA_PRIVATE_IP=$(aws ec2 describe-instances \
  --instance-ids "$KAFKA_INSTANCE_ID" \
  --query "Reservations[0].Instances[0].PrivateIpAddress" \
  --output text --region "$AWS_REGION")
echo "  ✓ Kafka EC2 private IP: $KAFKA_PRIVATE_IP"
echo "  Note: Kafka takes ~2 min after instance start before it accepts connections."

# ── IAM Roles ─────────────────────────────────────────────────────────────
echo "Creating IAM roles..."
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam create-role --role-name "${PROJECT}-ecs-execution-role" \
  --assume-role-policy-document "$TRUST" --no-cli-pager 2>/dev/null || true
aws iam attach-role-policy --role-name "${PROJECT}-ecs-execution-role" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy 2>/dev/null || true

aws iam create-role --role-name "${PROJECT}-ecs-task-role" \
  --assume-role-policy-document "$TRUST" --no-cli-pager 2>/dev/null || true
aws iam put-role-policy --role-name "${PROJECT}-ecs-task-role" \
  --policy-name "${PROJECT}-task-policy" \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["dynamodb:*","sqs:SendMessage","sqs:GetQueueUrl"],"Resource":"*"}]}' 2>/dev/null || true

EXEC_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${PROJECT}-ecs-execution-role"
TASK_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${PROJECT}-ecs-task-role"
echo "  ✓ IAM roles created"

# ── Save all values ────────────────────────────────────────────────────────
cat >> "$SCRIPT_DIR/.env.deploy" << EOF
VPC_ID=${VPC_ID}
SUBNET_1=${SUBNET_1}
SUBNET_2=${SUBNET_2}
ALB_SG=${ALB_SG}
SERVICES_SG=${SERVICES_SG}
RDS_ENDPOINT=${RDS_ENDPOINT}
DB_PASSWORD=${DB_PASSWORD}
SQS_URL=${SQS_URL}
SQS_ARN=${SQS_ARN}
KAFKA_PRIVATE_IP=${KAFKA_PRIVATE_IP}
EXEC_ROLE_ARN=${EXEC_ROLE_ARN}
TASK_ROLE_ARN=${TASK_ROLE_ARN}
EOF

echo ""
echo "=== Infrastructure ready ==="
echo "RDS:   $RDS_ENDPOINT"
echo "Kafka: $KAFKA_PRIVATE_IP:9092 (wait ~2 min for Kafka to finish starting)"
echo "SQS:   $SQS_URL"
echo ""
echo "Next: run  bash 3-build-backend.sh"
