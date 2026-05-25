#!/bin/bash
# Step 10 - Migrate frontend from ECS Fargate to S3 + CloudFront
# Creates S3 bucket, builds/uploads React app, creates CloudFront distribution,
# removes the frontend ECS service and ALB port-80 listener.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
source "$SCRIPT_DIR/config.sh"
source "$SCRIPT_DIR/.env.deploy"

echo "=== Frontend Migration: ECS + Nginx -> S3 + CloudFront ==="

BUCKET_NAME="${PROJECT}-frontend-${AWS_ACCOUNT_ID}"

# ── Step 1: Build React frontend ───────────────────────────────────────────
echo "Step 1: Building React frontend..."

if [ -z "$ALB_DNS" ]; then
  echo "ERROR: ALB_DNS not found in .env.deploy. Run 4-ecs-deploy.sh first."
  exit 1
fi

VITE_API_URL="http://${ALB_DNS}:3000"

cd "$ROOT/frontend"
npm install --silent
VITE_API_URL="$VITE_API_URL" npm run build
cd "$SCRIPT_DIR"
echo "  Built with VITE_API_URL=$VITE_API_URL"
echo "  Dist directory: $ROOT/frontend/dist"

# ── Step 2: Create S3 bucket ───────────────────────────────────────────────
echo "Step 2: Creating S3 bucket..."

if aws s3api head-bucket --bucket "$BUCKET_NAME" --region "$AWS_REGION" 2>/dev/null; then
  echo "  Bucket already exists: $BUCKET_NAME"
else
  aws s3api create-bucket \
    --bucket "$BUCKET_NAME" \
    --region "$AWS_REGION" \
    --create-bucket-configuration "LocationConstraint=${AWS_REGION}" \
    --no-cli-pager
  echo "  Created bucket: $BUCKET_NAME"
fi

# Unblock public access (required for website hosting)
aws s3api put-public-access-block \
  --bucket "$BUCKET_NAME" \
  --public-access-block-configuration \
  "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false" \
  --region "$AWS_REGION"

# Enable static website hosting with index.html as error doc (SPA routing)
aws s3api put-bucket-website \
  --bucket "$BUCKET_NAME" \
  --website-configuration \
  '{"IndexDocument":{"Suffix":"index.html"},"ErrorDocument":{"Key":"index.html"}}' \
  --region "$AWS_REGION"

# Public read policy
aws s3api put-bucket-policy \
  --bucket "$BUCKET_NAME" \
  --policy "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Principal\": \"*\",
      \"Action\": \"s3:GetObject\",
      \"Resource\": \"arn:aws:s3:::${BUCKET_NAME}/*\"
    }]
  }" \
  --region "$AWS_REGION"

echo "  S3 static website configured"

# ── Step 3: Upload built files ─────────────────────────────────────────────
echo "Step 3: Uploading to S3..."
aws s3 sync "$ROOT/frontend/dist/" "s3://${BUCKET_NAME}/" \
  --delete \
  --region "$AWS_REGION" \
  --cache-control "public,max-age=0,must-revalidate"
echo "  Files uploaded"

S3_WEBSITE_ENDPOINT="${BUCKET_NAME}.s3-website-${AWS_REGION}.amazonaws.com"
echo "  S3 website: http://${S3_WEBSITE_ENDPOINT}"

# ── Step 4: Create CloudFront distribution ─────────────────────────────────
echo "Step 4: Creating CloudFront distribution..."

# Check if one already exists for this bucket
CF_DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='AeroLink Frontend'].Id | [0]" \
  --output text 2>/dev/null | grep -v None | grep -v "^$" || true)

