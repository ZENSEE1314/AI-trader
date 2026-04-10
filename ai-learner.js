// ============================================================
// AI Self-Learning Engine
// Tracks trade outcomes, learns patterns, adapts parameters
// Storage: Neon PostgreSQL (persistent across deploys)
// ============================================================

const { query, initAllTables } = require('./db');

// ── Constants ────────────────────────────────────────────────

const MIN_TRADES_FOR_LEARNING = 20;
const RECALC_INTERVAL = 10;
const MAX_WEIGHT_SHIFT = 0.05;
const EMA_ALPHA = 0.3;
let lastVersionTradeCount = 0;

// ── Current Session Detection ────────────────────────────────

function getCurrentSession() {
  const utcH = new Date().getUTCHours();
  if (utcH >= 23 || utcH <= 2) return 'asia';
  if (utcH >= 7 && utcH <= 10) return 'asia_europe';
  if (utcH >= 12 && utcH <= 16) return 'europe_us';
  return 'off_hours';
}

// ── Record a Completed Trade ─────────────────────────────────

async function recordTrade(data) {
  await initAllTables();
  const isWin = data.pnlPct > 0 ? 1 : 0;
  await query(
    `INSERT INTO ai_trades (
      symbol, direction, setup, entry_price, exit_price, pnl_pct, is_win,
      leverage, duration_min, session, rsi_at_entry, atr_pct, vol_ratio,
      sentiment_score, bb_position, score_at_entry, sl_distance_pct,
      tp_distance_pct, trend_1h, market_structure, closed_at,
      tf_15m, tf_3m, tf_1m, exit_reason
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
    [
      data.symbol, data.direction, data.setup, data.entryPrice,
      data.exitPrice || null, data.pnlPct || 0, isWin,
      data.leverage || 20, data.durationMin || 0,
      data.session || getCurrentSession(),
      data.rsiAtEntry || null, data.atrPct || null, data.volRatio || null,
      data.sentimentScore || null, data.bbPosition || null,
      data.scoreAtEntry || null, data.slDistancePct || null,
      data.tpDistancePct || null, data.trend1h || null,
      data.marketStructure || null, new Date().toISOString(),
      data.tf15m || null, data.tf3m || null, data.tf1m || null,
      data.exitReason || null,
    ]
  );

  const countRes = await query('SELECT COUNT(*) as c FROM ai_trades WHERE pnl_pct IS NOT NULL');
  const totalTrades = parseInt(countRes[0].c);
  if (totalTrades >= MIN_TRADES_FOR_LEARNING && totalTrades - lastVersionTradeCount >= RECALC_INTERVAL) {
    lastVersionTradeCount = totalTrades;
    await saveVersion(totalTrades);
  }
}

// ── Weight Calculations (EMA-based) ──────────────────────────

function calcEMAWinRate(trades) {
  if (!trades.length) return 0.5;
  let emaWinRate = trades[0].is_win;
  for (let i = 1; i < trades.length; i++) {
    emaWinRate = EMA_ALPHA * trades[i].is_win + (1 - EMA_ALPHA) * emaWinRate;
  }
  return emaWinRate;
}

function winRateToWeight(winRate) {
  const weight = 0.5 + winRate * 1.5;
  return Math.max(0.5, Math.min(2.0, weight));
}

// ── Setup Weight ─────────────────────────────────────────────

async function getSetupWeight(setupType) {
  const trades = await query(
    `SELECT is_win FROM ai_trades
     WHERE setup = $1 AND pnl_pct IS NOT NULL
     ORDER BY created_at ASC`,
    [setupType]
  );
  if (trades.length < MIN_TRADES_FOR_LEARNING) return 1.0;
  return winRateToWeight(calcEMAWinRate(trades));
}

// ── Coin Weight ──────────────────────────────────────────────

async function getCoinWeight(symbol) {
  const trades = await query(
    `SELECT is_win FROM ai_trades
     WHERE symbol = $1 AND pnl_pct IS NOT NULL
     ORDER BY created_at ASC`,
    [symbol]
  );
  if (trades.length < MIN_TRADES_FOR_LEARNING) return 1.0;
  return winRateToWeight(calcEMAWinRate(trades));
}

// ── Session Weight ───────────────────────────────────────────

async function getSessionWeight() {
  const session = getCurrentSession();
  const trades = await query(
    `SELECT is_win FROM ai_trades
     WHERE session = $1 AND pnl_pct IS NOT NULL
     ORDER BY created_at ASC`,
    [session]
  );
  if (trades.length < MIN_TRADES_FOR_LEARNING) return 1.0;
  return winRateToWeight(calcEMAWinRate(trades));
}

// ── Should Avoid Coin ────────────────────────────────────────

async function shouldAvoidCoin(symbol) {
  try {
    // Check trade history — only avoid if we have enough data
    const stats = await query(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins
       FROM ai_trades
       WHERE symbol = $1 AND pnl_pct IS NOT NULL`,
      [symbol]
    );
    const row = stats[0];
    if (row && parseInt(row.total) >= MIN_TRADES_FOR_LEARNING) {
      const winRate = parseInt(row.wins) / parseInt(row.total);
      if (winRate < 0.30) return true;
    }
  } catch (_) {
    // ai_trades table may not exist yet — don't avoid any coin
    return false;
  }

  return false;
}

