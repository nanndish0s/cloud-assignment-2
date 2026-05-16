const express = require('express');
const { Pool } = require('pg');
const { Kafka } = require('kafkajs');
const swaggerJsDoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const cors = require('cors');
require('dotenv').config();
const logger = require('./logger');

const app = express();
app.use(express.json());
app.use(cors());

app.use((req, res, next) => {
  logger.info('Incoming request', { method: req.method, url: req.url });
  next();
});

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Flight Service' }));

const PORT = process.env.PORT || 3002;

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
  clientId: 'flight-service',
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
      title: 'AeroLink Flight Service API',
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
 * /flights:
 *   get:
 *     summary: Get all flights
 *     responses:
 *       200:
 *         description: List of flights
 */
app.get('/flights', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM flights');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch flights' });
  }
});

/**
 * @swagger
 * /flights:
 *   post:
 *     summary: Create a new flight (admin only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, origin, destination, seats, price]
 *             properties:
 *               id:
 *                 type: string
 *                 example: AL404
 *               origin:
 *                 type: string
 *                 example: London
 *               destination:
 *                 type: string
 *                 example: Sydney
 *               seats:
 *                 type: integer
 *                 example: 120
 *               price:
 *                 type: string
 *                 example: LKR 310,000
 *     responses:
 *       201:
 *         description: Flight created
 *       400:
 *         description: Missing required fields or flight ID already exists
 */
app.post('/flights', async (req, res) => {
  const { id, origin, destination, seats, price } = req.body;

  if (!id || !origin || !destination || seats === undefined || !price) {
    return res.status(400).json({ error: 'Missing required fields: id, origin, destination, seats, price' });
  }

  try {
    await pool.query(
      'INSERT INTO flights (id, origin, destination, seats, price) VALUES ($1, $2, $3, $4, $5)',
      [id.toUpperCase(), origin, destination, seats, price]
    );

    await producer.send({
      topic: 'flight-schedule-updates',
      messages: [{ value: JSON.stringify({ flightId: id, origin, destination, seats, price, type: 'CREATED' }) }],
    });

    logger.info('New flight created', { flightId: id, origin, destination, seats });
    res.status(201).json({ message: 'Flight created successfully', flight: { id: id.toUpperCase(), origin, destination, seats, price } });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: `Flight ID ${id} already exists` });
    }
    logger.error('Failed to create flight', { error: error.message });
    res.status(500).json({ error: 'Failed to create flight' });
  }
});

/**
 * @swagger
 * /flights/{id}:
 *   put:
 *     summary: Edit a flight (admin only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               origin:
 *                 type: string
 *               destination:
 *                 type: string
 *               seats:
 *                 type: integer
 *               price:
 *                 type: string
 *     responses:
 *       200:
 *         description: Flight updated
 *       404:
 *         description: Flight not found
 */
app.put('/flights/:id', async (req, res) => {
  const { id } = req.params;
  const { origin, destination, seats, price } = req.body;

  if (!origin || !destination || seats === undefined || !price) {
    return res.status(400).json({ error: 'Missing required fields: origin, destination, seats, price' });
  }

  try {
    const result = await pool.query(
      'UPDATE flights SET origin=$1, destination=$2, seats=$3, price=$4 WHERE id=$5 RETURNING *',
      [origin, destination, seats, price, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: `Flight ${id} not found` });
    }

    await producer.send({
      topic: 'flight-schedule-updates',
      messages: [{ value: JSON.stringify({ flightId: id, origin, destination, seats, price, type: 'UPDATED' }) }],
    });

    logger.info('Flight updated', { flightId: id });
    res.json({ message: 'Flight updated successfully', flight: result.rows[0] });
  } catch (error) {
    logger.error('Failed to update flight', { error: error.message });
    res.status(500).json({ error: 'Failed to update flight' });
  }
});

/**
 * @swagger
 * /flights/{id}:
 *   delete:
 *     summary: Delete a flight (admin only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Flight deleted
 *       404:
 *         description: Flight not found
 */
app.delete('/flights/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM flights WHERE id=$1 RETURNING id', [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: `Flight ${id} not found` });
    }

    await producer.send({
      topic: 'flight-schedule-updates',
      messages: [{ value: JSON.stringify({ flightId: id, type: 'DELETED' }) }],
    });

    logger.info('Flight deleted', { flightId: id });
    res.json({ message: `Flight ${id} deleted successfully` });
  } catch (error) {
    logger.error('Failed to delete flight', { error: error.message });
    res.status(500).json({ error: 'Failed to delete flight' });
  }
});

/**
 * @swagger
 * /flights/{id}/availability:
 *   patch:
 *     summary: Update flight seat availability
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               seats:
 *                 type: number
 *     responses:
 *       200:
 *         description: Availability updated and event emitted
 */
app.patch('/flights/:id/availability', async (req, res) => {
  const { id } = req.params;
  const { seats } = req.body;

  try {
    // Update DB
    await pool.query('UPDATE flights SET seats = $1 WHERE id = $2', [seats, id]);
    logger.info('Updating flight availability', { flightId: id, seats });

    // Emit event to Kafka
    await producer.send({
      topic: 'flight-availability-updates',
      messages: [{ value: JSON.stringify({ flightId: id, seatsAvailable: seats }) }],
    });

    res.json({ message: 'Availability updated and broadcasted' });
  } catch (error) {
    logger.error('Failed to update flight availability', { error: error.message });
    res.status(500).json({ error: 'Failed to update availability' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`Flight Service running on port ${PORT}`);
  });
}

module.exports = app;
