const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

app.use((req, res, next) => {
  console.log(`[Gateway] ${req.method} ${req.url}`);
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

// Apply Proxies
Object.entries(routes).forEach(([path, target]) => {
    const isProtected = path === '/bookings' || path === '/baggage';
    
    app.use(path, 
        (isProtected ? authenticate : (req, res, next) => next()), // Only protect specific routes
        createProxyMiddleware({
            target,
            changeOrigin: true,
            pathRewrite: { [`^${path}`]: path }, // Keep the path prefix
        })
    );
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`API Gateway running on port ${PORT}`);
    console.log('Routes:');
    console.table(routes);
  });
}

module.exports = app;
