// ============================================================
// AccountantAgent — Trade auditing & PnL correction
//
// Audits trade history, recalculates PnL from exchange data,
// fixes missing fees, and generates financial reports.
// ============================================================

const { BaseAgent } = require('./base-agent');
const { log: bLog } = require('../bot-logger');

class AccountantAgent extends BaseAgent {
  constructor(options = {}) {
    super('AccountantAgent', options);
    this.lastAuditResult = null;
    this.auditsRun = 0;
    this.tradesFixed = 0;
    this.totalFeesRecovered = 0;

    this._profile = {
      description: 'Audits all trade history, recalculates PnL from exchange data, fixes missing fees and incorrect amounts.',
      role: 'Trade Auditor',
      icon: 'accountant',
      skills: [
        { id: 'audit_pnl', name: 'PnL Audit', description: 'Check all trades for incorrect or missing PnL values', enabled: true },
        { id: 'fix_fees', name: 'Fee Recovery', description: 'Fetch actual trading fees from exchange and update records', enabled: true },
        { id: 'recalc_gross', name: 'Gross PnL Recalc', description: 'Recalculate gross PnL from entry/exit prices', enabled: true },
        { id: 'report', name: 'Financial Report', description: 'Generate summary of all trades with totals', enabled: true },
        { id: 'memory', name: 'Memory', description: 'Remember audit results and track fixes across restarts', enabled: true },
        { id: 'self_learn', name: 'Self-Learning', description: 'Learn which trade types have fee issues and flag them early', enabled: true },
      ],
      config: [
        { key: 'auditLimit', label: 'Max Trades to Audit', type: 'number', value: options.auditLimit || 100, min: 10, max: 500 },
      ],
    };
  }

  async execute(context = {}) {
    const { mode = 'audit' } = context;
    this.auditsRun++;

    if (mode === 'audit') return this.runFullAudit();
    if (mode === 'report') return this.generateReport();
    return this.runFullAudit();
  }

