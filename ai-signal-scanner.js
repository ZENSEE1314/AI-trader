// ============================================================
// AI Signal Scanner — Replaces hardcoded SMC strategy
//
// Uses the StrategyAgent's best discovered strategies to scan
// for live trading signals. Runs the top-performing strategies
// against real-time market data and produces trade signals.
//
// Signal flow:
//   1. Load best strategies from DB (discovered_strategies)
//   2. Fetch real-time klines for top coins
//   3. Run each elite strategy's scan function
//   4. Score signals by strategy win rate + Kronos AI
//   5. Return top signals for cycle.js to execute
// ============================================================

const fetch = require('node-fetch');
const aiLearner = require('./ai-learner');
const { log: bLog } = require('./bot-logger');
const { INDICATOR_LIB, recompileStrategy, RECIPE_TEMPLATES, compileStrategy } = require('./agents/strategy-lab');

const REQUEST_TIMEOUT = 15000;
const MIN_24H_VOLUME = 10_000_000;
const TOP_N_COINS = 10;
const MAX_SIGNALS = 3;

// Backtest results (backtest-smc-trailing.js — 7 days × 4 symbols):
//   TP 2.0% / SL 1% → 56.2% WR, PF 2.56, Net +61%  ← chosen
//   TP 1.5% / SL 1% → 62.6% WR, PF 2.51, Net +51%
//   TP 3.0% / SL 1% → 44.8% WR (below 50% — rejected)
//   Trailing SL      → 62.6% WR but only +42% net (worse than fixed TP in session windows)
// Hard-cap TP at 2.0% regardless of what any DB strategy stores.
const SMC_MAX_TP_PCT = 0.020;
const SMC_SL_PCT     = 0.010;

// SMC trades only these 5 symbols — no random altcoins
const SMC_WHITELIST = new Map([
  ['BTCUSDT', 100],
  ['ETHUSDT', 100],
  ['SOLUSDT',  20],
  ['BNBUSDT',  20],
  ['XRPUSDT',  50],
]);

// Cache compiled strategies — reload from DB every 5 min
let _cachedStrategies = [];
let _cacheLoadedAt = 0;
const CACHE_TTL = 300_000; // 5 min

// Fetch klines from Binance
async function fetchKlines(symbol, interval, limit = 100) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { timeout: REQUEST_TIMEOUT });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Load best AI-discovered strategies from DB
async function loadBestStrategies() {
  if (_cachedStrategies.length > 0 && Date.now() - _cacheLoadedAt < CACHE_TTL) {
    return _cachedStrategies;
  }

  const strategies = [];

  try {
    const { query } = require('./db');
    const rows = await query(
      `SELECT strategy_id, name, recipe, params, win_rate, total_pnl, total_trades
       FROM discovered_strategies
       WHERE is_active = true AND win_rate >= 55 AND total_trades >= 5
       ORDER BY win_rate DESC
       LIMIT 10`
    );

    for (const row of rows) {
      const params = typeof row.params === 'string' ? JSON.parse(row.params) : row.params;
      const recipe = RECIPE_TEMPLATES.find(r => r.type === row.recipe);
      if (!recipe || !params) continue;

      try {
        const scan = compileStrategy(recipe, params);
        strategies.push({
          id: row.strategy_id,
          name: row.name,
          recipe: row.recipe,
          params,
          scan,
          winRate: parseFloat(row.win_rate) || 0,
          totalPnl: parseFloat(row.total_pnl) || 0,
          totalTrades: parseInt(row.total_trades) || 0,
        });
      } catch {
        // Skip strategies that fail to compile
      }
    }

    bLog.scan(`AI Scanner: loaded ${strategies.length} elite strategies from DB`);
  } catch (err) {
    bLog.error(`AI Scanner: failed to load strategies — ${err.message}`);
  }

  // Also try to get strategies from StrategyAgent in memory
  try {
    const { getCoordinator } = require('./agents');
    const coordinator = getCoordinator();
    if (coordinator?.strategyAgent) {
      const pop = coordinator.strategyAgent._population || [];
      const elites = pop
        .filter(s => s.results && s.results.winRate >= 55 && s.results.totalTrades >= 5 && s.scan)
        .sort((a, b) => b.results.winRate - a.results.winRate)
        .slice(0, 5);

      for (const s of elites) {
        // Avoid duplicates
        if (!strategies.find(x => x.id === s.id)) {
          strategies.push({
            id: s.id,
            name: s.name,
            recipe: s.recipe,
            params: s.params,
            scan: s.scan,
            winRate: s.results.winRate,
            totalPnl: s.results.totalPnl,
            totalTrades: s.results.totalTrades,
          });
        }
      }
    }
  } catch {
    // Coordinator not available
  }

  _cachedStrategies = strategies;
  _cacheLoadedAt = Date.now();
  return strategies;
}

