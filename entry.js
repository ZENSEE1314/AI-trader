#!/usr/bin/env node

// Minimal entry point: bind PORT instantly for Railway healthcheck,
// then load the full app + bot after.

const express = require('express');
const PORT = process.env.PORT || 3000;

// Bare-minimum app just for healthcheck
const app = express();
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const server = app.listen(PORT, () => {
  console.log(`Healthcheck ready on :${PORT}`);

  // Now load the full server app and bot
  setImmediate(() => {
    try {
      const fullApp = require('./server');
      // Mount the full app on the same server
      server.removeAllListeners('request');
      server.on('request', fullApp);
      console.log('Full server loaded');
    } catch (err) {
      console.error('Failed to load server:', err.message);
    }

    // Start the trading bot
    process.env.SKIP_SERVER = '1';
    try {
      require('./bot');
    } catch (err) {
      console.error('Failed to load bot:', err.message);
    }
  });
});