  async runFullAudit() {
    this.currentTask = { description: 'Auditing all trade history', startedAt: Date.now() };
    this.addActivity('info', 'Starting full trade audit...');

    let db;
    try { db = require('../db'); } catch (e) {
      this.addActivity('error', 'Database not available');
      return { ok: false, error: 'Database not available' };
    }

    // Step 1: Find all closed trades
    const trades = await db.query(
      `SELECT t.*, ak.api_key_enc, ak.iv, ak.auth_tag,
              ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag,
              ak.platform
       FROM trades t
       LEFT JOIN api_keys ak ON ak.id = t.api_key_id
       WHERE t.status IN ('WIN','LOSS','TP','SL','CLOSED')
       ORDER BY t.closed_at DESC
       LIMIT $1`,
      [this._profile.config.find(c => c.key === 'auditLimit')?.value || 100]
    );

    this.addActivity('info', `Found ${trades.length} closed trades to audit`);

    let issues = [];
    let fixed = 0;
    let totalFeeRecovered = 0;

    for (const trade of trades) {
      const problems = [];
      const entryPrice = parseFloat(trade.entry_price) || 0;
      const exitPrice = parseFloat(trade.exit_price) || 0;
      const qty = parseFloat(trade.quantity) || 0;
      const isLong = trade.direction !== 'SHORT';
      const currentPnl = parseFloat(trade.pnl_usdt) || 0;
      const currentFee = parseFloat(trade.trading_fee) || 0;
      const currentGross = trade.gross_pnl != null ? parseFloat(trade.gross_pnl) : null;

      // Check 1: Missing exit price
      if (!exitPrice || exitPrice === 0) {
        problems.push('missing_exit_price');
      }

      // Check 2: Recalculate gross PnL from prices
      if (entryPrice > 0 && exitPrice > 0 && qty > 0) {
        const calcGross = isLong
          ? (exitPrice - entryPrice) * qty
          : (entryPrice - exitPrice) * qty;
        const calcGrossRound = parseFloat(calcGross.toFixed(4));

        // Check if gross_pnl is missing or wrong
        if (currentGross === null) {
          problems.push('missing_gross_pnl');
          await db.query('UPDATE trades SET gross_pnl = $1 WHERE id = $2', [calcGrossRound, trade.id]);
          fixed++;
        } else if (Math.abs(currentGross - calcGrossRound) > 0.01) {
          problems.push(`gross_pnl_mismatch: stored=${currentGross} calc=${calcGrossRound}`);
          await db.query('UPDATE trades SET gross_pnl = $1 WHERE id = $2', [calcGrossRound, trade.id]);
          fixed++;
        }
      }

      // Check 3: Missing fee — try to fetch from exchange
      if (currentFee === 0 && trade.api_key_enc) {
        try {
          const fee = await this._fetchTradeFee(trade, db);
          if (fee > 0) {
            await db.query('UPDATE trades SET trading_fee = $1 WHERE id = $2', [fee, trade.id]);
            totalFeeRecovered += fee;
            fixed++;
            problems.push(`fee_recovered: $${fee.toFixed(4)}`);
          }
        } catch (e) {
          // Can't fetch fee — skip
        }
      }

      // Check 4: PnL sign vs status mismatch
      if (currentPnl > 0 && (trade.status === 'LOSS' || trade.status === 'SL')) {
        problems.push(`status_mismatch: pnl=+${currentPnl} but status=${trade.status}`);
        await db.query('UPDATE trades SET status = $1 WHERE id = $2', ['WIN', trade.id]);
        fixed++;
      } else if (currentPnl < 0 && (trade.status === 'WIN' || trade.status === 'TP')) {
        problems.push(`status_mismatch: pnl=${currentPnl} but status=${trade.status}`);
        await db.query('UPDATE trades SET status = $1 WHERE id = $2', ['LOSS', trade.id]);
        fixed++;
      }

      if (problems.length > 0) {
        issues.push({ id: trade.id, symbol: trade.symbol, problems });
      }
    }

    this.tradesFixed += fixed;
    this.totalFeesRecovered += totalFeeRecovered;
    this.currentTask = null;

    const result = {
      totalAudited: trades.length,
      issuesFound: issues.length,
      fixed,
      feesRecovered: parseFloat(totalFeeRecovered.toFixed(4)),
      issues: issues.slice(0, 20), // top 20 for display
    };
    this.lastAuditResult = result;
    this.addActivity('success', `Audit done: ${trades.length} trades, ${issues.length} issues, ${fixed} fixed, $${totalFeeRecovered.toFixed(2)} fees recovered`);
    // NOTE: XP awarded only on winning trades (see cycle.js). Earnings tracked there too.

    // Memory: remember audit results
    if (this.isSkillEnabled('memory')) {
      await this.remember('last_audit', result, 'audit');
      const totalAudits = (await this.recall('total_audits')) || 0;
      await this.remember('total_audits', totalAudits + 1, 'stats');
      const totalFixed = (await this.recall('lifetime_fixes')) || 0;
      await this.remember('lifetime_fixes', totalFixed + fixed, 'stats');
    }
    // Learn: which platforms have fee issues
    if (this.isSkillEnabled('self_learn') && issues.length > 0) {
      const platforms = {};
      for (const i of issues) {
        const t = trades.find(t => t.id === i.id);
        if (t) platforms[t.platform] = (platforms[t.platform] || 0) + 1;
      }
      for (const [platform, count] of Object.entries(platforms)) {
        await this.learn('fee_issues', { platform }, { count },
          `${platform}: ${count} trades with fee issues`, count);
      }
    }

    return result;
  }

