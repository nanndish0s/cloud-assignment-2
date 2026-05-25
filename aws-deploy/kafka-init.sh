#!/bin/bash
# EC2 user-data script - installs Docker and starts Kafka + Zookeeper
yum update -y
yum install -y docker
service docker start
usermod -a -G docker ec2-user

# Install docker compose v2 plugin
mkdir -p /usr/local/lib/docker/cli-plugins
curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Get this instance's private IP from the metadata service
PRIVATE_IP=$(curl -s http://169.254.169.254/latest/meta-data/local-ipv4)

mkdir -p /opt/kafka
cat > /opt/kafka/docker-compose.yml << COMPOSE
services:
  zookeeper:
    image: confluentinc/cp-zookeeper:6.2.0
    restart: always
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
      ZOOKEEPER_TICK_TIME: 2000
      KAFKA_HEAP_OPTS: "-Xmx128m -Xms64m"

  kafka:
    image: confluentinc/cp-kafka:6.2.0
    restart: always
    depends_on: [zookeeper]
    ports:
      - "9092:9092"
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://${PRIVATE_IP}:9092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"
      KAFKA_HEAP_OPTS: "-Xmx384m -Xms256m"
COMPOSE

cd /opt/kafka && docker compose up -d
