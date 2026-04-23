// ============================================================
// Quantum AI Strategy Optimizer
//
// Mix-and-matches 4 strategies using bitmask combos (1-15).
// Tracks performance per combo, auto-selects the best one.
// Epsilon-greedy exploration → exploitation after 20+ trades.
// Admin can force-lock any combo via API.
// ============================================================

const { log: bLog } = require('./bot-logger');

const STRATEGIES = {
  LIQUIDITY_SWEEP:  0, // bit 0
  STOP_LOSS_HUNT:   1, // bit 1
  MOMENTUM_SCALP:   2, // bit 2
  BRR_FIBO:         3, // bit 3
  SMC_CLASSIC:      4, // bit 4
  SMC_HL_STRUCTURE: 5, // bit 5 — Zeiierman curved HL/LH + EMA55 + 3m/1m cascade
  TREND_FOLLOW:     6, // bit 6 — HH+HL uptrend → LONG; LL+LH downtrend → SHORT
};

const STRATEGY_SHORT = ['SWEEP', 'HUNT', 'MOMENTUM', 'BRR', 'SMC', 'HL', 'TF'];
const TOTAL_COMBOS = 127; // 1-127 (7 strategies = 2^7 - 1)
const MIN_TRADES_PER_COMBO = 20;
const EXPLORE_EPSILON = 0.15;
const SWITCH_MARGIN = 0.05; // 5% improvement needed to switch
const EMA_ALPHA = 0.3;
const EVAL_INTERVAL = 10; // evaluate every N trades

let _initialized = false;
let _tradesSinceEval = 0;

// ── Bitmask Helpers ────────────────────────────────────────

function comboToName(comboId) {
  const parts = [];
  for (const [name, bit] of Object.entries(STRATEGIES)) {
    if (comboId & (1 << bit)) parts.push(STRATEGY_SHORT[bit]);
  }
  return parts.join('+') || 'NONE';
}

function isStrategyEnabled(comboId, strategyName) {
  const bit = STRATEGIES[strategyName];
  return (comboId & (1 << bit)) !== 0;
}

function getEnabledStrategies(comboId) {
  return {
    LIQUIDITY_SWEEP:  isStrategyEnabled(comboId, 'LIQUIDITY_SWEEP'),
    STOP_LOSS_HUNT:   isStrategyEnabled(comboId, 'STOP_LOSS_HUNT'),
    MOMENTUM_SCALP:   isStrategyEnabled(comboId, 'MOMENTUM_SCALP'),
    BRR_FIBO:         isStrategyEnabled(comboId, 'BRR_FIBO'),
    SMC_CLASSIC:      isStrategyEnabled(comboId, 'SMC_CLASSIC'),
    SMC_HL_STRUCTURE: isStrategyEnabled(comboId, 'SMC_HL_STRUCTURE'),
    TREND_FOLLOW:     isStrategyEnabled(comboId, 'TREND_FOLLOW'),
  };
}

// ── Database Helpers ───────────────────────────────────────

function getDB() {
  try { return require('./db'); }
  catch (e) { return null; }
}

async function initCombos() {
  if (_initialized) return;
  const db = getDB();
  if (!db) return;

  try {
    const existing = await db.query('SELECT combo_id FROM quantum_strategy_combos');
    if (existing.length >= TOTAL_COMBOS) {
      _initialized = true;
      return;
    }

    for (let id = 1; id <= TOTAL_COMBOS; id++) {
      const name = comboToName(id);
      const isDefault = id === 15;
      await db.query(
        `INSERT INTO quantum_strategy_combos (combo_id, combo_name, is_active, ema_win_rate)
         VALUES ($1, $2, $3, 0.5)
         ON CONFLICT (combo_id) DO NOTHING`,
        [id, name, isDefault]
      );
    }
    _initialized = true;
    bLog.ai('Quantum optimizer: seeded 15 strategy combos');
  } catch (err) {
    console.error('[Quantum] Init error:', err.message);
  }
}

// ── Get Active Combo ───────────────────────────────────────

