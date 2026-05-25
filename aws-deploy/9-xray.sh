#!/bin/bash
# Step 9 — Enable AWS X-Ray distributed tracing across all ECS services
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
source "$SCRIPT_DIR/config.sh"
source "$SCRIPT_DIR/.env.deploy"

echo "=== AWS X-Ray Distributed Tracing Setup ==="

# ── IAM: add X-Ray permissions to task role ────────────────────────────────
echo "Adding X-Ray permissions to ECS task role..."
aws iam put-role-policy \
  --role-name "${PROJECT}-ecs-task-role" \
  --policy-name "${PROJECT}-xray-policy" \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": [
        "xray:PutTraceSegments",
        "xray:PutTelemetryRecords",
        "xray:GetSamplingRules",
        "xray:GetSamplingTargets"
      ],
      "Resource": "*"
    }]
  }' > /dev/null
echo "  ✓ X-Ray IAM permissions granted"

# ── CloudWatch log group for X-Ray daemon ─────────────────────────────────
MSYS_NO_PATHCONV=1 aws logs create-log-group \
  --log-group-name "/ecs/${PROJECT}/xray-daemon" \
  --region "$AWS_REGION" 2>/dev/null || true
echo "  ✓ X-Ray daemon log group created"

# ── Rebuild and push all backend images (now include aws-xray-sdk) ─────────
if [ "${SKIP_BUILD:-false}" != "true" ]; then
  echo "Rebuilding backend images with X-Ray SDK..."
  aws ecr get-login-password --region "$AWS_REGION" \
    | docker login --username AWS --password-stdin "$ECR_BASE"

  for SERVICE in auth-service flight-service booking-service baggage-service api-gateway; do
    docker build -t "${PROJECT}-${SERVICE}" "$ROOT/${SERVICE}" --quiet
    docker tag "${PROJECT}-${SERVICE}:latest" "${ECR_BASE}/${PROJECT}-${SERVICE}:latest"
    docker push "${ECR_BASE}/${PROJECT}-${SERVICE}:latest" --quiet
    echo "  ✓ Pushed ${SERVICE}"
  done
else
  echo "Skipping image rebuild (SKIP_BUILD=true)"
fi

# ── Re-register task definitions with X-Ray daemon sidecar ────────────────
echo "Re-registering task definitions with X-Ray daemon sidecar..."

XRAY_SIDECAR="{
  \"name\": \"xray-daemon\",
  \"image\": \"public.ecr.aws/xray/aws-xray-daemon:latest\",
  \"cpu\": 32,
  \"memoryReservation\": 64,
  \"portMappings\": [{\"containerPort\": 2000, \"protocol\": \"udp\"}],
  \"logConfiguration\": {
    \"logDriver\": \"awslogs\",
    \"options\": {
      \"awslogs-group\": \"/ecs/${PROJECT}/xray-daemon\",
      \"awslogs-region\": \"${AWS_REGION}\",
      \"awslogs-stream-prefix\": \"ecs\"
    }
  }
}"

register_task_xray() {
  local name=$1 port=$2 env_json=$3 secrets_json=$4

  aws ecs register-task-definition \
    --family "${PROJECT}-${name}" \
    --network-mode awsvpc \
    --requires-compatibilities FARGATE \
    --cpu 512 --memory 1024 \
    --execution-role-arn "$EXEC_ROLE_ARN" \
    --task-role-arn "$TASK_ROLE_ARN" \
    --container-definitions "[
      {
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
      },
      ${XRAY_SIDECAR}
    ]" \
    --region "$AWS_REGION" --no-cli-pager > /dev/null
  echo "  ✓ Task def: ${PROJECT}-${name} (with X-Ray sidecar)"
}

# Get secret ARNs
DB_PASS_ARN=$(aws secretsmanager describe-secret --secret-id "aerolink/db-password" \
  --query "ARN" --output text --region "$AWS_REGION")
JWT_ARN=$(aws secretsmanager describe-secret --secret-id "aerolink/jwt-secret" \
  --query "ARN" --output text --region "$AWS_REGION")
ADMIN_EMAIL_ARN=$(aws secretsmanager describe-secret --secret-id "aerolink/admin-email" \
  --query "ARN" --output text --region "$AWS_REGION")
ADMIN_PASS_ARN=$(aws secretsmanager describe-secret --secret-id "aerolink/admin-password" \
  --query "ARN" --output text --region "$AWS_REGION")

