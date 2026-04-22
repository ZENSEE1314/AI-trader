// ============================================================
// Strategy Runner
//
// Loads strategy definitions from the `strategy_definitions`
// DB table, runs enabled indicators for each symbol, and emits
// signals in the same format cycle.js expects.
//
// Built-in hardcoded scanners (smc-engine, tjunction, etc.) run
// in parallel with DB-defined strategies. Disable a built-in
// strategy in the admin UI to hand full control to a DB definition.
// ============================================================

const { log: bLog }   = require('./bot-logger');
const { fetchKlines, fetchNeededBars, gates, signals, filters } = require('./indicator-library');

const FETCH_TIMEOUT   = 15000;
const MIN_24H_VOLUME  = 10_000_000;
const TOP_N_COINS     = 15;

// ── Strategy cache (reload every 60 s) ───────────────────────
let _stratCache    = null;
let _stratCacheTs  = 0;
const STRAT_TTL    = 60_000;

async function loadEnabledStrategies() {
  if (_stratCache && Date.now() - _stratCacheTs < STRAT_TTL) return _stratCache;
  try {
    const db   = require('./db');
    const rows = await db.query(
      `SELECT id, name, description, is_builtin, config
       FROM strategy_definitions
       WHERE is_enabled = true
       ORDER BY id`
    );
    _stratCache   = rows;
    _stratCacheTs = Date.now();
    return rows;
  } catch (err) {
    bLog.error(`strategy-runner: failed to load strategies: ${err.message}`);
    return _stratCache || [];
  }
}

function invalidateStratCache() { _stratCache = null; _stratCacheTs = 0; }

// ── Top Coins Fetch ───────────────────────────────────────────

async function fetchTopCoins(symbols) {
  // If the strategy defines specific symbols, use those directly
  if (symbols && symbols.length > 0) {
    return symbols.map(s => ({ symbol: s, lastPrice: '0', quoteVolume: '999999999' }));
  }
  try {
    const res = await require('node-fetch')('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: FETCH_TIMEOUT });
    if (!res.ok) return [];
    const tickers = await res.json();
    const BLACKLIST = new Set([
      'ALPACAUSDT','BNXUSDT','ALPHAUSDT','BANANAS31USDT','LYNUSDT','PORT3USDT',
      'RVVUSDT','BSWUSDT','NEIROETHUSDT','COSUSDT','YALAUSDT','TANSSIUSDT',
      'EPTUSDT','LEVERUSDT','AGLDUSDT','LOOKSUSDT','TRUUSDT',
      'XAUUSDT','XAGUSDT','EURUSDT','GBPUSDT','JPYUSDT',
    ]);
    return tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_') && !BLACKLIST.has(t.symbol))
      .filter(t => parseFloat(t.quoteVolume) >= MIN_24H_VOLUME)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, TOP_N_COINS);
  } catch {
    return [];
  }
}

// ── Run a single strategy against a single symbol ────────────

