const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const swaggerJsDoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const cors = require('cors');
require('dotenv').config();
const logger = require('./logger');

const app = express();
app.use(express.json());
app.use(cors());

// Request Logger
app.use((req, res, next) => {
  logger.info('Incoming request', { method: req.method, url: req.url });
  next();
});

// X-Ray distributed tracing (enabled in AWS via ENABLE_XRAY=true)
let AWSXRay = null;
if (process.env.ENABLE_XRAY === 'true') {
  AWSXRay = require('aws-xray-sdk');
  AWSXRay.config([AWSXRay.plugins.ECSPlugin]);
  app.use(AWSXRay.express.openSegment('auth-service'));
}

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Auth Service' }));

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'aerolink_secret_key';

// Mock DB Connection (PostgreSQL)
const pool = new Pool({
  user: process.env.DB_USER || 'user',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'aerolink',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
});

// Swagger Configuration
const swaggerOptions = {
  swaggerDefinition: {
    openapi: '3.0.0',
    info: {
      title: 'AeroLink Auth Service API',
      version: '1.0.0',
      description: 'Authentication Service for AeroLink Airline Systems',
    },
    servers: [{ url: `http://localhost:${PORT}` }],
  },
  apis: ['./index.js'],
};

const swaggerDocs = swaggerJsDoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       201:
 *         description: User registered successfully
 */
app.post('/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (email, password, role) VALUES ($1, $2, $3)', [email, hashedPassword, 'user']);
    res.status(201).json({ message: 'User registered successfully' });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    logger.error('Registration failed', { error: error.message });
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login with email and password to receive a JWT token
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
 *                   description: JWT Bearer token
 *       401:
 *         description: Invalid credentials
 */
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (user && await bcrypt.compare(password, user.password)) {
      const token = jwt.sign({ email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
      res.json({ token });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * @swagger
 * /auth/token:
 *   post:
 *     summary: OAuth 2.0 token endpoint (Resource Owner Password Credentials Grant)
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
 *                 example: user@aerolink.com
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: OAuth 2.0 access token response
 *       400:
 *         description: Unsupported grant type
 *       401:
 *         description: Invalid credentials
 */
app.post('/auth/token', async (req, res) => {
  const { grant_type, username, password } = req.body;

  if (grant_type !== 'password') {
    return res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'Only grant_type=password is supported',
    });
  }

  if (!username || !password) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'username and password are required',
    });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [username]);
    const user = result.rows[0];

    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({
        error: 'invalid_grant',
        error_description: 'Invalid credentials',
      });
    }

    const access_token = jwt.sign(
      { email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    logger.info('OAuth2 token issued', { email: user.email, role: user.role });

    res.json({
      access_token,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: user.role,
    });
  } catch (error) {
    logger.error('Token endpoint failed', { error: error.message });
    res.status(500).json({ error: 'server_error', error_description: 'Token generation failed' });
  }
});

/**
 * @swagger
 * /auth/verify:
 *   get:
 *     summary: Verify JWT token
 *     parameters:
 *       - in: header
 *         name: Authorization
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Token is valid
 */
app.get('/auth/verify', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    res.json({ valid: true, user });
  });
});

if (AWSXRay) app.use(AWSXRay.express.closeSegment());

const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(50) DEFAULT 'user'
    )
  `);
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@aerolink.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [adminEmail]);
  if (existing.rows.length === 0) {
    const hashed = await bcrypt.hash(adminPassword, 10);
    await pool.query(
      'INSERT INTO users (email, password, role) VALUES ($1, $2, $3)',
      [adminEmail, hashed, 'admin']
    );
    logger.info('Admin user seeded', { email: adminEmail });
  }
};

if (require.main === module) {
  initDB().catch(err => logger.error('DB init failed', { error: err.message }));
  app.listen(PORT, () => {
    logger.info(`Auth Service running on port ${PORT}`);
  });
}

module.exports = app;
