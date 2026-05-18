#!/usr/bin/env node

// Load .env file for local development (ignored on Render where env vars are set in dashboard)
require('dotenv').config();

// Global error handlers — prevent crashes from killing the server
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION] (not exiting):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION] (not exiting):', reason?.message || reason);
});

const PORT = process.env.PORT || 3000;

// Load the full Express app immediately — no swapping, no bare stub
const app = require('./server');

const server = app.listen(PORT, () => {
  console.log(`Server ready on :${PORT}`);
});

// Start the trading bot after server is listening
process.env.SKIP_SERVER = '1';
try {
  require('./bot');
} catch (err) {
  console.error('Failed to load bot:', err.message);
}
