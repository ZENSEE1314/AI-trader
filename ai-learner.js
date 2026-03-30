// ============================================================
// AI Self-Learning Engine
// Tracks trade outcomes, learns patterns, adapts parameters
// Storage: Neon PostgreSQL (persistent across deploys)
// ============================================================

const { query } = require('./db');

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
  const isWin = data.pnlPct > 0 ? 1 : 0;
  await query(
    `INSERT INTO ai_trades (
      symbol, direction, setup, entry_price, exit_price, pnl_pct, is_win,
      leverage, duration_min, session, rsi_at_entry, atr_pct, vol_ratio,
      sentiment_score, bb_position, score_at_entry, sl_distance_pct,
      tp_distance_pct, trend_1h, market_structure, closed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
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
  const stats = await query(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins
     FROM ai_trades
     WHERE symbol = $1 AND pnl_pct IS NOT NULL`,
    [symbol]
  );
  const row = stats[0];
  if (!row || parseInt(row.total) < MIN_TRADES_FOR_LEARNING) return false;
  const winRate = parseInt(row.wins) / parseInt(row.total);
  return winRate < 0.30;
}

// ── Optimal Parameters (adaptive tuning) ─────────────────────
// These match the LH/HL 3-TF strategy in smc-engine.js and cycle.js

const DEFAULT_PARAMS = {
  // Strategy params (smc-engine.js)
  SL_BUFFER_PCT: 0.001,    // 0.1% buffer above/below swing candle
  RR_RATIO: 1.5,           // TP = 1.5x SL distance
  SL_MAX_PCT: 0.02,        // skip trades with SL > 2%
  SL_MIN_PCT: 0.001,       // skip trades with SL < 0.1%
  MIN_SCORE: 8,            // minimum confluence score

  // Sizing params (cycle.js)
  WALLET_SIZE_PCT: 0.10,   // 10% of wallet per trade
  LEV_BTC_ETH: 100,        // BTC/ETH leverage
  LEV_ALT: 20,             // altcoin leverage (price >= $100)
  LEV_CHEAP: 10,           // cheap coin leverage (price < $100)
};