async function getActiveCombo() {
  try {
    await initCombos();
    const db = getDB();
    if (!db) return 15;

    const rows = await db.query(
      'SELECT combo_id FROM quantum_strategy_combos WHERE is_active = true LIMIT 1'
    );
    return rows.length ? rows[0].combo_id : 15;
  } catch (err) {
    console.error('[Quantum] getActiveCombo error:', err.message);
    return 15;
  }
}

// ── Record Trade Outcome for a Combo ───────────────────────

async function recordComboTrade(comboId, { pnlPct, isWin }) {
  const db = getDB();
  if (!db || !comboId || comboId < 1 || comboId > TOTAL_COMBOS) return;

  try {
    const rows = await db.query(
      'SELECT * FROM quantum_strategy_combos WHERE combo_id = $1',
      [comboId]
    );
    if (!rows.length) return;

    const combo = rows[0];
    const newTrades = combo.total_trades + 1;
    const newWins = combo.wins + (isWin ? 1 : 0);
    const newLosses = combo.losses + (isWin ? 0 : 1);
    const newTotalPnl = parseFloat(combo.total_pnl) + pnlPct;
    const newAvgPnl = newTotalPnl / newTrades;
    const newWinRate = newWins / newTrades;

    // EMA win rate (same formula as ai-learner.js)
    const prevEma = parseFloat(combo.ema_win_rate) || 0.5;
    const newEmaWinRate = EMA_ALPHA * (isWin ? 1 : 0) + (1 - EMA_ALPHA) * prevEma;

    // Sharpe estimate: avg_pnl / estimated_stddev
    // Approximate stddev using variance update
    const oldAvg = combo.total_trades > 0 ? parseFloat(combo.total_pnl) / combo.total_trades : 0;
    const deviation = pnlPct - oldAvg;
    const prevSharpe = parseFloat(combo.sharpe_estimate) || 0;
    const estimatedStddev = Math.max(Math.abs(deviation), 0.1);
    const newSharpe = newAvgPnl / estimatedStddev;

    await db.query(
      `UPDATE quantum_strategy_combos SET
        total_trades = $1, wins = $2, losses = $3, total_pnl = $4,
        avg_pnl = $5, win_rate = $6, ema_win_rate = $7, sharpe_estimate = $8,
        last_trade_at = NOW(), updated_at = NOW()
       WHERE combo_id = $9`,
      [newTrades, newWins, newLosses, newTotalPnl.toFixed(4),
       newAvgPnl.toFixed(4), newWinRate.toFixed(4), newEmaWinRate.toFixed(4),
       newSharpe.toFixed(4), comboId]
    );

    _tradesSinceEval++;
    if (_tradesSinceEval >= EVAL_INTERVAL) {
      _tradesSinceEval = 0;
      await evaluateAndSwitch();
    }
  } catch (err) {
    console.error('[Quantum] recordComboTrade error:', err.message);
  }
}

// ── Composite Score ────────────────────────────────────────

function calcComposite(combo) {
  const ema = parseFloat(combo.ema_win_rate) || 0;
  const avgPnl = parseFloat(combo.avg_pnl) || 0;
  const sharpe = parseFloat(combo.sharpe_estimate) || 0;

  // Normalize avg_pnl to 0-1 range (cap at +/-5%)
  const normPnl = Math.max(0, Math.min(1, (avgPnl + 5) / 10));
  // Normalize sharpe to 0-1 range (cap at 3)
  const normSharpe = Math.max(0, Math.min(1, (sharpe + 1) / 4));

  return ema * 0.4 + normPnl * 0.3 + normSharpe * 0.3;
}

// ── Evaluate & Auto-Switch ─────────────────────────────────

