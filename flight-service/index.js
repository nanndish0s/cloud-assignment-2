const express = require('express');
const { Pool } = require('pg');
const { Kafka } = require('kafkajs');
const swaggerJsDoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

app.use((req, res, next) => {
  console.log(`[Flight Service] ${req.method} ${req.url}`);
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
  console.log('Flight Service Kafka Producer connected');
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
    console.log(`Updating availability for flight ${id} to ${seats}`);

    // Emit event to Kafka
    await producer.send({
      topic: 'flight-availability-updates',
      messages: [{ value: JSON.stringify({ flightId: id, seatsAvailable: seats }) }],
    });

    res.json({ message: 'Availability updated and broadcasted' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update availability' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Flight Service running on port ${PORT}`);
  });
}

module.exports = app;