if [ -z "$CF_DIST_ID" ]; then
  CF_DIST_ID=$(aws cloudfront create-distribution \
    --distribution-config "{
      \"CallerReference\": \"aerolink-frontend-$(date +%s)\",
      \"Comment\": \"AeroLink Frontend\",
      \"Enabled\": true,
      \"DefaultRootObject\": \"index.html\",
      \"PriceClass\": \"PriceClass_100\",
      \"Origins\": {
        \"Quantity\": 1,
        \"Items\": [{
          \"Id\": \"S3-${BUCKET_NAME}\",
          \"DomainName\": \"${S3_WEBSITE_ENDPOINT}\",
          \"CustomOriginConfig\": {
            \"HTTPPort\": 80,
            \"HTTPSPort\": 443,
            \"OriginProtocolPolicy\": \"http-only\"
          }
        }]
      },
      \"DefaultCacheBehavior\": {
        \"TargetOriginId\": \"S3-${BUCKET_NAME}\",
        \"ViewerProtocolPolicy\": \"redirect-to-https\",
        \"AllowedMethods\": {
          \"Quantity\": 2,
          \"Items\": [\"GET\", \"HEAD\"]
        },
        \"ForwardedValues\": {
          \"QueryString\": false,
          \"Cookies\": {\"Forward\": \"none\"},
          \"Headers\": {\"Quantity\": 0}
        },
        \"MinTTL\": 0,
        \"DefaultTTL\": 86400,
        \"MaxTTL\": 31536000,
        \"Compress\": true
      },
      \"CustomErrorResponses\": {
        \"Quantity\": 2,
        \"Items\": [
          {
            \"ErrorCode\": 404,
            \"ResponsePagePath\": \"/index.html\",
            \"ResponseCode\": \"200\",
            \"ErrorCachingMinTTL\": 0
          },
          {
            \"ErrorCode\": 403,
            \"ResponsePagePath\": \"/index.html\",
            \"ResponseCode\": \"200\",
            \"ErrorCachingMinTTL\": 0
          }
        ]
      }
    }" \
    --query "Distribution.Id" --output text --no-cli-pager)
  echo "  CloudFront distribution created: $CF_DIST_ID"
else
  echo "  CloudFront distribution already exists: $CF_DIST_ID"
fi

CF_DOMAIN=$(aws cloudfront get-distribution \
  --id "$CF_DIST_ID" \
  --query "Distribution.DomainName" --output text --no-cli-pager)
echo "  CloudFront domain: https://$CF_DOMAIN"

# ── Step 5: Scale down frontend ECS service ────────────────────────────────
echo "Step 5: Scaling down frontend ECS service..."
aws ecs update-service \
  --cluster "${PROJECT}-cluster" \
  --service "frontend" \
  --desired-count 0 \
  --region "$AWS_REGION" --no-cli-pager > /dev/null 2>&1 || true
echo "  Frontend ECS service scaled to 0"

# ── Step 6: Remove port 80 ALB listener ───────────────────────────────────
echo "Step 6: Removing port 80 ALB listener..."
LISTENER_80_ARN=$(aws elbv2 describe-listeners \
  --load-balancer-arn "$ALB_ARN" \
  --query "Listeners[?Port==\`80\`].ListenerArn | [0]" \
  --output text --region "$AWS_REGION" 2>/dev/null | grep -v None | grep -v "^$" || true)

if [ -n "$LISTENER_80_ARN" ]; then
  aws elbv2 delete-listener \
    --listener-arn "$LISTENER_80_ARN" \
    --region "$AWS_REGION" --no-cli-pager
  echo "  Port 80 listener removed"
else
  echo "  Port 80 listener not found (already removed?)"
fi

# ── Save to .env.deploy ────────────────────────────────────────────────────
# Remove old CF entries if re-running
grep -v "^CF_DIST_ID=\|^CF_DOMAIN=\|^S3_BUCKET=" "$SCRIPT_DIR/.env.deploy" > /tmp/.env.deploy.tmp && \
  mv /tmp/.env.deploy.tmp "$SCRIPT_DIR/.env.deploy" || true

cat >> "$SCRIPT_DIR/.env.deploy" << EOF
CF_DIST_ID=${CF_DIST_ID}
CF_DOMAIN=${CF_DOMAIN}
S3_BUCKET=${BUCKET_NAME}
EOF

echo ""
echo "=== Migration Complete ==="
echo ""
echo "  Frontend (HTTPS): https://${CF_DOMAIN}"
echo "  API Gateway:      http://${ALB_DNS}:3000"
echo ""
echo "NOTE: CloudFront deployment takes 5-15 minutes."
echo "      S3 direct URL (HTTP only): http://${S3_WEBSITE_ENDPOINT}"
echo ""
echo "To update the frontend later after code changes:"
echo "  npm --prefix $ROOT/frontend run build"
echo "  aws s3 sync $ROOT/frontend/dist/ s3://${BUCKET_NAME}/ --delete --region ${AWS_REGION}"
echo "  aws cloudfront create-invalidation --distribution-id ${CF_DIST_ID} --paths '/*'"
