#!/bin/bash
# Remove ECS Auto Scaling registrations.
# Run before stop-all.sh to avoid scaling conflicts during shutdown.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"

CLUSTER="${PROJECT}-cluster"

echo "=== Removing ECS Auto Scaling ==="

for SVC in api-gateway booking-service; do
  aws application-autoscaling deregister-scalable-target \
    --service-namespace ecs \
    --resource-id "service/${CLUSTER}/${SVC}" \
    --scalable-dimension ecs:service:DesiredCount \
    --region "$AWS_REGION" --no-cli-pager 2>/dev/null || true
  echo "  ✓ Removed: $SVC"
done

echo "=== Auto Scaling removed ==="
