#!/bin/bash
# Step 5 — Package and deploy the notification Lambda, then wire SQS trigger
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
source "$SCRIPT_DIR/config.sh"
source "$SCRIPT_DIR/.env.deploy"

LAMBDA_NAME="${PROJECT}-notification"
LAMBDA_DIR="$ROOT/notification-lambda"

echo "=== Lambda Deployment ==="

# ── IAM Role for Lambda ────────────────────────────────────────────────────
LAMBDA_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam create-role --role-name "${PROJECT}-lambda-role" \
  --assume-role-policy-document "$LAMBDA_TRUST" --no-cli-pager 2>/dev/null || true

aws iam attach-role-policy --role-name "${PROJECT}-lambda-role" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole 2>/dev/null || true

aws iam put-role-policy --role-name "${PROJECT}-lambda-role" \
  --policy-name "${PROJECT}-lambda-policy" \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[
      {"Effect":"Allow","Action":["ses:SendEmail","ses:SendRawEmail"],"Resource":"*"},
      {"Effect":"Allow","Action":["sqs:ReceiveMessage","sqs:DeleteMessage","sqs:GetQueueAttributes"],"Resource":"*"}
    ]
  }' 2>/dev/null || true

LAMBDA_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${PROJECT}-lambda-role"
echo "  ✓ Lambda IAM role: $LAMBDA_ROLE_ARN"
echo "  Waiting 10s for IAM role to propagate..."
sleep 10

# ── Package Lambda ─────────────────────────────────────────────────────────
echo "Installing Lambda dependencies..."
cd "$LAMBDA_DIR"
npm install --omit=dev --silent

echo "Creating deployment package..."
ZIPFILE="$(pwd)/${LAMBDA_NAME}.zip"
if command -v zip &>/dev/null; then
  zip -r "$ZIPFILE" . --exclude "*.test.js" --exclude ".env" > /dev/null
else
  # Fallback for Windows Git Bash — use PowerShell
  WIN_DIR=$(cygpath -w "$(pwd)")
  WIN_ZIP=$(cygpath -w "$ZIPFILE")
  powershell.exe -Command "Compress-Archive -Path '${WIN_DIR}\\*' -DestinationPath '${WIN_ZIP}' -Force"
fi
echo "  ✓ Package: $ZIPFILE"

# ── Deploy Lambda ──────────────────────────────────────────────────────────
EXISTING=$(aws lambda get-function --function-name "$LAMBDA_NAME" \
  --region "$AWS_REGION" --query "Configuration.FunctionArn" \
  --output text 2>/dev/null || echo "")
EXISTING=$(echo "$EXISTING" | grep -v None | grep -v "^$" || true)

WIN_ZIPFILE=$(cygpath -w "$ZIPFILE" 2>/dev/null || echo "$ZIPFILE")
if [ -n "$EXISTING" ]; then
  echo "Updating existing Lambda function..."
  aws lambda update-function-code \
    --function-name "$LAMBDA_NAME" \
    --zip-file "fileb://${WIN_ZIPFILE}" \
    --region "$AWS_REGION" --no-cli-pager > /dev/null
  aws lambda update-function-configuration \
    --function-name "$LAMBDA_NAME" \
    --environment "Variables={SES_SENDER=${SES_SENDER}}" \
    --region "$AWS_REGION" --no-cli-pager > /dev/null
  LAMBDA_ARN="$EXISTING"
else
  echo "Creating Lambda function..."
  LAMBDA_ARN=$(aws lambda create-function \
    --function-name "$LAMBDA_NAME" \
    --runtime nodejs20.x \
    --role "$LAMBDA_ROLE_ARN" \
    --handler handler.handler \
    --zip-file "fileb://${WIN_ZIPFILE}" \
    --timeout 30 \
    --environment "Variables={SES_SENDER=${SES_SENDER}}" \
    --region "$AWS_REGION" \
    --query "FunctionArn" --output text --no-cli-pager)
fi
echo "  ✓ Lambda: $LAMBDA_ARN"

# ── SQS Event Source Mapping ───────────────────────────────────────────────
echo "Wiring SQS trigger to Lambda..."
EXISTING_MAPPING=$(aws lambda list-event-source-mappings \
  --function-name "$LAMBDA_NAME" \
  --event-source-arn "$SQS_ARN" \
  --query "EventSourceMappings[0].UUID" \
  --output text --region "$AWS_REGION" 2>/dev/null || echo "")
EXISTING_MAPPING=$(echo "$EXISTING_MAPPING" | grep -v None | grep -v "^$" || true)

if [ -z "$EXISTING_MAPPING" ]; then
  aws lambda create-event-source-mapping \
    --function-name "$LAMBDA_NAME" \
    --event-source-arn "$SQS_ARN" \
    --batch-size 1 \
    --region "$AWS_REGION" --no-cli-pager > /dev/null
  echo "  ✓ SQS trigger created"
else
  echo "  ✓ SQS trigger already exists"
fi

echo ""
echo "=== All done! ==="
echo ""
echo "  Frontend:    http://${ALB_DNS}"
echo "  API Gateway: http://${ALB_DNS}:3000"
echo "  Lambda:      $LAMBDA_ARN"
echo ""
echo "Important: Verify your SES sender email if you haven't already:"
echo "  aws ses verify-email-identity --email-address ${SES_SENDER} --region ${AWS_REGION}"
