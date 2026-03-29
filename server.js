const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/keys', require('./routes/api-keys'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/subscription', require('./routes/subscription'));
app.use('/api/wallet', require('./routes/wallet'));

// Stripe webhook needs raw body — mount before json parser catches it
// (already handled inside subscription.js with express.raw)

// Health check for Render
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// SPA fallback — serve index.html for non-API routes
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;