// ── Optimal Parameters (adaptive tuning) ─────────────────────
// These match the LH/HL 3-TF strategy in smc-engine.js and cycle.js

const DEFAULT_PARAMS = {
  // Capital-based SL/TP (smc-engine.js)
  SL_MARGIN_PCT: 0.30,     // lose max 30% of position margin per trade
  TP_MARGIN_PCT: 0.45,     // target 45% of position margin per trade
  MIN_SCORE: 5,            // minimum confluence score (lowered for more trades)

  // Sizing params (cycle.js)
  WALLET_SIZE_PCT: 0.10,   // 10% of wallet per trade
  LEV_BTC_ETH: 100,        // BTC/ETH leverage
  LEV_ALT: 20,             // all altcoin leverage

  // Strategy config — LOCKED to Genetic Gen5 (v3.0): 71.4% WR, +$242
  // NOTE: Do not change these defaults without user approval
  requireBothHTF: false,    // either 4H or 1H aligned (not both required)
  requireKeyLevel: false,   // skip PDH/PDL/VWAP proximity check
  require15m: true,         // 15M swing setup REQUIRED
  require1m: true,          // 1M entry confirmation REQUIRED
  requireVolSpike: false,   // volume spike filter off
  maxEntryAge: 35,          // 1M swing must be within 35 candles
  indecisiveThresh: 0.2,    // daily candle body/range ratio below this = indecisive
  keyLevelProximity: 0.005, // 0.5% proximity to key levels (if enabled)
  swingLen4h: 11,
  swingLen1h: 10,
  swingLen15m: 8,
  swingLen1m: 3,
};

let _paramsCache = { data: null, ts: 0 };
const PARAMS_CACHE_TTL = 120_000;

