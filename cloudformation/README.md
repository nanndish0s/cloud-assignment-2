# AeroLink CloudFormation Deployment

Deploy in this exact order. Each stack exports values that the next stack imports.

## Prerequisites
- AWS CLI configured (`aws configure`)
- Docker installed and running
- Images already pushed to ECR (run `bash aws-deploy/3-build-backend.sh` first)

## Stack Deployment Order

### 1. Networking — Security Groups
```bash
aws cloudformation deploy \
  --template-file 01-networking.yaml \
  --stack-name aerolink-networking \
  --parameter-overrides \
    VpcId=<your-default-vpc-id> \
    MyIp=$(curl -s https://checkip.amazonaws.com)/32 \
  --region ap-southeast-1
```

### 2. Secrets Manager
```bash
aws cloudformation deploy \
  --template-file 02-secrets.yaml \
  --stack-name aerolink-secrets \
  --parameter-overrides \
    DbPassword=AeroLink2024 \
    DbUser=aerouser \
    JwtSecret=aerolink_secret_key \
    AdminPassword=admin123 \
  --region ap-southeast-1
```

### 3. IAM Roles
```bash
aws cloudformation deploy \
  --template-file 03-iam.yaml \
  --stack-name aerolink-iam \
  --capabilities CAPABILITY_NAMED_IAM \
  --region ap-southeast-1
```

### 4. Data — RDS, DynamoDB, SQS
```bash
aws cloudformation deploy \
  --template-file 04-data.yaml \
  --stack-name aerolink-data \
  --parameter-overrides \
    DbPassword=AeroLink2024 \
    DbUser=aerouser \
  --region ap-southeast-1
```
> RDS takes 5-10 minutes to become available.

### 5. Kafka EC2 Broker
```bash
aws cloudformation deploy \
  --template-file 05-kafka.yaml \
  --stack-name aerolink-kafka \
  --parameter-overrides \
    KeyPairName=<your-key-pair-name> \
    SubnetId=<your-subnet-id> \
  --region ap-southeast-1
```
> Wait ~2 minutes after deploy for Kafka to finish starting inside the EC2 instance.

### 6. ECR Repositories
```bash
aws cloudformation deploy \
  --template-file 06-ecr.yaml \
  --stack-name aerolink-ecr \
  --region ap-southeast-1
```

### 7. ECS — Cluster, ALB, Task Definitions, Services
```bash
aws cloudformation deploy \
  --template-file 07-ecs.yaml \
  --stack-name aerolink-ecs \
  --parameter-overrides \
    VpcId=<your-default-vpc-id> \
    Subnet1Id=<subnet-1-id> \
    Subnet2Id=<subnet-2-id> \
    AdminEmail=admin@aerolink.com \
    SesSender=<your-verified-ses-email> \
  --capabilities CAPABILITY_IAM \
  --region ap-southeast-1
```

### 8. Lambda — SQS Notification
```bash
aws cloudformation deploy \
  --template-file 08-lambda.yaml \
  --stack-name aerolink-lambda \
  --parameter-overrides \
    SesSender=<your-verified-ses-email> \
  --capabilities CAPABILITY_IAM \
  --region ap-southeast-1
```

### 9. Auto Scaling
```bash
aws cloudformation deploy \
  --template-file 09-autoscaling.yaml \
  --stack-name aerolink-autoscaling \
  --region ap-southeast-1
```

## Get the ALB DNS after deploy
```bash
aws cloudformation describe-stacks \
  --stack-name aerolink-ecs \
  --query "Stacks[0].Outputs" \
  --output table \
  --region ap-southeast-1
```

## Tear down everything (reverse order)
```bash
for stack in aerolink-autoscaling aerolink-lambda aerolink-ecs aerolink-ecr aerolink-kafka aerolink-data aerolink-iam aerolink-secrets aerolink-networking; do
  aws cloudformation delete-stack --stack-name $stack --region ap-southeast-1
  aws cloudformation wait stack-delete-complete --stack-name $stack --region ap-southeast-1
  echo "Deleted $stack"
done
```

## Key difference vs bash scripts
| Bash scripts | CloudFormation |
|---|---|
| Manual `2>/dev/null \|\| echo already exists` guards | CloudFormation tracks state — safe to re-run |
| Must delete resources manually | `delete-stack` removes everything in dependency order |
| No rollback on failure | Automatic rollback if any resource fails |
| Dependencies managed with `sleep` | Dependency graph resolved automatically |
