const { client } = require('./client');

let userToken;
let userEmail;
let availableFlight;
let bookingId;

beforeAll(async () => {
  userEmail = `booking_test_${Date.now()}@aerolink.com`;
  await client.post('/auth/register', { email: userEmail, password: 'Test1234' });
  const res = await client.post('/auth/login', { email: userEmail, password: 'Test1234' });
  userToken = res.data.token;

  // Get a flight with available seats
  const flightsRes = await client.get('/flights');
  availableFlight = flightsRes.data.find(f => f.seats > 0);
});

describe('Booking Service — Integration', () => {

  describe('POST /bookings', () => {
    test('returns 401 when no token provided', async () => {
      const res = await client.post('/bookings', {
        flightId: 'AL101',
        passengerEmail: userEmail,
      });
      expect(res.status).toBe(401);
      expect(res.data.error).toBe('No token provided');
    });

    test('returns 403 when token is invalid', async () => {
      const res = await client.post('/bookings', {
        flightId: 'AL101',
        passengerEmail: userEmail,
      }, { headers: { Authorization: 'Bearer invalid.token' } });
      expect(res.status).toBe(403);
    });

    test('creates a booking successfully with valid token', async () => {
      if (!availableFlight) {
        console.warn('No available flights — skipping booking test');
        return;
      }

      const res = await client.post('/bookings', {
        flightId: availableFlight.id,
        passengerEmail: userEmail,
      }, { headers: { Authorization: `Bearer ${userToken}` } });

      expect(res.status).toBe(201);
      expect(res.data.bookingId).toMatch(/^BK-/);
      expect(res.data.message).toBe('Booking successful');
      bookingId = res.data.bookingId;
    });

    test('booking reduces available seat count', async () => {
      if (!availableFlight || !bookingId) return;

      const res = await client.get('/flights');
      const updatedFlight = res.data.find(f => f.id === availableFlight.id);
      expect(updatedFlight.seats).toBe(availableFlight.seats - 1);
    });

    test('returns 400 when flight is not found', async () => {
      const res = await client.post('/bookings', {
        flightId: 'NONEXISTENT',
        passengerEmail: userEmail,
      }, { headers: { Authorization: `Bearer ${userToken}` } });

      expect([400, 503]).toContain(res.status);
    });
  });

});
