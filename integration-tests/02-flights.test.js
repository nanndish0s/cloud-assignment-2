const { client } = require('./client');

let adminToken;
let userToken;
let createdFlightId;

beforeAll(async () => {
  const adminRes = await client.post('/auth/login', {
    email: 'admin@aerolink.com',
    password: 'admin123',
  });
  adminToken = adminRes.data.token;

  // Register and login a regular user
  const email = `flight_test_${Date.now()}@aerolink.com`;
  await client.post('/auth/register', { email, password: 'Test1234' });
  const userRes = await client.post('/auth/login', { email, password: 'Test1234' });
  userToken = userRes.data.token;
});

describe('Flight Service — Integration', () => {

  describe('GET /flights (public)', () => {
    test('returns flight list without authentication', async () => {
      const res = await client.get('/flights');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
      expect(res.data.length).toBeGreaterThan(0);
    });

    test('each flight has required fields', async () => {
      const res = await client.get('/flights');
      const flight = res.data[0];
      expect(flight).toHaveProperty('id');
      expect(flight).toHaveProperty('origin');
      expect(flight).toHaveProperty('destination');
      expect(flight).toHaveProperty('seats');
      expect(flight).toHaveProperty('price');
    });
  });

  describe('POST /flights (admin only)', () => {
    test('returns 401 when no token provided', async () => {
      const res = await client.post('/flights', {
        id: 'AL999', origin: 'Test', destination: 'Test', seats: 10, price: 'LKR 100,000',
      });
      expect(res.status).toBe(401);
    });

    test('returns 403 when user role tries to create a flight', async () => {
      const res = await client.post('/flights', {
        id: 'AL999', origin: 'Test', destination: 'Test', seats: 10, price: 'LKR 100,000',
      }, { headers: { Authorization: `Bearer ${userToken}` } });
      expect(res.status).toBe(403);
      expect(res.data.error).toMatch(/Access denied/);
    });

    test('admin can create a new flight', async () => {
      createdFlightId = `ALTEST${Date.now().toString().slice(-4)}`;
      const res = await client.post('/flights', {
        id: createdFlightId,
        origin: 'Colombo',
        destination: 'London',
        seats: 50,
        price: 'LKR 250,000',
      }, { headers: { Authorization: `Bearer ${adminToken}` } });
      expect(res.status).toBe(201);
      expect(res.data.flight.id).toBe(createdFlightId);
    });
  });

  describe('PUT /flights/:id (admin only)', () => {
    test('returns 403 when user role tries to edit a flight', async () => {
      const res = await client.put(`/flights/${createdFlightId}`, {
        origin: 'Colombo', destination: 'Paris', seats: 40, price: 'LKR 220,000',
      }, { headers: { Authorization: `Bearer ${userToken}` } });
      expect(res.status).toBe(403);
    });

    test('admin can update an existing flight', async () => {
      const res = await client.put(`/flights/${createdFlightId}`, {
        origin: 'Colombo',
        destination: 'Paris',
        seats: 40,
        price: 'LKR 220,000',
      }, { headers: { Authorization: `Bearer ${adminToken}` } });
      expect(res.status).toBe(200);
      expect(res.data.flight.destination).toBe('Paris');
      expect(res.data.flight.seats).toBe(40);
    });
  });

  describe('DELETE /flights/:id (admin only)', () => {
    test('returns 403 when user role tries to delete a flight', async () => {
      const res = await client.delete(`/flights/${createdFlightId}`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      expect(res.status).toBe(403);
    });

    test('admin can delete a flight', async () => {
      const res = await client.delete(`/flights/${createdFlightId}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.status).toBe(200);
      expect(res.data.message).toMatch(/deleted/i);
    });

    test('deleted flight no longer appears in list', async () => {
      const res = await client.get('/flights');
      const ids = res.data.map(f => f.id);
      expect(ids).not.toContain(createdFlightId);
    });
  });

});
