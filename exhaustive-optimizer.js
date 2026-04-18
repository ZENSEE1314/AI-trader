// ============================================================
// Exhaustive Strategy Optimizer — 24/7 Background Agent
//
// Genetic search across ALL indicator combinations on 4 tokens.
// Runs continuously, saving every result to DB.
// Goal: find parameter sets maximising win rate & total return.
//
// Metrics saved per strategy:
//   win_rate       = wins / total_trades × 100
//   profit_factor  = Σ winning_pnl / |Σ losing_pnl|
//   total_return   = compounded PnL from $10,000 start
//   max_drawdown   = largest peak→trough capital decline
//   expectancy     = (WR × avg_win) − ((1−WR) × avg_loss)
//   sharpe         = avg_return / std_dev_return × √(periods/yr)
// ============================================================

const fetch  = require('node-fetch');
const { log: bLog } = require('./bot-logger');
const { INDICATOR_LIB } = require('./agents/strategy-lab');

const SYMBOLS        = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const BACKTEST_DAYS  = 30;
const POPULATION     = 80;   // strategies per generation
const ELITE_KEEP     = 16;   // top strategies carried forward
const SAVE_EVERY_N   = 5;    // save to DB every N generations
const SLEEP_BETWEEN  = 200;  // ms between backtests (rate-limit guard)
const MAX_KLINES     = 1500; // Binance cap per request

// ── Parameter space — every combination is valid ─────────────
const SPACE = {
  ema_fast:    [5, 8, 9, 12, 13, 21],
  ema_slow:    [21, 26, 34, 50, 55, 100],
  ema_trend:   [100, 150, 200],
  rsi_period:  [7, 9, 14, 21],
  rsi_ob:      [65, 70, 75, 80],   // overbought → short zone
  rsi_os:      [20, 25, 30, 35],   // oversold → long zone
  atr_period:  [7, 14, 21],
  atr_sl:      [0.5, 0.8, 1.0, 1.5, 2.0],   // ATR multiplier for SL
  atr_tp:      [1.5, 2.0, 2.5, 3.0, 4.0],   // ATR multiplier for TP
  vol_min:     [1.0, 1.2, 1.5, 2.0],         // min volume vs MA20
  leverage:    [10, 15, 20],
  entry_type:  ['ema_cross', 'rsi_bounce', 'macd_cross',
                'engulfing', 'bb_bounce', 'structure_break'],
  session:     ['asia', 'europe', 'us', 'all'],
  trend_align: ['1h', '4h', 'none'],
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randomGenome() {
  return {
    ema_fast:    pick(SPACE.ema_fast),
    ema_slow:    pick(SPACE.ema_slow),
    ema_trend:   pick(SPACE.ema_trend),
    rsi_period:  pick(SPACE.rsi_period),
    rsi_ob:      pick(SPACE.rsi_ob),
    rsi_os:      pick(SPACE.rsi_os),
    atr_period:  pick(SPACE.atr_period),
    atr_sl:      pick(SPACE.atr_sl),
    atr_tp:      pick(SPACE.atr_tp),
    vol_min:     pick(SPACE.vol_min),
    leverage:    pick(SPACE.leverage),
    entry_type:  pick(SPACE.entry_type),
    session:     pick(SPACE.session),
    trend_align: pick(SPACE.trend_align),
  };
}

function mutate(genome) {
  const child = { ...genome };
  const keys = Object.keys(SPACE);
  // Mutate 1–3 random genes
  const numMutations = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < numMutations; i++) {
    const key = keys[Math.floor(Math.random() * keys.length)];
    child[key] = pick(SPACE[key]);
  }
  // Ensure fast < slow EMA
  if (child.ema_fast >= child.ema_slow) {
    child.ema_slow = SPACE.ema_slow.find(v => v > child.ema_fast) || 50;
  }
  return child;
}

function crossover(a, b) {
  const child = {};
  for (const key of Object.keys(SPACE)) {
    child[key] = Math.random() < 0.5 ? a[key] : b[key];
  }
  if (child.ema_fast >= child.ema_slow) {
    child.ema_slow = SPACE.ema_slow.find(v => v > child.ema_fast) || 50;
  }
  return child;
}