// Fetch top coins by volume
async function fetchTopCoins(n = TOP_N_COINS) {
  try {
    const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: REQUEST_TIMEOUT });
    if (!res.ok) return [];
    const tickers = await res.json();

    let bannedTokens = new Set();
    try {
      const { query } = require('./db');
      const rows = await query('SELECT symbol FROM global_token_settings WHERE banned = true');
      bannedTokens = new Set(rows.map(r => r.symbol));
    } catch {}

    const BLACKLIST = new Set([
      'ALPACAUSDT', 'BNXUSDT', 'ALPHAUSDT', 'BANANAS31USDT',
      'LYNUSDT', 'PORT3USDT', 'RVVUSDT', 'BSWUSDT',
      'NEIROETHUSDT', 'COSUSDT', 'YALAUSDT', 'TANSSIUSDT', 'EPTUSDT',
      'LEVERUSDT', 'AGLDUSDT', 'LOOKSUSDT', 'TRUUSDT',
      'XAUUSDT', 'XAGUSDT', 'EURUSDT', 'GBPUSDT', 'JPYUSDT',
      'ZECUSDT', 'RAVEUSDT', 'CLUSDT',
    ]);

    return tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .filter(t => !BLACKLIST.has(t.symbol) && !bannedTokens.has(t.symbol))
      .filter(t => parseFloat(t.quoteVolume) >= MIN_24H_VOLUME)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, n);
  } catch {
    return [];
  }
}

// ── EMA helper (used for per-coin EMA200 bias) ──────────────
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
  return ema;
}

