// ============================================================
// Pattern Analyzer — learns from last N trades to guide entries
// ============================================================

const { query } = require('./db');

const MIN_PATTERN_TRADES = 5;

// Analyze last trades and return actionable guidance
async function analyzeRecentTrades(symbolFilter = null, limit = 15) {
  try {
    let sql = `
      SELECT symbol, direction, setup, entry_price, exit_price,
             pnl_pct, is_win, vwap_zone, trend_1h, market_structure,
             tf_15m, tf_1m, session, vol_ratio, closed_at
      FROM ai_trades
      WHERE pnl_pct IS NOT NULL
      ${symbolFilter ? "AND symbol = '" + symbolFilter + "'" : ""}
      ORDER BY closed_at DESC
      LIMIT $1
    `;
    const trades = await query(sql, [limit]);

    if (trades.length < MIN_PATTERN_TRADES) {
      return { ready: false, reason: `Only ${trades.length} trades in DB (need ${MIN_PATTERN_TRADES})` };
    }

    const wins = trades.filter(t => t.is_win);
    const losses = trades.filter(t => !t.is_win);

    // Extract patterns that distinguish wins from losses
    const patterns = {
      winZones: freq(wins, 'vwap_zone'),
      lossZones: freq(losses, 'vwap_zone'),
      winStructures: freq(wins, 'market_structure'),
      lossStructures: freq(losses, 'market_structure'),
      win15m: freq(wins, 'tf_15m'),
      loss15m: freq(losses, 'tf_15m'),
      win1m: freq(wins, 'tf_1m'),
      loss1m: freq(losses, 'tf_1m'),
      winVol: avg(wins, 'vol_ratio'),
      lossVol: avg(losses, 'vol_ratio'),
      winSession: freq(wins, 'session'),
      lossSession: freq(losses, 'session'),
      winTrend: freq(wins, 'trend_1h'),
      lossTrend: freq(losses, 'trend_1h'),
    };

    // Build recommendations
    const recs = [];

    // VWAP zone insight
    const bestWinZone = topKey(patterns.winZones);
    const worstLossZone = topKey(patterns.lossZones);
    if (bestWinZone && bestWinZone !== worstLossZone) {
      recs.push(`Favor ${bestWinZone} zone entries — ${pct(wins, 'vwap_zone', bestWinZone)}% of wins came from there`);
    }
    if (worstLossZone) {
      recs.push(`Avoid ${worstLossZone} zone — ${pct(losses, 'vwap_zone', worstLossZone)}% of losses came from there`);
    }

    // Structure insight
    const bestStructure = topKey(patterns.winStructures);
    if (bestStructure) {
      recs.push(`Best structure: ${bestStructure} — present in ${pct(wins, 'market_structure', bestStructure)}% of wins`);
    }

    // Volume insight
    if (patterns.winVol && patterns.lossVol && patterns.winVol > patterns.lossVol * 1.3) {
      recs.push(`Winners avg ${patterns.winVol.toFixed(1)}× vol vs losers ${patterns.lossVol.toFixed(1)}× — require stronger volume`);
    }

    // Session insight
    const bestSession = topKey(patterns.winSession);
    if (bestSession) {
      recs.push(`Best session: ${bestSession} — ${pct(wins, 'session', bestSession)}% of wins`);
    }

    // Trend insight
    const avoidTrend = topKey(patterns.lossTrend);
    if (avoidTrend) {
      recs.push(`Avoid trading against ${avoidTrend} 1h trend — ${pct(losses, 'trend_1h', avoidTrend)}% of losses`);
    }

    // Pivot combo insight
    const winPivotCombo = topPivotCombo(wins);
    const lossPivotCombo = topPivotCombo(losses);
    if (winPivotCombo && winPivotCombo !== lossPivotCombo) {
      recs.push(`Winning pivot combo: ${winPivotCombo}`);
    }
    if (lossPivotCombo) {
      recs.push(`Losing pivot combo to avoid: ${lossPivotCombo}`);
    }

    // Direction bias
    const longWins = wins.filter(t => t.direction !== 'SHORT').length;
    const shortWins = wins.filter(t => t.direction === 'SHORT').length;
    const longLosses = losses.filter(t => t.direction !== 'SHORT').length;
    const shortLosses = losses.filter(t => t.direction === 'SHORT').length;
    const longWR = longWins + longLosses > 0 ? longWins / (longWins + longLosses) : 0;
    const shortWR = shortWins + shortLosses > 0 ? shortWins / (shortWins + shortLosses) : 0;
    if (longWR > shortWR + 0.2) {
      recs.push(`LONG bias: ${(longWR*100).toFixed(0)}% WR vs SHORT ${(shortWR*100).toFixed(0)}% — favor LONGs`);
    } else if (shortWR > longWR + 0.2) {
      recs.push(`SHORT bias: ${(shortWR*100).toFixed(0)}% WR vs LONG ${(longWR*100).toFixed(0)}% — favor SHORTs`);
    }

    return {
      ready: true,
      totalTrades: trades.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: (wins.length / trades.length * 100).toFixed(1),
      patterns,
      recommendations: recs,
      // Computed filters for the bot
      filters: {
        avoidZones: [worstLossZone].filter(Boolean),
        requireVolumeRatio: patterns.winVol > patterns.lossVol * 1.2 ? patterns.winVol : null,
        avoidTrends: [avoidTrend].filter(Boolean),
        bestPivotCombo: winPivotCombo,
        directionBias: longWR > shortWR + 0.15 ? 'LONG' : shortWR > longWR + 0.15 ? 'SHORT' : null,
      }
    };
  } catch (e) {
    console.error('[PatternAnalyzer] Error:', e.message);
    return { ready: false, reason: e.message };
  }
}

