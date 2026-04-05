#!/usr/bin/env node

// Minimal entry point: start Express server IMMEDIATELY for Railway healthcheck,
// then load the heavy bot module after the port is bound.

const app = require('./server');
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server on :${PORT}`);

  // Now load and start the bot (heavy imports happen here, after port is open)
  process.env.SKIP_SERVER = '1';
  require('./bot');
});