async function getOptimalParams() {
  if (_paramsCache.data && Date.now() - _paramsCache.ts < PARAMS_CACHE_TTL) {
    return { ..._paramsCache.data };
  }

  const countRes = await query('SELECT COUNT(*) as count FROM ai_trades WHERE pnl_pct IS NOT NULL');
  const totalTrades = parseInt(countRes[0].count);

  if (totalTrades < MIN_TRADES_FOR_LEARNING * 2) {
    _paramsCache = { data: { ...DEFAULT_PARAMS }, ts: Date.now() };
    return { ...DEFAULT_PARAMS };
  }

  const params = { ...DEFAULT_PARAMS };

  // Preserve strategy config from latest saved version (admin may have tuned these)
  try {
    const prevRows = await query('SELECT params FROM ai_versions ORDER BY id DESC LIMIT 1');
    if (prevRows.length && prevRows[0].params) {
      const prev = typeof prevRows[0].params === 'string' ? JSON.parse(prevRows[0].params) : prevRows[0].params;
      const strategyKeys = [
        'requireBothHTF', 'requireKeyLevel', 'require15m', 'require1m',
        'requireVolSpike', 'maxEntryAge', 'indecisiveThresh', 'keyLevelProximity',
        'swingLen4h', 'swingLen1h', 'swingLen15m', 'swingLen1m',
      ];
      for (const key of strategyKeys) {
        if (prev[key] !== undefined) params[key] = prev[key];
      }
    }
  } catch (_) {}

  // ── 1. SL margin %: learn if 30% margin loss is right or needs adjustment ──
  const slMarginAnalysis = await query(
    `SELECT
      COUNT(*) FILTER (WHERE is_win = 1) as wins,
      COUNT(*) FILTER (WHERE is_win = 0) as losses,
      AVG(pnl_pct) as avg_pnl
     FROM (SELECT * FROM ai_trades WHERE pnl_pct IS NOT NULL
           ORDER BY created_at DESC LIMIT 50) sub`
  );
  const slm = slMarginAnalysis[0];
  if (slm && parseInt(slm.wins) + parseInt(slm.losses) >= 20) {
    const winRate = parseInt(slm.wins) / (parseInt(slm.wins) + parseInt(slm.losses));
    // If win rate < 35%, SL too tight — widen to give more room
    if (winRate < 0.35) {
      const newSl = Math.min(params.SL_MARGIN_PCT * (1 + MAX_WEIGHT_SHIFT), 0.50); // max 50%
      const newTp = newSl * 1.5; // keep 1.5 RR
      if (newSl !== params.SL_MARGIN_PCT) {
        await logParamChange('SL_MARGIN_PCT', params.SL_MARGIN_PCT, newSl,
          `WR ${(winRate*100).toFixed(0)}%, widening SL margin to give room`, totalTrades);
        params.SL_MARGIN_PCT = newSl;
        params.TP_MARGIN_PCT = Math.min(newTp, 0.75);
      }
    }
    // If win rate > 65%, can tighten SL to protect capital more
    if (winRate > 0.65) {
      const newSl = Math.max(params.SL_MARGIN_PCT * (1 - MAX_WEIGHT_SHIFT), 0.15); // min 15%
      const newTp = newSl * 1.5;
      if (newSl !== params.SL_MARGIN_PCT) {
        await logParamChange('SL_MARGIN_PCT', params.SL_MARGIN_PCT, newSl,
          `WR ${(winRate*100).toFixed(0)}%, tightening SL to protect capital`, totalTrades);
        params.SL_MARGIN_PCT = newSl;
        params.TP_MARGIN_PCT = Math.max(newTp, 0.225);
      }
    }
  }

  // ── 2. (removed — RR is now fixed at TP/SL = 1.5) ──

  // ── 3. (removed — SL range is now capital-based, not swing-based) ──

  // ── 4. Min Score threshold: find cutoff that filters losers ──
  const scoreAnalysis = await query(
    `SELECT score_at_entry, is_win
     FROM ai_trades
     WHERE pnl_pct IS NOT NULL AND score_at_entry IS NOT NULL
     ORDER BY created_at DESC LIMIT 100`
  );
  if (scoreAnalysis.length >= 30) {
    const winsByScore = {};
    for (const t of scoreAnalysis) {
      const bucket = Math.floor(parseFloat(t.score_at_entry) / 2) * 2;
      if (!winsByScore[bucket]) winsByScore[bucket] = { wins: 0, total: 0 };
      winsByScore[bucket].total++;
      if (t.is_win) winsByScore[bucket].wins++;
    }
    const goodBuckets = Object.entries(winsByScore)
      .filter(([, v]) => v.total >= 3 && v.wins / v.total > 0.5)
      .map(([k]) => parseInt(k))
      .sort((a, b) => a - b);
    if (goodBuckets.length) {
      const optimalMin = goodBuckets[0];
      params.MIN_SCORE = Math.round(params.MIN_SCORE + (optimalMin - params.MIN_SCORE) * MAX_WEIGHT_SHIFT);
      params.MIN_SCORE = Math.max(6, Math.min(15, params.MIN_SCORE));
    }
  }

  // ── 5. Wallet size: reduce if losing streak, increase if winning ──
  const recentPerf = await query(
    `SELECT is_win, pnl_pct
     FROM ai_trades WHERE pnl_pct IS NOT NULL
     ORDER BY created_at DESC LIMIT 20`
  );
  if (recentPerf.length >= 10) {
    const recentWinRate = recentPerf.filter(t => t.is_win).length / recentPerf.length;
    const recentPnl = recentPerf.reduce((s, t) => s + parseFloat(t.pnl_pct), 0);
    // Losing badly → reduce trade size to protect capital
    if (recentWinRate < 0.35 || recentPnl < -5) {
      const newSize = Math.max(params.WALLET_SIZE_PCT * 0.95, 0.05); // min 5%
      if (newSize < params.WALLET_SIZE_PCT) {
        await logParamChange('WALLET_SIZE_PCT', params.WALLET_SIZE_PCT, newSize, `recent WR ${(recentWinRate*100).toFixed(0)}%, reducing size`, totalTrades);
        params.WALLET_SIZE_PCT = newSize;
      }
    }
    // Winning consistently → allow slightly bigger trades
    if (recentWinRate > 0.60 && recentPnl > 5) {
      const newSize = Math.min(params.WALLET_SIZE_PCT * 1.05, 0.15); // max 15%
      if (newSize > params.WALLET_SIZE_PCT) {
        await logParamChange('WALLET_SIZE_PCT', params.WALLET_SIZE_PCT, newSize, `recent WR ${(recentWinRate*100).toFixed(0)}%, increasing size`, totalTrades);
        params.WALLET_SIZE_PCT = newSize;
      }
    }
  }

  // ── 6. Leverage: analyze wins/losses by leverage tier ──
  const levAnalysis = await query(
    `SELECT leverage,
      COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl
     FROM ai_trades WHERE pnl_pct IS NOT NULL AND leverage IS NOT NULL
     GROUP BY leverage HAVING COUNT(*) >= 5
     ORDER BY leverage`
  );
  if (levAnalysis.length >= 2) {
    for (const lev of levAnalysis) {
      const levVal = parseInt(lev.leverage);
      const wr = parseInt(lev.wins) / parseInt(lev.total);
      const avgPnl = parseFloat(lev.avg_pnl);
      // If a leverage tier is losing badly, reduce it
      if (wr < 0.35 && avgPnl < -0.5) {
        if (levVal === 100) {
          const newLev = Math.max(params.LEV_BTC_ETH - 10, 50);
          if (newLev !== params.LEV_BTC_ETH) {
            await logParamChange('LEV_BTC_ETH', params.LEV_BTC_ETH, newLev, `100x WR ${(wr*100).toFixed(0)}%, reducing`, totalTrades);
            params.LEV_BTC_ETH = newLev;
          }
        } else if (levVal === 20) {
          const newLev = Math.max(params.LEV_ALT - 5, 10);
          if (newLev !== params.LEV_ALT) {
            await logParamChange('LEV_ALT', params.LEV_ALT, newLev, `20x WR ${(wr*100).toFixed(0)}%, reducing`, totalTrades);
            params.LEV_ALT = newLev;
          }
        }
      }
      // If a tier is winning well, consider increasing
      if (wr > 0.60 && avgPnl > 1.0) {
        if (levVal >= 50 && levVal < 125) {
          const newLev = Math.min(params.LEV_BTC_ETH + 5, 125);
          if (newLev !== params.LEV_BTC_ETH) {
            await logParamChange('LEV_BTC_ETH', params.LEV_BTC_ETH, newLev, `${levVal}x WR ${(wr*100).toFixed(0)}%, increasing`, totalTrades);
            params.LEV_BTC_ETH = newLev;
          }
        } else if (levVal >= 10 && levVal <= 25) {
          const newLev = Math.min(params.LEV_ALT + 5, 50);
          if (newLev !== params.LEV_ALT) {
            await logParamChange('LEV_ALT', params.LEV_ALT, newLev, `${levVal}x WR ${(wr*100).toFixed(0)}%, increasing`, totalTrades);
            params.LEV_ALT = newLev;
          }
        }
      }
    }
  }

  // ── 7. Direction bias: if SHORT consistently loses, prefer LONG (and vice versa) ──
  // Uses lower threshold (5 trades per direction instead of 10) for faster adaptation
  const dirAnalysis = await query(
    `SELECT direction,
      COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl
     FROM (SELECT * FROM ai_trades WHERE pnl_pct IS NOT NULL ORDER BY created_at DESC LIMIT 40) sub
     GROUP BY direction`
  );
  params.DIRECTION_BIAS = null;
  if (dirAnalysis.length === 2) {
    const longD = dirAnalysis.find(d => d.direction === 'LONG');
    const shortD = dirAnalysis.find(d => d.direction === 'SHORT');
    if (longD && shortD && parseInt(longD.total) >= 5 && parseInt(shortD.total) >= 5) {
      const longWR = parseInt(longD.wins) / parseInt(longD.total);
      const shortWR = parseInt(shortD.wins) / parseInt(shortD.total);
      // Bias towards direction with better win rate when gap is significant
      if (longWR < 0.35 && shortWR > 0.45) {
        params.DIRECTION_BIAS = 'SHORT';
        await logParamChange('DIRECTION_BIAS', 0, -1, `LONG WR ${(longWR*100).toFixed(0)}% vs SHORT ${(shortWR*100).toFixed(0)}%, bias SHORT`, totalTrades);
      } else if (shortWR < 0.35 && longWR > 0.45) {
        params.DIRECTION_BIAS = 'LONG';
        await logParamChange('DIRECTION_BIAS', 0, 1, `SHORT WR ${(shortWR*100).toFixed(0)}% vs LONG ${(longWR*100).toFixed(0)}%, bias LONG`, totalTrades);
      }
    }
  }

  // ── 8. Early exit learning: track if structure_break_15m exits help or hurt ──
  const exitAnalysis = await query(
    `SELECT exit_reason,
      COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl
     FROM ai_trades
     WHERE exit_reason IS NOT NULL AND pnl_pct IS NOT NULL
     GROUP BY exit_reason HAVING COUNT(*) >= 5`
  );
  // Store early exit effectiveness for the engine to use
  params.EARLY_EXIT_ENABLED = true; // default on
  for (const ex of exitAnalysis) {
    if (ex.exit_reason === 'structure_break_15m') {
      const wr = parseInt(ex.wins) / parseInt(ex.total);
      const avgPnl = parseFloat(ex.avg_pnl);
      // If early exits are consistently losing us money, disable them
      if (wr < 0.25 && avgPnl < -1.0) {
        params.EARLY_EXIT_ENABLED = false;
        await logParamChange('EARLY_EXIT_ENABLED', 1, 0,
          `15m exits WR ${(wr*100).toFixed(0)}% avg ${avgPnl.toFixed(1)}%, disabling`, totalTrades);
      }
    }
  }

  // ── 9. (removed — SL is now capital-based, no min/max filtering needed) ──

  // ── 10. Swing length optimization: learn which swing lengths produce better WR ──
  try {
    const swingAnalysis = await query(
      `SELECT tf_15m, tf_1m, is_win, pnl_pct
       FROM ai_trades
       WHERE pnl_pct IS NOT NULL AND tf_15m IS NOT NULL
       ORDER BY created_at DESC LIMIT 80`
    );
    if (swingAnalysis.length >= 30) {
      // Analyze win rate by structure quality reported in tf_15m/tf_1m
      const wins = swingAnalysis.filter(t => t.is_win);
      const losses = swingAnalysis.filter(t => !t.is_win);

      // If losses consistently have weak 1m confirmation, tighten maxEntryAge
      const lossesWithOld1m = losses.filter(t => {
        const tf1m = typeof t.tf_1m === 'string' ? t.tf_1m : '';
        return tf1m.includes('aged') || tf1m.includes('stale');
      });
      if (losses.length >= 10 && lossesWithOld1m.length / losses.length > 0.3) {
        const newAge = Math.max(params.maxEntryAge - 3, 15);
        if (newAge < params.maxEntryAge) {
          await logParamChange('maxEntryAge', params.maxEntryAge, newAge,
            `${((lossesWithOld1m.length/losses.length)*100).toFixed(0)}% of losses had aged 1m swings — tightening`, totalTrades);
          params.maxEntryAge = newAge;
        }
      }
    }
  } catch (_) {}

  // ── 11. Apply winning backtest strategies from StrategyAgent ──
  try {
    const bestBacktest = await query(
      `SELECT params, win_rate, total_pnl, total_trades
       FROM strategy_backtests
       WHERE win_rate >= 60 AND total_trades >= 20 AND total_pnl > 0
       ORDER BY win_rate * total_pnl DESC
       LIMIT 1`
    );
    if (bestBacktest.length) {
      const bt = bestBacktest[0];
      const btParams = typeof bt.params === 'string' ? JSON.parse(bt.params) : bt.params;
      // Only adopt swing lengths from backtests (conservative — don't change SL/TP from backtest)
      const ADOPTABLE = ['swing_15m', 'swing_1m'];
      const PARAM_MAP = { swing_15m: 'swingLen15m', swing_1m: 'swingLen1m' };
      for (const key of ADOPTABLE) {
        if (btParams[key] !== undefined && PARAM_MAP[key]) {
          const mapped = PARAM_MAP[key];
          const oldVal = params[mapped];
          const newVal = btParams[key];
          // Only shift by MAX_WEIGHT_SHIFT toward the backtest value
          const shifted = Math.round(oldVal + (newVal - oldVal) * MAX_WEIGHT_SHIFT);
          if (shifted !== oldVal) {
            await logParamChange(mapped, oldVal, shifted,
              `Backtest WR ${bt.win_rate.toFixed(1)}% suggests ${key}=${newVal}, shifting toward it`, totalTrades);
            params[mapped] = shifted;
          }
        }
      }
    }
  } catch (_) {}

  // ── 12. Per-coin learning: avoid coins that consistently lose ──
  try {
    const coinPerf = await query(
      `SELECT symbol, COUNT(*) as total,
        SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
        AVG(pnl_pct) as avg_pnl
       FROM ai_trades WHERE pnl_pct IS NOT NULL
       GROUP BY symbol HAVING COUNT(*) >= 10
       ORDER BY AVG(pnl_pct) ASC LIMIT 5`
    );
    params.AVOID_COINS = [];
    for (const coin of coinPerf) {
      const wr = parseInt(coin.wins) / parseInt(coin.total);
      if (wr < 0.30 && parseFloat(coin.avg_pnl) < -1.0) {
        params.AVOID_COINS.push(coin.symbol);
      }
    }
    if (params.AVOID_COINS.length > 0) {
      console.log(`[AI] Avoiding coins with <30% WR: ${params.AVOID_COINS.join(', ')}`);
    }
  } catch (_) {
    params.AVOID_COINS = [];
  }

  _paramsCache = { data: { ...params }, ts: Date.now() };
  return params;
}

