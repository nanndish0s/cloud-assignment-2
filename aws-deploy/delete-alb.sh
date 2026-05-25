#!/bin/bash
# Delete the ALB to eliminate ~$0.50/day cost.
# Target groups are preserved (free) so recreating the ALB is fast.
# Run create-alb.sh to bring it back.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"
source "$SCRIPT_DIR/.env.deploy"

echo "=== Deleting ALB (cost saving) ==="

# Save gateway target group ARN before deleting
GW_TG_ARN=$(aws elbv2 describe-target-groups \
  --names "${PROJECT}-gateway-tg" \
  --query "TargetGroups[0].TargetGroupArn" \
  --output text --region "$AWS_REGION" 2>/dev/null || true)

if [ -n "$GW_TG_ARN" ] && ! grep -q "GW_TG_ARN" "$SCRIPT_DIR/.env.deploy"; then
  echo "GW_TG_ARN=${GW_TG_ARN}" >> "$SCRIPT_DIR/.env.deploy"
  echo "  Saved GW_TG_ARN to .env.deploy"
fi

# Delete ALB (listeners are auto-deleted with it)
if [ -n "$ALB_ARN" ]; then
  aws elbv2 delete-load-balancer \
    --load-balancer-arn "$ALB_ARN" \
    --region "$AWS_REGION" --no-cli-pager
  echo "  ALB deleted: $ALB_ARN"
else
  echo "  ALB_ARN not set — already deleted?"
fi

echo ""
echo "=== Done ==="
echo "Target groups preserved (free). ALB charge stopped."
echo "Run create-alb.sh to recreate the ALB when needed."