async function runStrategy(stratDef, symbol, price) {
  const cfg = typeof stratDef.config === 'string' ? JSON.parse(stratDef.config) : stratDef.config;
  const ic  = cfg.indicators || {};
  const tf  = cfg.timeframe || '1m';

  // ── 1. Gates (time windows) ─────────────────────────────────
  if (ic.session_gate?.enabled) {
    if (!gates.checkSessionGate(ic.session_gate).pass) return null;
  }
  if (ic.prime_session?.enabled) {
    if (!gates.checkPrimeSession(ic.prime_session).pass) return null;
  }

  // ── 2. Fetch candles for all needed timeframes ──────────────
  const barsMap = await fetchNeededBars(symbol, ic);
  const bars    = barsMap[tf] || barsMap['1m'];
  if (!bars || bars.length < 20) return null;

  // ── 3. Signal Indicators (determine direction + entry) ──────
  let direction = null;
  let signalSl  = null;
  let signalEntry = null;

  // Priority order: hl_structure → spike_hl → ma_stack → tjunction
  if (ic.hl_structure?.enabled && !direction) {
    const r = signals.checkHLStructure(barsMap, ic.hl_structure);
    if (!r) return null;
    direction   = r.direction;
    signalSl    = r.sl;
    signalEntry = price;
  }

  if (ic.spike_hl?.enabled && !direction) {
    const r = signals.checkSpikeHL(barsMap[tf] || bars, ic.spike_hl);
    if (!r) return null;
    direction   = r.direction;
    signalSl    = r.sl;
    signalEntry = r.entry;
  }

  if (ic.ma_stack?.enabled && !direction) {
    const r = signals.checkMAStack(barsMap[tf] || bars, ic.ma_stack);
    if (!r) return null;
    direction = r.direction;
  }

  if (ic.tjunction?.enabled && !direction) {
    const r = signals.checkTJunction(barsMap[tf] || bars, ic.tjunction);
    if (!r) return null;
    direction = r.direction;
  }

  if (!direction) return null; // no signal indicator fired

  const entry = signalEntry || price;

  // ── 4. Filter Indicators ────────────────────────────────────
  let score   = 10;

  if (ic.ema_filter?.enabled) {
    const htf   = ic.ema_filter.htf || '1h';
    const htfBars = barsMap[htf] || await fetchKlines(symbol, htf, 210);
    const r = filters.checkEMAFilter(htfBars, ic.ema_filter, direction);
    if (!r.pass) return null;
    score += r.penalty;
  }

  if (ic.vwap_filter?.enabled) {
    const r = filters.checkVWAP(bars, ic.vwap_filter, direction);
    if (!r.pass) return null;
  }

  if (ic.vol_filter?.enabled) {
    const r = filters.checkVolume(bars, ic.vol_filter);
    if (!r.pass) return null;
  }

  if (ic.atr_gate?.enabled) {
    const r = filters.checkATRGate(bars, ic.atr_gate);
    if (!r.pass) return null;
  }

  if (ic.candle_dir?.enabled) {
    const sigBar = bars[bars.length - 1];
    const r = filters.checkCandleDir(sigBar, direction);
    if (!r.pass) return null;
  }

  if (ic.rsi_filter?.enabled) {
    const r = filters.checkRSIFilter(bars, ic.rsi_filter, direction);
    if (!r.pass) return null;
  }

  // ── 5. Build signal ─────────────────────────────────────────
  const slPct   = cfg.sl_pct || 0.01;
  const tpMult  = cfg.tp_multiplier || 2.0;
  const sizePct = cfg.size_pct || 0.10;
  const trailSt = cfg.trailing_step || 0;

  // Use signal-provided SL if available, otherwise fallback to strategy sl_pct
  const sl = signalSl != null ? signalSl
    : direction === 'LONG'  ? entry * (1 - slPct)
    : entry * (1 + slPct);
  const slDist = Math.abs(entry - sl) / entry;
  const tp = direction === 'LONG' ? entry + (entry - sl) * tpMult : entry - (sl - entry) * tpMult;

  // Leverage: high-cap coins 100×, mid 50×, others 20×
  const HIGH_CAP = new Set(['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT']);
  const leverage = HIGH_CAP.has(symbol) ? 100 : parseFloat(price) >= 10 ? 50 : 20;

  return {
    symbol,
    direction,
    price: entry,
    lastPrice: entry,
    sl,
    tp1: tp, tp2: tp, tp3: tp,
    slDist,
    leverage,
    score,
    setupName: `${stratDef.name}-${direction}`,
    strategyWinRate: score >= 15 ? 70 : 60,
    sizeMod: 1.0,
    trailingStep: trailSt || undefined,
    strategyId: stratDef.id,
  };
}

// ── Main Scan ─────────────────────────────────────────────────

async function scan(log, opts = {}) {
  const strategies = await loadEnabledStrategies();
  if (!strategies.length) return [];

  const allSignals = [];

  for (const stratDef of strategies) {
    const cfg     = typeof stratDef.config === 'string' ? JSON.parse(stratDef.config) : stratDef.config;
    const symbols = cfg.symbols || [];
    const coins   = await fetchTopCoins(symbols);

    bLog.scan(`Strategy Runner [${stratDef.name}]: scanning ${coins.length} symbols`);

    for (const ticker of coins) {
      try {
        const price  = parseFloat(ticker.lastPrice) || 0;
        const signal = await runStrategy(stratDef, ticker.symbol, price);
        if (signal) {
          allSignals.push(signal);
          bLog.scan(`  SIGNAL: ${ticker.symbol} ${signal.direction} score=${signal.score} [${stratDef.name}]`);
        }
        await new Promise(r => setTimeout(r, 150)); // rate-limit
      } catch (err) {
        bLog.error(`Strategy Runner [${stratDef.name}] ${ticker.symbol}: ${err.message}`);
      }
    }
  }

  return allSignals;
}

module.exports = { scan, loadEnabledStrategies, invalidateStratCache };
