// ============================================================
// PolymarketAgent — Polymarket prediction market copy trading
//
// Workflow every poll cycle:
//   1. Fetch leaderboard → pick the #1 profit trader this month
//   2. Poll that wallet's recent activity for new BUY trades
//   3. For each new trade: scale size by multiplier and execute
//      via the user's own Polygon wallet (private key stored encrypted)
//
// One agent instance per api_key row with platform = 'polymarket'.
// Multiple users can each copy-trade independently.
// ============================================================

const { BaseAgent } = require('./base-agent');
const {
  getLeaderboard,
  getUserActivity,
  getMidPrice,
  buildClobClient,
  placeCopyOrder,
} = require('../polymarket-client');
const { log: bLog } = require('../bot-logger');

// How often to poll for new trades from the target wallet (ms)
const POLL_INTERVAL_MS = 30_000;
// How far back to look for activity on first run (ms)
const LOOKBACK_MS = 5 * 60 * 1000;
// Max slippage allowed vs target price before skipping a copy
const MAX_SLIPPAGE = 0.05;

class PolymarketAgent extends BaseAgent {
  constructor(options = {}) {
    super('PolymarketAgent', options);

    this.multiplier  = options.multiplier  || 0.1;   // copy 10% of target size by default
    this.maxUsdcPerTrade = options.maxUsdcPerTrade || 50; // hard cap per copied trade
    this.buyOnly     = options.buyOnly !== false;     // safeguard: only copy BUY trades
    this.enabled     = options.enabled !== false;

    // Runtime state
    this._targetAddress   = null;   // wallet we're copying
    this._targetName      = '';
    this._seenTradeIds    = new Set();
    this._lastPollMs      = 0;
    this._leaderboardAge  = 0;      // when we last refreshed the leaderboard
    this._tradesExecuted  = 0;
    this._totalPnlUsdc    = 0;
    this._clobClients     = new Map(); // api_key_id → { client, address }
    this._lastError       = null;

    this._profile = {
      description: 'Copies the #1 profit trader on Polymarket prediction markets each month.',
      role: 'Polymarket Copy Trader',
      icon: 'polymarket',
      skills: [
        { id: 'leaderboard', name: 'Leaderboard Scan', description: 'Find the top monthly profit trader automatically', enabled: true },
        { id: 'monitor',     name: 'Trade Monitor',    description: `Poll target wallet every ${POLL_INTERVAL_MS / 1000}s for new trades`, enabled: true },
        { id: 'copy_trade',  name: 'Copy Execute',     description: 'Mirror detected trades scaled by position multiplier', enabled: true },
        { id: 'buy_only',    name: 'Buy-Only Guard',   description: 'Skip SELL trades — only copy BUY positions', enabled: true },
        { id: 'memory',      name: 'Memory',           description: 'Remember executed copies and target history', enabled: true },
      ],
      config: [
        { key: 'multiplier',      label: 'Size Multiplier',      type: 'number', value: this.multiplier,      min: 0.01, max: 2.0  },
        { key: 'maxUsdcPerTrade', label: 'Max USDC Per Trade',   type: 'number', value: this.maxUsdcPerTrade, min: 1,    max: 1000 },
        { key: 'buyOnly',         label: 'Buy-Only Mode',        type: 'boolean',value: this.buyOnly },
      ],
    };
  }

  // ── Main execute cycle ─────────────────────────────────────

