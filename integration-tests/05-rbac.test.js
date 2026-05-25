const { client } = require('./client');

let adminToken;
let userToken;

beforeAll(async () => {
  const adminRes = await client.post('/auth/login', {
    email: 'admin@aerolink.com',
    password: 'admin123',
  });
  adminToken = adminRes.data.token;

  const email = `rbac_test_${Date.now()}@aerolink.com`;
  await client.post('/auth/register', { email, password: 'Test1234' });
  const userRes = await client.post('/auth/login', { email, password: 'Test1234' });
  userToken = userRes.data.token;
});

describe('RBAC Enforcement — Integration', () => {

  describe('Admin-only: POST /flights', () => {
    test('user role → 403', async () => {
      const res = await client.post('/flights',
        { id: 'RBAC1', origin: 'A', destination: 'B', seats: 10, price: 'LKR 1,000' },
        { headers: { Authorization: `Bearer ${userToken}` } }
      );
      expect(res.status).toBe(403);
    });

    test('no token → 401', async () => {
      const res = await client.post('/flights',
        { id: 'RBAC1', origin: 'A', destination: 'B', seats: 10, price: 'LKR 1,000' }
      );
      expect(res.status).toBe(401);
    });

    test('admin token → allowed (201 or 400 if ID exists)', async () => {
      const res = await client.post('/flights',
        { id: `RBAC${Date.now()}`, origin: 'A', destination: 'B', seats: 10, price: 'LKR 1,000' },
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      expect([201, 400]).toContain(res.status);
    });
  });

  describe('Admin-only: PUT /flights/:id', () => {
    test('user role → 403', async () => {
      const res = await client.put('/flights/AL101',
        { origin: 'London', destination: 'NY', seats: 50, price: 'LKR 100,000' },
        { headers: { Authorization: `Bearer ${userToken}` } }
      );
      expect(res.status).toBe(403);
    });

    test('no token → 401', async () => {
      const res = await client.put('/flights/AL101',
        { origin: 'London', destination: 'NY', seats: 50, price: 'LKR 100,000' }
      );
      expect(res.status).toBe(401);
    });
  });

  describe('Admin-only: DELETE /flights/:id', () => {
    test('user role → 403', async () => {
      const res = await client.delete('/flights/AL101', {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      expect(res.status).toBe(403);
    });

    test('no token → 401', async () => {
      const res = await client.delete('/flights/AL101');
      expect(res.status).toBe(401);
    });
  });

  describe('Admin-only: PATCH /flights/:id/availability', () => {
    test('user role → 403', async () => {
      const res = await client.patch('/flights/AL101/availability',
        { seats: 49 },
        { headers: { Authorization: `Bearer ${userToken}` } }
      );
      expect(res.status).toBe(403);
    });

    test('admin → allowed', async () => {
      const res = await client.patch('/flights/AL101/availability',
        { seats: 49 },
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      expect([200, 500]).toContain(res.status);
    });
  });

  describe('Authenticated routes: /bookings', () => {
    test('no token → 401', async () => {
      const res = await client.post('/bookings', { flightId: 'AL101', passengerEmail: 'test@test.com' });
      expect(res.status).toBe(401);
    });

    test('valid user token → allowed through gateway', async () => {
      const res = await client.post('/bookings',
        { flightId: 'AL999FAKE', passengerEmail: 'test@test.com' },
        { headers: { Authorization: `Bearer ${userToken}` } }
      );
      // Gets past gateway (authenticated) — service may return 400 for invalid flight
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  describe('Public routes: /flights GET', () => {
    test('no token → 200 (public access)', async () => {
      const res = await client.get('/flights');
      expect(res.status).toBe(200);
    });
  });

});
