# Security, Compliance, and Resilience - AeroLink Platform

This document outlines the design decisions and justifications for Task 3 and Task 5 of the AeroLink assignment.

## 1. Security Model (Task 3)

### Authentication & Authorization
- **OAuth 2.0 / JWT**: We use JSON Web Tokens (JWT) for stateless authentication. Upon successful login, the Auth Service issues a token signed with a secret key.
- **RBAC (Role-Based Access Control)**: Tokens include a `role` claim (e.g., `user`, `admin`, `gate-agent`). The API Gateway and individual services verify this claim before allowing access to specific endpoints.
- **Password Security**: Passwords are never stored in plain text. We use `bcrypt` with a salt factor of 10 to hash passwords in the PostgreSQL database.

### Data Protection & Compliance
- **Encryption in Transit**: All service-to-service and client-to-server communication is encrypted using TLS 1.2+.
- **Encryption at Rest**: Databases (AWS RDS/DynamoDB) use AES-256 encryption via AWS KMS.
- **GDPR**: User data is centralized in the Auth Service. We implement a "cascading delete" mechanism to ensure the "Right to be Forgotten" is respected across services.
- **PCI DSS**: For payment processing, AeroLink integrates with a PCI-compliant third party (e.g., Stripe), ensuring no credit card data enters our internal network.

---

## 2. Data Consistency (Task 3)

In our distributed system, we face the **CAP Theorem** challenges. We prioritize **Availability** and **Partition Tolerance**, opting for **Eventual Consistency**.

### The Saga Pattern
When a booking is created:
1. **Booking Service** creates a "PENDING" booking and emits a `BookingCreated` event.
2. **Flight Service** consumes the event, reserves the seat, and emits a `SeatReserved` event.
3. If reservation fails (e.g., flight full), the Flight Service emits a `ReservationFailed` event, and the Booking Service performs a **Compensating Transaction** to mark the booking as "CANCELLED".

---

## 3. Fault Tolerance & Resilience (Task 5)

### Circuit Breaker Pattern
To prevent a single failing service (e.g., Notification Lambda) from cascading failures through the system, we implement Circuit Breakers (using `opossum` in Node.js).
- **Closed**: Requests flow normally.
- **Open**: If failure rate exceeds 50%, requests are blocked immediately, returning a fallback response.
- **Half-Open**: After a cooldown, a trial request is sent to see if the service has recovered.

### Scalability & Availability
- **Horizontal Scaling**: All microservices are stateless and deployed on AWS Elastic Beanstalk, which automatically adds instances based on traffic.
- **Multi-AZ Deployment**: AWS RDS is configured in Multi-AZ mode for synchronous data replication and automatic failover.
- **Kafka Resilience**: Kafka brokers are distributed across zones, ensuring event delivery even if a broker fails.
