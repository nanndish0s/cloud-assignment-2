#!/bin/bash
# ── AeroLink AWS Deployment Configuration ────────────────────────────────────
# Edit the values below before running any deploy scripts.
# Run scripts from Git Bash or WSL on Windows.

export AWS_REGION="ap-southeast-1"
export AWS_PROFILE="aerolink-new"

# EC2 key pair name — must already exist in your AWS account.
# Create one via: aws ec2 create-key-pair --key-name aerolink-key --query "KeyMaterial" --output text > aerolink-key.pem
export KEY_PAIR_NAME="aerolink-key"

# SES sender email — must be verified in AWS SES before Lambda can send mail.
# Verify via: aws ses verify-email-identity --email-address notifications@aerolink.com --region $AWS_REGION
export SES_SENDER="nanndishaws3@gmail.com"

# RDS master password (min 8 chars, no special chars that break shell)
export DB_PASSWORD="AeroLink2024"

# Project prefix used for all AWS resource names
export PROJECT="aerolink"