// ── Helpers ──────────────────────────────────────────────────

function calcATR(candles, period) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  // Simple ATR average
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function calcVolMA(volumes, period = 20) {
  if (volumes.length < period) return volumes[volumes.length - 1];
  return volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function isSession(utcHour, session) {
  if (session === 'all') return true;
  if (session === 'asia')   return utcHour >= 23 || utcHour < 2;
  if (session === 'europe') return utcHour >= 7  && utcHour < 10;
  if (session === 'us')     return utcHour >= 12 && utcHour < 16;
  return true;
}

function detectEntry(g, candles, idx) {
  const c = candles[idx];
  const closes = candles.slice(0, idx + 1).map(x => x.close);
  const volumes = candles.slice(0, idx + 1).map(x => x.volume);

  // Volume filter
  const volMA = calcVolMA(volumes, 20);
  if (c.volume < volMA * g.vol_min) return null;

  const emaF = INDICATOR_LIB.ema(closes, g.ema_fast);
  const emaS = INDICATOR_LIB.ema(closes, g.ema_slow);
  const rsi  = INDICATOR_LIB.rsi(closes, g.rsi_period);

  const curF = emaF[emaF.length - 1], prevF = emaF[emaF.length - 2];
  const curS = emaS[emaS.length - 1], prevS = emaS[emaS.length - 2];
  const curRsi = rsi[rsi.length - 1];

  // Trend filter
  const emaT = INDICATOR_LIB.ema(closes, Math.min(g.ema_trend, closes.length - 1));
  const curT = emaT[emaT.length - 1];

  switch (g.entry_type) {
    case 'ema_cross': {
      const crossUp   = prevF <= prevS && curF > curS && c.close > curT;
      const crossDown = prevF >= prevS && curF < curS && c.close < curT;
      if (crossUp   && curRsi < g.rsi_ob) return 'LONG';
      if (crossDown && curRsi > g.rsi_os) return 'SHORT';
      break;
    }
    case 'rsi_bounce': {
      const prevRsi = rsi[rsi.length - 2] || 50;
      if (prevRsi < g.rsi_os && curRsi > g.rsi_os && c.close > curT) return 'LONG';
      if (prevRsi > g.rsi_ob && curRsi < g.rsi_ob && c.close < curT) return 'SHORT';
      break;
    }
    case 'macd_cross': {
      const macdData = INDICATOR_LIB.macd(closes);
      if (!macdData || macdData.length < 2) break;
      const cur  = macdData[macdData.length - 1];
      const prev = macdData[macdData.length - 2];
      if (!cur || !prev) break;
      if (prev.histogram < 0 && cur.histogram > 0 && c.close > curT) return 'LONG';
      if (prev.histogram > 0 && cur.histogram < 0 && c.close < curT) return 'SHORT';
      break;
    }
    case 'engulfing': {
      if (idx === 0) break;
      const prev = candles[idx - 1];
      const bullEngulf = prev.close < prev.open && c.close > c.open &&
                         c.close > prev.open && c.open < prev.close && c.close > curT;
      const bearEngulf = prev.close > prev.open && c.close < c.open &&
                         c.open > prev.close && c.close < prev.open && c.close < curT;
      if (bullEngulf && curRsi < g.rsi_ob) return 'LONG';
      if (bearEngulf && curRsi > g.rsi_os) return 'SHORT';
      break;
    }
    case 'bb_bounce': {
      const bb = INDICATOR_LIB.bb ? INDICATOR_LIB.bb(closes, 20, 2) : null;
      if (!bb) break;
      const band = bb[bb.length - 1];
      if (!band) break;
      if (c.low < band.lower && c.close > band.lower && c.close > curT) return 'LONG';
      if (c.high > band.upper && c.close < band.upper && c.close < curT) return 'SHORT';
      break;
    }
    case 'structure_break': {
      const lookback = candles.slice(Math.max(0, idx - 10), idx);
      if (lookback.length < 5) break;
      const recentHigh = Math.max(...lookback.map(x => x.high));
      const recentLow  = Math.min(...lookback.map(x => x.low));
      if (c.close > recentHigh && c.close > curT && curRsi < g.rsi_ob) return 'LONG';
      if (c.close < recentLow  && c.close < curT && curRsi > g.rsi_os) return 'SHORT';
      break;
    }
  }
  return null;
}

// ── Core Backtest ─────────────────────────────────────────────
// Returns { wins, losses, totalReturn, maxDrawdown, profitFactor,
//           expectancy, sharpe, avgWin, avgLoss, totalTrades }

function runBacktest(g, candles) {
  const INITIAL_CAPITAL = 10000;
  let capital = INITIAL_CAPITAL;
  let peak = capital;
  let maxDrawdown = 0;

  let wins = 0, losses = 0;
  let totalWinPnl = 0, totalLossPnl = 0;
  const returns = [];
  const WINDOW = Math.max(g.ema_slow, g.ema_trend, g.rsi_period) + 5;

  for (let i = WINDOW; i < candles.length - 5; i++) {
    const c = candles[i];
    const utcHour = new Date(c.time).getUTCHours();
    if (!isSession(utcHour, g.session)) continue;

    const direction = detectEntry(g, candles, i);
    if (!direction) continue;

    const entry = c.close;
    const atr   = calcATR(candles.slice(Math.max(0, i - g.atr_period - 1), i + 1), g.atr_period);
    const sl    = direction === 'LONG' ? entry - atr * g.atr_sl : entry + atr * g.atr_sl;
    const tp    = direction === 'LONG' ? entry + atr * g.atr_tp : entry - atr * g.atr_tp;

    // Simulate outcome over next 5 candles
    let outcome = 'TIMEOUT';
    for (const fc of candles.slice(i + 1, i + 6)) {
      if (direction === 'LONG') {
        if (fc.low  <= sl) { outcome = 'LOSS'; break; }
        if (fc.high >= tp) { outcome = 'WIN';  break; }
      } else {
        if (fc.high >= sl) { outcome = 'LOSS'; break; }
        if (fc.low  <= tp) { outcome = 'WIN';  break; }
      }
    }
    if (outcome === 'TIMEOUT') {
      const lastClose = candles[Math.min(i + 5, candles.length - 1)].close;
      outcome = (direction === 'LONG' && lastClose > entry) ||
                (direction === 'SHORT' && lastClose < entry) ? 'WIN' : 'LOSS';
    }

    // PnL as % of entry, scaled by leverage, applied to capital
    const pricePct = outcome === 'WIN'
      ? Math.abs(tp - entry) / entry
      : Math.abs(sl - entry) / entry;
    const tradePnlPct = (outcome === 'WIN' ? 1 : -1) * pricePct * g.leverage;
    const tradePnl = capital * tradePnlPct;

    capital += tradePnl;
    if (capital <= 0) { capital = 0; break; }

    if (capital > peak) peak = capital;
    const dd = (peak - capital) / peak * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;

    returns.push(tradePnlPct * 100);

    if (outcome === 'WIN') { wins++; totalWinPnl  += Math.abs(tradePnl); }
    else                   { losses++; totalLossPnl += Math.abs(tradePnl); }
  }

  const totalTrades  = wins + losses;
  const winRate      = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const profitFactor = totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? 99 : 0;
  const totalReturn  = (capital - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const avgWin       = wins > 0   ? totalWinPnl  / wins   : 0;
  const avgLoss      = losses > 0 ? totalLossPnl / losses : 0;
  const expectancy   = totalTrades > 0
    ? (winRate / 100) * avgWin - ((1 - winRate / 100)) * avgLoss
    : 0;
  const avgRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdDev = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - avgRet) ** 2, 0) / (returns.length - 1))
    : 1;
  const sharpe = stdDev > 0 ? avgRet / stdDev * Math.sqrt(252 * 24 * 4) : 0; // 15m annualised

  return { wins, losses, totalTrades, winRate, profitFactor,
           totalReturn, maxDrawdown, expectancy, sharpe, avgWin, avgLoss };
}

