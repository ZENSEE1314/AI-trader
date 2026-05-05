'use strict';
// ════════════════════════════════════════════════════════════════
//  chart-agent-memory.js  —  Self-learning memory for ChartAgent
//
//  Every signal ChartAgent fires is stored with its market profile.
//  When a trade closes, the outcome is recorded.
//  Before each new analysis, past lessons are loaded and injected
//  into Claude/Ollama's prompt so it gets smarter over time.
//
//  Daily review: Ollama synthesizes yesterday's trade outcomes
//  into durable lessons ("EQH sweeps before LONG entry = 78% WR").
// ════════════════════════════════════════════════════════════════

const { query } = require('./db');

// ── DB tables (auto-create) ───────────────────────────────────

async function initTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS chart_agent_signals (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(30),
      side VARCHAR(10),
      confidence VARCHAR(10),
      reason TEXT,
      market_profile TEXT,
      vwap_slope VARCHAR(10),
      structure TEXT,
      entry_price DECIMAL,
      exit_price DECIMAL,
      pnl_pct DECIMAL,
      outcome VARCHAR(10) DEFAULT 'OPEN',
      session VARCHAR(20),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS chart_agent_lessons (
      id SERIAL PRIMARY KEY,
      lesson_date DATE UNIQUE,
      lessons_json TEXT,
      trades_analyzed INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── Save a new signal ─────────────────────────────────────────

async function saveSignal({ symbol, side, confidence, reason, marketProfile, vwapSlope, structure, entryPrice }) {
  try {
    await initTables();
    const utcH = new Date().getUTCHours();
    const session = utcH >= 23 || utcH <= 2 ? 'asia'
      : utcH >= 7  && utcH <= 10 ? 'asia_europe'
      : utcH >= 12 && utcH <= 16 ? 'europe_us' : 'off_hours';

    const rows = await query(
      `INSERT INTO chart_agent_signals
         (symbol, side, confidence, reason, market_profile, vwap_slope, structure, entry_price, session)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [symbol, side, confidence, reason, marketProfile, vwapSlope, structure, entryPrice, session]
    );
    return rows[0]?.id || null;
  } catch (e) {
    console.error('[ChartMemory] saveSignal error:', e.message);
    return null;
  }
}

// ── Record outcome when trade closes ─────────────────────────

async function recordOutcome(symbol, side, entryPrice, exitPrice, pnlPct) {
  try {
    await initTables();
    const outcome = pnlPct > 0 ? 'WIN' : 'LOSS';
    await query(
      `UPDATE chart_agent_signals
       SET exit_price=$1, pnl_pct=$2, outcome=$3, closed_at=NOW()
       WHERE symbol=$4 AND side=$5 AND outcome='OPEN'
         AND entry_price BETWEEN $6*0.998 AND $6*1.002
       ORDER BY created_at DESC
       LIMIT 1`,
      [exitPrice, pnlPct, outcome, symbol, side, entryPrice]
    );
  } catch (e) {
    console.error('[ChartMemory] recordOutcome error:', e.message);
  }
}

// ── Get lessons for a symbol ─────────────────────────────────
// Returns a formatted string to inject into Claude/Ollama's prompt.

async function getLessons(symbol) {
  try {
    await initTables();

    // 1. Recent trade stats for this symbol (last 30 closed trades)
    const recent = await query(
      `SELECT side, confidence, vwap_slope, structure, pnl_pct, outcome
       FROM chart_agent_signals
       WHERE symbol=$1 AND outcome IN ('WIN','LOSS')
       ORDER BY closed_at DESC LIMIT 30`,
      [symbol]
    );

    // 2. Overall stats by side
    const stats = await query(
      `SELECT side,
         COUNT(*) as total,
         SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
         ROUND(AVG(pnl_pct)::numeric,2) as avg_pnl
       FROM chart_agent_signals
       WHERE symbol=$1 AND outcome IN ('WIN','LOSS')
       GROUP BY side`,
      [symbol]
    );

    // 3. Best / worst vwap_slope + side combos
    const patterns = await query(
      `SELECT side, vwap_slope,
         COUNT(*) as total,
         SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins
       FROM chart_agent_signals
       WHERE symbol=$1 AND outcome IN ('WIN','LOSS') AND vwap_slope IS NOT NULL
       GROUP BY side, vwap_slope
       HAVING COUNT(*) >= 3
       ORDER BY (SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END)::float / COUNT(*)) DESC`,
      [symbol]
    );

    // 4. Today's synthesized lesson (if daily review ran)
    const today = new Date().toISOString().slice(0, 10);
    const lessonRow = await query(
      `SELECT lessons_json FROM chart_agent_lessons
       WHERE lesson_date >= (CURRENT_DATE - INTERVAL '3 days')
       ORDER BY lesson_date DESC LIMIT 1`
    );

    if (!recent.length && !lessonRow.length) return '';

    const lines = [`\n── ChartAgent Memory: ${symbol} ──`];

    // Stats per side
    for (const s of stats) {
      const wr = Math.round(parseInt(s.wins) / parseInt(s.total) * 100);
      lines.push(`${s.side}: ${s.total} trades, ${wr}% WR, avg PnL ${s.avg_pnl}%`);
    }

    // Best patterns
    if (patterns.length) {
      lines.push('Best entry conditions (historically):');
      for (const p of patterns.slice(0, 3)) {
        const wr = Math.round(parseInt(p.wins) / parseInt(p.total) * 100);
        lines.push(`  ${p.side} + VWAP ${p.vwap_slope}: ${wr}% WR (${p.total} trades)`);
      }
    }

    // Recent 5 trades
    if (recent.length) {
      lines.push(`Last ${Math.min(5, recent.length)} trades: ${recent.slice(0,5).map(t => `${t.side}${t.outcome==='WIN'?'✓':'✗'}(${t.pnl_pct>0?'+':''}${parseFloat(t.pnl_pct).toFixed(1)}%)`).join(', ')}`);
    }

    // Synthesized lessons
    if (lessonRow.length) {
      try {
        const lessons = JSON.parse(lessonRow[0].lessons_json);
        if (lessons.length) {
          lines.push('Learned rules:');
          for (const l of lessons.slice(0, 4)) lines.push(`  • ${l}`);
        }
      } catch (_) {}
    }

    return lines.join('\n');
  } catch (e) {
    console.error('[ChartMemory] getLessons error:', e.message);
    return '';
  }
}

// ── Daily review: synthesize lessons from past trades ─────────
// Called once per day. Uses Ollama (or Claude) to extract patterns.

async function runDailyReview(askFn, log = console.log) {
  try {
    await initTables();
    const today = new Date().toISOString().slice(0, 10);

    // Already ran today?
    const existing = await query(
      `SELECT id FROM chart_agent_lessons WHERE lesson_date = $1`, [today]
    );
    if (existing.length) return;

    // Fetch yesterday's closed trades
    const trades = await query(
      `SELECT symbol, side, confidence, vwap_slope, structure, pnl_pct, outcome, session
       FROM chart_agent_signals
       WHERE outcome IN ('WIN','LOSS')
         AND closed_at >= NOW() - INTERVAL '24 hours'
       ORDER BY closed_at DESC`
    );

    if (trades.length < 3) {
      log('[ChartMemory] Not enough trades for daily review yet');
      return;
    }

    const tradeLines = trades.map(t =>
      `${t.symbol} ${t.side} [${t.confidence}] VWAP-${t.vwap_slope} struct="${t.structure}" → ${t.outcome} ${t.pnl_pct > 0 ? '+' : ''}${parseFloat(t.pnl_pct).toFixed(1)}%`
    ).join('\n');

    const prompt = `You are reviewing yesterday's ChartAgent trading decisions to extract lessons.

Here are the trades from the last 24 hours:
${tradeLines}

Analyze the wins vs losses. Look for patterns in:
- VWAP slope (rising/falling/flat) and whether LONG/SHORT worked
- Market structure (HH+HL, LL+LH, etc.) and outcomes
- Which conditions consistently won vs lost

Return a JSON array of 3-6 concise lessons learned (each under 20 words):
["lesson1", "lesson2", "lesson3"]

Only return the JSON array, nothing else.`;

    const result = await askFn(prompt);
    if (!result) return;

    try {
      const lessons = JSON.parse(result.match(/\[[\s\S]*?\]/)?.[0] || '[]');
      if (!lessons.length) return;

      await query(
        `INSERT INTO chart_agent_lessons (lesson_date, lessons_json, trades_analyzed)
         VALUES ($1, $2, $3)
         ON CONFLICT (lesson_date) DO UPDATE SET lessons_json=$2, trades_analyzed=$3`,
        [today, JSON.stringify(lessons), trades.length]
      );

      log(`[ChartMemory] Daily review complete: ${lessons.length} lessons from ${trades.length} trades`);
      log(`[ChartMemory] Lessons: ${lessons.join(' | ')}`);
    } catch (_) {}
  } catch (e) {
    console.error('[ChartMemory] dailyReview error:', e.message);
  }
}

// ── Performance summary ───────────────────────────────────────

async function getSummary() {
  try {
    await initTables();
    const overall = await query(
      `SELECT COUNT(*) as total,
         SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
         SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses,
         ROUND(AVG(CASE WHEN outcome IN ('WIN','LOSS') THEN pnl_pct END)::numeric,2) as avg_pnl,
         COUNT(CASE WHEN outcome='OPEN' THEN 1 END) as open_trades
       FROM chart_agent_signals`
    );
    const bySymbol = await query(
      `SELECT symbol,
         COUNT(*) as total,
         SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
         ROUND(AVG(CASE WHEN outcome IN ('WIN','LOSS') THEN pnl_pct END)::numeric,2) as avg_pnl
       FROM chart_agent_signals
       WHERE outcome IN ('WIN','LOSS')
       GROUP BY symbol ORDER BY AVG(pnl_pct) DESC`
    );
    return { overall: overall[0], bySymbol };
  } catch (e) {
    return null;
  }
}

module.exports = { saveSignal, recordOutcome, getLessons, runDailyReview, getSummary, initTables };
