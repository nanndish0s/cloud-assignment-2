const express = require('express');
const { Kafka } = require('kafkajs');
const { DynamoDBClient, PutItemCommand, GetItemCommand, CreateTableCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const swaggerJsDoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const cors = require('cors');
require('dotenv').config();
const logger = require('./logger');

const app = express();
app.use(express.json());
app.use(cors());

let AWSXRay = null;
if (process.env.ENABLE_XRAY === 'true') {
  AWSXRay = require('aws-xray-sdk');
  AWSXRay.config([AWSXRay.plugins.ECSPlugin]);
  app.use(AWSXRay.express.openSegment('baggage-service'));
}

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Baggage Service' }));

const PORT = process.env.PORT || 3004;

// DynamoDB Configuration
// DYNAMODB_ENDPOINT is only set for local dev (points to DynamoDB Local).
// In AWS, it is unset so the SDK connects to real DynamoDB using the task role.
const ddbConfig = { region: process.env.AWS_REGION || 'ap-southeast-1' };
if (process.env.DYNAMODB_ENDPOINT) ddbConfig.endpoint = process.env.DYNAMODB_ENDPOINT;
const ddbClient = new DynamoDBClient(ddbConfig);

const initDynamoDB = async () => {
  try {
    await ddbClient.send(new CreateTableCommand({
      TableName: 'Baggage',
      AttributeDefinitions: [{ AttributeName: 'BaggageId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'BaggageId', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    }));
    logger.info('DynamoDB Baggage table created');
  } catch (err) {
    if (err.name === 'ResourceInUseException') {
      logger.info('DynamoDB Baggage table already exists');
    } else {
      throw err;
    }
  }
};

// Kafka Configuration
const kafka = new Kafka({
  clientId: 'baggage-service',
  brokers: [process.env.KAFKA_BROKER || 'localhost:9092'],
});
const consumer = kafka.consumer({ groupId: 'baggage-group' });
const producer = kafka.producer();

const initKafka = async () => {
  await consumer.connect();
  await producer.connect();
  await consumer.subscribe({ topic: 'booking-events', fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const event = JSON.parse(message.value.toString());
      logger.info('Kafka event received', { type: event.type, bookingId: event.bookingId });
      
      if (event.type === 'CREATED') {
        // Initialize baggage record in DynamoDB
        const params = {
          TableName: 'Baggage',
          Item: {
            BaggageId: { S: `BAG-${event.bookingId}` },
            BookingId: { S: event.bookingId },
            Status: { S: 'REGISTERED' },
            LastUpdate: { S: new Date().toISOString() },
          },
        };
        try {
          await ddbClient.send(new PutItemCommand(params));
          logger.info('Baggage record created', { bookingId: event.bookingId });
        } catch (err) {
          logger.error('DynamoDB write failed', { error: err.message });
        }
      }
    },
  });
};
if (require.main === module) {
  initDynamoDB().then(() => initKafka()).catch(err => {
    logger.error('Startup failed', { error: err.message });
    process.exit(1);
  });
}

// Swagger Configuration
const swaggerOptions = {
  swaggerDefinition: {
    openapi: '3.0.0',
    info: {
      title: 'AeroLink Baggage Service API',
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
 * /baggage/{id}:
 *   get:
 *     summary: Get baggage status
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Baggage status
 */
app.get('/baggage/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const params = {
      TableName: 'Baggage',
      Key: { BaggageId: { S: id } },
    };
    const result = await ddbClient.send(new GetItemCommand(params));
    
    if (result.Item) {
      res.json({
        BaggageId: result.Item.BaggageId.S,
        Status: result.Item.Status.S,
        BookingId: result.Item.BookingId.S,
        LastUpdate: result.Item.LastUpdate.S,
      });
    } else {
      res.status(404).json({ error: 'Baggage not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch baggage status' });
  }
});

/**
 * @swagger
 * /baggage/{id}/status:
 *   patch:
 *     summary: Update baggage status
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
 *               status:
 *                 type: string
 *                 enum: [REGISTERED, IN-TRANSIT, DELIVERED]
 *     responses:
 *       200:
 *         description: Status updated and event emitted
 *       400:
 *         description: Invalid status value
 *       404:
 *         description: Baggage not found
 */
const VALID_STATUSES = ['REGISTERED', 'IN-TRANSIT', 'DELIVERED'];

app.patch('/baggage/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  try {
    await ddbClient.send(new UpdateItemCommand({
      TableName: 'Baggage',
      Key: { BaggageId: { S: id } },
      UpdateExpression: 'SET #s = :status, LastUpdate = :lastUpdate',
      ExpressionAttributeNames: { '#s': 'Status' },
      ExpressionAttributeValues: {
        ':status': { S: status },
        ':lastUpdate': { S: new Date().toISOString() },
      },
      ConditionExpression: 'attribute_exists(BaggageId)',
    }));

    await producer.send({
      topic: 'baggage-status-updates',
      messages: [{ value: JSON.stringify({ baggageId: id, status, timestamp: new Date().toISOString() }) }],
    });

    logger.info('Baggage status updated', { baggageId: id, status });
    res.json({ message: 'Baggage status updated', baggageId: id, status });
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return res.status(404).json({ error: 'Baggage not found' });
    }
    logger.error('Failed to update baggage status', { error: error.message });
    res.status(500).json({ error: 'Failed to update baggage status' });
  }
});

if (AWSXRay) app.use(AWSXRay.express.closeSegment());

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`Baggage Service running on port ${PORT}`);
  });
}

module.exports = app;