// ── Kline Fetching ────────────────────────────────────────────

const _klineCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchCandles(symbol) {
  const key = symbol;
  const cached = _klineCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

  const limit = Math.min(BACKTEST_DAYS * 24 * 4, MAX_KLINES); // 15m candles
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=${limit}`;
  try {
    const res = await fetch(url, { timeout: 20000 });
    if (!res.ok) return null;
    const raw = await res.json();
    const candles = raw.map(k => ({
      time:   k[0],
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
    _klineCache.set(key, { data: candles, at: Date.now() });
    return candles;
  } catch { return null; }
}

// ── Scoring (fitness function) ────────────────────────────────
// Composite score: rewards high WR, high return, low drawdown, positive PF

function score(m) {
  if (m.totalTrades < 5) return -999; // not enough trades
  const wrScore   = m.winRate;                    // 0-100
  const retScore  = Math.min(m.totalReturn, 500); // cap at 500% to avoid outliers
  const pfScore   = Math.min(m.profitFactor, 10) * 10; // 0-100
  const ddPenalty = m.maxDrawdown;                // subtract drawdown
  const sharpe    = Math.min(m.sharpe, 5) * 5;   // 0-25
  return wrScore * 1.5 + retScore * 0.3 + pfScore * 0.5 + sharpe - ddPenalty * 0.5;
}

// ── DB Helpers ────────────────────────────────────────────────

let _db = null;
function getDB() {
  if (!_db) { try { _db = require('./db'); } catch (_) {} }
  return _db;
}

async function ensureTable() {
  const db = getDB();
  if (!db) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS strategy_search_results (
        id               SERIAL PRIMARY KEY,
        generation       INTEGER DEFAULT 0,
        genome           JSONB NOT NULL,
        symbol           VARCHAR(20),
        win_rate         DECIMAL(8,4),
        profit_factor    DECIMAL(8,4),
        total_return     DECIMAL(12,4),
        max_drawdown     DECIMAL(8,4),
        expectancy       DECIMAL(12,4),
        sharpe           DECIMAL(8,4),
        avg_win          DECIMAL(12,4),
        avg_loss         DECIMAL(12,4),
        total_trades     INTEGER,
        wins             INTEGER,
        losses           INTEGER,
        fitness          DECIMAL(12,4),
        tested_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_ssr_fitness ON strategy_search_results (fitness DESC)
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_ssr_winrate ON strategy_search_results (win_rate DESC)
    `);
  } catch (e) {
    bLog.error(`[Optimizer] ensureTable: ${e.message}`);
  }
}