  async _fetchTradeFee(trade, db) {
    let cryptoUtils;
    try { cryptoUtils = require('../crypto-utils'); } catch { return 0; }

    const apiKey = cryptoUtils.decrypt(trade.api_key_enc, trade.iv, trade.auth_tag);
    const apiSecret = cryptoUtils.decrypt(trade.api_secret_enc, trade.secret_iv, trade.secret_auth_tag);

    if (trade.platform === 'binance') {
      const { USDMClient } = require('binance');
      const { getBinanceRequestOptions } = require('../proxy-agent');
      const client = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
      const openTime = trade.created_at ? new Date(trade.created_at).getTime() : Date.now() - 7 * 86400000;
      const fills = await client.getAccountTrades({ symbol: trade.symbol, startTime: openTime, limit: 50 });
      let totalFee = 0;
      for (const f of (fills || [])) {
        totalFee += Math.abs(parseFloat(f.commission || 0));
      }
      return parseFloat(totalFee.toFixed(4));
    } else if (trade.platform === 'bitunix') {
      const { BitunixClient } = require('../bitunix-client');
      const client = new BitunixClient({ apiKey, apiSecret });
      const positions = await client.getHistoryPositions({ symbol: trade.symbol, pageSize: 20 });
      for (const p of (positions || [])) {
        const ep = parseFloat(p.entryPrice || 0);
        if (Math.abs(ep - parseFloat(trade.entry_price)) / parseFloat(trade.entry_price) < 0.002) {
          const fee = Math.abs(parseFloat(p.fee || 0));
          const funding = Math.abs(parseFloat(p.funding || 0));
          return parseFloat((fee + funding).toFixed(4));
        }
      }
    }
    return 0;
  }

  async generateReport() {
    this.currentTask = { description: 'Generating financial report', startedAt: Date.now() };
    let db;
    try { db = require('../db'); } catch { return { ok: false, error: 'DB unavailable' }; }

    const stats = await db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status IN ('WIN','TP')) as wins,
        COUNT(*) FILTER (WHERE status IN ('LOSS','SL')) as losses,
        COALESCE(SUM(pnl_usdt), 0) as total_net_pnl,
        COALESCE(SUM(gross_pnl), 0) as total_gross_pnl,
        COALESCE(SUM(trading_fee), 0) as total_fees,
        COALESCE(AVG(pnl_usdt), 0) as avg_pnl,
        MAX(pnl_usdt) as best_trade,
        MIN(pnl_usdt) as worst_trade
      FROM trades
      WHERE status IN ('WIN','LOSS','TP','SL','CLOSED')
    `);

    const s = stats[0];
    this.currentTask = null;
    this.addActivity('success', 'Financial report generated');

    return {
      total: parseInt(s.total),
      wins: parseInt(s.wins),
      losses: parseInt(s.losses),
      winRate: parseInt(s.total) > 0 ? ((parseInt(s.wins) / parseInt(s.total)) * 100).toFixed(1) : '0',
      totalNetPnl: parseFloat(parseFloat(s.total_net_pnl).toFixed(2)),
      totalGrossPnl: parseFloat(parseFloat(s.total_gross_pnl).toFixed(2)),
      totalFees: parseFloat(parseFloat(s.total_fees).toFixed(2)),
      avgPnl: parseFloat(parseFloat(s.avg_pnl).toFixed(4)),
      bestTrade: parseFloat(parseFloat(s.best_trade || 0).toFixed(2)),
      worstTrade: parseFloat(parseFloat(s.worst_trade || 0).toFixed(2)),
    };
  }

  async syncBitunixHistory() {
    this.currentTask = { description: 'Syncing full Bitunix trade history', startedAt: Date.now() };
    this.addActivity('info', 'Starting Bitunix trade history synchronization...');

    let db;
    try { db = require('../db'); } catch (e) {
      this.addActivity('error', 'Database not available');
      return { ok: false, error: 'Database not available' };
    }

    let keys;
    try {
      keys = await db.query(`SELECT * FROM api_keys WHERE platform = 'bitunix' AND enabled = true`);
    } catch (e) {
      this.addActivity('error', `Failed to fetch API keys: ${e.message}`);
      return { ok: false, error: e.message };
    }

    let totalSynced = 0;
    let totalUpdated = 0;

    for (const key of keys) {
      try {
        let cryptoUtils;
        try { cryptoUtils = require('../crypto-utils'); } catch { continue; }
        const apiKey = cryptoUtils.decrypt(key.api_key_enc, key.iv, key.auth_tag);
        const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);

        const { BitunixClient } = require('../bitunix-client');
        const client = new BitunixClient({ apiKey, apiSecret });

        // Fetch all historical positions
        const historyPositions = await client.getHistoryPositions({ all: true });
        this.addActivity('info', `Fetched ${historyPositions.length} historical positions for ${key.email}`);

        for (const p of historyPositions) {
          const symbol = p.symbol;
          // NOTE: Bitunix history positions use entryPrice (not avgOpenPrice)
          const entryPrice = parseFloat(p.entryPrice || p.avgOpenPrice || p.openPrice || 0);
          const exitPrice = parseFloat(p.closePrice || p.exitPrice || 0);
          const qty = parseFloat(p.qty || p.positionAmt || 0);
          const side = (p.side || '').toUpperCase();

          if (!symbol || !entryPrice) continue;

          // Bitunix realizedPNL is already net (fee + funding already deducted)
          const netPnl = parseFloat((parseFloat(p.realizedPNL || 0)).toFixed(8));
          const fee = Math.abs(parseFloat(p.fee || 0));
          const funding = Math.abs(parseFloat(p.funding || 0));
          const totalFee = parseFloat((fee + funding).toFixed(8));

          // Gross PnL = net + fees
          const grossPnl = parseFloat((netPnl + totalFee).toFixed(8));

          const direction = (side === 'BUY' || side === 'LONG') ? 'LONG' : 'SHORT';
          const status = netPnl > 0 ? 'WIN' : 'LOSS';
          const closedAt = p.mtime ? new Date(parseInt(p.mtime)).toISOString()
            : p.ctime ? new Date(parseInt(p.ctime)).toISOString()
            : p.closedAt || new Date().toISOString();

          // Check if trade already exists in DB (match by symbol + entry + direction + api_key)
          const existing = await db.query(
            `SELECT id, pnl_usdt, exit_price, trading_fee FROM trades WHERE symbol = $1 AND entry_price = $2 AND api_key_id = $3 AND direction = $4`,
            [symbol, entryPrice, key.id, direction]
          );

          if (existing.length === 0) {
            await db.query(
              `INSERT INTO trades (symbol, direction, entry_price, exit_price, quantity, pnl_usdt, trading_fee, gross_pnl, status, api_key_id, platform, closed_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [symbol, direction, entryPrice, exitPrice, qty, netPnl, totalFee, grossPnl, status, key.id, 'bitunix', closedAt]
            );
            totalSynced++;

