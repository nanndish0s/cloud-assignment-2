#!/bin/bash
# Step 1 — Create ECR repositories for all services
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"

AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_BASE="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "=== Creating ECR Repositories ==="
echo "Account: $AWS_ACCOUNT_ID | Region: $AWS_REGION"

for SERVICE in auth-service flight-service booking-service baggage-service api-gateway frontend; do
  REPO="${PROJECT}-${SERVICE}"
  aws ecr describe-repositories --repository-names "$REPO" --region "$AWS_REGION" --no-cli-pager > /dev/null 2>&1 \
    || aws ecr create-repository --repository-name "$REPO" --region "$AWS_REGION" --no-cli-pager > /dev/null
  echo "  ✓ $REPO"
done

# Persist for subsequent scripts
cat > "$SCRIPT_DIR/.env.deploy" << EOF
AWS_ACCOUNT_ID=${AWS_ACCOUNT_ID}
ECR_BASE=${ECR_BASE}
EOF

echo ""
echo "Done. ECR base: $ECR_BASE"
echo "Values saved to .env.deploy"
