#!/bin/bash
# Step 7 — Configure ECS auto-scaling for all backend services
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"

CLUSTER="${PROJECT}-cluster"
SERVICES=("auth-service" "flight-service" "booking-service" "baggage-service" "api-gateway")

echo "=== ECS Auto-Scaling Configuration ==="
echo "Cluster: $CLUSTER"
echo "Services: ${SERVICES[*]}"
echo ""

for SVC in "${SERVICES[@]}"; do
  RESOURCE="service/${CLUSTER}/${SVC}"
  echo "Configuring: $SVC"

  # 1. Register as scalable target (min 1, max 3 tasks)
  aws application-autoscaling register-scalable-target \
    --service-namespace ecs \
    --resource-id "$RESOURCE" \
    --scalable-dimension ecs:service:DesiredCount \
    --min-capacity 1 \
    --max-capacity 3 \
    --region "$AWS_REGION" --no-cli-pager
  echo "  ✓ Registered: min=1, max=3 tasks"

  # 2. CPU target tracking — scale out when CPU > 70%
  aws application-autoscaling put-scaling-policy \
    --service-namespace ecs \
    --resource-id "$RESOURCE" \
    --scalable-dimension ecs:service:DesiredCount \
    --policy-name "${SVC}-cpu-scaling" \
    --policy-type TargetTrackingScaling \
    --target-tracking-scaling-policy-configuration "{
      \"TargetValue\": 70.0,
      \"PredefinedMetricSpecification\": {
        \"PredefinedMetricType\": \"ECSServiceAverageCPUUtilization\"
      },
      \"ScaleOutCooldown\": 60,
      \"ScaleInCooldown\": 120
    }" \
    --region "$AWS_REGION" --no-cli-pager > /dev/null
  echo "  ✓ CPU policy: scale out at 70% CPU (cooldown: 60s out / 120s in)"

  # 3. Memory target tracking — scale out when memory > 75%
  aws application-autoscaling put-scaling-policy \
    --service-namespace ecs \
    --resource-id "$RESOURCE" \
    --scalable-dimension ecs:service:DesiredCount \
    --policy-name "${SVC}-memory-scaling" \
    --policy-type TargetTrackingScaling \
    --target-tracking-scaling-policy-configuration "{
      \"TargetValue\": 75.0,
      \"PredefinedMetricSpecification\": {
        \"PredefinedMetricType\": \"ECSServiceAverageMemoryUtilization\"
      },
      \"ScaleOutCooldown\": 60,
      \"ScaleInCooldown\": 120
    }" \
    --region "$AWS_REGION" --no-cli-pager > /dev/null
  echo "  ✓ Memory policy: scale out at 75% memory"
  echo ""
done

echo "=== Auto-scaling configured ==="
echo ""
echo "Summary:"
echo "  Min tasks per service : 1"
echo "  Max tasks per service : 3"
echo "  Scale-out trigger     : CPU > 70% OR Memory > 75%"
echo "  Scale-out cooldown    : 60 seconds"
echo "  Scale-in cooldown     : 120 seconds"
echo ""
echo "Verify with:"
echo "  aws application-autoscaling describe-scalable-targets --service-namespace ecs --region ${AWS_REGION}"
