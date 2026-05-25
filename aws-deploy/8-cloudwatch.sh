#!/bin/bash
# Step 8 — CloudWatch alarms and dashboard for monitoring and observability
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"

CLUSTER="${PROJECT}-cluster"
SERVICES=("auth-service" "flight-service" "booking-service" "baggage-service" "api-gateway")

echo "=== CloudWatch Monitoring Setup ==="

# ── Per-service alarms ─────────────────────────────────────────────────────
echo "Creating per-service alarms..."

for SVC in "${SERVICES[@]}"; do

  # High CPU alarm
  aws cloudwatch put-metric-alarm \
    --alarm-name "${PROJECT}-${SVC}-high-cpu" \
    --alarm-description "CPU > 80% for ${SVC}" \
    --metric-name CPUUtilization \
    --namespace AWS/ECS \
    --dimensions Name=ClusterName,Value=$CLUSTER Name=ServiceName,Value=$SVC \
    --statistic Average \
    --period 60 \
    --evaluation-periods 2 \
    --threshold 80 \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    --region "$AWS_REGION" --no-cli-pager
  echo "  ✓ ${SVC}: CPU > 80% alarm"

  # High memory alarm
  aws cloudwatch put-metric-alarm \
    --alarm-name "${PROJECT}-${SVC}-high-memory" \
    --alarm-description "Memory > 85% for ${SVC}" \
    --metric-name MemoryUtilization \
    --namespace AWS/ECS \
    --dimensions Name=ClusterName,Value=$CLUSTER Name=ServiceName,Value=$SVC \
    --statistic Average \
    --period 60 \
    --evaluation-periods 2 \
    --threshold 85 \
    --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching \
    --region "$AWS_REGION" --no-cli-pager
  echo "  ✓ ${SVC}: Memory > 85% alarm"

  # Task count alarm (running tasks drops to 0)
  aws cloudwatch put-metric-alarm \
    --alarm-name "${PROJECT}-${SVC}-no-tasks" \
    --alarm-description "No running tasks for ${SVC}" \
    --metric-name RunningTaskCount \
    --namespace ECS/ContainerInsights \
    --dimensions Name=ClusterName,Value=$CLUSTER Name=ServiceName,Value=$SVC \
    --statistic Average \
    --period 60 \
    --evaluation-periods 1 \
    --threshold 1 \
    --comparison-operator LessThanThreshold \
    --treat-missing-data breaching \
    --region "$AWS_REGION" --no-cli-pager
  echo "  ✓ ${SVC}: No running tasks alarm"

done

# ── ALB alarms ─────────────────────────────────────────────────────────────
echo "Creating ALB alarms..."

ALB_ARN=$(aws elbv2 describe-load-balancers \
  --names "${PROJECT}-alb" \
  --query "LoadBalancers[0].LoadBalancerArn" --output text --region "$AWS_REGION")
ALB_SUFFIX=$(echo $ALB_ARN | sed 's|.*loadbalancer/||')

# High 5xx error rate
aws cloudwatch put-metric-alarm \
  --alarm-name "${PROJECT}-alb-5xx-errors" \
  --alarm-description "ALB 5xx error rate is high" \
  --metric-name HTTPCode_ELB_5XX_Count \
  --namespace AWS/ApplicationELB \
  --dimensions Name=LoadBalancer,Value="$ALB_SUFFIX" \
  --statistic Sum \
  --period 60 \
  --evaluation-periods 2 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  --region "$AWS_REGION" --no-cli-pager
echo "  ✓ ALB: 5xx error rate > 10/min alarm"

# High latency
aws cloudwatch put-metric-alarm \
  --alarm-name "${PROJECT}-alb-high-latency" \
  --alarm-description "ALB response time > 2 seconds" \
  --metric-name TargetResponseTime \
  --namespace AWS/ApplicationELB \
  --dimensions Name=LoadBalancer,Value="$ALB_SUFFIX" \
  --statistic Average \
  --period 60 \
  --evaluation-periods 2 \
  --threshold 2 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  --region "$AWS_REGION" --no-cli-pager
echo "  ✓ ALB: Response time > 2s alarm"

# ── CloudWatch Dashboard ───────────────────────────────────────────────────
echo "Creating CloudWatch dashboard..."

