// ════════════════════════════════════════════════════════════════
//  user-trade-diag.js
//  Dump every api_key's trading status — flags and outstanding
//  reasons each user is or isn't trading.
//
//  Reasons checked:
//    enabled / paused_by_admin / paused_by_user
//    user row missing (orphan key)
//    loss_cooldown_until in the future
//    Recent 4h LOSS on each active symbol
//    Active OPEN trades (counts toward max_positions)
//    Last trade timestamp
// ════════════════════════════════════════════════════════════════

'use strict';

const { query } = require('./db');

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT'];

function pad(s, n) { return String(s ?? '-').slice(0, n).padEnd(n); }
function fmt(d) { return d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '-'; }

(async () => {
  try {
    const keys = await query(
      `SELECT ak.id, ak.user_id, ak.platform, ak.enabled,
              ak.paused_by_admin, ak.paused_by_user,
              ak.loss_cooldown_until, ak.max_positions, ak.max_loss_usdt,
              u.email
       FROM api_keys ak
       LEFT JOIN users u ON u.id = ak.user_id
       ORDER BY ak.id ASC`
    );

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  USER TRADE DIAG — ${new Date().toISOString()}`);
    console.log(`  ${keys.length} api_key(s) total`);
    console.log('═══════════════════════════════════════════════════════════');

    let tradeable = 0;
    for (const k of keys) {
      const reasons = [];
      const flags   = [];

      if (!k.email)                               reasons.push('orphan-no-user-row');
      if (k.enabled === false)                    reasons.push('enabled=false');
      if (k.paused_by_admin)                      reasons.push('paused_by_admin');
      if (k.paused_by_user)                       reasons.push('paused_by_user');
      if (k.loss_cooldown_until && new Date(k.loss_cooldown_until) > new Date()) {
        reasons.push(`loss_cooldown_until=${fmt(k.loss_cooldown_until)}`);
      }

      // Open positions for this user
      const openTrades = await query(
        `SELECT symbol FROM trades WHERE user_id = $1 AND status = 'OPEN'`,
        [k.user_id]
      );
      const maxPos = Math.max(5, parseInt(k.max_positions) || 5);
      flags.push(`open=${openTrades.length}/${maxPos}`);
      if (openTrades.length >= maxPos) reasons.push(`at-max-pos(${openTrades.length}/${maxPos})`);

      // Recent loss cooldowns per symbol (4h)
      const recentLosses = await query(
        `SELECT symbol, closed_at FROM trades
         WHERE user_id = $1 AND status = 'LOSS'
           AND closed_at > NOW() - INTERVAL '4 hours'
         ORDER BY closed_at DESC`,
        [k.user_id]
      );
      const lockedSyms = recentLosses.map(r => r.symbol);
      const availSyms  = SYMBOLS.filter(s => !lockedSyms.includes(s));
      if (lockedSyms.length) flags.push(`4h-loss-locked: ${lockedSyms.join(',')}`);
      flags.push(`tradeable-syms: ${availSyms.join(',') || 'NONE'}`);

      // Last trade
      const last = await query(
        `SELECT symbol, status, opened_at, closed_at
         FROM trades WHERE user_id = $1
         ORDER BY COALESCE(closed_at, opened_at) DESC LIMIT 1`,
        [k.user_id]
      );
      if (last[0]) {
        flags.push(`last: ${last[0].symbol} ${last[0].status} ${fmt(last[0].closed_at || last[0].opened_at)}`);
      } else {
        flags.push('last: never');
      }

      const isTradeable = reasons.length === 0 && availSyms.length > 0 && openTrades.length < maxPos;
      if (isTradeable) tradeable++;

      console.log('');
      console.log(`#${k.id} ${k.email || `(orphan uid=${k.user_id})`}  [${k.platform || '?'}]  ${isTradeable ? '✅ TRADEABLE' : '🚫 BLOCKED'}`);
      if (reasons.length) console.log(`   blocked: ${reasons.join(' | ')}`);
      console.log(`   ${flags.join(' | ')}`);
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  SUMMARY: ${tradeable}/${keys.length} keys can trade right now`);
    console.log('═══════════════════════════════════════════════════════════');

    process.exit(0);
  } catch (e) {
    console.error('Failed:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