async function logParamChange(name, oldVal, newVal, reason, tradeCount) {
  const wrRes = await query('SELECT AVG(is_win) as wr FROM ai_trades WHERE pnl_pct IS NOT NULL');
  const winRate = parseFloat(wrRes[0].wr) || 0;

  await query(
    `INSERT INTO ai_parameter_history (param_name, old_value, new_value, reason, trade_count, win_rate)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [name, oldVal, newVal, reason, tradeCount, winRate]
  );
}

// ── Version Snapshots ────────────────────────────────────────

async function saveVersion(tradeCount) {
  const overall = await query(
    `SELECT AVG(is_win) as win_rate, AVG(pnl_pct) as avg_pnl, SUM(pnl_pct) as total_pnl
     FROM ai_trades WHERE pnl_pct IS NOT NULL`
  );
  const o = overall[0];

  const params = await getOptimalParams();

  const setups = await query(
    `SELECT setup, COUNT(*) as total,
      ROUND(AVG(CASE WHEN is_win = 1 THEN 1.0 ELSE 0.0 END)::numeric, 3) as win_rate
     FROM ai_trades WHERE pnl_pct IS NOT NULL
     GROUP BY setup HAVING COUNT(*) >= 3`
  );
  const setupWeights = {};
  for (const s of setups) {
    const w = await getSetupWeight(s.setup);
    setupWeights[s.setup] = { trades: parseInt(s.total), winRate: parseFloat(s.win_rate), weight: w };
  }

  const allSymbols = await query(
    'SELECT DISTINCT symbol FROM ai_trades WHERE pnl_pct IS NOT NULL'
  );
  const avoided = [];
  for (const r of allSymbols) {
    if (await shouldAvoidCoin(r.symbol)) avoided.push(r.symbol);
  }

  const prevVersion = await query(
    'SELECT params FROM ai_versions ORDER BY id DESC LIMIT 1'
  );
  const changes = [];
  if (prevVersion.length) {
    const prev = JSON.parse(prevVersion[0].params);
    for (const [key, val] of Object.entries(params)) {
      if (prev[key] !== undefined && prev[key] !== val) {
        changes.push(`${key}: ${prev[key]} → ${val}`);
      }
    }
  }

  const major = Math.floor(tradeCount / 50) + 1;
  const minor = Math.floor((tradeCount % 50) / RECALC_INTERVAL);
  const version = `v${major}.${minor}`;

  await query(
    `INSERT INTO ai_versions (version, trade_count, win_rate, avg_pnl, total_pnl, params, setup_weights, avoided_coins, changes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      version, tradeCount,
      parseFloat(o.win_rate) || 0,
      parseFloat(o.avg_pnl) || 0,
      parseFloat(o.total_pnl) || 0,
      JSON.stringify(params),
      JSON.stringify(setupWeights),
      JSON.stringify(avoided),
      changes.length ? changes.join(' | ') : 'initial snapshot',
    ]
  );

  console.log(`[AI] Version ${version} saved — ${tradeCount} trades, ${((parseFloat(o.win_rate) || 0) * 100).toFixed(0)}% WR, ${changes.length} param changes`);
}

