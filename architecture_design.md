# Architectural Design - AeroLink Airline Systems Platform

This document provides the visual representation and explanation of the AeroLink cloud-native architecture.

## 1. System Architecture
The system is composed of loosely coupled microservices communicating synchronously via REST and asynchronously via Apache Kafka.

```mermaid
graph TD
    Client[Web Frontend / Mobile] --> Gateway[AWS API Gateway]
    
    subgraph "Public Zone"
        Gateway
    end
    
    subgraph "Microservices Layer"
        Gateway --> AuthSvc[Auth Service]
        Gateway --> FlightSvc[Flight Service]
        Gateway --> BookingSvc[Booking Service]
        Gateway --> BaggageSvc[Baggage Service]
    end
    
    subgraph "Event Bus"
        FlightSvc -- "Produce: FlightUpdates" --> Kafka[(Apache Kafka)]
        BookingSvc -- "Produce: BookingCreated" --> Kafka
        Kafka -- "Consume" --> BaggageSvc
        Kafka -- "Consume" --> Lambda[AWS Lambda - Notification]
    end
    
    subgraph "Data Layer"
        AuthSvc --> RDS_Auth[(PostgreSQL)]
        FlightSvc --> RDS_Flight[(PostgreSQL)]
        BookingSvc --> RDS_Booking[(PostgreSQL)]
        BaggageSvc --> Dynamo[(DynamoDB)]
    end
    
    subgraph "Cloud Services"
        Lambda --> SES[Amazon SES / SNS]
        Microservices --> CloudWatch[AWS CloudWatch]
    end
```

### High Availability & Scalability
- **Multi-Region**: The architecture can be deployed across multiple AWS regions using Route 53 for global DNS load balancing.
- **Auto-Scaling**: Microservices in Elastic Beanstalk automatically scale based on CPU/Memory usage.
- **Fault Tolerance**: Kafka acts as a buffer, ensuring that even if the Notification service is down, events are not lost.

---

## 2. Data Flow: Booking Process
This diagram illustrates the sequence of events when a passenger books a flight.

```mermaid
sequenceDiagram
    participant User
    participant Gateway as API Gateway
    participant Auth as Auth Service
    participant Booking as Booking Service
    participant Flight as Flight Service
    participant Kafka as Kafka
    participant Lambda as Notification (Lambda)

    User->>Gateway: POST /bookings (with JWT)
    Gateway->>Auth: Validate JWT
    Auth-->>Gateway: Valid
    Gateway->>Booking: Forward Request
    Booking->>Flight: GET /flights/:id (Check Availability)
    Flight-->>Booking: Available
    Booking->>Booking: Create Record (PostgreSQL)
    Booking->>Kafka: Emit "BookingCreated"
    Booking-->>User: 201 Created (Booking ID)
    
    Kafka->>Lambda: Trigger
    Lambda->>User: Send Email Confirmation
```

---

## 3. Security Model
AeroLink implements a robust security model using OAuth 2.0 principles and JWT.

```mermaid
graph LR
    User[User] -- "Login (Credentials)" --> Auth[Auth Service]
    Auth -- "Validate" --> DB[(PostgreSQL)]
    Auth -- "Issue JWT" --> User
    
    User -- "Request + JWT" --> Gateway[API Gateway]
    Gateway -- "Verify Signature" --> Gateway
    Gateway -- "Route Request" --> Svc[Microservice]
```

### Compliance Strategy
- **Encryption in Transit**: All communication is secured via TLS/SSL (HTTPS).
- **Encryption at Rest**: AWS RDS and DynamoDB use AWS KMS for disk encryption.
- **GDPR**: User data is isolated in the Auth Service; implement "Right to be Forgotten" by cascading deletes.
- **PCI DSS**: Payment processing should be handled by a third-party provider (e.g., Stripe) to avoid storing credit card data directly.