register_task_xray "auth-service" 3001 \
  "[{\"name\":\"PORT\",\"value\":\"3001\"},
    {\"name\":\"DB_HOST\",\"value\":\"${RDS_ENDPOINT}\"},
    {\"name\":\"DB_USER\",\"value\":\"aerouser\"},
    {\"name\":\"DB_NAME\",\"value\":\"aerolink\"},
    {\"name\":\"DB_PORT\",\"value\":\"5432\"},
    {\"name\":\"ENABLE_XRAY\",\"value\":\"true\"}]" \
  "[{\"name\":\"DB_PASSWORD\",\"valueFrom\":\"${DB_PASS_ARN}\"},
    {\"name\":\"JWT_SECRET\",\"valueFrom\":\"${JWT_ARN}\"},
    {\"name\":\"ADMIN_EMAIL\",\"valueFrom\":\"${ADMIN_EMAIL_ARN}\"},
    {\"name\":\"ADMIN_PASSWORD\",\"valueFrom\":\"${ADMIN_PASS_ARN}\"}]"

register_task_xray "flight-service" 3002 \
  "[{\"name\":\"PORT\",\"value\":\"3002\"},
    {\"name\":\"DB_HOST\",\"value\":\"${RDS_ENDPOINT}\"},
    {\"name\":\"DB_USER\",\"value\":\"aerouser\"},
    {\"name\":\"DB_NAME\",\"value\":\"aerolink\"},
    {\"name\":\"DB_PORT\",\"value\":\"5432\"},
    {\"name\":\"KAFKA_BROKER\",\"value\":\"${KAFKA_PRIVATE_IP}:9092\"},
    {\"name\":\"ENABLE_XRAY\",\"value\":\"true\"}]" \
  "[{\"name\":\"DB_PASSWORD\",\"valueFrom\":\"${DB_PASS_ARN}\"}]"

register_task_xray "booking-service" 3003 \
  "[{\"name\":\"PORT\",\"value\":\"3003\"},
    {\"name\":\"DB_HOST\",\"value\":\"${RDS_ENDPOINT}\"},
    {\"name\":\"DB_USER\",\"value\":\"aerouser\"},
    {\"name\":\"DB_NAME\",\"value\":\"aerolink\"},
    {\"name\":\"DB_PORT\",\"value\":\"5432\"},
    {\"name\":\"KAFKA_BROKER\",\"value\":\"${KAFKA_PRIVATE_IP}:9092\"},
    {\"name\":\"FLIGHT_SERVICE_URL\",\"value\":\"http://flight-service.${PROJECT}.local:3002\"},
    {\"name\":\"BOOKING_SQS_URL\",\"value\":\"${SQS_URL}\"},
    {\"name\":\"AWS_REGION\",\"value\":\"${AWS_REGION}\"},
    {\"name\":\"ENABLE_XRAY\",\"value\":\"true\"}]" \
  "[{\"name\":\"DB_PASSWORD\",\"valueFrom\":\"${DB_PASS_ARN}\"}]"

register_task_xray "baggage-service" 3004 \
  "[{\"name\":\"PORT\",\"value\":\"3004\"},
    {\"name\":\"KAFKA_BROKER\",\"value\":\"${KAFKA_PRIVATE_IP}:9092\"},
    {\"name\":\"AWS_REGION\",\"value\":\"${AWS_REGION}\"},
    {\"name\":\"ENABLE_XRAY\",\"value\":\"true\"}]" \
  "[]"

register_task_xray "api-gateway" 3000 \
  "[{\"name\":\"GATEWAY_PORT\",\"value\":\"3000\"},
    {\"name\":\"AUTH_SERVICE_URL\",\"value\":\"http://auth-service.${PROJECT}.local:3001\"},
    {\"name\":\"FLIGHT_SERVICE_URL\",\"value\":\"http://flight-service.${PROJECT}.local:3002\"},
    {\"name\":\"BOOKING_SERVICE_URL\",\"value\":\"http://booking-service.${PROJECT}.local:3003\"},
    {\"name\":\"BAGGAGE_SERVICE_URL\",\"value\":\"http://baggage-service.${PROJECT}.local:3004\"},
    {\"name\":\"ENABLE_XRAY\",\"value\":\"true\"}]" \
  "[{\"name\":\"JWT_SECRET\",\"valueFrom\":\"${JWT_ARN}\"}]"

# ── Force redeploy all services ────────────────────────────────────────────
echo "Force-redeploying all services..."
for SVC in auth-service flight-service booking-service baggage-service api-gateway; do
  aws ecs update-service \
    --cluster "${PROJECT}-cluster" --service "$SVC" \
    --force-new-deployment \
    --region "$AWS_REGION" --no-cli-pager > /dev/null
  echo "  ✓ Redeployed $SVC"
done

echo ""
echo "=== X-Ray setup complete ==="
echo ""
echo "View service map and traces:"
echo "  https://${AWS_REGION}.console.aws.amazon.com/xray/home?region=${AWS_REGION}#/service-map"
echo ""
echo "Wait ~3 min for services to restart with X-Ray daemon sidecar."