async function getVersions(limit = 50) {
  return query(
    `SELECT id, version, trade_count, win_rate, avg_pnl, total_pnl,
            params, setup_weights, avoided_coins, changes, created_at
     FROM ai_versions ORDER BY id DESC LIMIT $1`,
    [limit]
  );
}

async function getCurrentVersion() {
  const rows = await query('SELECT version FROM ai_versions ORDER BY id DESC LIMIT 1');
  return rows.length ? rows[0].version : 'v0.0';
}

// ── Stats for Telegram /stats Command ────────────────────────

async function getStats() {
  await initAllTables();
  const overall = await query(
    `SELECT COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl, SUM(pnl_pct) as total_pnl,
      MAX(pnl_pct) as best_trade, MIN(pnl_pct) as worst_trade
     FROM ai_trades WHERE pnl_pct IS NOT NULL`
  );

  const bySetup = await query(
    `SELECT setup, COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl
     FROM ai_trades WHERE pnl_pct IS NOT NULL
     GROUP BY setup ORDER BY AVG(pnl_pct) DESC`
  );

  const bySession = await query(
    `SELECT session, COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl
     FROM ai_trades WHERE pnl_pct IS NOT NULL
     GROUP BY session ORDER BY AVG(pnl_pct) DESC`
  );

  const recent = await query(
    `SELECT symbol, direction, setup, pnl_pct, created_at
     FROM ai_trades WHERE pnl_pct IS NOT NULL
     ORDER BY created_at DESC LIMIT 10`
  );

  const paramChanges = await query(
    `SELECT param_name, old_value, new_value, reason, created_at
     FROM ai_parameter_history ORDER BY created_at DESC LIMIT 5`
  );

  return { overall: overall[0], bySetup, bySession, recent, paramChanges };
}

