const { client, API_BASE } = require('./client');

const TEST_EMAIL = `integration_test_${Date.now()}@aerolink.com`;
const TEST_PASSWORD = 'IntegrationTest123';

console.log(`Running auth integration tests against: ${API_BASE}`);

describe('Auth Service — Integration', () => {

  describe('POST /auth/register', () => {
    test('registers a new user successfully', async () => {
      const res = await client.post('/auth/register', {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      });
      expect(res.status).toBe(201);
      expect(res.data.message).toMatch(/registered/i);
    });

    test('returns 409 when email already exists', async () => {
      const res = await client.post('/auth/register', {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      });
      expect(res.status).toBe(409);
    });
  });

  describe('POST /auth/login', () => {
    test('returns JWT token with valid credentials', async () => {
      const res = await client.post('/auth/login', {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      });
      expect(res.status).toBe(200);
      expect(res.data.token).toBeDefined();
      expect(typeof res.data.token).toBe('string');
      // JWT has 3 parts separated by dots
      expect(res.data.token.split('.')).toHaveLength(3);
    });

    test('returns 401 with wrong password', async () => {
      const res = await client.post('/auth/login', {
        email: TEST_EMAIL,
        password: 'wrongpassword',
      });
      expect(res.status).toBe(401);
    });

    test('returns 401 for non-existent user', async () => {
      const res = await client.post('/auth/login', {
        email: 'nobody@aerolink.com',
        password: 'pass',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /auth/token (OAuth 2.0)', () => {
    test('returns OAuth2 access_token with password grant', async () => {
      const res = await client.post('/auth/token', {
        grant_type: 'password',
        username: TEST_EMAIL,
        password: TEST_PASSWORD,
      });
      expect(res.status).toBe(200);
      expect(res.data.access_token).toBeDefined();
      expect(res.data.token_type).toBe('Bearer');
      expect(res.data.expires_in).toBe(3600);
      expect(res.data.scope).toBe('user');
    });

    test('returns 400 for unsupported grant_type', async () => {
      const res = await client.post('/auth/token', {
        grant_type: 'client_credentials',
      });
      expect(res.status).toBe(400);
      expect(res.data.error).toBe('unsupported_grant_type');
    });
  });

  describe('GET /auth/verify', () => {
    test('returns valid:true for a valid JWT', async () => {
      const loginRes = await client.post('/auth/login', {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      });
      const token = loginRes.data.token;

      const res = await client.get('/auth/verify', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(res.data.valid).toBe(true);
      expect(res.data.user.email).toBe(TEST_EMAIL);
    });

    test('returns 401 when no token provided', async () => {
      const res = await client.get('/auth/verify');
      expect(res.status).toBe(401);
    });

    test('returns 403 for a tampered token', async () => {
      const res = await client.get('/auth/verify', {
        headers: { Authorization: 'Bearer invalid.token.here' },
      });
      expect(res.status).toBe(403);
    });
  });

});
