#!/bin/bash
# Configure ECS Auto Scaling for AeroLink services.
# Uses ALB request count target tracking — scales api-gateway between 1 and 3 tasks.
# Run after 4-ecs-deploy.sh. Safe to re-run.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"
source "$SCRIPT_DIR/.env.deploy"

echo "=== Configuring ECS Auto Scaling ==="

CLUSTER="${PROJECT}-cluster"

# ── Register scalable targets ──────────────────────────────────────────────
# api-gateway: scales 1→3 (handles incoming traffic, directly behind ALB)
# booking-service: scales 1→3 (processes bookings, CPU/memory bound)
for SVC in api-gateway booking-service; do
  aws application-autoscaling register-scalable-target \
    --service-namespace ecs \
    --resource-id "service/${CLUSTER}/${SVC}" \
    --scalable-dimension ecs:service:DesiredCount \
    --min-capacity 1 \
    --max-capacity 5 \
    --region "$AWS_REGION" --no-cli-pager
  echo "  ✓ Registered scalable target: $SVC (1–3 tasks)"
done

# ── Target tracking: ALB request count per target (api-gateway only) ───────
# Scale out when avg requests per task > 50 over 1 minute.
# ALB resource label format: app/<alb-name>/<alb-id>|targetgroup/<tg-name>/<tg-id>
ALB_SUFFIX=$(echo "$ALB_ARN" | sed 's|.*:loadbalancer/||')
TG_SUFFIX=$(echo "$GW_TG_ARN" | sed 's|.*:targetgroup|targetgroup|')
RESOURCE_LABEL="${ALB_SUFFIX}/${TG_SUFFIX}"

echo "Configuring ALB request-count tracking for api-gateway..."
aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --resource-id "service/${CLUSTER}/api-gateway" \
  --scalable-dimension ecs:service:DesiredCount \
  --policy-name "${PROJECT}-gw-request-count" \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration "{
    \"TargetValue\": 50.0,
    \"PredefinedMetricSpecification\": {
      \"PredefinedMetricType\": \"ALBRequestCountPerTarget\",
      \"ResourceLabel\": \"${RESOURCE_LABEL}\"
    },
    \"ScaleOutCooldown\": 30,
    \"ScaleInCooldown\": 120,
    \"DisableScaleIn\": false
  }" \
  --region "$AWS_REGION" --no-cli-pager > /dev/null
echo "  ✓ api-gateway: scale out when >50 req/target/min, scale in after 120s idle"

# ── Target tracking: CPU utilisation (booking-service) ─────────────────────
echo "Configuring CPU tracking for booking-service..."
aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --resource-id "service/${CLUSTER}/booking-service" \
  --scalable-dimension ecs:service:DesiredCount \
  --policy-name "${PROJECT}-booking-cpu" \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration "{
    \"TargetValue\": 60.0,
    \"PredefinedMetricSpecification\": {
      \"PredefinedMetricType\": \"ECSServiceAverageCPUUtilization\"
    },
    \"ScaleOutCooldown\": 30,
    \"ScaleInCooldown\": 120,
    \"DisableScaleIn\": false
  }" \
  --region "$AWS_REGION" --no-cli-pager > /dev/null
echo "  ✓ booking-service: scale out when CPU >60%, scale in after 120s"

echo ""
echo "=== Auto Scaling Configured ==="
echo ""
echo "  api-gateway:     1–3 tasks, trigger: >50 requests/target/min (ALB)"
echo "  booking-service: 1–3 tasks, trigger: >60% CPU"
echo ""
echo "To verify policies:"
echo "  aws application-autoscaling describe-scaling-policies \\"
echo "    --service-namespace ecs --region ${AWS_REGION}"
echo ""
echo "To watch task count during a load test:"
echo "  watch -n5 'aws ecs describe-services --cluster ${CLUSTER} --services api-gateway booking-service --query \"services[*].{name:serviceName,running:runningCount,desired:desiredCount}\" --output table --region ${AWS_REGION}'"
echo ""
echo "To remove auto scaling (before stopping services):"
echo "  bash ${SCRIPT_DIR}/6-remove-autoscaling.sh"
