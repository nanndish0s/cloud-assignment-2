#!/bin/bash
# Recreate the ALB after deletion.
# Reuses existing target groups — no ECS changes needed.
# Rebuilds and redeploys frontend with new ALB DNS.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
source "$SCRIPT_DIR/config.sh"
source "$SCRIPT_DIR/.env.deploy"

echo "=== Recreating ALB ==="

# ── Create new ALB ─────────────────────────────────────────────────────────
echo "Creating Application Load Balancer..."
NEW_ALB_ARN=$(aws elbv2 create-load-balancer \
  --name "${PROJECT}-alb" \
  --subnets "$SUBNET_1" "$SUBNET_2" \
  --security-groups "$ALB_SG" \
  --scheme internet-facing \
  --type application \
  --region "$AWS_REGION" \
  --query "LoadBalancers[0].LoadBalancerArn" \
  --output text --no-cli-pager)

NEW_ALB_DNS=$(aws elbv2 describe-load-balancers \
  --load-balancer-arns "$NEW_ALB_ARN" \
  --query "LoadBalancers[0].DNSName" \
  --output text --region "$AWS_REGION")

echo "  New ALB ARN: $NEW_ALB_ARN"
echo "  New ALB DNS: $NEW_ALB_DNS"

# ── Create listeners ───────────────────────────────────────────────────────
echo "Creating listeners..."

FE_TG_ARN=$(aws elbv2 describe-target-groups \
  --names "${PROJECT}-frontend-tg" \
  --query "TargetGroups[0].TargetGroupArn" \
  --output text --region "$AWS_REGION" 2>/dev/null || true)

aws elbv2 create-listener \
  --load-balancer-arn "$NEW_ALB_ARN" \
  --protocol HTTP --port 3000 \
  --default-actions "Type=forward,TargetGroupArn=${GW_TG_ARN}" \
  --region "$AWS_REGION" --no-cli-pager > /dev/null
echo "  Listener created: port 3000 → api-gateway"

if [ -n "$FE_TG_ARN" ] && [ "$FE_TG_ARN" != "None" ]; then
  aws elbv2 create-listener \
    --load-balancer-arn "$NEW_ALB_ARN" \
    --protocol HTTP --port 80 \
    --default-actions "Type=forward,TargetGroupArn=${FE_TG_ARN}" \
    --region "$AWS_REGION" --no-cli-pager > /dev/null
  echo "  Listener created: port 80 → frontend"
fi

# ── Update .env.deploy with new ALB values ─────────────────────────────────
echo "Updating .env.deploy..."
grep -v "^ALB_DNS=\|^ALB_ARN=" "$SCRIPT_DIR/.env.deploy" > /tmp/.env.deploy.tmp
mv /tmp/.env.deploy.tmp "$SCRIPT_DIR/.env.deploy"
cat >> "$SCRIPT_DIR/.env.deploy" << EOF
ALB_DNS=${NEW_ALB_DNS}
ALB_ARN=${NEW_ALB_ARN}
EOF
echo "  .env.deploy updated"

# ── Update performance test targets ───────────────────────────────────────
echo "Updating performance test targets..."
sed -i "s|target: \"http://.*:3000\"|target: \"http://${NEW_ALB_DNS}:3000\"|g" \
  "$ROOT/performance-tests/load-test.yml" \
  "$ROOT/performance-tests/stress-test.yml" 2>/dev/null || true
echo "  Performance tests updated"

# ── Rebuild and push frontend Docker image with new ALB DNS ───────────────
echo "Rebuilding frontend Docker image with new ALB DNS..."
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_BASE"

docker build \
  --build-arg "VITE_API_URL=http://${NEW_ALB_DNS}:3000" \
  -t "${PROJECT}-frontend" "$ROOT/frontend"
docker tag "${PROJECT}-frontend:latest" "${ECR_BASE}/${PROJECT}-frontend:latest"
docker push "${ECR_BASE}/${PROJECT}-frontend:latest"
echo "  Frontend image pushed to ECR"

echo "Force-redeploying frontend ECS service..."
aws ecs update-service \
  --cluster "${PROJECT}-cluster" \
  --service frontend \
  --force-new-deployment \
  --desired-count 1 \
  --region "$AWS_REGION" --no-cli-pager > /dev/null
echo "  Frontend ECS service redeploying"

echo ""
echo "=== ALB Recreated ==="
echo ""
echo "  Frontend:    http://${NEW_ALB_DNS}"
echo "  API Gateway: http://${NEW_ALB_DNS}:3000"
echo "  Swagger:     http://${NEW_ALB_DNS}:3000/api-docs"
echo ""
echo "ECS tasks take ~2 min to reach RUNNING state."