async function evaluateAndSwitch() {
  const db = getDB();
  if (!db) return;

  try {
    const combos = await db.query(
      'SELECT * FROM quantum_strategy_combos ORDER BY combo_id'
    );
    if (!combos.length) return;

    const active = combos.find(c => c.is_active);
    if (!active) return;

    // Admin locked — no auto switch
    if (active.admin_locked) {
      bLog.ai(`Quantum: combo ${active.combo_id} (${active.combo_name}) is admin-locked — skipping eval`);
      return;
    }

    // Check if we're still exploring
    const underExplored = combos.filter(c => c.total_trades < MIN_TRADES_PER_COMBO);
    const isExploring = underExplored.length > 0;

    if (isExploring) {
      // Epsilon-greedy: 15% chance to explore an under-tested combo
      if (Math.random() < EXPLORE_EPSILON && underExplored.length > 0) {
        const pick = underExplored[Math.floor(Math.random() * underExplored.length)];

        // Mark current active as inactive, new one as active + exploring
        await db.query('UPDATE quantum_strategy_combos SET is_active = false, is_exploring = false WHERE is_active = true');
        await db.query('UPDATE quantum_strategy_combos SET is_active = true, is_exploring = true WHERE combo_id = $1', [pick.combo_id]);

        bLog.ai(`Quantum EXPLORE: switched to combo ${pick.combo_id} (${pick.combo_name}) — ${pick.total_trades}/${MIN_TRADES_PER_COMBO} trades`);
        return;
      }
    }

    // Exploitation: find best combo with enough data
    const eligible = combos.filter(c => c.total_trades >= MIN_TRADES_PER_COMBO);
    if (!eligible.length) return;

    const scored = eligible.map(c => ({ ...c, composite: calcComposite(c) }));
    scored.sort((a, b) => b.composite - a.composite);
    const best = scored[0];

    const activeComposite = calcComposite(active);
    const improvement = best.composite - activeComposite;

    if (best.combo_id !== active.combo_id && improvement > SWITCH_MARGIN) {
      await db.query('UPDATE quantum_strategy_combos SET is_active = false, is_exploring = false WHERE is_active = true');
      await db.query('UPDATE quantum_strategy_combos SET is_active = true, is_exploring = false WHERE combo_id = $1', [best.combo_id]);

      bLog.ai(
        `Quantum SWITCH: ${active.combo_name} (${activeComposite.toFixed(3)}) → ${best.combo_name} (${best.composite.toFixed(3)}) | ` +
        `improvement=${(improvement * 100).toFixed(1)}% | WR=${(parseFloat(best.ema_win_rate) * 100).toFixed(0)}% avgPnL=${parseFloat(best.avg_pnl).toFixed(2)}%`
      );

      // Log to parameter history
      try {
        await db.query(
          `INSERT INTO ai_parameter_history (param_name, old_value, new_value, reason, trade_count, win_rate)
           VALUES ('quantum_combo', $1, $2, $3, $4, $5)`,
          [active.combo_id, best.combo_id,
           `Auto-switch: ${best.combo_name} scored ${best.composite.toFixed(3)} vs ${activeComposite.toFixed(3)}`,
           best.total_trades, best.win_rate]
        );
      } catch (e) { console.error('[Quantum] param history log error:', e.message); }
    }
  } catch (err) {
    console.error('[Quantum] evaluateAndSwitch error:', err.message);
  }
}

// ── Backtest Seeding ───────────────────────────────────────

async function resetAndSeedFromBacktest(results) {
  const db = getDB();
  if (!db) return false;

  try {
    await initCombos();

    let bestCombo = 15;
    let bestScore = -Infinity;

    for (const r of results) {
      if (r.comboId < 1 || r.comboId > 15) continue;

      const winRate = r.trades > 0 ? r.wins / r.trades : 0;
      const avgPnl = r.trades > 0 ? r.totalPnl / r.trades : 0;
      const emaWinRate = winRate; // use raw WR from backtest

      // Approximate sharpe
      const stddev = Math.max(Math.abs(avgPnl), 0.1);
      const sharpe = avgPnl / stddev;

      const composite = calcComposite({
        ema_win_rate: emaWinRate, avg_pnl: avgPnl, sharpe_estimate: sharpe,
      });

      if (composite > bestScore && r.trades >= 3) {
        bestScore = composite;
        bestCombo = r.comboId;
      }

      await db.query(
        `UPDATE quantum_strategy_combos SET
          total_trades = $1, wins = $2, losses = $3, total_pnl = $4,
          avg_pnl = $5, win_rate = $6, ema_win_rate = $7, sharpe_estimate = $8,
          best_params = $9,
          is_active = false, is_exploring = false, admin_locked = false,
          last_trade_at = NOW(), updated_at = NOW()
         WHERE combo_id = $10`,
        [r.trades, r.wins, r.losses, r.totalPnl.toFixed(4),
         avgPnl.toFixed(4), winRate.toFixed(4), emaWinRate.toFixed(4),
         sharpe.toFixed(4), JSON.stringify(r.bestParams || {}), r.comboId]
      );
    }

    // Activate best combo
    await db.query('UPDATE quantum_strategy_combos SET is_active = true WHERE combo_id = $1', [bestCombo]);
    bLog.ai(`Quantum BACKTEST: seeded ${results.length} combos, best=#${bestCombo} (${comboToName(bestCombo)}) score=${bestScore.toFixed(3)}`);
    return bestCombo;
  } catch (err) {
    console.error('[Quantum] resetAndSeedFromBacktest error:', err.message);
    return false;
  }
}