// Main AI scan — replaces scanSMC
async function scanAI(log, opts = {}) {
  // ── Session gate: only trade during institutional opens ──
  const {
    checkDailyLimits,
    isAvoidTime,
    getActiveSession,
  } = require('./liquidity-sweep-engine');

  const limits = checkDailyLimits();
  if (!limits.canTrade) {
    bLog.scan(`AI Scanner: ${limits.reason}`);
    return [];
  }

  if (isAvoidTime()) {
    bLog.scan('AI Scanner: avoid candle-open minute — skipping this cycle');
    return [];
  }

  const activeSession = getActiveSession();
  if (!activeSession) {
    bLog.scan('AI Scanner: outside institutional session window — skipping this cycle');
    return [];
  }
  bLog.scan(`AI Scanner: session=${activeSession.name} ✓`);

  // Check AI-learned hour
  const hourCheck = await aiLearner.shouldTradeNow();
  if (!hourCheck.trade) {
    bLog.scan(`AI Scanner: ${hourCheck.reason} — skipping this cycle`);
    return [];
  }

  // Load strategies
  const strategies = await loadBestStrategies();
  if (strategies.length === 0) {
    // No elite strategies in DB yet — agents still building their history.
    // Fall back to the classic hardcoded SMC scanner so trading doesn't stop.
    bLog.scan('AI Scanner: no elite strategies yet — running classic SMC fallback');
    try {
      const { scanSMC } = require('./liquidity-sweep-engine');
      return await scanSMC(msg => bLog.scan(msg), { topNCoins: opts.topNCoins || TOP_N_COINS });
    } catch (err) {
      bLog.error(`SMC fallback error: ${err.message}`);
      return [];
    }
  }

  bLog.scan(`AI Scanner: ${strategies.length} strategies loaded (best: ${strategies[0]?.name} ${strategies[0]?.winRate?.toFixed(1)}% WR)`);

  // Always scan only the 4 watchlist coins — fetch prices individually (fast, no bulk ticker)
  const watchSymbols = Array.from(SMC_WHITELIST.keys()); // ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT']
  const topCoins = [];
  for (const sym of watchSymbols) {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`, { timeout: 8000 });
      if (res.ok) {
        const data = await res.json();
        topCoins.push({ symbol: sym, lastPrice: data.price, quoteVolume: '999999999' });
      }
    } catch {}
  }
  bLog.scan(`AI Scanner: scanning ${topCoins.map(t => t.symbol.replace('USDT', '')).join(', ')}`);

  if (topCoins.length === 0) {
    bLog.error('AI Scanner: failed to fetch prices for watchlist coins');
    return [];
  }

  const results = [];
  let analyzed = 0;

  // Only scan the 4 whitelisted SMC symbols — filter out everything else
  const smcCoins = topCoins.filter(t => SMC_WHITELIST.has(t.symbol));
  if (smcCoins.length === 0) {
    // Fallback: build coin list directly from whitelist if not in top volume list
    for (const [sym] of SMC_WHITELIST) {
      try {
        const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`, { timeout: 8000 });
        if (res.ok) {
          const d = await res.json();
          smcCoins.push({ symbol: sym, lastPrice: d.price, quoteVolume: '999999999' });
        }
      } catch {}
    }
  }
  bLog.scan(`AI Scanner: SMC whitelist — scanning ${smcCoins.map(t => t.symbol.replace('USDT','')).join(', ')}`);

  for (const ticker of smcCoins) {
    const symbol = ticker.symbol;
    const price = parseFloat(ticker.lastPrice);

    // Check if AI says to avoid this coin
    if (await aiLearner.shouldAvoidCoin(symbol)) continue;

    // Fetch klines for scanning (use 15m as primary, 3m for confirmation)
    const [klines15m, klines3m] = await Promise.all([
      fetchKlines(symbol, '15m', 200),
      fetchKlines(symbol, '3m', 100),
    ]);

    if (!klines15m || klines15m.length < 60) continue;
    analyzed++;

    const closes15m = klines15m.map(k => parseFloat(k[4]));
    const highs15m = klines15m.map(k => parseFloat(k[2]));
    const lows15m = klines15m.map(k => parseFloat(k[3]));

    // EMA200 bias — hard directional filter (no shorts above EMA200, no longs below)
    let ema200Bias = null;
    if (closes15m.length >= 50) {
      const ema200Period = Math.min(200, closes15m.length - 1);
      const ema200Val = calcEMA(closes15m, ema200Period);
      ema200Bias = price > ema200Val ? 'bullish' : 'bearish';
      bLog.scan(`${symbol}: EMA${ema200Period}(15m)=$${ema200Val.toFixed(4)} price=$${price} bias=${ema200Bias}`);
    }

    // Run each strategy on this symbol
    for (const strat of strategies) {
      try {
        const i = closes15m.length - 1;
        const signal = strat.scan(closes15m, highs15m, lows15m, i);
        if (!signal) continue;

        // Hard EMA200 filter: no longs below EMA200, no shorts above EMA200
        if (ema200Bias === 'bullish' && signal === 'SHORT') {
          bLog.scan(`${symbol}: SHORT blocked — price above EMA200 (bullish bias)`);
          continue;
        }
        if (ema200Bias === 'bearish' && signal === 'LONG') {
          bLog.scan(`${symbol}: LONG blocked — price below EMA200 (bearish bias)`);
          continue;
        }

        // Anti-chase filter: if price already moved >1.2% in the signal direction
        // in the last 3 candles, the move is extended — don't chase it
        {
          const lastIdx = closes15m.length - 1;
          const lookback = Math.max(0, lastIdx - 3);
          const pastClose = closes15m[lookback];
          const momentum = (closes15m[lastIdx] - pastClose) / pastClose;
          const MAX_MOMENTUM = 0.012; // 1.2% in 3 candles
          if (signal === 'LONG' && momentum > MAX_MOMENTUM) {
            bLog.scan(`${symbol}: LONG blocked — already rallied ${(momentum*100).toFixed(2)}% in last 3 candles (chasing)`);
            continue;
          }
          if (signal === 'SHORT' && momentum < -MAX_MOMENTUM) {
            bLog.scan(`${symbol}: SHORT blocked — already dropped ${(Math.abs(momentum)*100).toFixed(2)}% in last 3 candles (chasing)`);
            continue;
          }
        }

        // Range position filter — NEVER buy at the top, NEVER short at the bottom
        // LONG only in bottom 35% of the last 5h range (HL/LL zone)
        // SHORT only in top 65%+ of range (HH/LH zone)
        {
          const recent20High = Math.max(...highs15m.slice(-20));
          const recent20Low  = Math.min(...lows15m.slice(-20));
          const rangeSize    = recent20High - recent20Low;
          const priceInRange = rangeSize > 0 ? (price - recent20Low) / rangeSize : 0.5;

          if (signal === 'LONG' && priceInRange > 0.80) {
            bLog.scan(`${symbol}: LONG blocked — price at ${(priceInRange*100).toFixed(0)}% of 5h range (top — wait for HL pullback)`);
            continue;
          }
          if (signal === 'SHORT' && priceInRange < 0.20) {
            bLog.scan(`${symbol}: SHORT blocked — price at ${(priceInRange*100).toFixed(0)}% of 5h range (bottom — wait for LH bounce)`);
            continue;
          }
        }

        // TP capped at 1.5% — backtest proves lower TP → 55% WR vs 33% WR at 3%
        // DB strategies may carry stale tp_pct=0.03; override enforced here.
        const slPct = SMC_SL_PCT;
        const tpPct = Math.min(strat.params.tp_pct || SMC_MAX_TP_PCT, SMC_MAX_TP_PCT);
        const isLong = signal === 'LONG';

        const sl = isLong ? price * (1 - slPct) : price * (1 + slPct);
        const tp = isLong ? price * (1 + tpPct) : price * (1 - tpPct);
        const slDist = slPct;

        // Score based on strategy win rate + confidence
        let score = 10;
        score += (strat.winRate - 50) / 5; // +1 per 5% above 50% WR
        if (strat.totalTrades >= 20) score += 2; // well-tested bonus
        if (strat.totalPnl > 10) score += 2;     // profitable strategy bonus

        // 3m confirmation — run strategy on 3m data too if available
        if (klines3m && klines3m.length >= 60) {
          const closes3m = klines3m.map(k => parseFloat(k[4]));
          const highs3m = klines3m.map(k => parseFloat(k[2]));
          const lows3m = klines3m.map(k => parseFloat(k[3]));
          try {
            const confirm = strat.scan(closes3m, highs3m, lows3m, closes3m.length - 1);
            if (confirm === signal) score += 3; // multi-TF agreement
            else if (confirm && confirm !== signal) score -= 5; // conflicting TFs
          } catch {}
        }

        // Kronos AI prediction
        let kronosData = null;
        if (opts.kronosPredictions && opts.kronosPredictions.has(symbol)) {
          kronosData = opts.kronosPredictions.get(symbol);
          if (!kronosData.error) {
            if (kronosData.direction === signal) {
              score += kronosData.confidence === 'high' ? 5 : kronosData.confidence === 'medium' ? 3 : 1;
            } else if (kronosData.direction !== 'NEUTRAL') {
              score -= kronosData.confidence === 'high' ? 6 : kronosData.confidence === 'medium' ? 3 : 1;
            }
          }
        }

        // AI modifier from learning history
        const setup = `AI_${strat.recipe || 'unknown'}`.toUpperCase();
        const aiMod = await aiLearner.getAIScoreModifier(symbol, setup, signal);
        score *= aiMod;

        // Hour size modifier
        const sizeMod = hourCheck.reduceSizeBy || hourCheck.boostSizeBy || 1.0;

        // Leverage from SMC whitelist: BTC/ETH=100x, SOL/BNB=20x
        const leverage = SMC_WHITELIST.get(symbol) || 20;

        if (score >= 8) {
          results.push({
            symbol,
            direction: signal,
            price,
            lastPrice: price,
            sl,
            tp1: tp,
            tp2: tp,
            tp3: tp,
            slDist,
            leverage,
            score: Math.round(score * 10) / 10,
            setup,
            setupName: `AI-${strat.recipe}`,
            aiModifier: Math.round(aiMod * 100) / 100,
            sizeMod,
            ema200Bias,
            marketStructure: `AI:${strat.name.slice(0, 30)}`,
            strategyId: strat.id,
            strategyName: strat.name,
            strategyWinRate: strat.winRate,
            structure: {
              strategy: strat.recipe,
              winRate: strat.winRate,
            },
            kronos: kronosData ? {
              direction: kronosData.direction,
              change_pct: kronosData.change_pct,
              confidence: kronosData.confidence,
              trend: kronosData.trend,
            } : null,
          });

          bLog.scan(
            `AI SIGNAL: ${symbol} ${signal} | strategy=${strat.name} (${strat.winRate.toFixed(1)}% WR) ` +
            `| SL=$${sl.toFixed(4)} TP=$${tp.toFixed(4)} | score=${score.toFixed(1)}`
          );
        }
      } catch (err) {
        // Strategy scan error — skip silently
      }
    }

    await new Promise(r => setTimeout(r, 150));
  }

  bLog.scan(`AI Scan complete: ${analyzed} coins × ${strategies.length} strategies = ${results.length} signals`);

  // Sort by score and return top signals
  results.sort((a, b) => b.score - a.score);

  // Deduplicate: only one signal per symbol (best strategy wins)
  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    if (!seen.has(r.symbol)) {
      seen.add(r.symbol);
      deduped.push(r);
    }
  }

  // Prioritize monitored tokens — they go first, then fill remaining with others
  const monSet = new Set(opts.monitoredSymbols || []);
  const monitoredSignals = deduped.filter(s => monSet.has(s.symbol));
  const otherSignals = deduped.filter(s => !monSet.has(s.symbol));
  const finalSignals = [...monitoredSignals, ...otherSignals].slice(0, Math.max(MAX_SIGNALS, monitoredSignals.length));

  if (monitoredSignals.length > 0) {
    bLog.scan(`AI Scanner: ${monitoredSignals.length} monitored signals prioritized (${monitoredSignals.map(s => s.symbol.replace('USDT','')).join(', ')})`);
  }

  return finalSignals;
}

// Force reload strategies (called after optimizer applies new strategy)
function clearStrategyCache() {
  _cachedStrategies = [];
  _cacheLoadedAt = 0;
}

module.exports = {
  scanAI,
  loadBestStrategies,
  clearStrategyCache,
};
