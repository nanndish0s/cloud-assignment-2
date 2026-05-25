#!/bin/bash
# Step 6 — Security upgrade: Secrets Manager + encrypted RDS
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"
source "$SCRIPT_DIR/.env.deploy"

echo "=== Security Upgrade ==="

# ── Secrets Manager ────────────────────────────────────────────────────────
echo "Storing secrets in AWS Secrets Manager..."

store_secret() {
  local name=$1 value=$2
  EXISTING=$(aws secretsmanager describe-secret --secret-id "$name" \
    --region "$AWS_REGION" --query "ARN" --output text 2>/dev/null || echo "")
  if [ -n "$EXISTING" ]; then
    aws secretsmanager put-secret-value --secret-id "$name" \
      --secret-string "$value" --region "$AWS_REGION" --no-cli-pager > /dev/null
  else
    aws secretsmanager create-secret --name "$name" \
      --secret-string "$value" --region "$AWS_REGION" --no-cli-pager > /dev/null
  fi
  echo "  ✓ $name"
}

store_secret "aerolink/db-password"   "$DB_PASSWORD"
store_secret "aerolink/jwt-secret"    "aerolink_secret_key"
store_secret "aerolink/admin-email"   "admin@aerolink.com"
store_secret "aerolink/admin-password" "admin123"

# Get secret ARNs
DB_PASS_ARN=$(aws secretsmanager describe-secret --secret-id "aerolink/db-password" \
  --query "ARN" --output text --region "$AWS_REGION")
JWT_ARN=$(aws secretsmanager describe-secret --secret-id "aerolink/jwt-secret" \
  --query "ARN" --output text --region "$AWS_REGION")
ADMIN_EMAIL_ARN=$(aws secretsmanager describe-secret --secret-id "aerolink/admin-email" \
  --query "ARN" --output text --region "$AWS_REGION")
ADMIN_PASS_ARN=$(aws secretsmanager describe-secret --secret-id "aerolink/admin-password" \
  --query "ARN" --output text --region "$AWS_REGION")

echo "  ✓ All secrets stored"

# ── Update ECS execution role to read secrets ──────────────────────────────
echo "Granting ECS execution role access to Secrets Manager..."
aws iam put-role-policy \
  --role-name "${PROJECT}-ecs-execution-role" \
  --policy-name "${PROJECT}-secrets-policy" \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "*"
    }]
  }' > /dev/null
echo "  ✓ IAM policy updated"

# ── Re-register task definitions using Secrets Manager ────────────────────
echo "Re-registering task definitions with secrets references..."

register_task_with_secrets() {
  local name=$1 port=$2 env_json=$3 secrets_json=$4

  aws ecs register-task-definition \
    --family "${PROJECT}-${name}" \
    --network-mode awsvpc \
    --requires-compatibilities FARGATE \
    --cpu 256 --memory 512 \
    --execution-role-arn "$EXEC_ROLE_ARN" \
    --task-role-arn "$TASK_ROLE_ARN" \
    --container-definitions "[{
      \"name\": \"${name}\",
      \"image\": \"${ECR_BASE}/${PROJECT}-${name}:latest\",
      \"portMappings\": [{\"containerPort\": ${port}, \"protocol\": \"tcp\"}],
      \"environment\": ${env_json},
      \"secrets\": ${secrets_json},
      \"logConfiguration\": {
        \"logDriver\": \"awslogs\",
        \"options\": {
          \"awslogs-group\": \"/ecs/${PROJECT}/${name}\",
          \"awslogs-region\": \"${AWS_REGION}\",
          \"awslogs-stream-prefix\": \"ecs\"
        }
      }
    }]" \
    --region "$AWS_REGION" --no-cli-pager > /dev/null
  echo "  ✓ Task def: ${PROJECT}-${name}"
}

