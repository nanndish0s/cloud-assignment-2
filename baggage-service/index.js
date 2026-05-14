const express = require('express');
const { Kafka } = require('kafkajs');
const { DynamoDBClient, PutItemCommand, GetItemCommand, CreateTableCommand } = require('@aws-sdk/client-dynamodb');
const swaggerJsDoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Baggage Service' }));

const PORT = process.env.PORT || 3004;

// DynamoDB Configuration
const ddbClient = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000',
});

const initDynamoDB = async () => {
  try {
    await ddbClient.send(new CreateTableCommand({
      TableName: 'Baggage',
      AttributeDefinitions: [{ AttributeName: 'BaggageId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'BaggageId', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    }));
    console.log('DynamoDB Baggage table created');
  } catch (err) {
    if (err.name === 'ResourceInUseException') {
      console.log('DynamoDB Baggage table already exists');
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

const initKafka = async () => {
  await consumer.connect();
  await consumer.subscribe({ topic: 'booking-events', fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const event = JSON.parse(message.value.toString());
      console.log(`[Baggage Service] 🔔 RECEIVED KAFKA EVENT: ${event.type} for Booking ${event.bookingId}`);
      
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
          console.log(`Baggage initialized for booking ${event.bookingId} in DynamoDB`);
        } catch (err) {
          console.error('DynamoDB Error:', err);
        }
      }
    },
  });
};
if (require.main === module) {
  initDynamoDB().then(() => initKafka()).catch(err => {
    console.error('Startup failed:', err);
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Baggage Service running on port ${PORT}`);
  });
}

module.exports = app;
