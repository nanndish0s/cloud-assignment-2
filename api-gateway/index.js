const express = require('express');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const CircuitBreaker = require('opossum');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const swaggerJsDoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
require('dotenv').config();
const logger = require('./logger');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use((req, res, next) => {
  logger.info('Incoming request', { method: req.method, url: req.url });
  next();
});

let AWSXRay = null;
if (process.env.ENABLE_XRAY === 'true') {
  AWSXRay = require('aws-xray-sdk');
  AWSXRay.config([AWSXRay.plugins.ECSPlugin]);
  app.use(AWSXRay.express.openSegment('api-gateway'));
}

const PORT = process.env.GATEWAY_PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'aerolink_secret_key';

// Swagger / OpenAPI
const swaggerOptions = {
  swaggerDefinition: {
    openapi: '3.0.0',
    info: {
      title: 'AeroLink API Gateway',
      version: '1.0.0',
      description: 'Public-facing API for the AeroLink Airline Systems Platform. All requests are routed through this gateway to the appropriate microservice. Protected endpoints require a Bearer JWT token obtained from POST /auth/login.',
    },
    servers: [{ url: process.env.SWAGGER_SERVER_URL || `http://localhost:${PORT}` }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT token obtained from POST /auth/login or POST /auth/token',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  },
  apis: ['./index.js'],
};

const swaggerDocs = swaggerJsDoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: axiosRetry.isNetworkOrIdempotentRequestError,
  onRetry: (retryCount, error) => {
    logger.warn('Retrying upstream request', { retryCount, error: error.message });
  },
});

// Circuit Breakers
const breakerOptions = {
  timeout: 5000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
};

async function callUpstream(req, targetBase) {
  return axios({
    method: req.method,
    url: `${targetBase}${req.originalUrl}`,
    data: req.body,
    headers: {
      'content-type': req.headers['content-type'],
      'authorization': req.headers['authorization'],
    },
    validateStatus: (status) => status < 500,
  });
}

const breakers = {
  auth:     new CircuitBreaker(callUpstream, { ...breakerOptions, name: 'auth-service' }),
  flights:  new CircuitBreaker(callUpstream, { ...breakerOptions, name: 'flight-service' }),
  bookings: new CircuitBreaker(callUpstream, { ...breakerOptions, name: 'booking-service' }),
  baggage:  new CircuitBreaker(callUpstream, { ...breakerOptions, name: 'baggage-service' }),
};

Object.entries(breakers).forEach(([name, breaker]) => {
  breaker.on('open',     () => logger.error(`Circuit OPEN: ${name} — requests will fail fast`));
  breaker.on('halfOpen', () => logger.warn(`Circuit HALF-OPEN: ${name} — probing upstream`));
  breaker.on('close',    () => logger.info(`Circuit CLOSED: ${name} — service recovered`));
});

const proxyVia = (breakerName, targetUrl) => async (req, res) => {
  const breaker = breakers[breakerName];
  try {
    const upstream = await breaker.fire(req, targetUrl);
    res.status(upstream.status).json(upstream.data);
  } catch (err) {
    if (breaker.opened) {
      logger.error('Circuit open, rejecting request', { service: breakerName, url: req.url });
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        service: breakerName,
        retryAfter: 30,
      });
    }
    logger.error('Upstream request failed', { service: breakerName, error: err.message });
    res.status(502).json({ error: 'Bad gateway', service: breakerName });
  }
};

// Auth Middleware
const authenticate = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!roles.includes(req.user.role)) {
    logger.warn('Access denied', { userRole: req.user.role, required: roles, url: req.url });
    return res.status(403).json({ error: `Access denied. Required role: ${roles.join(' or ')}` });
  }
  next();
};

const SERVICES = {
  auth:     process.env.AUTH_SERVICE_URL    || 'http://localhost:3001',
  flights:  process.env.FLIGHT_SERVICE_URL  || 'http://localhost:3002',
  bookings: process.env.BOOKING_SERVICE_URL || 'http://localhost:3003',
  baggage:  process.env.BAGGAGE_SERVICE_URL || 'http://localhost:3004',
};

// Routes

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 example: passenger@aerolink.com
 *               password:
 *                 type: string
 *                 example: mypassword123
 *     responses:
 *       201:
 *         description: User registered successfully
 *       500:
 *         description: Registration failed (user may already exist)
 *
 * /auth/login:
 *   post:
 *     summary: Login and receive a JWT token
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 example: passenger@aerolink.com
 *               password:
 *                 type: string
 *                 example: mypassword123
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: JWT Bearer token — use in Authorization header
 *       401:
 *         description: Invalid credentials
 *
 * /auth/token:
 *   post:
 *     summary: OAuth 2.0 token endpoint (Resource Owner Password Credentials Grant)
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [grant_type, username, password]
 *             properties:
 *               grant_type:
 *                 type: string
 *                 example: password
 *               username:
 *                 type: string
 *                 example: passenger@aerolink.com
 *               password:
 *                 type: string
 *                 example: mypassword123
 *     responses:
 *       200:
 *         description: OAuth 2.0 access token
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 access_token:
 *                   type: string
 *                 token_type:
 *                   type: string
 *                   example: Bearer
 *                 expires_in:
 *                   type: integer
 *                   example: 3600
 *                 scope:
 *                   type: string
 *                   example: user
 *       400:
 *         description: Unsupported grant type
 *       401:
 *         description: Invalid credentials
 *
 * /auth/verify:
 *   get:
 *     summary: Verify a JWT token
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token is valid
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid:
 *                   type: boolean
 *                 user:
 *                   type: object
 *                   properties:
 *                     email:
 *                       type: string
 *                     role:
 *                       type: string
 *       401:
 *         description: No token provided
 *       403:
 *         description: Invalid or expired token
 */
