// ============================================================
// Backtest: SMC 3-Candle Strategy — Last 30 Days
// Uses exact same logic as smc-engine.js + trailing SL from cycle.js
// Run: node backtest.js
// ============================================================

const fetch = require('node-fetch');
const { getFetchOptions } = require('./proxy-agent');

// ── Strategy Parameters ─────────────────────────────────────
const SWING_LENGTHS = { '15m': 10, '3m': 10, '1m': 5 };
const MIN_24H_VOLUME = 10_000_000;
const DEFAULT_TP_PCT = 0.01;       // 1% TP (user default)
const DEFAULT_SL_PCT = 0.01;       // 1% SL (initial trailing)
const TRAILING_SL = {
  INITIAL_SL_PCT: 0.01,
  FIRST_STEP: 0.013,
  STEP_INCREMENT: 0.01,
};
const VWAP_PROXIMITY = 0.003;      // 0.3% proximity to key level
const WALLET = 1000;               // Starting wallet USDT
const RISK_PCT = 0.10;             // 10% of wallet per trade
const LEVERAGE = 20;
const MAX_POSITIONS = 3;
const SCAN_INTERVAL_CANDLES = 1;   // Check every 15m candle
const TOP_N_COINS = 20;            // Top coins by volume to scan
const DAYS = 30;

// ── Fetch Helpers ───────────────────────────────────────────
async function fetchKlines(symbol, interval, limit, endTime) {
  const params = `symbol=${symbol}&interval=${interval}&limit=${limit}` +
    (endTime ? `&endTime=${endTime}` : '');
  const url = `https://fapi.binance.com/fapi/v1/klines?${params}`;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { timeout: 15000, ...getFetchOptions() });
      if (res.ok) return res.json();
    } catch {}
    await sleep(1000);
  }
  return null;
}

async function fetchAllKlines(symbol, interval, startTime, endTime) {
  const all = [];
  let cursor = startTime;
  const limits = { '1m': 1500, '3m': 1500, '15m': 1500, '1d': 100 };
  const msPerCandle = { '1m': 60000, '3m': 180000, '15m': 900000, '1d': 86400000 };

  while (cursor < endTime) {
    const data = await fetchKlines(symbol, interval, limits[interval], endTime);
    if (!data || !data.length) break;

    // Filter to only candles in our range
    const filtered = data.filter(k => k[0] >= startTime && k[0] <= endTime);
    if (!filtered.length) break;

    // Actually we need to paginate properly
    break; // Just use single fetch for now
  }

  // Simpler: fetch max candles ending at endTime
  const data = await fetchKlines(symbol, interval, limits[interval], endTime);
  return data || [];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Swing Detection (same as smc-engine.js) ─────────────────
function detectSwings(klines, len) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const swings = [];
  let lastType = null;

  for (let i = len; i < klines.length - len; i++) {
    let isHigh = true;
    for (let j = -len; j <= len; j++) {
      if (j === 0) continue;
      if (highs[i] <= highs[i + j]) { isHigh = false; break; }
    }
    let isLow = true;
    for (let j = -len; j <= len; j++) {
      if (j === 0) continue;
      if (lows[i] >= lows[i + j]) { isLow = false; break; }
    }
    if (isHigh && isLow) {
      const highDist = highs[i] - Math.max(highs[i - 1], highs[i + 1]);
      const lowDist = Math.min(lows[i - 1], lows[i + 1]) - lows[i];
      if (highDist > lowDist) isLow = false; else isHigh = false;
    }
    if (isHigh) {
      if (lastType === 'high') {
        if (highs[i] > swings[swings.length - 1].price)
          swings[swings.length - 1] = { type: 'high', index: i, price: highs[i] };
      } else { swings.push({ type: 'high', index: i, price: highs[i] }); lastType = 'high'; }
    }
    if (isLow) {
      if (lastType === 'low') {
        if (lows[i] < swings[swings.length - 1].price)
          swings[swings.length - 1] = { type: 'low', index: i, price: lows[i] };
      } else { swings.push({ type: 'low', index: i, price: lows[i] }); lastType = 'low'; }
    }
  }
  return swings;
}

