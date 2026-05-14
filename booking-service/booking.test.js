jest.mock('pg', () => ({
  Pool: jest.fn(() => ({ query: jest.fn() })),
}));

jest.mock('kafkajs', () => ({
  Kafka: jest.fn(() => ({
    producer: jest.fn(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
    })),
  })),
}));

jest.mock('axios');

// Circuit breaker passes through to the wrapped function directly
jest.mock('opossum', () =>
  jest.fn().mockImplementation((fn) => ({
    fire: jest.fn().mockImplementation((...args) => fn(...args)),
    fallback: jest.fn(),
    on: jest.fn(),
  }))
);

const request = require('supertest');
const app = require('./index');
const { Pool } = require('pg');
const axios = require('axios');

const mockPool = Pool.mock.results[0].value;

beforeEach(() => jest.clearAllMocks());

describe('GET /health', () => {
  test('returns 200 with status UP', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'UP', service: 'Booking Service' });
  });
});

describe('POST /bookings', () => {
  test('creates booking successfully when seats are available', async () => {
    axios.get.mockResolvedValue({
      data: [{ id: 'AL101', seats: 10 }],
    });
    axios.patch.mockResolvedValue({ data: {} });
    mockPool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/bookings')
      .send({ flightId: 'AL101', passengerEmail: 'passenger@aerolink.com' });

    expect(res.status).toBe(201);
    expect(res.body.bookingId).toMatch(/^BK-/);
    expect(res.body.message).toBe('Booking successful');
  });

  test('returns 400 when flight ID is not found', async () => {
    axios.get.mockResolvedValue({
      data: [{ id: 'AL202', seats: 10 }],
    });

    const res = await request(app)
      .post('/bookings')
      .send({ flightId: 'AL999', passengerEmail: 'passenger@aerolink.com' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not available/i);
  });

  test('returns 400 when flight has no seats remaining', async () => {
    axios.get.mockResolvedValue({
      data: [{ id: 'AL101', seats: 0 }],
    });

    const res = await request(app)
      .post('/bookings')
      .send({ flightId: 'AL101', passengerEmail: 'passenger@aerolink.com' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/full/i);
  });

  test('returns 503 when flight service circuit breaker fallback triggers', async () => {
    // Simulate the fallback response the circuit breaker returns
    axios.get.mockResolvedValue({
      data: [],
      error: 'Flight Service is currently unavailable. Please try again later.',
    });

    const res = await request(app)
      .post('/bookings')
      .send({ flightId: 'AL101', passengerEmail: 'passenger@aerolink.com' });

    expect(res.status).toBe(503);
  });

  test('returns 500 on database error', async () => {
    axios.get.mockResolvedValue({
      data: [{ id: 'AL101', seats: 5 }],
    });
    mockPool.query.mockRejectedValue(new Error('DB error'));

    const res = await request(app)
      .post('/bookings')
      .send({ flightId: 'AL101', passengerEmail: 'passenger@aerolink.com' });

    expect(res.status).toBe(500);
  });
});