// ── Load Best Params for Active Combo ──────────────────────

async function getActiveParams() {
  try {
    const db = getDB();
    if (!db) return {};
    const rows = await db.query('SELECT best_params FROM quantum_strategy_combos WHERE is_active = true LIMIT 1');
    if (rows.length && rows[0].best_params) return rows[0].best_params;
    return {};
  } catch { return {}; }
}

// ── Admin Controls ─────────────────────────────────────────

async function adminSetCombo(comboId) {
  const db = getDB();
  if (!db || comboId < 1 || comboId > TOTAL_COMBOS) return false;

  try {
    await db.query('UPDATE quantum_strategy_combos SET is_active = false, is_exploring = false, admin_locked = false WHERE is_active = true');
    await db.query('UPDATE quantum_strategy_combos SET is_active = true, admin_locked = true WHERE combo_id = $1', [comboId]);
    bLog.ai(`Quantum ADMIN: forced combo ${comboId} (${comboToName(comboId)}) — locked`);
    return true;
  } catch (err) {
    console.error('[Quantum] adminSetCombo error:', err.message);
    return false;
  }
}

async function adminUnlockCombo() {
  const db = getDB();
  if (!db) return false;

  try {
    await db.query('UPDATE quantum_strategy_combos SET admin_locked = false WHERE admin_locked = true');
    bLog.ai('Quantum ADMIN: unlocked — auto-optimization resumed');
    return true;
  } catch (err) {
    console.error('[Quantum] adminUnlockCombo error:', err.message);
    return false;
  }
}

// ── Stats for API ──────────────────────────────────────────

async function getComboStats() {
  const db = getDB();
  if (!db) return [];

  try {
    await initCombos();
    const combos = await db.query(
      'SELECT * FROM quantum_strategy_combos ORDER BY combo_id'
    );

    const explored = combos.filter(c => c.total_trades >= MIN_TRADES_PER_COMBO).length;

    return {
      combos: combos.map(c => ({
        combo_id: c.combo_id,
        combo_name: c.combo_name,
        strategies: getEnabledStrategies(c.combo_id),
        total_trades: c.total_trades,
        wins: c.wins,
        losses: c.losses,
        win_rate: parseFloat(c.win_rate) || 0,
        ema_win_rate: parseFloat(c.ema_win_rate) || 0,
        avg_pnl: parseFloat(c.avg_pnl) || 0,
        sharpe_estimate: parseFloat(c.sharpe_estimate) || 0,
        composite_score: calcComposite(c),
        is_active: c.is_active,
        is_exploring: c.is_exploring,
        admin_locked: c.admin_locked,
        last_trade_at: c.last_trade_at,
      })),
      exploration_progress: {
        explored,
        total: TOTAL_COMBOS,
        min_trades: MIN_TRADES_PER_COMBO,
      },
      current_phase: explored >= TOTAL_COMBOS ? 'exploiting' : 'exploring',
    };
  } catch (err) {
    console.error('[Quantum] getComboStats error:', err.message);
    return { combos: [], exploration_progress: { explored: 0, total: 15, min_trades: 20 }, current_phase: 'error' };
  }
}

module.exports = {
  initCombos,
  getActiveCombo,
  getEnabledStrategies,
  recordComboTrade,
  evaluateAndSwitch,
  getComboStats,
  adminSetCombo,
  adminUnlockCombo,
  resetAndSeedFromBacktest,
  getActiveParams,
  comboToName,
  isStrategyEnabled,
  STRATEGIES,
};