DASHBOARD_BODY=$(cat << DASHBOARD
{
  "widgets": [
    {
      "type": "text",
      "x": 0, "y": 0, "width": 24, "height": 1,
      "properties": { "markdown": "# AeroLink System Health" }
    },
    {
      "type": "metric",
      "x": 0, "y": 1, "width": 12, "height": 6,
      "properties": {
        "title": "ECS CPU Utilization (%)",
        "metrics": [
          ["AWS/ECS", "CPUUtilization", "ClusterName", "$CLUSTER", "ServiceName", "api-gateway"],
          ["AWS/ECS", "CPUUtilization", "ClusterName", "$CLUSTER", "ServiceName", "auth-service"],
          ["AWS/ECS", "CPUUtilization", "ClusterName", "$CLUSTER", "ServiceName", "flight-service"],
          ["AWS/ECS", "CPUUtilization", "ClusterName", "$CLUSTER", "ServiceName", "booking-service"],
          ["AWS/ECS", "CPUUtilization", "ClusterName", "$CLUSTER", "ServiceName", "baggage-service"]
        ],
        "period": 60,
        "stat": "Average",
        "view": "timeSeries",
        "region": "$AWS_REGION"
      }
    },
    {
      "type": "metric",
      "x": 12, "y": 1, "width": 12, "height": 6,
      "properties": {
        "title": "ECS Memory Utilization (%)",
        "metrics": [
          ["AWS/ECS", "MemoryUtilization", "ClusterName", "$CLUSTER", "ServiceName", "api-gateway"],
          ["AWS/ECS", "MemoryUtilization", "ClusterName", "$CLUSTER", "ServiceName", "auth-service"],
          ["AWS/ECS", "MemoryUtilization", "ClusterName", "$CLUSTER", "ServiceName", "flight-service"],
          ["AWS/ECS", "MemoryUtilization", "ClusterName", "$CLUSTER", "ServiceName", "booking-service"],
          ["AWS/ECS", "MemoryUtilization", "ClusterName", "$CLUSTER", "ServiceName", "baggage-service"]
        ],
        "period": 60,
        "stat": "Average",
        "view": "timeSeries",
        "region": "$AWS_REGION"
      }
    },
    {
      "type": "metric",
      "x": 0, "y": 7, "width": 12, "height": 6,
      "properties": {
        "title": "ALB Request Count",
        "metrics": [
          ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", "$ALB_SUFFIX"]
        ],
        "period": 60,
        "stat": "Sum",
        "view": "timeSeries",
        "region": "$AWS_REGION"
      }
    },
    {
      "type": "metric",
      "x": 12, "y": 7, "width": 12, "height": 6,
      "properties": {
        "title": "ALB Response Time (s) and 5xx Errors",
        "metrics": [
          ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", "$ALB_SUFFIX"],
          ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", "$ALB_SUFFIX"]
        ],
        "period": 60,
        "stat": "Average",
        "view": "timeSeries",
        "region": "$AWS_REGION"
      }
    },
    {
      "type": "metric",
      "x": 0, "y": 13, "width": 12, "height": 6,
      "properties": {
        "title": "RDS CPU and Connections",
        "metrics": [
          ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", "${PROJECT}-postgres"],
          ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", "${PROJECT}-postgres"]
        ],
        "period": 60,
        "stat": "Average",
        "view": "timeSeries",
        "region": "$AWS_REGION"
      }
    },
    {
      "type": "alarm",
      "x": 12, "y": 13, "width": 12, "height": 6,
      "properties": {
        "title": "Active Alarms",
        "alarms": [
          "arn:aws:cloudwatch:${AWS_REGION}:$(aws sts get-caller-identity --query Account --output text):alarm:${PROJECT}-api-gateway-high-cpu",
          "arn:aws:cloudwatch:${AWS_REGION}:$(aws sts get-caller-identity --query Account --output text):alarm:${PROJECT}-alb-5xx-errors",
          "arn:aws:cloudwatch:${AWS_REGION}:$(aws sts get-caller-identity --query Account --output text):alarm:${PROJECT}-alb-high-latency"
        ]
      }
    }
  ]
}
DASHBOARD
)

aws cloudwatch put-dashboard \
  --dashboard-name "${PROJECT}-dashboard" \
  --dashboard-body "$DASHBOARD_BODY" \
  --region "$AWS_REGION" --no-cli-pager > /dev/null
echo "  ✓ Dashboard: ${PROJECT}-dashboard"

echo ""
echo "=== CloudWatch setup complete ==="
echo ""
echo "View dashboard:"
echo "  https://${AWS_REGION}.console.aws.amazon.com/cloudwatch/home?region=${AWS_REGION}#dashboards:name=${PROJECT}-dashboard"
echo ""
echo "Alarms created: $((${#SERVICES[@]} * 3 + 2)) total"
echo "  - High CPU (>80%) per service"
echo "  - High memory (>85%) per service"
echo "  - No running tasks per service"
echo "  - ALB 5xx error rate"
echo "  - ALB response time >2s"
