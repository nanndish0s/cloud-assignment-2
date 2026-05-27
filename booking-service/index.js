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

let AWSXRay = null;
if (process.env.ENABLE_XRAY === 'true') {
  AWSXRay = require('aws-xray-sdk');
  AWSXRay.config([AWSXRay.plugins.ECSPlugin]);
  AWSXRay.captureHTTPsGlobal(require('https'));
  AWSXRay.captureHTTPsGlobal(require('http'));
  app.use(AWSXRay.express.openSegment('booking-service'));
}

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

const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      booking_id VARCHAR(50) PRIMARY KEY,
      flight_id VARCHAR(20),
      passenger_email VARCHAR(255),
      status VARCHAR(20) DEFAULT 'CONFIRMED',
      seat_number VARCHAR(10),
      checked_in_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Migrate existing tables that were created without these columns
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'CONFIRMED'`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS seat_number VARCHAR(10)`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMP`);
};

// SQS client — only created when BOOKING_SQS_URL is set (AWS deployment)
let sqsClient = null;
if (process.env.BOOKING_SQS_URL) {
  const { SQSClient } = require('@aws-sdk/client-sqs');
  sqsClient = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
}

if (require.main === module) initDB().then(() => initKafka());

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
      'INSERT INTO bookings (booking_id, flight_id, passenger_email, status) VALUES ($1, $2, $3, $4)',
      [bookingId, flightId, passengerEmail, 'CONFIRMED']
    );
    logger.info('Booking saved', { bookingId, flightId, passengerEmail });

    // 3. Emit "BookingCreated" event to Kafka
    await producer.send({
      topic: 'booking-events',
      messages: [{ value: JSON.stringify({ bookingId, flightId, passengerEmail, type: 'CREATED' }) }],
    });

    // 4. Notify Lambda via SQS (AWS only — no-op when BOOKING_SQS_URL is not set)
    if (sqsClient) {
      const { SendMessageCommand } = require('@aws-sdk/client-sqs');
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: process.env.BOOKING_SQS_URL,
        MessageBody: JSON.stringify({ bookingId, flightId, passengerEmail, type: 'BOOKING_CONFIRMED' }),
      }));
      logger.info('Booking notification queued to SQS', { bookingId });
    }

    // 5. Update flight seat availability
    await axios.patch(`${FLIGHT_SERVICE_URL}/flights/${flightId}/availability`, {
      seats: flight.seats - 1
    });

    res.status(201).json({ bookingId, message: 'Booking successful' });
  } catch (error) {
    logger.error('Booking failed', { error: error.message });
    res.status(500).json({ error: 'Booking failed' });
  }
});

/**
 * @swagger
 * /bookings/my:
 *   get:
 *     summary: Get all bookings for a passenger
 *     parameters:
 *       - in: query
 *         name: email
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of bookings for the passenger
 *       400:
 *         description: Email query parameter required
 */
app.get('/bookings/my', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email query parameter required' });
  try {
    const result = await pool.query(
      'SELECT * FROM bookings WHERE passenger_email = $1 ORDER BY created_at DESC',
      [email]
    );
    res.json(result.rows);
  } catch (error) {
    logger.error('Failed to fetch bookings', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

/**
 * @swagger
 * /bookings/{id}/checkin:
 *   patch:
 *     summary: Check in a passenger for their booked flight
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Check-in successful, returns assigned seat number
 *       400:
 *         description: Already checked in or booking not in CONFIRMED status
 *       404:
 *         description: Booking not found
 */
app.patch('/bookings/:id/checkin', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM bookings WHERE booking_id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    if (rows[0].status === 'CHECKED_IN') return res.status(400).json({ error: 'Already checked in' });
    if (rows[0].status !== 'CONFIRMED') return res.status(400).json({ error: 'Booking is not in CONFIRMED status' });

    const seatLetter = String.fromCharCode(65 + Math.floor(Math.random() * 6));
    const seatNumber = `${seatLetter}${Math.floor(Math.random() * 30) + 1}`;

    await pool.query(
      'UPDATE bookings SET status = $1, seat_number = $2, checked_in_at = NOW() WHERE booking_id = $3',
      ['CHECKED_IN', seatNumber, id]
    );

    await producer.send({
      topic: 'booking-events',
      messages: [{ value: JSON.stringify({
        bookingId: id,
        flightId: rows[0].flight_id,
        passengerEmail: rows[0].passenger_email,
        seatNumber,
        type: 'CHECKED_IN',
      }) }],
    });

    logger.info('Passenger checked in', { bookingId: id, seatNumber });
    res.json({ message: 'Check-in successful', bookingId: id, seatNumber, status: 'CHECKED_IN' });
  } catch (error) {
    logger.error('Check-in failed', { error: error.message });
    res.status(500).json({ error: 'Check-in failed' });
  }
});

if (AWSXRay) app.use(AWSXRay.express.closeSegment());

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`Booking Service running on port ${PORT}`);
  });
}

module.exports = app;
