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

const express = require('express');
const PORT = process.env.PORT || 3000;

// ── Immediate healthcheck stub ──
// Railway needs /health to pass before it routes traffic.
const stub = express();
stub.get('/health', (req, res) => res.json({ status: 'ok' }));

const server = stub.listen(PORT, () => {
  console.log(`Healthcheck ready on :${PORT}`);
});

// ── Load full app + bot in background ──
setImmediate(() => {
  try {
    const fullApp = require('./server');
    stub.use(fullApp);   // mount full Express app as middleware
    console.log('Full server mounted');
  } catch (err) {
    console.error('Failed to mount server:', err.message);
  }

  process.env.SKIP_SERVER = '1';
  try {
    require('./bot');
  } catch (err) {
    console.error('Failed to load bot:', err.message);
  }
});
