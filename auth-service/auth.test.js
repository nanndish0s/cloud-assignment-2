jest.mock('pg', () => ({
  Pool: jest.fn(() => ({ query: jest.fn() })),
}));

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('$2b$10$hashedpassword'),
  compare: jest.fn(),
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('mocked.jwt.token'),
  verify: jest.fn(),
}));

const request = require('supertest');
const app = require('./index');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const mockPool = Pool.mock.results[0].value;

beforeEach(() => jest.clearAllMocks());

describe('GET /health', () => {
  test('returns 200 with status UP', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'UP', service: 'Auth Service' });
  });
});

describe('POST /auth/register', () => {
  test('registers a new user successfully', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'test@aerolink.com', password: 'securepass' });

    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/registered successfully/);
    expect(bcrypt.hash).toHaveBeenCalledWith('securepass', 10);
  });

  test('returns 500 when email already exists', async () => {
    mockPool.query.mockRejectedValue(new Error('duplicate key value'));

    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'existing@aerolink.com', password: 'pass' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Registration failed/);
  });
});

describe('POST /auth/login', () => {
  test('returns JWT token with valid credentials', async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ email: 'test@aerolink.com', password: '$2b$10$hash', role: 'user' }],
    });
    bcrypt.compare.mockResolvedValue(true);

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'test@aerolink.com', password: 'securepass' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('mocked.jwt.token');
    expect(jwt.sign).toHaveBeenCalledWith(
      { email: 'test@aerolink.com', role: 'user' },
      expect.any(String),
      { expiresIn: '1h' }
    );
  });

  test('returns 401 with wrong password', async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ email: 'test@aerolink.com', password: '$2b$10$hash', role: 'user' }],
    });
    bcrypt.compare.mockResolvedValue(false);

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'test@aerolink.com', password: 'wrongpass' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  test('returns 401 when user does not exist', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@aerolink.com', password: 'pass' });

    expect(res.status).toBe(401);
  });
});

describe('GET /auth/verify', () => {
  test('returns valid:true for a valid token', async () => {
    jwt.verify.mockImplementation((token, secret, cb) =>
      cb(null, { email: 'test@aerolink.com', role: 'user' })
    );

    const res = await request(app)
      .get('/auth/verify')
      .set('Authorization', 'Bearer valid.token');

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  test('returns 401 when no token provided', async () => {
    const res = await request(app).get('/auth/verify');
    expect(res.status).toBe(401);
  });

  test('returns 403 for an invalid token', async () => {
    jwt.verify.mockImplementation((token, secret, cb) =>
      cb(new Error('invalid signature'))
    );

    const res = await request(app)
      .get('/auth/verify')
      .set('Authorization', 'Bearer bad.token');

    expect(res.status).toBe(403);
  });
});
