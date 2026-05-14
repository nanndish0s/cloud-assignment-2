const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockSend })),
  PutItemCommand: jest.fn(),
  GetItemCommand: jest.fn(),
  CreateTableCommand: jest.fn(),
}));

jest.mock('kafkajs', () => ({
  Kafka: jest.fn(() => ({
    consumer: jest.fn(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(undefined),
      run: jest.fn().mockResolvedValue(undefined),
    })),
  })),
}));

const request = require('supertest');
const app = require('./index');

beforeEach(() => jest.clearAllMocks());

describe('GET /health', () => {
  test('returns 200 with status UP', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'UP', service: 'Baggage Service' });
  });
});

describe('GET /baggage/:id', () => {
  test('returns baggage record when found in DynamoDB', async () => {
    mockSend.mockResolvedValue({
      Item: {
        BaggageId: { S: 'BAG-BK-1234' },
        BookingId: { S: 'BK-1234' },
        Status: { S: 'REGISTERED' },
        LastUpdate: { S: '2026-05-01T10:00:00.000Z' },
      },
    });

    const res = await request(app).get('/baggage/BAG-BK-1234');

    expect(res.status).toBe(200);
    expect(res.body.BaggageId).toBe('BAG-BK-1234');
    expect(res.body.Status).toBe('REGISTERED');
    expect(res.body.BookingId).toBe('BK-1234');
  });

  test('returns 404 when baggage record does not exist', async () => {
    mockSend.mockResolvedValue({ Item: null });

    const res = await request(app).get('/baggage/BAG-NOTFOUND');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Baggage not found');
  });

  test('returns 500 on DynamoDB error', async () => {
    mockSend.mockRejectedValue(new Error('DynamoDB unavailable'));

    const res = await request(app).get('/baggage/BAG-BK-1234');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch baggage status');
  });
});
