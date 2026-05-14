# Monitoring and Observability - AeroLink Platform

This document addresses Task 7: Monitoring and Observability using cloud-native tools.

## 1. AWS CloudWatch Integration

### Logging
- Each microservice is configured to send logs to **CloudWatch Logs**.
- We use structured JSON logging (via `winston` or `pino`) to enable easy querying using **CloudWatch Insights**.
- **Log Groups**: `/aws/aerolink/auth-service`, `/aws/aerolink/booking-service`, etc.

### Metrics
- **Custom Metrics**: We track application-specific metrics such as:
    - `BookingSuccessRate`
    - `FlightAvailabilityUpdateLatency`
    - `BaggageTrackingProcessingTime`
- **Standard Metrics**: Elastic Beanstalk automatically provides CPU, Memory, and Network I/O metrics.

### Alarms
- **High Latency**: Triggered if the 95th percentile (P95) latency for `/bookings` exceeds 2 seconds.
- **Error Rate**: Triggered if the 5XX error count exceeds 5% of total requests over a 5-minute period.

## 2. Distributed Tracing (AWS X-Ray)
- We use **AWS X-Ray** to trace requests as they move from the API Gateway, through the Booking Service, and across to the Flight Service.
- This helps identify bottlenecks in service-to-service communication and Kafka event processing.

## 3. Health Checks
- Each service exposes a `/health` endpoint.
- The API Gateway and Load Balancer use these endpoints to determine if an instance should be taken out of rotation.
