'use strict';

const fetch = require('node-fetch');

const DEFAULT_HORIZON = Number(process.env.TIMEFM_HORIZON || 5);
const DEFAULT_MIN_MOVE_BPS = Number(process.env.TIMEFM_MIN_MOVE_BPS || 4);

function isEnabled() {
  return (process.env.TIMEFM_GATE_ENABLED || '0') !== '0';
}

function endpointUrl() {
  return process.env.TIMEFM_URL || process.env.GOOGLE_TIMEFM_URL || process.env.TIMEFM_ENDPOINT_URL || '';
}

function flattenForecast(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.forecast)) return json.forecast;
  if (Array.isArray(json.point_forecast)) return json.point_forecast;
  if (Array.isArray(json.predictions)) {
    const first = json.predictions[0];
    if (Array.isArray(first)) return first;
    if (Array.isArray(first?.forecast)) return first.forecast;
    if (Array.isArray(first?.point_forecast)) return first.point_forecast;
    if (Array.isArray(first?.outputs)) return first.outputs;
  }
  if (Array.isArray(json.output)) return json.output;
  if (Array.isArray(json.outputs)) return json.outputs;
  return [];
}

function normalizeDirection(value) {
  const v = String(value || '').trim().toUpperCase();
  if (['LONG', 'UP', 'BUY', 'BULL', 'BULLISH'].includes(v)) return 'LONG';
  if (['SHORT', 'DOWN', 'SELL', 'BEAR', 'BEARISH'].includes(v)) return 'SHORT';
  return null;
}

function directionFromForecast(values, lastPrice, minMoveBps) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length || !Number.isFinite(lastPrice) || lastPrice <= 0) {
    return { direction: null, moveBps: 0, reason: 'no numeric forecast' };
  }
  const take = nums.slice(Math.max(0, nums.length - 3));
  const target = take.reduce((a, b) => a + b, 0) / take.length;
  const moveBps = ((target - lastPrice) / lastPrice) * 10000;
  if (moveBps >= minMoveBps) return { direction: 'LONG', moveBps, target };
  if (moveBps <= -minMoveBps) return { direction: 'SHORT', moveBps, target };
  return { direction: null, moveBps, target, reason: 'forecast not clear' };
}

function buildPayload({ symbol, direction, candles, horizon }) {
  const closes = candles.map(c => Number(c.close)).filter(Number.isFinite);
  return {
    symbol,
    requested_direction: direction,
    interval: '1m',
    horizon,
    context: closes,
    timestamps: candles.map(c => c.time),
    instances: [{ values: closes, horizon }],
  };
}

async function checkTimefmDirection({ symbol, direction, candles }) {
  if (!isEnabled()) return { pass: true, skipped: true, reason: 'TimeFM gate disabled' };

  const url = endpointUrl();
  if (!url) {
    return { pass: false, reason: 'TimeFM endpoint not configured' };
  }

  const last = candles[candles.length - 1];
  const lastPrice = Number(last?.close);
  const horizon = DEFAULT_HORIZON;
  const minMoveBps = DEFAULT_MIN_MOVE_BPS;
  const headers = { 'content-type': 'application/json' };
  const token = process.env.TIMEFM_API_KEY || process.env.GOOGLE_TIMEFM_API_KEY || process.env.TIMEFM_BEARER_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  let json;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      timeout: Number(process.env.TIMEFM_TIMEOUT_MS || 8000),
      body: JSON.stringify(buildPayload({ symbol, direction, candles, horizon })),
    });
    if (!res.ok) return { pass: false, reason: `TimeFM HTTP ${res.status}` };
    json = await res.json();
  } catch (e) {
    return { pass: false, reason: `TimeFM error: ${e.message}` };
  }
  const stats = directionFromForecast(flattenForecast(json), lastPrice, minMoveBps);
  const forecastDir = normalizeDirection(json.direction || json.predicted_direction || json.bias) || stats.direction;
  if (!forecastDir) return { pass: false, reason: stats.reason || 'TimeFM unclear', moveBps: stats.moveBps };
  return {
    pass: forecastDir === direction,
    direction: forecastDir,
    moveBps: stats.moveBps,
    reason: forecastDir === direction ? 'TimeFM agrees' : `TimeFM says ${forecastDir}`,
  };
}

module.exports = { checkTimefmDirection };