register_task_with_secrets "auth-service" 3001 \
  "[{\"name\":\"PORT\",\"value\":\"3001\"},
    {\"name\":\"DB_HOST\",\"value\":\"${RDS_ENDPOINT}\"},
    {\"name\":\"DB_USER\",\"value\":\"aerouser\"},
    {\"name\":\"DB_NAME\",\"value\":\"aerolink\"},
    {\"name\":\"DB_PORT\",\"value\":\"5432\"}]" \
  "[{\"name\":\"DB_PASSWORD\",\"valueFrom\":\"${DB_PASS_ARN}\"},
    {\"name\":\"JWT_SECRET\",\"valueFrom\":\"${JWT_ARN}\"},
    {\"name\":\"ADMIN_EMAIL\",\"valueFrom\":\"${ADMIN_EMAIL_ARN}\"},
    {\"name\":\"ADMIN_PASSWORD\",\"valueFrom\":\"${ADMIN_PASS_ARN}\"}]"

register_task_with_secrets "flight-service" 3002 \
  "[{\"name\":\"PORT\",\"value\":\"3002\"},
    {\"name\":\"DB_HOST\",\"value\":\"${RDS_ENDPOINT}\"},
    {\"name\":\"DB_USER\",\"value\":\"aerouser\"},
    {\"name\":\"DB_NAME\",\"value\":\"aerolink\"},
    {\"name\":\"DB_PORT\",\"value\":\"5432\"},
    {\"name\":\"KAFKA_BROKER\",\"value\":\"${KAFKA_PRIVATE_IP}:9092\"}]" \
  "[{\"name\":\"DB_PASSWORD\",\"valueFrom\":\"${DB_PASS_ARN}\"}]"

register_task_with_secrets "booking-service" 3003 \
  "[{\"name\":\"PORT\",\"value\":\"3003\"},
    {\"name\":\"DB_HOST\",\"value\":\"${RDS_ENDPOINT}\"},
    {\"name\":\"DB_USER\",\"value\":\"aerouser\"},
    {\"name\":\"DB_NAME\",\"value\":\"aerolink\"},
    {\"name\":\"DB_PORT\",\"value\":\"5432\"},
    {\"name\":\"KAFKA_BROKER\",\"value\":\"${KAFKA_PRIVATE_IP}:9092\"},
    {\"name\":\"FLIGHT_SERVICE_URL\",\"value\":\"http://flight-service.${PROJECT}.local:3002\"},
    {\"name\":\"BOOKING_SQS_URL\",\"value\":\"${SQS_URL}\"},
    {\"name\":\"AWS_REGION\",\"value\":\"${AWS_REGION}\"}]" \
  "[{\"name\":\"DB_PASSWORD\",\"valueFrom\":\"${DB_PASS_ARN}\"}]"

register_task_with_secrets "baggage-service" 3004 \
  "[{\"name\":\"PORT\",\"value\":\"3004\"},
    {\"name\":\"KAFKA_BROKER\",\"value\":\"${KAFKA_PRIVATE_IP}:9092\"},
    {\"name\":\"AWS_REGION\",\"value\":\"${AWS_REGION}\"}]" \
  "[]"

register_task_with_secrets "api-gateway" 3000 \
  "[{\"name\":\"GATEWAY_PORT\",\"value\":\"3000\"},
    {\"name\":\"AUTH_SERVICE_URL\",\"value\":\"http://auth-service.${PROJECT}.local:3001\"},
    {\"name\":\"FLIGHT_SERVICE_URL\",\"value\":\"http://flight-service.${PROJECT}.local:3002\"},
    {\"name\":\"BOOKING_SERVICE_URL\",\"value\":\"http://booking-service.${PROJECT}.local:3003\"},
    {\"name\":\"BAGGAGE_SERVICE_URL\",\"value\":\"http://baggage-service.${PROJECT}.local:3004\"}]" \
  "[{\"name\":\"JWT_SECRET\",\"valueFrom\":\"${JWT_ARN}\"}]"

# ── Recreate RDS with encryption ───────────────────────────────────────────
echo "Recreating RDS with encryption at rest..."

# Look up RDS security group (may not be in .env.deploy)
RDS_SG=$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=aerolink-rds-sg" \
  --query "SecurityGroups[0].GroupId" --output text --region "$AWS_REGION")

# Delete old unencrypted instance
aws rds delete-db-instance \
  --db-instance-identifier "${PROJECT}-postgres" \
  --skip-final-snapshot \
  --region "$AWS_REGION" --no-cli-pager > /dev/null 2>/dev/null || true

echo "  Waiting for old RDS to be deleted (~3 min)..."
aws rds wait db-instance-deleted \
  --db-instance-identifier "${PROJECT}-postgres" --region "$AWS_REGION"

# Create new encrypted instance
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
  --storage-encrypted \
  --region "$AWS_REGION" --no-cli-pager > /dev/null

echo "  Waiting for encrypted RDS to be available (~10 min)..."
aws rds wait db-instance-available \
  --db-instance-identifier "${PROJECT}-postgres" --region "$AWS_REGION"

NEW_RDS_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier "${PROJECT}-postgres" \
  --query "DBInstances[0].Endpoint.Address" --output text --region "$AWS_REGION")
echo "  ✓ Encrypted RDS: $NEW_RDS_ENDPOINT"

# Update .env.deploy with new endpoint
sed -i "s|RDS_ENDPOINT=.*|RDS_ENDPOINT=${NEW_RDS_ENDPOINT}|" "$SCRIPT_DIR/.env.deploy"

# ── Force redeploy all services ────────────────────────────────────────────
echo "Force-redeploying all services with new task definitions..."
for SVC in auth-service flight-service booking-service baggage-service api-gateway; do
  aws ecs update-service \
    --cluster "${PROJECT}-cluster" --service "$SVC" \
    --force-new-deployment \
    --region "$AWS_REGION" --no-cli-pager > /dev/null
  echo "  ✓ Redeployed $SVC"
done

echo ""
echo "=== Security upgrade complete ==="
echo "  Secrets Manager: DB password, JWT secret, admin credentials"
echo "  RDS encryption:  StorageEncrypted=true"
echo "  ECS task defs:   Secrets pulled from Secrets Manager at runtime"
echo ""
echo "Wait ~2 min for services to restart."
