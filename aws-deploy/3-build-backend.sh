#!/bin/bash
# Step 3 — Build and push all backend service images to ECR
# Frontend is built later in step 4 once the ALB DNS is known.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
source "$SCRIPT_DIR/config.sh"
source "$SCRIPT_DIR/.env.deploy"

echo "=== Building & Pushing Backend Images ==="
echo "ECR: $ECR_BASE"

# Authenticate Docker with ECR
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_BASE"

for SERVICE in auth-service flight-service booking-service baggage-service api-gateway; do
  IMAGE="${ECR_BASE}/${PROJECT}-${SERVICE}:latest"
  echo "Building ${SERVICE}..."
  docker build -t "${PROJECT}-${SERVICE}" "$ROOT/${SERVICE}"
  docker tag "${PROJECT}-${SERVICE}:latest" "$IMAGE"
  docker push "$IMAGE"
  echo "  ✓ Pushed $IMAGE"
done

echo ""
echo "Backend images pushed. Next: run  bash 4-ecs-deploy.sh"