async function saveResults(results, generation) {
  const db = getDB();
  if (!db || !results.length) return;
  try {
    for (const r of results) {
      await db.query(`
        INSERT INTO strategy_search_results
          (generation, genome, symbol, win_rate, profit_factor, total_return,
           max_drawdown, expectancy, sharpe, avg_win, avg_loss,
           total_trades, wins, losses, fitness, tested_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
      `, [
        generation,
        JSON.stringify(r.genome),
        r.symbol,
        r.metrics.winRate,
        r.metrics.profitFactor,
        r.metrics.totalReturn,
        r.metrics.maxDrawdown,
        r.metrics.expectancy,
        r.metrics.sharpe,
        r.metrics.avgWin,
        r.metrics.avgLoss,
        r.metrics.totalTrades,
        r.metrics.wins,
        r.metrics.losses,
        r.fitness,
      ]);
    }
    bLog.scan(`[Optimizer] Saved ${results.length} results (gen ${generation})`);
  } catch (e) {
    bLog.error(`[Optimizer] saveResults: ${e.message}`);
  }
}

// ── Main Evolution Loop ───────────────────────────────────────

let _running    = false;
let _generation = 0;
let _bestEver   = { fitness: -Infinity, winRate: 0, totalReturn: 0 };
let _totalTested = 0;