            // Notify survival system for new trades discovered by Accountant
            try {
              const { fireTradeOutcome } = require('../cycle');
              fireTradeOutcome({ symbol, direction, status, pnlUsdt: netPnl, structure: {} });
            } catch (_) {}
          } else {
            // Always update with latest Bitunix data for accuracy
            const trade = existing[0];
            await db.query(
              `UPDATE trades SET exit_price = $1, pnl_usdt = $2, trading_fee = $3, gross_pnl = $4, status = $5, quantity = COALESCE(NULLIF($6, 0), quantity), closed_at = COALESCE($7, closed_at) WHERE id = $8`,
              [exitPrice || trade.exit_price, netPnl, totalFee, grossPnl, status, qty, closedAt, trade.id]
            );
            totalUpdated++;
          }
        }
      } catch (e) {
        this.addActivity('error', `Sync failed for ${key.email}: ${e.message}`);
      }
    }

    this.currentTask = null;
    this.addActivity('success', `Bitunix sync complete: ${totalSynced} new trades, ${totalUpdated} updated`);
    return { ok: true, synced: totalSynced, updated: totalUpdated };
  }

  async _getAIContext() {
    return {
      auditsRun: this.auditsRun,
      tradesFixed: this.tradesFixed,
      totalFeesRecovered: this.totalFeesRecovered,
      lastAuditResult: this.lastAuditResult,
    };
  }

  getHealth() {
    return {
      ...super.getHealth(),
      auditsRun: this.auditsRun,
      tradesFixed: this.tradesFixed,
      totalFeesRecovered: this.totalFeesRecovered,
      lastAuditResult: this.lastAuditResult,
    };
  }
}

module.exports = { AccountantAgent };
