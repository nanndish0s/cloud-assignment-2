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

const request = require('supertest');
const { Kafka } = require('kafkajs');
const app = require('./index');
const { Pool } = require('pg');

// Capture references at module load time — before beforeEach can wipe mock.results
const mockPool = Pool.mock.results[0].value;
const mockProducer = Kafka.mock.results[0].value.producer.mock.results[0].value;

beforeEach(() => jest.clearAllMocks());

describe('GET /health', () => {
  test('returns 200 with status UP', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'UP', service: 'Flight Service' });
  });
});

describe('GET /flights', () => {
  test('returns list of flights from database', async () => {
    const mockFlights = [
      { id: 'AL101', origin: 'London', destination: 'New York', seats: 50, price: 'LKR 145,000' },
      { id: 'AL202', origin: 'Paris', destination: 'Tokyo', seats: 30, price: 'LKR 265,000' },
    ];
    mockPool.query.mockResolvedValue({ rows: mockFlights });

    const res = await request(app).get('/flights');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe('AL101');
    expect(res.body[1].origin).toBe('Paris');
  });

  test('returns 500 when database query fails', async () => {
    mockPool.query.mockRejectedValue(new Error('DB connection lost'));

    const res = await request(app).get('/flights');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch flights');
  });
});

describe('PATCH /flights/:id/availability', () => {
  test('updates seat count and emits Kafka event', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .patch('/flights/AL101/availability')
      .send({ seats: 49 });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/updated/i);
    expect(mockProducer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'flight-availability-updates',
        messages: expect.arrayContaining([
          expect.objectContaining({
            value: expect.stringContaining('AL101'),
          }),
        ]),
      })
    );
  });

  test('returns 500 when update fails', async () => {
    mockPool.query.mockRejectedValue(new Error('DB error'));

    const res = await request(app)
      .patch('/flights/AL101/availability')
      .send({ seats: 49 });

    expect(res.status).toBe(500);
  });
});
