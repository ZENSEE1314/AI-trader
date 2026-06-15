'use strict';
// Public "live backtest" API for the homepage. Lets prospects run the SMC Expo
// strategy on chosen tokens / leverage / SL / TP / days against recent data.
const express = require('express');
const router = express.Router();
const { runExpoBacktest, SUPPORTED, LIMITS } = require('../backtest-expo-engine');

// ── Light abuse guard: per-IP cooldown + global concurrency cap ──
const _last = new Map();                 // ip → last request ms
const COOLDOWN_MS = 4000;
let _running = 0;
const MAX_CONCURRENT = 3;

router.get('/config', (_req, res) => {
  res.json({ tokens: SUPPORTED, limits: LIMITS, defaults: { leverage: 20, sl: 50, tp: 35, days: 7 } });
});

router.post('/expo', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || 'anon').split(',')[0].trim();
  const now = Date.now();
  if (now - (_last.get(ip) || 0) < COOLDOWN_MS) {
    return res.status(429).json({ ok: false, error: 'Slow down — one backtest every few seconds.' });
  }
  if (_running >= MAX_CONCURRENT) {
    return res.status(503).json({ ok: false, error: 'Backtester busy — try again in a moment.' });
  }
  _last.set(ip, now);
  _running++;
  try {
    const result = await runExpoBacktest(req.body || {});
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    _running--;
  }
});

module.exports = router;