function getStructure(klines, len) {
  const swings = detectSwings(klines, len);
  const swingHighs = swings.filter(s => s.type === 'high');
  const swingLows = swings.filter(s => s.type === 'low');

  const highLabels = [];
  for (let i = 1; i < swingHighs.length; i++) {
    const label = swingHighs[i].price > swingHighs[i - 1].price ? 'HH' : 'LH';
    highLabels.push({ ...swingHighs[i], label });
  }
  const lowLabels = [];
  for (let i = 1; i < swingLows.length; i++) {
    const label = swingLows[i].price > swingLows[i - 1].price ? 'HL' : 'LL';
    lowLabels.push({ ...swingLows[i], label });
  }

  const lastHigh = highLabels.length ? highLabels[highLabels.length - 1] : null;
  const lastLow = lowLabels.length ? lowLabels[lowLabels.length - 1] : null;

  return {
    lastHigh, lastLow,
    hasLH: lastHigh?.label === 'LH',
    hasHL: lastLow?.label === 'HL',
    trend: (() => {
      if (!lastHigh || !lastLow) return 'neutral';
      if (lastHigh.label === 'LH' && lastLow.label === 'LL') return 'bearish';
      if (lastHigh.label === 'HH' && lastLow.label === 'HL') return 'bullish';
      return 'neutral';
    })(),
  };
}

// ── VWAP Bands ──────────────────────────────────────────────
function calcVWAPBands(klines) {
  let cumVolume = 0, cumTPV = 0, cumTPV2 = 0, currentDay = '';
  const values = [];
  for (const k of klines) {
    const day = new Date(parseInt(k[0])).toISOString().slice(0, 10);
    const high = parseFloat(k[2]), low = parseFloat(k[3]), close = parseFloat(k[4]), volume = parseFloat(k[5]);
    if (day !== currentDay) { cumVolume = 0; cumTPV = 0; cumTPV2 = 0; currentDay = day; }
    const tp = (high + low + close) / 3;
    cumTPV += tp * volume; cumTPV2 += tp * tp * volume; cumVolume += volume;
    if (cumVolume > 0) {
      const vwap = cumTPV / cumVolume;
      const sd = Math.sqrt(Math.max(0, (cumTPV2 / cumVolume) - vwap * vwap));
      values.push({ vwap, upper: vwap + sd, lower: vwap - sd });
    } else values.push({ vwap: close, upper: close, lower: close });
  }
  return values;
}

function isAtKeyLevel(price, pdh, pdl, vwapBands, direction) {
  const lastBand = vwapBands[vwapBands.length - 1];
  const nearPDH = Math.abs(price - pdh) / pdh < VWAP_PROXIMITY;
  const nearPDL = Math.abs(price - pdl) / pdl < VWAP_PROXIMITY;
  const nearUpper = Math.abs(price - lastBand.upper) / lastBand.upper < VWAP_PROXIMITY;
  const nearLower = Math.abs(price - lastBand.lower) / lastBand.lower < VWAP_PROXIMITY;
  const nearVWAP = Math.abs(price - lastBand.vwap) / lastBand.vwap < VWAP_PROXIMITY;

  if (direction === 'LONG') return nearLower || nearPDL || nearVWAP;
  return nearUpper || nearPDH || nearVWAP;
}

// ── Daily Bias (for PDH/PDL only) ───────────────────────────
function getDailyLevels(dailyKlines, idx) {
  if (idx < 1) return null;
  const prevDay = dailyKlines[idx - 1];
  return { pdh: parseFloat(prevDay[2]), pdl: parseFloat(prevDay[3]) };
}

