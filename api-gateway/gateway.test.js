jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(() => (req, res) =>
    res.status(200).json({ proxied: true })
  ),
}));

jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(),
}));

const request = require('supertest');
const app = require('./index');
const jwt = require('jsonwebtoken');

beforeEach(() => jest.clearAllMocks());

describe('Unprotected routes', () => {
  test('GET /flights - passes through without authentication', async () => {
    const res = await request(app).get('/flights');
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });

  test('POST /auth/login - passes through without authentication', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'test@aerolink.com', password: 'pass' });
    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });
});

describe('Protected routes - /bookings', () => {
  test('returns 401 when no Authorization header provided', async () => {
    const res = await request(app)
      .post('/bookings')
      .send({ flightId: 'AL101' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('No token provided');
  });

  test('returns 403 when token is invalid', async () => {
    jwt.verify.mockImplementation((token, secret, cb) =>
      cb(new Error('invalid signature'))
    );

    const res = await request(app)
      .post('/bookings')
      .set('Authorization', 'Bearer invalid.token')
      .send({ flightId: 'AL101' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Invalid or expired token');
  });

  test('proxies request when valid token is provided', async () => {
    jwt.verify.mockImplementation((token, secret, cb) =>
      cb(null, { email: 'test@aerolink.com', role: 'user' })
    );

    const res = await request(app)
      .post('/bookings')
      .set('Authorization', 'Bearer valid.token')
      .send({ flightId: 'AL101' });

    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });
});

describe('Protected routes - /baggage', () => {
  test('returns 401 when no token provided', async () => {
    const res = await request(app).get('/baggage/BAG-BK-1234');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('No token provided');
  });

  test('proxies request when valid token is provided', async () => {
    jwt.verify.mockImplementation((token, secret, cb) =>
      cb(null, { email: 'test@aerolink.com', role: 'user' })
    );

    const res = await request(app)
      .get('/baggage/BAG-BK-1234')
      .set('Authorization', 'Bearer valid.token');

    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });
});

describe('RBAC - PATCH /flights/:id/availability (admin only)', () => {
  test('returns 401 when no token provided', async () => {
    const res = await request(app).patch('/flights/AL101/availability').send({ seats: 49 });
    expect(res.status).toBe(401);
  });

  test('returns 403 when user role tries to update availability', async () => {
    jwt.verify.mockImplementation((token, secret, cb) =>
      cb(null, { email: 'user@aerolink.com', role: 'user' })
    );

    const res = await request(app)
      .patch('/flights/AL101/availability')
      .set('Authorization', 'Bearer user.token')
      .send({ seats: 49 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Access denied/);
  });

  test('returns 403 when gate-agent role tries to update availability', async () => {
    jwt.verify.mockImplementation((token, secret, cb) =>
      cb(null, { email: 'agent@aerolink.com', role: 'gate-agent' })
    );

    const res = await request(app)
      .patch('/flights/AL101/availability')
      .set('Authorization', 'Bearer agent.token')
      .send({ seats: 49 });

    expect(res.status).toBe(403);
  });

  test('proxies request when admin role is used', async () => {
    jwt.verify.mockImplementation((token, secret, cb) =>
      cb(null, { email: 'admin@aerolink.com', role: 'admin' })
    );

    const res = await request(app)
      .patch('/flights/AL101/availability')
      .set('Authorization', 'Bearer admin.token')
      .send({ seats: 49 });

    expect(res.status).toBe(200);
    expect(res.body.proxied).toBe(true);
  });
});