// ── Best Performing Setups ───────────────────────────────────

async function getBestSetups() {
  return query(
    `SELECT setup, COUNT(*) as total,
      ROUND(AVG(CASE WHEN is_win = 1 THEN 1.0 ELSE 0.0 END)::numeric * 100, 1) as win_rate,
      ROUND(AVG(pnl_pct)::numeric, 3) as avg_pnl
     FROM ai_trades WHERE pnl_pct IS NOT NULL
     GROUP BY setup HAVING COUNT(*) >= 5
     ORDER BY AVG(pnl_pct) DESC`
  );
}

// ── Direction Preference for a Coin ──────────────────────────

async function getDirectionPreference(symbol) {
  const stats = await query(
    `SELECT direction, COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl
     FROM ai_trades WHERE symbol = $1 AND pnl_pct IS NOT NULL
     GROUP BY direction`,
    [symbol]
  );

  if (stats.length < 2) return null;
  const longStats = stats.find(s => s.direction === 'LONG');
  const shortStats = stats.find(s => s.direction === 'SHORT');
  if (!longStats || !shortStats) return null;
  if (parseInt(longStats.total) < 5 || parseInt(shortStats.total) < 5) return null;

  if (parseFloat(longStats.avg_pnl) > parseFloat(shortStats.avg_pnl) * 1.5) return 'LONG';
  if (parseFloat(shortStats.avg_pnl) > parseFloat(longStats.avg_pnl) * 1.5) return 'SHORT';
  return null;
}

