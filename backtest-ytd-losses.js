// Compatibility entrypoint for the existing loss-backtest GitHub workflow.
// It reports the same closed-trade loser breakdown over a longer default window.

process.env.DAYS = process.env.DAYS || process.env.BACKTEST_DAYS || '365';
require('./analyze-trade-wr');