// ── Helpers ──────────────────────────────────────────────────

function freq(arr, key) {
  const counts = {};
  for (const item of arr) {
    const v = item[key] || 'unknown';
    counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}

function avg(arr, key) {
  const vals = arr.map(x => parseFloat(x[key])).filter(v => !isNaN(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function topKey(freqMap) {
  const entries = Object.entries(freqMap);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

function pct(arr, key, value) {
  const matches = arr.filter(x => (x[key] || 'unknown') === value).length;
  return arr.length > 0 ? Math.round(matches / arr.length * 100) : 0;
}

function topPivotCombo(trades) {
  const combos = {};
  for (const t of trades) {
    const combo = `${t.tf_15m}+${t.tf_1m}`;
    if (!combo.includes('null') && !combo.includes('undefined')) {
      combos[combo] = (combos[combo] || 0) + 1;
    }
  }
  const entries = Object.entries(combos);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

// ── Performance Alert — check last 5 trades post-deploy ──────
// If win rate of last 5 trades drops below 40%, returns an alert message.
// Call after every trade or every cycle to monitor strategy health.
async function checkPerformanceAlert(minWinRate = 40, lookbackCount = 5) {
  try {
    const trades = await query(`
      SELECT is_win, pnl_pct, symbol, direction, setup, closed_at
      FROM ai_trades
      WHERE pnl_pct IS NOT NULL
      ORDER BY closed_at DESC
      LIMIT $1
    `, [lookbackCount]);

    if (trades.length < lookbackCount) {
      return { alert: false, reason: `Only ${trades.length} closed trades (need ${lookbackCount})` };
    }

    const wins = trades.filter(t => t.is_win).length;
    const wr = (wins / trades.length) * 100;

    const pnlSum = trades.reduce((s, t) => s + (parseFloat(t.pnl_pct) || 0), 0);
    const avgPnl = pnlSum / trades.length;

    if (wr < minWinRate) {
      const details = trades.map(t => `${t.symbol} ${t.direction} ${t.is_win ? 'WIN' : 'LOSS'} ${parseFloat(t.pnl_pct).toFixed(2)}%`).join(' | ');
      return {
        alert: true,
        message: `⚠️ *Strategy Alert*\nLast ${trades.length} trades: ${wins}W/${trades.length - wins}L (${wr.toFixed(1)}% WR)\nAvg PnL: ${avgPnl > 0 ? '+' : ''}${avgPnl.toFixed(2)}%\n\n${details}\n\n_Action: review logs, consider pausing new entries._`,
        winRate: wr,
        avgPnl,
        trades,
      };
    }

    return {
      alert: false,
      message: `✅ Last ${trades.length} trades: ${wins}W/${trades.length - wins}L (${wr.toFixed(1)}% WR) | Avg PnL ${avgPnl > 0 ? '+' : ''}${avgPnl.toFixed(2)}%`,
      winRate: wr,
      avgPnl,
      trades,
    };
  } catch (e) {
    return { alert: false, reason: e.message };
  }
}

// ── Export ───────────────────────────────────────────────────
module.exports = { analyzeRecentTrades, checkPerformanceAlert };
