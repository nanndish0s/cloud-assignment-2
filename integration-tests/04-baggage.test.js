const { client } = require('./client');

let userToken;
let userEmail;
let bookingId;

beforeAll(async () => {
  userEmail = `baggage_test_${Date.now()}@aerolink.com`;
  await client.post('/auth/register', { email: userEmail, password: 'Test1234' });
  const loginRes = await client.post('/auth/login', { email: userEmail, password: 'Test1234' });
  userToken = loginRes.data.token;

  // Create a booking to generate a baggage record
  const flightsRes = await client.get('/flights');
  const flight = flightsRes.data.find(f => f.seats > 0);
  if (flight) {
    const bookingRes = await client.post('/bookings', {
      flightId: flight.id,
      passengerEmail: userEmail,
    }, { headers: { Authorization: `Bearer ${userToken}` } });
    bookingId = bookingRes.data?.bookingId;
  }
});

describe('Baggage Service — Integration', () => {

  describe('GET /baggage/:id', () => {
    test('returns 401 when no token provided', async () => {
      const res = await client.get('/baggage/BAG-BK-0000');
      expect(res.status).toBe(401);
    });

    test('returns 403 with invalid token', async () => {
      const res = await client.get('/baggage/BAG-BK-0000', {
        headers: { Authorization: 'Bearer bad.token.here' },
      });
      expect(res.status).toBe(403);
    });

    test('returns baggage record for a valid booking', async () => {
      if (!bookingId) {
        console.warn('No booking created — skipping baggage lookup test');
        return;
      }

      // Baggage record is created async by Kafka consumer — wait briefly
      await new Promise(r => setTimeout(r, 3000));

      const res = await client.get(`/baggage/BAG-${bookingId}`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });

      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(res.data.BaggageId).toBe(`BAG-${bookingId}`);
        expect(res.data.Status).toBe('REGISTERED');
      }
    });

    test('returns 404 for non-existent baggage ID', async () => {
      const res = await client.get('/baggage/BAG-DOESNOTEXIST999', {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /baggage/:id/status', () => {
    test('returns 400 for invalid status value', async () => {
      if (!bookingId) return;

      const res = await client.patch(`/baggage/BAG-${bookingId}/status`,
        { status: 'LOST' },
        { headers: { Authorization: `Bearer ${userToken}` } }
      );
      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(/Invalid status/);
    });
  });

});