async function getOptimalParams() {
  const countRes = await query('SELECT COUNT(*) as count FROM ai_trades WHERE pnl_pct IS NOT NULL');
  const totalTrades = parseInt(countRes[0].count);

  if (totalTrades < MIN_TRADES_FOR_LEARNING * 2) return { ...DEFAULT_PARAMS };

  const params = { ...DEFAULT_PARAMS };

  // ── 1. SL Buffer: are we getting stopped out too early or too late? ──
  const slAnalysis = await query(
    `SELECT
      AVG(CASE WHEN is_win = 1 THEN sl_distance_pct END) as avg_win_sl,
      AVG(CASE WHEN is_win = 0 THEN sl_distance_pct END) as avg_lose_sl
     FROM (SELECT * FROM ai_trades WHERE pnl_pct IS NOT NULL AND sl_distance_pct IS NOT NULL
           ORDER BY created_at DESC LIMIT 50) sub`
  );
  const sl = slAnalysis[0];
  if (sl && sl.avg_win_sl && sl.avg_lose_sl) {
    const winSl = parseFloat(sl.avg_win_sl);
    const loseSl = parseFloat(sl.avg_lose_sl);
    // If winning trades had wider SL → our buffer is too tight, widen it
    if (winSl > loseSl * 1.2) {
      const newBuf = Math.min(params.SL_BUFFER_PCT * (1 + MAX_WEIGHT_SHIFT), 0.005);
      if (newBuf !== params.SL_BUFFER_PCT) {
        await logParamChange('SL_BUFFER_PCT', params.SL_BUFFER_PCT, newBuf, 'winners use wider SL buffer', totalTrades);
        params.SL_BUFFER_PCT = newBuf;
      }
    }
    // If losing trades had wider SL → our buffer is too loose, tighten it
    if (loseSl > winSl * 1.3) {
      const newBuf = Math.max(params.SL_BUFFER_PCT * (1 - MAX_WEIGHT_SHIFT), 0.0005);
      if (newBuf !== params.SL_BUFFER_PCT) {
        await logParamChange('SL_BUFFER_PCT', params.SL_BUFFER_PCT, newBuf, 'losers have wider SL, tightening buffer', totalTrades);
        params.SL_BUFFER_PCT = newBuf;
      }
    }
  }

  // ── 2. RR Ratio: find the sweet spot between TP hit rate and reward ──
  const tpAnalysis = await query(
    `SELECT
      AVG(CASE WHEN is_win = 1 THEN tp_distance_pct END) as avg_win_tp,
      AVG(CASE WHEN is_win = 1 THEN sl_distance_pct END) as avg_win_sl,
      AVG(CASE WHEN is_win = 0 THEN tp_distance_pct END) as avg_lose_tp,
      COUNT(*) FILTER (WHERE is_win = 1) as wins,
      COUNT(*) FILTER (WHERE is_win = 0) as losses
     FROM (SELECT * FROM ai_trades WHERE pnl_pct IS NOT NULL AND tp_distance_pct IS NOT NULL
           ORDER BY created_at DESC LIMIT 80) sub`
  );
  const tp = tpAnalysis[0];
  if (tp && tp.wins && tp.losses) {
    const winRate = parseInt(tp.wins) / (parseInt(tp.wins) + parseInt(tp.losses));
    // If win rate < 40%, TP too far → lower RR to hit TP more often
    if (winRate < 0.40 && params.RR_RATIO > 1.0) {
      const newRR = Math.max(params.RR_RATIO - 0.1, 1.0);
      await logParamChange('RR_RATIO', params.RR_RATIO, newRR, `win rate ${(winRate*100).toFixed(0)}% too low, lowering TP target`, totalTrades);
      params.RR_RATIO = newRR;
    }
    // If win rate > 65%, TP too close → raise RR to capture more profit
    if (winRate > 0.65 && params.RR_RATIO < 2.5) {
      const newRR = Math.min(params.RR_RATIO + 0.1, 2.5);
      await logParamChange('RR_RATIO', params.RR_RATIO, newRR, `win rate ${(winRate*100).toFixed(0)}% high, raising TP target`, totalTrades);
      params.RR_RATIO = newRR;
    }
  }

  // ── 3. SL Max/Min: find optimal SL distance range ──
  const slRangeAnalysis = await query(
    `SELECT
      sl_distance_pct,
      is_win
     FROM ai_trades
     WHERE pnl_pct IS NOT NULL AND sl_distance_pct IS NOT NULL
     ORDER BY created_at DESC LIMIT 100`
  );
  if (slRangeAnalysis.length >= 30) {
    // Bucket SL distances and find which ranges win most
    const buckets = {};
    for (const t of slRangeAnalysis) {
      const dist = parseFloat(t.sl_distance_pct);
      const bucket = Math.round(dist * 200) / 200; // 0.5% buckets
      if (!buckets[bucket]) buckets[bucket] = { wins: 0, total: 0 };
      buckets[bucket].total++;
      if (t.is_win) buckets[bucket].wins++;
    }
    // Find the max SL distance where win rate is still decent (>40%)
    const goodMaxSl = Object.entries(buckets)
      .filter(([, v]) => v.total >= 3 && v.wins / v.total > 0.4)
      .map(([k]) => parseFloat(k))
      .sort((a, b) => b - a);
    if (goodMaxSl.length) {
      const optimalMax = Math.min(goodMaxSl[0] / 100 + 0.005, 0.03); // convert % to decimal, add buffer, cap at 3%
      const newMax = params.SL_MAX_PCT + (optimalMax - params.SL_MAX_PCT) * MAX_WEIGHT_SHIFT;
      if (Math.abs(newMax - params.SL_MAX_PCT) > 0.001) {
        await logParamChange('SL_MAX_PCT', params.SL_MAX_PCT, newMax, 'adjusted to optimal SL range', totalTrades);
        params.SL_MAX_PCT = Math.max(0.01, Math.min(0.03, newMax));
      }
    }
  }

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
        } else if (levVal === 10) {
          const newLev = Math.max(params.LEV_CHEAP - 2, 5);
          if (newLev !== params.LEV_CHEAP) {
            await logParamChange('LEV_CHEAP', params.LEV_CHEAP, newLev, `10x WR ${(wr*100).toFixed(0)}%, reducing`, totalTrades);
            params.LEV_CHEAP = newLev;
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
  const dirAnalysis = await query(
    `SELECT direction,
      COUNT(*) as total,
      SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END) as wins,
      AVG(pnl_pct) as avg_pnl
     FROM (SELECT * FROM ai_trades WHERE pnl_pct IS NOT NULL ORDER BY created_at DESC LIMIT 60) sub
     GROUP BY direction`
  );
  // Store direction bias for the engine to use
  params.DIRECTION_BIAS = null;
  if (dirAnalysis.length === 2) {
    const longD = dirAnalysis.find(d => d.direction === 'LONG');
    const shortD = dirAnalysis.find(d => d.direction === 'SHORT');
    if (longD && shortD && parseInt(longD.total) >= 10 && parseInt(shortD.total) >= 10) {
      const longWR = parseInt(longD.wins) / parseInt(longD.total);
      const shortWR = parseInt(shortD.wins) / parseInt(shortD.total);
      // If one direction is significantly worse, avoid it
      if (longWR < 0.30 && shortWR > 0.50) {
        params.DIRECTION_BIAS = 'SHORT';
        await logParamChange('DIRECTION_BIAS', 0, -1, `LONG WR ${(longWR*100).toFixed(0)}% vs SHORT ${(shortWR*100).toFixed(0)}%, bias SHORT`, totalTrades);
      } else if (shortWR < 0.30 && longWR > 0.50) {
        params.DIRECTION_BIAS = 'LONG';
        await logParamChange('DIRECTION_BIAS', 0, 1, `SHORT WR ${(shortWR*100).toFixed(0)}% vs LONG ${(longWR*100).toFixed(0)}%, bias LONG`, totalTrades);
      }
    }
  }

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
      avoided.join(','),
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

  return modifier;
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
  DEFAULT_PARAMS,
};
