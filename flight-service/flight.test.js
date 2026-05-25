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

describe('POST /flights', () => {
  test('creates a new flight successfully', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/flights')
      .send({ id: 'AL404', origin: 'London', destination: 'Sydney', seats: 120, price: 'LKR 310,000' });

    expect(res.status).toBe(201);
    expect(res.body.flight.id).toBe('AL404');
    expect(res.body.message).toMatch(/created/i);
  });

  test('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/flights')
      .send({ id: 'AL404', origin: 'London' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required fields/);
  });

  test('returns 400 when flight ID already exists', async () => {
    const err = new Error('duplicate key');
    err.code = '23505';
    mockPool.query.mockRejectedValue(err);

    const res = await request(app)
      .post('/flights')
      .send({ id: 'AL101', origin: 'London', destination: 'New York', seats: 50, price: 'LKR 145,000' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/);
  });
});

describe('PUT /flights/:id', () => {
  test('updates a flight successfully', async () => {
    const updatedFlight = { id: 'AL101', origin: 'London', destination: 'Dubai', seats: 80, price: 'LKR 200,000' };
    mockPool.query.mockResolvedValue({ rows: [updatedFlight], rowCount: 1 });

    const res = await request(app)
      .put('/flights/AL101')
      .send({ origin: 'London', destination: 'Dubai', seats: 80, price: 'LKR 200,000' });

    expect(res.status).toBe(200);
    expect(res.body.flight.destination).toBe('Dubai');
    expect(res.body.message).toMatch(/updated/i);
    expect(mockProducer.send).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'flight-schedule-updates' })
    );
  });

  test('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .put('/flights/AL101')
      .send({ origin: 'London' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required fields/);
  });

  test('returns 404 when flight does not exist', async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app)
      .put('/flights/AL999')
      .send({ origin: 'London', destination: 'Dubai', seats: 80, price: 'LKR 200,000' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/AL999/);
  });

  test('returns 500 on database error', async () => {
    mockPool.query.mockRejectedValue(new Error('DB error'));

    const res = await request(app)
      .put('/flights/AL101')
      .send({ origin: 'London', destination: 'Dubai', seats: 80, price: 'LKR 200,000' });

    expect(res.status).toBe(500);
  });
});

describe('DELETE /flights/:id', () => {
  test('deletes a flight successfully', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: 'AL101' }], rowCount: 1 });

    const res = await request(app).delete('/flights/AL101');

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/deleted/i);
    expect(mockProducer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'flight-schedule-updates',
        messages: expect.arrayContaining([
          expect.objectContaining({ value: expect.stringContaining('DELETED') }),
        ]),
      })
    );
  });

  test('returns 404 when flight does not exist', async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app).delete('/flights/AL999');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/AL999/);
  });

  test('returns 500 on database error', async () => {
    mockPool.query.mockRejectedValue(new Error('DB error'));

    const res = await request(app).delete('/flights/AL101');

    expect(res.status).toBe(500);
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
