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

# ── Create port 3000 listener → api-gateway target group ──────────────────
echo "Creating port 3000 listener..."
aws elbv2 create-listener \
  --load-balancer-arn "$NEW_ALB_ARN" \
  --protocol HTTP --port 3000 \
  --default-actions "Type=forward,TargetGroupArn=${GW_TG_ARN}" \
  --region "$AWS_REGION" --no-cli-pager > /dev/null
echo "  Listener created: port 3000 → api-gateway"

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

# ── Rebuild and redeploy frontend with new ALB DNS ─────────────────────────
echo "Rebuilding frontend with new ALB DNS..."
cd "$ROOT/frontend"
npm install --silent
VITE_API_URL="http://${NEW_ALB_DNS}:3000" npm run build
cd "$SCRIPT_DIR"
echo "  Frontend built"

echo "Uploading to S3..."
aws s3 sync "$ROOT/frontend/dist/" "s3://${S3_BUCKET}/" \
  --delete \
  --region "$AWS_REGION" \
  --cache-control "public,max-age=0,must-revalidate" \
  --quiet
echo "  S3 upload complete"

echo "Invalidating CloudFront cache..."
aws cloudfront create-invalidation \
  --distribution-id "$CF_DIST_ID" \
  --paths "/*" \
  --no-cli-pager > /dev/null
echo "  CloudFront invalidation started (~5 min to propagate)"

echo ""
echo "=== ALB Recreated ==="
echo ""
echo "  API Gateway: http://${NEW_ALB_DNS}:3000"
echo "  Frontend:    https://${CF_DOMAIN}"
echo ""
echo "Next: run start-all.sh to start ECS services, RDS, and Kafka."
echo "ECS tasks will automatically register with the existing target group."