// ── Pattern DNA & Loss Autopsy ─────────────────────────────────

async function performLossAutopsy(tradeData) {
  try {
    // DNA: symbol | setup | direction | session | trend1h
    const dna = [
      tradeData.symbol,
      tradeData.setup,
      tradeData.direction,
      tradeData.session || getCurrentSession(),
      tradeData.trend1h || 'unknown'
    ].join('|').toUpperCase();

    // 1. Update pattern stats
    await query(
      `INSERT INTO pattern_penalties (pattern_dna, loss_count, last_updated)
       VALUES ($1, 1, NOW())
       ON CONFLICT (pattern_dna) DO UPDATE SET
         loss_count = pattern_penalties.loss_count + 1,
         last_updated = NOW()`,
      [dna]
    );

    // 2. Calculate new penalty
    const [row] = await query(
      `SELECT loss_count, win_count FROM pattern_penalties WHERE pattern_dna = $1`,
      [dna]
    );

    if (row) {
      const total = row.loss_count + row.win_count;
      const winRate = total > 0 ? row.win_count / total : 1;

      let penalty = 0;
      if (winRate < 0.30) {
        // Aggressive penalty for high-failure patterns
        // Scale: -2 points per loss, cap at -15
        penalty = -Math.min(row.loss_count * 2, 15);
      }

      await query(
        `UPDATE pattern_penalties SET current_penalty = $1 WHERE pattern_dna = $2`,
        [penalty, dna]
      );
    }
  } catch (err) {
    console.error(`[AI Learner] Autopsy failed: ${err.message}`);
  }
}

