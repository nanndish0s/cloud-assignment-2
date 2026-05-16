const express = require('express');
const { Pool } = require('pg');
const { Kafka } = require('kafkajs');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const CircuitBreaker = require('opossum');
const swaggerJsDoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const cors = require('cors');
require('dotenv').config();
const logger = require('./logger');

const app = express();
app.use(express.json());
app.use(cors());

app.use((req, res, next) => {
  logger.info('Incoming request', { method: req.method, url: req.url, auth: req.headers['authorization'] ? 'present' : 'missing' });
  next();
});

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Booking Service' }));

const PORT = process.env.PORT || 3003;
const FLIGHT_SERVICE_URL = process.env.FLIGHT_SERVICE_URL || 'http://localhost:3002';

// Retry on network errors and 5xx responses — up to 3 attempts with exponential backoff
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: axiosRetry.isNetworkOrIdempotentRequestError,
  onRetry: (retryCount, error) => {
    logger.warn('Retrying request', { retryCount, error: error.message, url: error.config?.url });
  },
});

// Mock DB Connection
const pool = new Pool({
  user: process.env.DB_USER || 'user',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'aerolink',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
});

// Kafka Configuration
const kafka = new Kafka({
  clientId: 'booking-service',
  brokers: [process.env.KAFKA_BROKER || 'localhost:9092'],
});
const producer = kafka.producer();

const initKafka = async () => {
  await producer.connect();
  logger.info('Kafka Producer connected');
};
if (require.main === module) initKafka();

// Swagger Configuration
const swaggerOptions = {
  swaggerDefinition: {
    openapi: '3.0.0',
    info: {
      title: 'AeroLink Booking Service API',
      version: '1.0.0',
    },
    servers: [{ url: `http://localhost:${PORT}` }],
  },
  apis: ['./index.js'],
};
const swaggerDocs = swaggerJsDoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

/**
 * @swagger
 * /bookings:
 *   post:
 *     summary: Create a new booking
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               flightId:
 *                 type: string
 *               passengerEmail:
 *                 type: string
 *     responses:
 *       201:
 *         description: Booking created
 */
// Circuit Breaker Options
const breakerOptions = {
  timeout: 3000, // If the service takes longer than 3s, trigger a failure
  errorThresholdPercentage: 50, // If 50% of requests fail, open the circuit
  resetTimeout: 10000 // Wait 10s before trying again
};

const flightServiceBreaker = new CircuitBreaker(async (url) => {
  return await axios.get(url);
}, breakerOptions);

flightServiceBreaker.fallback(() => ({ data: [], error: 'Flight Service is currently unavailable. Please try again later.' }));

app.post('/bookings', async (req, res) => {
  const { flightId, passengerEmail } = req.body;

  try {
    // 1. Check flight availability (Using Circuit Breaker)
    const flightRes = await flightServiceBreaker.fire(`${FLIGHT_SERVICE_URL}/flights`);

    if (flightRes.error) {
      return res.status(503).json({ error: flightRes.error });
    }

    const flights = flightRes.data;
    const flight = flights.find(f => f.id === flightId);

    if (!flight || flight.seats <= 0) {
      return res.status(400).json({ error: 'Flight not available or full' });
    }

    // 2. Create Booking in DB
    const bookingId = `BK-${Math.floor(Math.random() * 10000)}`;
    await pool.query(
      'INSERT INTO bookings (booking_id, flight_id, passenger_email) VALUES ($1, $2, $3)',
      [bookingId, flightId, passengerEmail]
    );
    logger.info('Booking saved', { bookingId, flightId, passengerEmail });

    // 3. Emit "BookingCreated" event to Kafka
    await producer.send({
      topic: 'booking-events',
      messages: [{ value: JSON.stringify({ bookingId, flightId, passengerEmail, type: 'CREATED' }) }],
    });

    // 4. Update Flight availability (Call Flight Service)
    await axios.patch(`${FLIGHT_SERVICE_URL}/flights/${flightId}/availability`, {
      seats: flight.seats - 1
    });

    res.status(201).json({ bookingId, message: 'Booking successful' });
  } catch (error) {
    logger.error('Booking failed', { error: error.message });
    res.status(500).json({ error: 'Booking failed' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`Booking Service running on port ${PORT}`);
  });
}

module.exports = app;
