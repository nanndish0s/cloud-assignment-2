const axios = require('axios');

const API_BASE = process.env.API_BASE || 'http://localhost:3000';

const client = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
  validateStatus: () => true, // never throw on HTTP errors — let tests assert status
});

module.exports = { client, API_BASE };