async function getPatternPenalty(symbol, setup, direction, session, trend1h) {
  try {
    const dna = [symbol, setup, direction, session || getCurrentSession(), trend1h || 'unknown']
      .join('|').toUpperCase();
    const [row] = await query(
      `SELECT current_penalty FROM pattern_penalties WHERE pattern_dna = $1`,
      [dna]
    );
    return row ? parseFloat(row.current_penalty) : 0;
  } catch (err) {
    return 0;
  }
}

async function analyzeWorstPatterns() {
  try {
    const worst = await query(
      `SELECT pattern_dna, loss_count, win_count, current_penalty
       FROM pattern_penalties
       WHERE (loss_count + win_count) >= 5 AND (win_count::float / (loss_count + win_count)) < 0.25
       ORDER BY loss_count DESC LIMIT 10`
    );

    for (const p of worst) {
      // Bump penalty for absolute trap patterns
      const newPenalty = Math.max(p.current_penalty - 2, -20);
      await query(
        `UPDATE pattern_penalties SET current_penalty = $1 WHERE pattern_dna = $2`,
        [newPenalty, p.pattern_dna]
      );
    }
  } catch (err) {
    console.error(`[AI Learner] Worst pattern analysis failed: ${err.message}`);
  }
}

// ── Composite AI Score Modifier ──────────────────────────────

async function getAIScoreModifier(symbol, setup, direction) {
  const setupW = await getSetupWeight(setup);
  const coinW = await getCoinWeight(symbol);
  const sessionW = await getSessionWeight();
  const dirPref = await getDirectionPreference(symbol);

  let modifier = (setupW + coinW + sessionW) / 3;

  if (dirPref && dirPref !== direction) {
    modifier *= 0.7;
  }

  // Scan log bonus: if this coin has high signal-to-trade conversion, boost score
  try {
    const logStats = await query(
      `SELECT
         COUNT(*) FILTER (WHERE result = 'SIGNAL') as signals,
         COUNT(*) as total
       FROM bot_logs
       WHERE category = 'scan' AND symbol = $1
         AND ts > NOW() - INTERVAL '7 days'`,
      [symbol]
    );
    const lr = logStats[0];
    if (lr && parseInt(lr.total) >= 20) {
      const signalRate = parseInt(lr.signals) / parseInt(lr.total);
      // High signal rate = coin frequently aligns = boost
      if (signalRate > 0.1) modifier *= 1.1;
      // Very low signal rate = rare alignment = slight penalty
      else if (signalRate < 0.02) modifier *= 0.9;
    }
  } catch (_) {}

  return modifier;
}

// ── Scan Log Analysis for Learning ─────────────────────────

async function getLearningSummary() {
  try {
    // Cross-reference signals with trade outcomes
    const summary = await query(`
      SELECT
        bl.symbol,
        bl.direction,
        COUNT(DISTINCT bl.id) as signal_count,
        COUNT(DISTINCT t.id) as trade_count,
        SUM(CASE WHEN t.status = 'WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN t.status = 'LOSS' THEN 1 ELSE 0 END) as losses,
        ROUND(AVG(t.pnl_usdt)::numeric, 4) as avg_pnl
      FROM bot_logs bl
      LEFT JOIN trades t ON t.symbol = bl.symbol
        AND t.direction = bl.direction
        AND t.created_at BETWEEN bl.ts - INTERVAL '5 minutes' AND bl.ts + INTERVAL '30 minutes'
      WHERE bl.category = 'scan' AND bl.result = 'SIGNAL'
        AND bl.ts > NOW() - INTERVAL '30 days'
      GROUP BY bl.symbol, bl.direction
      ORDER BY signal_count DESC
    `);
    return summary;
  } catch (_) {
    return [];
  }
}

module.exports = {
  recordTrade,
  getSetupWeight,
  getCoinWeight,
  getSessionWeight,
  shouldAvoidCoin,
  getOptimalParams,
  getStats,
  getBestSetups,
  getDirectionPreference,
  getAIScoreModifier,
  getCurrentSession,
  getVersions,
  getCurrentVersion,
  getLearningSummary,
  performLossAutopsy,
  getPatternPenalty,
  analyzeWorstPatterns,
  DEFAULT_PARAMS,
};