// ── Main Backtest ───────────────────────────────────────────
async function runBacktest() {
  console.log('=== SMC 3-Candle Strategy Backtest ===');
  console.log(`Period: Last ${DAYS} days | Wallet: $${WALLET} | Leverage: ${LEVERAGE}x | Risk: ${RISK_PCT * 100}%`);
  console.log(`TP: ${DEFAULT_TP_PCT * 100}% | Initial SL: ${TRAILING_SL.INITIAL_SL_PCT * 100}% | Trailing: +${TRAILING_SL.FIRST_STEP * 100}% → +${TRAILING_SL.STEP_INCREMENT * 100}% steps`);
  console.log('');

  const endTime = Date.now();
  const startTime = endTime - DAYS * 86400000;

  // Step 1: Get top coins by volume
  console.log('Fetching top coins...');
  const tickerRes = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 15000, ...getFetchOptions() });
  const tickers = await tickerRes.json();
  const BLACKLIST = new Set(['USDCUSDT', 'ALPACAUSDT', 'BNXUSDT', 'XAUUSDT', 'XAGUSDT', 'EURUSDT', 'GBPUSDT', 'JPYUSDT']);
  const topCoins = tickers
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_') && !BLACKLIST.has(t.symbol))
    .filter(t => parseFloat(t.quoteVolume) >= MIN_24H_VOLUME)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, TOP_N_COINS)
    .map(t => t.symbol);

  console.log(`Top ${topCoins.length} coins: ${topCoins.join(', ')}`);
  console.log('');

  // Step 2: Fetch all historical data
  console.log('Fetching historical data (this takes a minute)...');
  const coinData = {};
  for (const symbol of topCoins) {
    process.stdout.write(`  ${symbol}...`);
    const [k15m, k3m, k1m, kDaily] = await Promise.all([
      fetchKlines(symbol, '15m', 1500, endTime),
      fetchKlines(symbol, '3m', 1500, endTime),
      fetchKlines(symbol, '1m', 1500, endTime),
      fetchKlines(symbol, '1d', 35, endTime),
    ]);

    if (k15m && k3m && k1m && kDaily) {
      coinData[symbol] = { k15m, k3m, k1m, kDaily };
      console.log(` ✓ (15m:${k15m.length} 3m:${k3m.length} 1m:${k1m.length} D:${kDaily.length})`);
    } else {
      console.log(' ✗ failed');
    }
    await sleep(300); // Rate limit
  }

  // Step 3: Walk through time and simulate
  console.log('\nRunning backtest...');

  let wallet = WALLET;
  const trades = [];
  const openPositions = [];
  let totalSignals = 0;
  let skippedMaxPos = 0;
  let skippedDuplicate = 0;

  // Walk through 15m candles as our scan interval
  // Use the first coin's 15m timestamps as the time axis
  const firstCoin = Object.keys(coinData)[0];
  if (!firstCoin) { console.log('No data fetched!'); return; }

  const timeSteps = coinData[firstCoin].k15m
    .map(k => parseInt(k[0]))
    .filter(t => t >= startTime);

  console.log(`Simulating ${timeSteps.length} time steps (15m intervals)...\n`);

  for (let step = 0; step < timeSteps.length; step++) {
    const now = timeSteps[step];

    // First: check open positions for SL/TP hits
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      const data = coinData[pos.symbol];
      if (!data) continue;

      // Find 1m candles in this 15m window
      const windowStart = step > 0 ? timeSteps[step - 1] : now - 900000;
      const candles1m = data.k1m.filter(k => parseInt(k[0]) >= windowStart && parseInt(k[0]) < now);

      for (const candle of candles1m) {
        const high = parseFloat(candle[2]);
        const low = parseFloat(candle[3]);
        const close = parseFloat(candle[4]);

        // Check SL hit
        if (pos.direction === 'LONG' && low <= pos.slPrice) {
          closeTrade(pos, pos.slPrice, 'SL', now);
          openPositions.splice(i, 1);
          break;
        }
        if (pos.direction === 'SHORT' && high >= pos.slPrice) {
          closeTrade(pos, pos.slPrice, 'SL', now);
          openPositions.splice(i, 1);
          break;
        }

        // Check TP hit
        if (pos.direction === 'LONG' && high >= pos.tpPrice) {
          closeTrade(pos, pos.tpPrice, 'TP', now);
          openPositions.splice(i, 1);
          break;
        }
        if (pos.direction === 'SHORT' && low <= pos.tpPrice) {
          closeTrade(pos, pos.tpPrice, 'TP', now);
          openPositions.splice(i, 1);
          break;
        }

        // Trailing SL update
        const profitPct = pos.direction === 'LONG'
          ? (close - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - close) / pos.entryPrice;

        const nextStep = pos.lastStep === 0 ? TRAILING_SL.FIRST_STEP : pos.lastStep + TRAILING_SL.STEP_INCREMENT;
        if (profitPct >= nextStep) {
          // Move SL to lock in profit at this step
          let reached = nextStep;
          while (profitPct >= reached + TRAILING_SL.STEP_INCREMENT) reached += TRAILING_SL.STEP_INCREMENT;
          pos.lastStep = reached;
          pos.slPrice = pos.direction === 'LONG'
            ? pos.entryPrice * (1 + reached - TRAILING_SL.STEP_INCREMENT)
            : pos.entryPrice * (1 - reached + TRAILING_SL.STEP_INCREMENT);
        }
      }
    }

    // Then: scan for new entries
    if (openPositions.length >= MAX_POSITIONS) continue;

    for (const symbol of Object.keys(coinData)) {
      if (openPositions.length >= MAX_POSITIONS) break;
      if (openPositions.find(p => p.symbol === symbol)) { skippedDuplicate++; continue; }

      const data = coinData[symbol];

      // Get candles up to current time
      const k15m = data.k15m.filter(k => parseInt(k[0]) <= now);
      const k3m = data.k3m.filter(k => parseInt(k[0]) <= now);
      const k1m = data.k1m.filter(k => parseInt(k[0]) <= now);

      if (k15m.length < 30 || k3m.length < 30 || k1m.length < 15) continue;

      // Step 1: 3-candle trend on 15M
      const last3 = k15m.slice(-4, -1);
      if (last3.length < 3) continue;

      let greenCount = 0, redCount = 0;
      for (const c of last3) {
        if (parseFloat(c[4]) > parseFloat(c[1])) greenCount++;
        else redCount++;
      }

      let direction = null;
      if (greenCount >= 2) direction = 'LONG';
      else if (redCount >= 2) direction = 'SHORT';
      if (!direction) continue;

      // Get PDH/PDL
      const dailyIdx = data.kDaily.findIndex(k => parseInt(k[0]) + 86400000 > now);
      const levels = dailyIdx > 0 ? getDailyLevels(data.kDaily, dailyIdx) : null;
      const price = parseFloat(k15m[k15m.length - 1][4]); // current close
      const pdh = levels?.pdh || price * 1.01;
      const pdl = levels?.pdl || price * 0.99;

      // Step 2: Key level check
      const vwapBands = calcVWAPBands(k15m);
      if (!isAtKeyLevel(price, pdh, pdl, vwapBands, direction)) continue;

      // Step 3: 3M setup
      const struct3m = getStructure(k3m, SWING_LENGTHS['3m']);
      const has3mSetup = (direction === 'LONG' && struct3m.hasHL) || (direction === 'SHORT' && struct3m.hasLH);
      if (!has3mSetup) continue;

      // Step 4: 1M entry
      const struct1m = getStructure(k1m, SWING_LENGTHS['1m']);
      const has1mEntry = (direction === 'LONG' && struct1m.hasHL) || (direction === 'SHORT' && struct1m.hasLH);
      if (!has1mEntry) continue;

      // Recency check
      const entrySwing = direction === 'LONG' ? struct1m.lastLow : struct1m.lastHigh;
      if (!entrySwing || (k1m.length - 1 - entrySwing.index) > 25) continue;

      // Volume check
      const volumes = k1m.slice(-20).map(k => parseFloat(k[5]));
      const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
      if (avgVol > 0 && recentVol / avgVol < 0.8) continue;

      // Signal found!
      totalSignals++;
      const tradeUsdt = wallet * RISK_PCT;
      const notional = tradeUsdt * LEVERAGE;
      const qty = notional / price;
      const slPrice = direction === 'LONG'
        ? price * (1 - TRAILING_SL.INITIAL_SL_PCT)
        : price * (1 + TRAILING_SL.INITIAL_SL_PCT);
      const tpPrice = direction === 'LONG'
        ? price * (1 + DEFAULT_TP_PCT)
        : price * (1 - DEFAULT_TP_PCT);

      const trade = {
        symbol, direction, entryPrice: price, qty, slPrice, tpPrice,
        lastStep: 0, entryTime: now, exitTime: null, exitPrice: null,
        exitReason: null, pnl: null,
      };

      openPositions.push(trade);
      trades.push(trade);
    }
  }

  // Close any remaining open positions at last price
  for (const pos of openPositions) {
    const data = coinData[pos.symbol];
    if (data && data.k1m.length > 0) {
      const lastPrice = parseFloat(data.k1m[data.k1m.length - 1][4]);
      closeTrade(pos, lastPrice, 'END', endTime);
    }
  }

  function closeTrade(pos, exitPrice, reason, time) {
    pos.exitPrice = exitPrice;
    pos.exitReason = reason;
    pos.exitTime = time;
    const pnl = pos.direction === 'LONG'
      ? (exitPrice - pos.entryPrice) * pos.qty
      : (pos.entryPrice - exitPrice) * pos.qty;
    pos.pnl = pnl;
    wallet += pnl;
  }

  // ── Results ─────────────────────────────────────────────────
  const closedTrades = trades.filter(t => t.pnl !== null);
  const wins = closedTrades.filter(t => t.pnl > 0);
  const losses = closedTrades.filter(t => t.pnl <= 0);
  const totalPnl = closedTrades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const maxDrawdown = (() => {
    let peak = WALLET, maxDD = 0, running = WALLET;
    for (const t of closedTrades) {
      running += t.pnl;
      if (running > peak) peak = running;
      const dd = (peak - running) / peak;
      if (dd > maxDD) maxDD = dd;
    }
    return maxDD;
  })();

  console.log('═══════════════════════════════════════════════════');
  console.log('                   BACKTEST RESULTS                ');
  console.log('═══════════════════════════════════════════════════');
  console.log(`Period:          ${new Date(startTime).toISOString().slice(0, 10)} → ${new Date(endTime).toISOString().slice(0, 10)}`);
  console.log(`Starting Wallet: $${WALLET.toFixed(2)}`);
  console.log(`Final Wallet:    $${wallet.toFixed(2)}`);
  console.log(`Total P&L:       ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${((totalPnl / WALLET) * 100).toFixed(1)}%)`);
  console.log(`Total Signals:   ${totalSignals}`);
  console.log(`Total Trades:    ${closedTrades.length}`);
  console.log(`Wins:            ${wins.length} (${closedTrades.length ? ((wins.length / closedTrades.length) * 100).toFixed(1) : 0}%)`);
  console.log(`Losses:          ${losses.length}`);
  console.log(`Avg Win:         +$${avgWin.toFixed(2)}`);
  console.log(`Avg Loss:        $${avgLoss.toFixed(2)}`);
  console.log(`Max Drawdown:    ${(maxDrawdown * 100).toFixed(1)}%`);
  console.log(`Skipped (dup):   ${skippedDuplicate}`);
  console.log('═══════════════════════════════════════════════════');

  // Show individual trades
  console.log('\n─── Trade Log ─────────────────────────────────────');
  console.log('Date       | Symbol        | Dir   | Entry      | Exit       | P&L       | Exit By');
  console.log('─'.repeat(95));
  for (const t of closedTrades) {
    const date = new Date(t.entryTime).toISOString().slice(5, 16).replace('T', ' ');
    const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
    console.log(
      `${date} | ${t.symbol.padEnd(13)} | ${t.direction.padEnd(5)} | $${t.entryPrice.toFixed(4).padStart(9)} | $${t.exitPrice.toFixed(4).padStart(9)} | ${pnlStr.padStart(9)} | ${t.exitReason}`
    );
  }

  // Show per-coin stats
  console.log('\n─── Per-Coin Summary ──────────────────────────────');
  const coinStats = {};
  for (const t of closedTrades) {
    if (!coinStats[t.symbol]) coinStats[t.symbol] = { wins: 0, losses: 0, pnl: 0 };
    if (t.pnl > 0) coinStats[t.symbol].wins++;
    else coinStats[t.symbol].losses++;
    coinStats[t.symbol].pnl += t.pnl;
  }
  const sortedCoins = Object.entries(coinStats).sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [sym, s] of sortedCoins) {
    const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(2)}` : `-$${Math.abs(s.pnl).toFixed(2)}`;
    console.log(`${sym.padEnd(13)} | W:${s.wins} L:${s.losses} | ${pnlStr}`);
  }

  // Weekly breakdown
  console.log('\n─── Weekly P&L ────────────────────────────────────');
  const weeklyPnl = {};
  for (const t of closedTrades) {
    const week = getWeekStr(t.entryTime);
    weeklyPnl[week] = (weeklyPnl[week] || 0) + t.pnl;
  }
  for (const [week, pnl] of Object.entries(weeklyPnl)) {
    const bar = pnl >= 0 ? '█'.repeat(Math.min(Math.round(pnl / 2), 40)) : '▓'.repeat(Math.min(Math.round(Math.abs(pnl) / 2), 40));
    console.log(`${week} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2).padStart(8)} | ${pnl >= 0 ? '🟢' : '🔴'} ${bar}`);
  }
}

function getWeekStr(ts) {
  const d = new Date(ts);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Run
runBacktest().catch(err => {
  console.error('Backtest error:', err);
  process.exit(1);
});
