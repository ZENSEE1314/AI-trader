// Quick diagnostic: analyze all losing trades
// Run on Railway: node analyze-losses.js

const { query } = require('./db');

(async () => {
  console.log('\n=== LOSING TRADE ANALYSIS ===\n');

  const losses = await query(`
    SELECT symbol, direction, status,
           entry_price, sl_price, tp_price, exit_price,
           pnl_usdt, pnl_pct, leverage,
           created_at, closed_at
    FROM trades
    WHERE status IN ('LOSS', 'SL')
       OR (status = 'CLOSED' AND pnl_usdt < 0)
    ORDER BY created_at DESC
    LIMIT 30
  `);

  if (!losses.length) {
    console.log('No losing trades found.');
    process.exit(0);
  }

  console.log(`Total losing trades: ${losses.length}\n`);

  for (const t of losses) {
    const entry = parseFloat(t.entry_price) || 0;
    const sl = parseFloat(t.sl_price) || 0;
    const tp = parseFloat(t.tp_price) || 0;
    const exit = parseFloat(t.exit_price) || 0;
    const pnl = parseFloat(t.pnl_usdt) || 0;
    const isLong = t.direction !== 'SHORT';

    // Did it hit SL?
    const hitSL = sl > 0 && (isLong ? exit <= sl : exit >= sl);
    // Was exit near TP but reversed?
    const tpDist = tp > 0 ? Math.abs(exit - tp) / tp * 100 : null;
    const nearTP = tpDist !== null && tpDist < 0.5;
    // SL distance from entry
    const slDist = sl > 0 ? (Math.abs(entry - sl) / entry * 100).toFixed(3) : '?';
    // How far did price move in our direction before reversing?
    const duration = t.closed_at && t.created_at
      ? Math.round((new Date(t.closed_at) - new Date(t.created_at)) / 60000)
      : '?';

    console.log(`${t.symbol} ${t.direction} | PnL: $${pnl.toFixed(4)} | Status: ${t.status}`);
    console.log(`  Entry: $${entry} → Exit: $${exit} | SL: $${sl} | TP: $${tp}`);
    console.log(`  SL dist: ${slDist}% | Hit SL: ${hitSL ? 'YES' : 'NO'} | Near TP: ${nearTP ? 'YES (almost!)' : 'NO'} | Duration: ${duration}min`);
    console.log(`  Time: ${t.created_at}`);
    console.log('');
  }

  // Summary stats
  const totalLost = losses.reduce((s, t) => s + (parseFloat(t.pnl_usdt) || 0), 0);
  const avgLoss = totalLost / losses.length;
  const hitSLCount = losses.filter(t => {
    const sl = parseFloat(t.sl_price) || 0;
    const exit = parseFloat(t.exit_price) || 0;
    const isLong = t.direction !== 'SHORT';
    return sl > 0 && (isLong ? exit <= sl : exit >= sl);
  }).length;

  const shortLosses = losses.filter(t => t.direction === 'SHORT').length;
  const longLosses = losses.filter(t => t.direction !== 'SHORT').length;

  // By symbol
  const bySymbol = {};
  for (const t of losses) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { count: 0, total: 0 };
    bySymbol[t.symbol].count++;
    bySymbol[t.symbol].total += parseFloat(t.pnl_usdt) || 0;
  }
  const worstCoins = Object.entries(bySymbol)
    .sort((a, b) => a[1].total - b[1].total)
    .slice(0, 5);

  console.log('=== SUMMARY ===');
  console.log(`Total lost: $${totalLost.toFixed(4)}`);
  console.log(`Avg loss per trade: $${avgLoss.toFixed(4)}`);
  console.log(`Hit SL: ${hitSLCount}/${losses.length} (${(hitSLCount/losses.length*100).toFixed(0)}%)`);
  console.log(`Direction: ${longLosses} LONG losses, ${shortLosses} SHORT losses`);
  console.log(`\nWorst coins:`);
  for (const [sym, data] of worstCoins) {
    console.log(`  ${sym}: ${data.count} losses, $${data.total.toFixed(4)}`);
  }

  // Check wins for comparison
  const wins = await query(`
    SELECT COUNT(*) as count, COALESCE(SUM(pnl_usdt), 0) as total,
           COALESCE(AVG(pnl_usdt), 0) as avg_win
    FROM trades
    WHERE status IN ('WIN') OR (status = 'CLOSED' AND pnl_usdt > 0)
  `);
  const w = wins[0];
  console.log(`\nFor comparison — Wins: ${w.count} trades, total +$${parseFloat(w.total).toFixed(4)}, avg +$${parseFloat(w.avg_win).toFixed(4)}`);
  console.log(`Avg win $${parseFloat(w.avg_win).toFixed(4)} vs Avg loss $${Math.abs(avgLoss).toFixed(4)} → ${Math.abs(parseFloat(w.avg_win) / avgLoss).toFixed(2)}:1 RR`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
