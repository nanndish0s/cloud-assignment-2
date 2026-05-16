const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();
const logger = require('./logger');

const app = express();
app.use(cors());

app.use((req, res, next) => {
  logger.info('Incoming request', { method: req.method, url: req.url });
  next();
});

const PORT = process.env.GATEWAY_PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'aerolink_secret_key';

// Middleware to verify JWT
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

// Routing Table
const routes = {
    '/auth':     process.env.AUTH_SERVICE_URL     || 'http://localhost:3001',
    '/flights':  process.env.FLIGHT_SERVICE_URL   || 'http://localhost:3002',
    '/bookings': process.env.BOOKING_SERVICE_URL  || 'http://localhost:3003',
    '/baggage':  process.env.BAGGAGE_SERVICE_URL  || 'http://localhost:3004',
};

// RBAC middleware — checks decoded JWT role against allowed roles
const requireRole = (...roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
        logger.warn('Access denied', { userRole: req.user.role, required: roles, url: req.url });
        return res.status(403).json({ error: `Access denied. Required role: ${roles.join(' or ')}` });
    }
    next();
};

// Admin-only: create a new flight
app.post('/flights',
    authenticate,
    requireRole('admin'),
    createProxyMiddleware({ target: routes['/flights'], changeOrigin: true })
);

// Admin-only: edit a flight
app.put('/flights/:id',
    authenticate,
    requireRole('admin'),
    createProxyMiddleware({ target: routes['/flights'], changeOrigin: true })
);

// Admin-only: delete a flight
app.delete('/flights/:id',
    authenticate,
    requireRole('admin'),
    createProxyMiddleware({ target: routes['/flights'], changeOrigin: true })
);

// Admin-only: update flight seat availability
app.patch('/flights/:id/availability',
    authenticate,
    requireRole('admin'),
    createProxyMiddleware({ target: routes['/flights'], changeOrigin: true })
);

// Public: browse flights
app.use('/flights', createProxyMiddleware({ target: routes['/flights'], changeOrigin: true }));

// Authenticated: create bookings (any logged-in user)
app.use('/bookings', authenticate, createProxyMiddleware({ target: routes['/bookings'], changeOrigin: true }));

// Authenticated: view baggage (any logged-in user)
app.use('/baggage', authenticate, createProxyMiddleware({ target: routes['/baggage'], changeOrigin: true }));

// Public: login / register
app.use('/auth', createProxyMiddleware({ target: routes['/auth'], changeOrigin: true }));

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`API Gateway running on port ${PORT}`, { routes });
  });
}

module.exports = app;
