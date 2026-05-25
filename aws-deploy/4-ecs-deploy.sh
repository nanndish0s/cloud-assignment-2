#!/bin/bash
# Step 4 — Create ECS cluster, ALB, task definitions, and deploy all services.
# Also builds and deploys the frontend using the ALB DNS.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
source "$SCRIPT_DIR/config.sh"
source "$SCRIPT_DIR/.env.deploy"

echo "=== ECS Cluster & Service Deployment ==="

# ── CloudWatch Log Groups ──────────────────────────────────────────────────
for SVC in auth-service flight-service booking-service baggage-service api-gateway frontend; do
  MSYS_NO_PATHCONV=1 aws logs create-log-group --log-group-name "/ecs/${PROJECT}/${SVC}" \
    --region "$AWS_REGION" 2>/dev/null || true
done
echo "✓ CloudWatch log groups created"

# ── ECS Cluster ────────────────────────────────────────────────────────────
aws ecs create-cluster --cluster-name "${PROJECT}-cluster" \
  --region "$AWS_REGION" --no-cli-pager 2>/dev/null || true
echo "✓ ECS cluster: ${PROJECT}-cluster"

# ── Helper: register task definition ───────────────────────────────────────
register_task() {
  local name=$1 port=$2
  shift 2
  local env_json="$*"

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

# ── Register task definitions ──────────────────────────────────────────────
echo "Registering task definitions..."

register_task "auth-service" 3001 "[
  {\"name\":\"PORT\",\"value\":\"3001\"},
  {\"name\":\"DB_HOST\",\"value\":\"${RDS_ENDPOINT}\"},
  {\"name\":\"DB_USER\",\"value\":\"aerouser\"},
  {\"name\":\"DB_PASSWORD\",\"value\":\"${DB_PASSWORD}\"},
  {\"name\":\"DB_NAME\",\"value\":\"aerolink\"},
  {\"name\":\"DB_PORT\",\"value\":\"5432\"},
  {\"name\":\"JWT_SECRET\",\"value\":\"aerolink_secret_key\"},
  {\"name\":\"ADMIN_EMAIL\",\"value\":\"admin@aerolink.com\"},
  {\"name\":\"ADMIN_PASSWORD\",\"value\":\"admin123\"}
]"

register_task "flight-service" 3002 "[
  {\"name\":\"PORT\",\"value\":\"3002\"},
  {\"name\":\"DB_HOST\",\"value\":\"${RDS_ENDPOINT}\"},
  {\"name\":\"DB_USER\",\"value\":\"aerouser\"},
  {\"name\":\"DB_PASSWORD\",\"value\":\"${DB_PASSWORD}\"},
  {\"name\":\"DB_NAME\",\"value\":\"aerolink\"},
  {\"name\":\"DB_PORT\",\"value\":\"5432\"},
  {\"name\":\"KAFKA_BROKER\",\"value\":\"${KAFKA_PRIVATE_IP}:9092\"}
]"

register_task "booking-service" 3003 "[
  {\"name\":\"PORT\",\"value\":\"3003\"},
  {\"name\":\"DB_HOST\",\"value\":\"${RDS_ENDPOINT}\"},
  {\"name\":\"DB_USER\",\"value\":\"aerouser\"},
  {\"name\":\"DB_PASSWORD\",\"value\":\"${DB_PASSWORD}\"},
  {\"name\":\"DB_NAME\",\"value\":\"aerolink\"},
  {\"name\":\"DB_PORT\",\"value\":\"5432\"},
  {\"name\":\"KAFKA_BROKER\",\"value\":\"${KAFKA_PRIVATE_IP}:9092\"},
  {\"name\":\"FLIGHT_SERVICE_URL\",\"value\":\"http://flight-service.${PROJECT}.local:3002\"},
  {\"name\":\"BOOKING_SQS_URL\",\"value\":\"${SQS_URL}\"},
  {\"name\":\"AWS_REGION\",\"value\":\"${AWS_REGION}\"}
]"

register_task "baggage-service" 3004 "[
  {\"name\":\"PORT\",\"value\":\"3004\"},
  {\"name\":\"KAFKA_BROKER\",\"value\":\"${KAFKA_PRIVATE_IP}:9092\"},
  {\"name\":\"AWS_REGION\",\"value\":\"${AWS_REGION}\"}
]"

register_task "api-gateway" 3000 "[
  {\"name\":\"GATEWAY_PORT\",\"value\":\"3000\"},
  {\"name\":\"JWT_SECRET\",\"value\":\"aerolink_secret_key\"},
  {\"name\":\"AUTH_SERVICE_URL\",\"value\":\"http://auth-service.${PROJECT}.local:3001\"},
  {\"name\":\"FLIGHT_SERVICE_URL\",\"value\":\"http://flight-service.${PROJECT}.local:3002\"},
  {\"name\":\"BOOKING_SERVICE_URL\",\"value\":\"http://booking-service.${PROJECT}.local:3003\"},
  {\"name\":\"BAGGAGE_SERVICE_URL\",\"value\":\"http://baggage-service.${PROJECT}.local:3004\"}
]"

# ── Application Load Balancer ──────────────────────────────────────────────
echo "Creating Application Load Balancer..."
ALB_ARN=$(aws elbv2 describe-load-balancers \
  --names "${PROJECT}-alb" --query "LoadBalancers[0].LoadBalancerArn" \
  --output text --region "$AWS_REGION" 2>/dev/null | grep -v None) \
|| ALB_ARN=$(aws elbv2 create-load-balancer \
     --name "${PROJECT}-alb" \
     --subnets "$SUBNET_1" "$SUBNET_2" \
     --security-groups "$ALB_SG" \
     --scheme internet-facing \
     --type application \
     --region "$AWS_REGION" \
     --query "LoadBalancers[0].LoadBalancerArn" --output text --no-cli-pager)

ALB_DNS=$(aws elbv2 describe-load-balancers \
  --load-balancer-arns "$ALB_ARN" \
  --query "LoadBalancers[0].DNSName" --output text --region "$AWS_REGION")
echo "  ✓ ALB DNS: $ALB_DNS"

# ── Target Groups ──────────────────────────────────────────────────────────
create_tg() {
  local name=$1 port=$2
  aws elbv2 describe-target-groups --names "$name" \
    --query "TargetGroups[0].TargetGroupArn" --output text --region "$AWS_REGION" 2>/dev/null \
  | grep -v None \
  || MSYS_NO_PATHCONV=1 aws elbv2 create-target-group \
       --name "$name" --protocol HTTP --port "$port" \
       --vpc-id "$VPC_ID" --target-type ip \
       --health-check-path /health \
       --region "$AWS_REGION" \
       --query "TargetGroups[0].TargetGroupArn" --output text --no-cli-pager
}

echo "Creating target groups..."
GW_TG_ARN=$(create_tg "${PROJECT}-gateway-tg" 3000)
FE_TG_ARN=$(create_tg "${PROJECT}-frontend-tg" 80)
echo "  ✓ Gateway TG: $GW_TG_ARN"
echo "  ✓ Frontend TG: $FE_TG_ARN"

# ── ALB Listeners ──────────────────────────────────────────────────────────
echo "Creating ALB listeners..."
# Port 3000 → api-gateway
aws elbv2 create-listener \
  --load-balancer-arn "$ALB_ARN" \
  --protocol HTTP --port 3000 \
  --default-actions "Type=forward,TargetGroupArn=${GW_TG_ARN}" \
  --region "$AWS_REGION" --no-cli-pager 2>/dev/null || true

# Port 80 → frontend
aws elbv2 create-listener \
  --load-balancer-arn "$ALB_ARN" \
  --protocol HTTP --port 80 \
  --default-actions "Type=forward,TargetGroupArn=${FE_TG_ARN}" \
  --region "$AWS_REGION" --no-cli-pager 2>/dev/null || true
echo "  ✓ Listeners: port 80 (frontend), port 3000 (api-gateway)"

# ── Cloud Map namespace for service discovery ──────────────────────────────
echo "Creating Cloud Map namespace for internal service discovery..."

# Create only if it doesn't exist yet
EXISTING_NS=$(aws servicediscovery list-namespaces \
  --query "Namespaces[?Name=='${PROJECT}.local'].Id | [0]" \
  --output text --region "$AWS_REGION" 2>/dev/null | grep -v None | grep -v "^$")

if [ -z "$EXISTING_NS" ]; then
  aws servicediscovery create-private-dns-namespace \
    --name "${PROJECT}.local" --vpc "$VPC_ID" \
    --region "$AWS_REGION" --no-cli-pager > /dev/null
  echo "  Waiting for namespace to be ready..."
  for i in {1..18}; do
    NS_ID=$(aws servicediscovery list-namespaces \
      --query "Namespaces[?Name=='${PROJECT}.local'].Id | [0]" \
      --output text --region "$AWS_REGION" 2>/dev/null | grep -v None | grep -v "^$")
    [ -n "$NS_ID" ] && break
    sleep 10
  done
else
  NS_ID="$EXISTING_NS"
fi
echo "  ✓ Namespace: ${PROJECT}.local (ID: $NS_ID)"

# ── Helper: create ECS service ─────────────────────────────────────────────
create_service() {
  local name=$1 port=$2 tg_arn=$3

  LB_CONFIG=""
  if [ -n "$tg_arn" ]; then
    LB_CONFIG="--load-balancers targetGroupArn=${tg_arn},containerName=${name},containerPort=${port}"
  fi

  SD_CONFIG=""
  if [ -z "$tg_arn" ] && [ -n "$NS_ID" ]; then
    SD_ID=$(aws servicediscovery list-services \
      --filters "Name=NAMESPACE_ID,Values=${NS_ID},Condition=EQ" \
      --query "Services[?Name=='${name}'].Id | [0]" \
      --output text --region "$AWS_REGION" 2>/dev/null || echo "")
    SD_ID=$(echo "$SD_ID" | grep -v None | grep -v "^$" || true)
    if [ -z "$SD_ID" ]; then
      SD_ID=$(aws servicediscovery create-service \
        --name "$name" \
        --dns-config "NamespaceId=${NS_ID},DnsRecords=[{Type=A,TTL=10}]" \
        --region "$AWS_REGION" \
        --query "Service.Id" --output text --no-cli-pager)
    fi
    SD_CONFIG="--service-registries registryArn=arn:aws:servicediscovery:${AWS_REGION}:${AWS_ACCOUNT_ID}:service/${SD_ID}"
  fi

  # Check if the ECS service already exists (active)
  SVC_STATUS=$(aws ecs describe-services \
    --cluster "${PROJECT}-cluster" --services "$name" \
    --query "services[?status!='INACTIVE'].status | [0]" \
    --output text --region "$AWS_REGION" 2>/dev/null || echo "")
  SVC_STATUS=$(echo "$SVC_STATUS" | grep -v None | grep -v "^$" || true)

  if [ -n "$SVC_STATUS" ]; then
    aws ecs update-service \
      --cluster "${PROJECT}-cluster" --service "$name" \
      --task-definition "${PROJECT}-${name}" \
      --region "$AWS_REGION" --no-cli-pager > /dev/null
  else
    aws ecs create-service \
      --cluster "${PROJECT}-cluster" \
      --service-name "$name" \
      --task-definition "${PROJECT}-${name}" \
      --desired-count 1 \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_1},${SUBNET_2}],securityGroups=[${SERVICES_SG}],assignPublicIp=ENABLED}" \
      $LB_CONFIG $SD_CONFIG \
      --region "$AWS_REGION" --no-cli-pager > /dev/null
  fi
  echo "  ✓ Service: $name"
}

echo "Creating ECS services (backend)..."
create_service "auth-service"    3001 ""
create_service "flight-service"  3002 ""
create_service "booking-service" 3003 ""
create_service "baggage-service" 3004 ""
create_service "api-gateway"     3000 "$GW_TG_ARN"

# ── Build & deploy frontend now that ALB DNS is known ─────────────────────
echo "Building frontend image with VITE_API_URL=http://${ALB_DNS}:3000 ..."
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_BASE"

docker build \
  --build-arg "VITE_API_URL=http://${ALB_DNS}:3000" \
  -t "${PROJECT}-frontend" "$ROOT/frontend"
docker tag "${PROJECT}-frontend:latest" "${ECR_BASE}/${PROJECT}-frontend:latest"
docker push "${ECR_BASE}/${PROJECT}-frontend:latest"
echo "  ✓ Frontend image pushed"

# Register frontend task definition
register_task "frontend" 80 "[]"

echo "Creating ECS service (frontend)..."
create_service "frontend" 80 "$FE_TG_ARN"

# ── Save ALB DNS ───────────────────────────────────────────────────────────
cat >> "$SCRIPT_DIR/.env.deploy" << EOF
ALB_DNS=${ALB_DNS}
ALB_ARN=${ALB_ARN}
NS_ID=${NS_ID}
EOF

echo ""
echo "=== Deployment complete ==="
echo ""
echo "  Frontend:    http://${ALB_DNS}"
echo "  API Gateway: http://${ALB_DNS}:3000"
echo ""
echo "Services take ~2 min to reach RUNNING state."
echo "Check status: aws ecs list-services --cluster ${PROJECT}-cluster --region ${AWS_REGION}"
echo ""
echo "Next: run  bash 5-lambda-deploy.sh"