app.use('/auth', proxyVia('auth', SERVICES.auth));

/**
 * @swagger
 * /flights:
 *   get:
 *     summary: Get all available flights
 *     tags: [Flights]
 *     responses:
 *       200:
 *         description: List of flights
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                     example: AL101
 *                   origin:
 *                     type: string
 *                     example: London
 *                   destination:
 *                     type: string
 *                     example: Dubai
 *                   seats:
 *                     type: integer
 *                     example: 50
 *                   price:
 *                     type: string
 *                     example: LKR 150,000
 *   post:
 *     summary: Create a new flight (admin only)
 *     tags: [Flights]
 *     security:
 *       - bearerAuth: []
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
 *                 example: AL202
 *               origin:
 *                 type: string
 *                 example: Singapore
 *               destination:
 *                 type: string
 *                 example: Tokyo
 *               seats:
 *                 type: integer
 *                 example: 120
 *               price:
 *                 type: string
 *                 example: LKR 220,000
 *     responses:
 *       201:
 *         description: Flight created
 *       401:
 *         description: No token provided
 *       403:
 *         description: Admin role required
 *
 * /flights/{id}:
 *   put:
 *     summary: Update a flight (admin only)
 *     tags: [Flights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         example: AL101
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
 *       403:
 *         description: Admin role required
 *       404:
 *         description: Flight not found
 *   delete:
 *     summary: Delete a flight (admin only)
 *     tags: [Flights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         example: AL101
 *     responses:
 *       200:
 *         description: Flight deleted
 *       403:
 *         description: Admin role required
 *       404:
 *         description: Flight not found
 *
 * /flights/{id}/availability:
 *   patch:
 *     summary: Update flight seat availability (admin only)
 *     tags: [Flights]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         example: AL101
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [seats]
 *             properties:
 *               seats:
 *                 type: integer
 *                 example: 49
 *     responses:
 *       200:
 *         description: Seat availability updated
 *       403:
 *         description: Admin role required
 */
app.post('/flights',                   authenticate, requireRole('admin'), proxyVia('flights', SERVICES.flights));
app.put('/flights/:id',                authenticate, requireRole('admin'), proxyVia('flights', SERVICES.flights));
app.delete('/flights/:id',             authenticate, requireRole('admin'), proxyVia('flights', SERVICES.flights));
app.patch('/flights/:id/availability', authenticate, requireRole('admin'), proxyVia('flights', SERVICES.flights));
app.use('/flights', proxyVia('flights', SERVICES.flights));

/**
 * @swagger
 * /bookings:
 *   post:
 *     summary: Create a new flight booking
 *     tags: [Bookings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [flightId, passengerEmail]
 *             properties:
 *               flightId:
 *                 type: string
 *                 example: AL101
 *               passengerEmail:
 *                 type: string
 *                 example: passenger@aerolink.com
 *     responses:
 *       201:
 *         description: Booking confirmed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Booking confirmed
 *                 bookingId:
 *                   type: string
 *                   example: BK-4821
 *       400:
 *         description: Flight not available or full
 *       401:
 *         description: No token provided
 *       503:
 *         description: Flight service unavailable (circuit open)
 *
 * /bookings/my:
 *   get:
 *     summary: Get all bookings for the authenticated passenger
 *     tags: [Bookings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: email
 *         required: true
 *         schema:
 *           type: string
 *         example: passenger@aerolink.com
 *     responses:
 *       200:
 *         description: List of bookings
 *       401:
 *         description: No token provided
 *
 * /bookings/{id}/checkin:
 *   patch:
 *     summary: Check in a passenger for their booked flight
 *     tags: [Bookings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         example: BK-4821
 *     responses:
 *       200:
 *         description: Check-in successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Check-in successful
 *                 bookingId:
 *                   type: string
 *                   example: BK-4821
 *                 seatNumber:
 *                   type: string
 *                   example: C14
 *                 status:
 *                   type: string
 *                   example: CHECKED_IN
 *       400:
 *         description: Already checked in or booking not confirmed
 *       404:
 *         description: Booking not found
 */
app.use('/bookings', authenticate, proxyVia('bookings', SERVICES.bookings));

/**
 * @swagger
 * /baggage/{id}:
 *   get:
 *     summary: Get baggage tracking status by booking ID
 *     tags: [Baggage]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         example: BK-4821
 *     responses:
 *       200:
 *         description: Baggage status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 bookingId:
 *                   type: string
 *                 status:
 *                   type: string
 *                   example: IN_TRANSIT
 *                 location:
 *                   type: string
 *                   example: Singapore Changi Airport
 *       401:
 *         description: No token provided
 *       404:
 *         description: Baggage record not found
 *
 * /baggage/{id}/status:
 *   patch:
 *     summary: Update baggage status
 *     tags: [Baggage]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         example: BK-4821
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 example: DELIVERED
 *               location:
 *                 type: string
 *                 example: Dubai International Airport
 *     responses:
 *       200:
 *         description: Baggage status updated
 *       401:
 *         description: No token provided
 *       404:
 *         description: Baggage record not found
 */
app.use('/baggage', authenticate, proxyVia('baggage', SERVICES.baggage));

if (AWSXRay) app.use(AWSXRay.express.closeSegment());

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info('API Gateway running', { port: PORT, services: SERVICES });
  });
}

module.exports = app;