  async execute(context = {}) {
    if (!this.enabled) return { skipped: true, reason: 'Agent disabled' };

    const nowMs = Date.now();

    // Refresh leaderboard every 6 hours to track new #1 trader
    if (!this._targetAddress || nowMs - this._leaderboardAge > 6 * 3600_000) {
      await this._refreshLeaderboard();
    }

    if (!this._targetAddress) {
      this.addActivity('warning', 'No target trader found on leaderboard yet');
      bLog.trade('[POLY] No target address — leaderboard fetch failed or returned empty');
      return { ok: false, reason: 'No target trader' };
    }

    // Throttle polling
    if (nowMs - this._lastPollMs < POLL_INTERVAL_MS) {
      return { ok: true, skipped: true, reason: 'Throttled' };
    }
    this._lastPollMs = nowMs;

    // Get new trades from the target wallet
    const sinceMs = this._seenTradeIds.size === 0
      ? nowMs - LOOKBACK_MS
      : this._lastPollMs - POLL_INTERVAL_MS - 5000;

    let newTrades;
    try {
      const activity = await getUserActivity(this._targetAddress, 50, sinceMs);
      newTrades = activity.filter(t => !this._seenTradeIds.has(t.id));
    } catch (e) {
      this._lastError = e.message;
      this.addActivity('error', `Activity poll failed: ${e.message}`);
      return { ok: false, error: e.message };
    }

    if (!newTrades.length) {
      this.addActivity('info', `Watching ${this._targetName || this._targetAddress.slice(0, 10)}... no new trades`);
      return { ok: true, newTrades: 0 };
    }

    this.addActivity('info', `${newTrades.length} new trade(s) from ${this._targetName || this._targetAddress.slice(0, 10)}`);

    // Load all Polymarket api_keys so we can copy for every subscribed user
    const keys = await this._loadPolymarketKeys();
    if (!keys.length) {
      this.addActivity('warning', 'No Polymarket wallet keys configured — add one in API Settings');
      return { ok: false, reason: 'No wallet keys' };
    }

    const results = [];
    for (const trade of newTrades) {
      this._seenTradeIds.add(trade.id);

      if (this.buyOnly && trade.side !== 'BUY') {
        this.addActivity('info', `Skipping SELL trade on ${trade.marketSlug || trade.tokenId.slice(0, 10)}`);
        continue;
      }
      if (!trade.tokenId || trade.price <= 0) continue;

      // Slippage check: current mid-price vs target's execution price
      const midPrice = await getMidPrice(trade.tokenId).catch(() => 0);
      if (midPrice > 0) {
        const slip = Math.abs(midPrice - trade.price) / trade.price;
        if (slip > MAX_SLIPPAGE) {
          this.addActivity('skip', `Slippage too wide on ${trade.marketSlug}: ${(slip * 100).toFixed(1)}% > ${(MAX_SLIPPAGE * 100).toFixed(0)}%`);
          bLog.trade(`[POLY] Slippage skip ${trade.marketSlug}: mid=${midPrice} target=${trade.price} slip=${(slip*100).toFixed(1)}%`);
          continue;
        }
      }

      for (const key of keys) {
        // Use per-key capital settings (fall back to agent-level defaults)
        const keyMultiplier   = parseFloat(key.pm_multiplier    || this.multiplier);
        const keyMaxPerTrade  = parseFloat(key.pm_max_per_trade  || this.maxUsdcPerTrade);
        const usdcToCopy      = Math.min(trade.usdcAmount * keyMultiplier, keyMaxPerTrade);

        if (usdcToCopy < 1) {
          this.addActivity('skip', `Trade too small to copy for ${key.email}: $${usdcToCopy.toFixed(2)}`);
          continue;
        }

        const result = await this._executeCopy(key, trade, usdcToCopy, midPrice || trade.price);
        results.push(result);
      } // end key loop
    } // end trade loop

    const executed = results.filter(r => r.ok).length;
    this._tradesExecuted += executed;
    return { ok: true, newTrades: newTrades.length, executed, results };
  }

  // ── Leaderboard refresh ────────────────────────────────────

  async _refreshLeaderboard() {
    this.addActivity('info', 'Refreshing Polymarket leaderboard...');
    bLog.trade('[POLY] Fetching leaderboard...');
    try {
      const board = await getLeaderboard('1m', 20);
      bLog.trade(`[POLY] Leaderboard returned ${board.length} traders`);
      if (!board.length) {
        this.addActivity('warning', 'Leaderboard returned 0 traders');
        bLog.trade('[POLY] ⚠ Leaderboard empty — Polymarket API may have changed endpoints');
        return;
      }

      // Pick the #1 trader by PnL (already sorted desc)
      const top = board[0];
      if (top.address !== this._targetAddress) {
        this.addActivity('success', `New #1 target: ${top.name || top.address.slice(0, 10)} +$${top.pnl.toLocaleString()}`);
        bLog.trade(`[POLY] Target changed → ${top.address} (${top.name}) PnL=$${top.pnl}`);
        this._seenTradeIds.clear(); // reset seen so we pick up recent trades for the new target
      }
      this._targetAddress  = top.address;
      this._targetName     = top.name || top.address.slice(0, 10);
      this._leaderboardAge = Date.now();

      if (this.isSkillEnabled('memory')) {
        await this.remember('target', { address: top.address, name: top.name, pnl: top.pnl }, 'leaderboard').catch(() => {});
      }
    } catch (e) {
      this._lastError = e.message;
      this.addActivity('error', `Leaderboard refresh failed: ${e.message}`);
    }
  }

