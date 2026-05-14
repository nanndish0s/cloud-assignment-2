-- Create Users Table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'user'
);

-- Create Flights Table
CREATE TABLE IF NOT EXISTS flights (
    id VARCHAR(50) PRIMARY KEY,
    origin VARCHAR(100) NOT NULL,
    destination VARCHAR(100) NOT NULL,
    seats INTEGER NOT NULL,
    price VARCHAR(50) NOT NULL
);

-- Create Bookings Table
CREATE TABLE IF NOT EXISTS bookings (
    id SERIAL PRIMARY KEY,
    booking_id VARCHAR(50) UNIQUE NOT NULL,
    flight_id VARCHAR(50) REFERENCES flights(id),
    passenger_email VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'CONFIRMED',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed Data for Flights
INSERT INTO flights (id, origin, destination, seats, price) VALUES
('AL101', 'London', 'New York', 50, 'LKR 145,000'),
('AL202', 'Paris', 'Tokyo', 30, 'LKR 265,000'),
('AL303', 'Dubai', 'Singapore', 15, 'LKR 198,000')
ON CONFLICT (id) DO UPDATE SET price = EXCLUDED.price;
