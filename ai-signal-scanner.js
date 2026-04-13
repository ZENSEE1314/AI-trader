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
       WHERE is_active = true AND win_rate >= 50 AND total_trades >= 5
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

// Main AI scan — replaces scanSMC
async function scanAI(log, opts = {}) {
  // Check daily limits
  const { checkDailyLimits } = require('./smc-engine');
  const limits = checkDailyLimits();
  if (!limits.canTrade) {
    log(`AI Scanner: ${limits.reason}`);
    return [];
  }

  // Check AI-learned hour
  const hourCheck = await aiLearner.shouldTradeNow();
  if (!hourCheck.trade) {
    bLog.scan(`AI Scanner: ${hourCheck.reason} — skipping this cycle`);
    return [];
  }

  // Load strategies
  const strategies = await loadBestStrategies();
  if (strategies.length === 0) {
    bLog.scan('AI Scanner: no elite strategies available yet — agents still learning');
    return [];
  }

  bLog.scan(`AI Scanner: ${strategies.length} strategies loaded (best: ${strategies[0]?.name} ${strategies[0]?.winRate?.toFixed(1)}% WR)`);

  // Fetch top coins — prioritize monitored tokens (dedicated agents)
  let topCoins;
  if (opts.monitoredSymbols && opts.monitoredSymbols.length > 0) {
    // Scan monitored tokens first, then fill remaining slots with top volume coins
    const monSet = new Set(opts.monitoredSymbols);
    const allCoins = await fetchTopCoins(Math.max(opts.topNCoins || TOP_N_COINS, 100));
    const monitored = allCoins.filter(t => monSet.has(t.symbol));
    const others = allCoins.filter(t => !monSet.has(t.symbol));

    // Monitored tokens that weren't in the ticker list — fetch prices individually
    const missingSymbols = opts.monitoredSymbols.filter(s => !monitored.find(t => t.symbol === s));
    for (const sym of missingSymbols) {
      try {
        const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`, { timeout: 8000 });
        if (res.ok) {
          const data = await res.json();
          monitored.push({ symbol: sym, lastPrice: data.price, quoteVolume: '999999999' });
        }
      } catch {}
    }

    // Monitored tokens go first, then fill remaining slots
    const maxOthers = Math.max(0, (opts.topNCoins || TOP_N_COINS) - monitored.length);
    topCoins = [...monitored, ...others.slice(0, maxOthers)];
    bLog.scan(`AI Scanner: ${monitored.length} monitored + ${Math.min(others.length, maxOthers)} others = ${topCoins.length} coins`);
  } else {
    topCoins = await fetchTopCoins(opts.topNCoins || TOP_N_COINS);
  }

  if (topCoins.length === 0) {
    bLog.error('AI Scanner: failed to fetch tickers');
    return [];
  }

  const results = [];
  let analyzed = 0;

  for (const ticker of topCoins) {
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

    // Run each strategy on this symbol
    for (const strat of strategies) {
      try {
        const i = closes15m.length - 1;
        const signal = strat.scan(closes15m, highs15m, lows15m, i);
        if (!signal) continue;

        // Calculate SL/TP from strategy params
        const slPct = strat.params.sl_pct || 0.01;
        const tpPct = strat.params.tp_pct || 0.015;
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

        // Leverage based on price tier
        const HIGH_PRICE = new Set(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'AAVEUSDT', 'MKRUSDT', 'BCHUSDT', 'LTCUSDT']);
        let leverage;
        if (HIGH_PRICE.has(symbol) || price >= 100) leverage = 100;
        else if (price >= 10) leverage = 50;
        else leverage = 20;

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

  return deduped.slice(0, MAX_SIGNALS);
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