  // ── Copy execution ─────────────────────────────────────────

  async _executeCopy(key, trade, usdcAmount, execPrice) {
    const label = `${key.email} [${key.label || key.id}]`;
    try {
      // Build or reuse the CLOB client for this key
      if (!this._clobClients.has(key.id)) {
        const { client, address } = await buildClobClient(key.privateKey);
        this._clobClients.set(key.id, { client, address });
        bLog.trade(`[POLY] ${label}: CLOB client ready → ${address}`);
      }
      const { client, address } = this._clobClients.get(key.id);

      const result = await placeCopyOrder({
        client,
        tokenId:    trade.tokenId,
        side:       trade.side,
        price:      execPrice,
        usdcAmount,
      });

      const msg = `${label}: copied ${trade.side} $${usdcAmount.toFixed(2)} on "${trade.question || trade.marketSlug}" @ ${execPrice}`;
      this.addActivity('success', msg);
      bLog.trade(`[POLY] ${msg} → orderId=${result.orderId}`);

      // Persist to DB
      await this._recordTrade(key, trade, result, usdcAmount).catch(() => {});

      return { ok: true, orderId: result.orderId, keyId: key.id, usdcAmount };
    } catch (e) {
      this._lastError = e.message;
      this.addActivity('error', `${label}: copy FAILED — ${e.message}`);
      bLog.error(`[POLY] ${label} copy error: ${e.message}`);
      return { ok: false, keyId: key.id, error: e.message };
    }
  }

  // ── DB helpers ─────────────────────────────────────────────

  async _loadPolymarketKeys() {
    let db, cryptoUtils;
    try {
      db          = require('../db');
      cryptoUtils = require('../crypto-utils');
    } catch { return []; }

    try {
      const rows = await db.query(
        `SELECT ak.id, ak.api_key_enc, ak.iv, ak.auth_tag, ak.label,
                COALESCE(ak.pm_budget_usdc,   200) as pm_budget_usdc,
                COALESCE(ak.pm_max_per_trade,  50) as pm_max_per_trade,
                COALESCE(ak.pm_multiplier,    0.1) as pm_multiplier,
                u.email, u.id as user_id
         FROM api_keys ak
         JOIN users u ON u.id = ak.user_id
         WHERE ak.platform = 'polymarket' AND ak.enabled = true`
      );
      return rows.map(r => {
        try {
          const privateKey = cryptoUtils.decrypt(r.api_key_enc, r.iv, r.auth_tag);
          return { ...r, privateKey };
        } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  async _recordTrade(key, sourceTrade, result, usdcAmount) {
    const db = require('../db');
    await db.query(
      `INSERT INTO polymarket_trades
         (api_key_id, user_id, target_address, token_id, market_slug, question,
          side, price, usdc_amount, shares, order_id, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       ON CONFLICT DO NOTHING`,
      [
        key.id, key.user_id,
        this._targetAddress, sourceTrade.tokenId, sourceTrade.marketSlug,
        sourceTrade.question, result.side, result.price, usdcAmount,
        result.shares, result.orderId, result.status || 'submitted',
      ]
    ).catch(() => {});
  }

  // ── Health / context ───────────────────────────────────────

  async _getAIContext() {
    return {
      targetAddress:  this._targetAddress,
      targetName:     this._targetName,
      tradesExecuted: this._tradesExecuted,
      multiplier:     this.multiplier,
      maxUsdcPerTrade: this.maxUsdcPerTrade,
      lastError:      this._lastError,
    };
  }

  getHealth() {
    return {
      ...super.getHealth(),
      targetAddress:  this._targetAddress,
      targetName:     this._targetName,
      tradesExecuted: this._tradesExecuted,
      multiplier:     this.multiplier,
      maxUsdcPerTrade: this.maxUsdcPerTrade,
      enabled:        this.enabled,
      lastError:      this._lastError,
    };
  }
}

module.exports = { PolymarketAgent };