async function runGeneration(population) {
  // Fetch candles for all 4 symbols (cached)
  const candleMap = new Map();
  for (const sym of SYMBOLS) {
    const c = await fetchCandles(sym);
    if (c && c.length > 100) candleMap.set(sym, c);
  }
  if (!candleMap.size) return [];

  const results = [];

  for (const genome of population) {
    // Test across all available symbols, average metrics
    const symResults = [];
    for (const [sym, candles] of candleMap) {
      const metrics = runBacktest(genome, candles);
      const fit = score(metrics);
      symResults.push({ symbol: sym, metrics, fitness: fit });
      _totalTested++;
    }

    // Combined fitness = average across symbols (want strategy to work on ALL 4)
    const avgFitness = symResults.reduce((s, r) => s + r.fitness, 0) / symResults.length;

    // Track best result per symbol for saving
    for (const sr of symResults) {
      results.push({ genome, ...sr });
    }

    // Track all-time best
    const avgWR = symResults.reduce((s, r) => s + r.metrics.winRate, 0) / symResults.length;
    const avgRet = symResults.reduce((s, r) => s + r.metrics.totalReturn, 0) / symResults.length;
    if (avgFitness > _bestEver.fitness) {
      _bestEver = { fitness: avgFitness, winRate: avgWR, totalReturn: avgRet, genome };
      bLog.scan(
        `[Optimizer] 🏆 New best! Gen=${_generation} | ` +
        `WR=${avgWR.toFixed(1)}% | Return=${avgRet.toFixed(1)}% | ` +
        `Fitness=${avgFitness.toFixed(2)} | entry=${genome.entry_type} ` +
        `emaF=${genome.ema_fast}/S=${genome.ema_slow} RSI=${genome.rsi_period} ` +
        `sl=${genome.atr_sl}×ATR tp=${genome.atr_tp}×ATR lev=${genome.leverage}x`
      );
    }

    await new Promise(r => setTimeout(r, SLEEP_BETWEEN));
  }

  return results;
}

async function evolve() {
  await ensureTable();

  // Seed initial population
  let population = Array.from({ length: POPULATION }, randomGenome);

  while (_running) {
    _generation++;
    bLog.scan(`[Optimizer] Gen ${_generation} | Testing ${population.length} strategies on ${SYMBOLS.join('+')} | Total tested: ${_totalTested}`);

    const results = await runGeneration(population);

    // Save every N generations
    if (_generation % SAVE_EVERY_N === 0 && results.length) {
      await saveResults(results, _generation);
    }

    // Build next generation: keep elite + breed + random newcomers
    // Score each genome by average fitness across all symbols
    const genomeScores = new Map();
    for (const r of results) {
      const key = JSON.stringify(r.genome);
      if (!genomeScores.has(key)) genomeScores.set(key, { genome: r.genome, totalFit: 0, count: 0 });
      genomeScores.get(key).totalFit += r.fitness;
      genomeScores.get(key).count++;
    }
    const ranked = Array.from(genomeScores.values())
      .map(g => ({ genome: g.genome, avgFit: g.totalFit / g.count }))
      .sort((a, b) => b.avgFit - a.avgFit);

    const elite = ranked.slice(0, ELITE_KEEP).map(r => r.genome);

    // Next population: elites + crossover children + random
    const nextPop = [...elite];
    while (nextPop.length < POPULATION - 10) {
      const a = elite[Math.floor(Math.random() * elite.length)];
      const b = elite[Math.floor(Math.random() * elite.length)];
      nextPop.push(Math.random() < 0.6 ? crossover(a, b) : mutate(a));
    }
    // Random newcomers for diversity
    while (nextPop.length < POPULATION) nextPop.push(randomGenome());
    population = nextPop;

    bLog.scan(`[Optimizer] Gen ${_generation} done | Best ever: WR=${_bestEver.winRate.toFixed(1)}% Return=${_bestEver.totalReturn.toFixed(1)}%`);

    // Brief pause between generations so it doesn't hammer the server
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ── Public API ────────────────────────────────────────────────

function start() {
  if (_running) return;
  _running = true;
  bLog.scan('[Optimizer] Starting 24/7 exhaustive strategy search on BTC/ETH/SOL/BNB...');
  evolve().catch(e => {
    bLog.error(`[Optimizer] Fatal: ${e.message}`);
    _running = false;
  });
}

function stop()  { _running = false; }
function status() {
  return {
    running:     _running,
    generation:  _generation,
    totalTested: _totalTested,
    bestEver:    _bestEver,
  };
}

module.exports = { start, stop, status };
