// ============================================================
// PolyBTCAgent — Trades directly on Polymarket "BTC Up or Down 15m"
//
// Every 15 minutes:
//   1. Finds the current active "BTC Up or Down 15m" market on Polymarket
//   2. Reads the Up-token probability trend (rising = crowd bullish)
//   3. If bullish → BUY Up tokens  ($1 USDC)
//      If bearish → BUY Down tokens ($1 USDC)
//
// Trades ON Polymarket CLOB using the user's Polymarket private key.
// No Bitunix. No futures. Pure prediction-market betting.
// ============================================================

const { BaseAgent } = require('./base-agent');
const { getBTCUpDownSignal } = require('../polymarket-btc-signal');
const { buildClobClient, getMidPrice, placeCopyOrder } = require('../polymarket-client');
const { log: bLog } = require('../bot-logger');

const TRADE_INTERVAL_MS      = 5 * 60 * 1000;  // 5 minutes — minimum between actual trades
const SCAN_INTERVAL_MS       = 2 * 60 * 1000;  // 2 minutes — re-check signal even on NEUTRAL
const TRADE_SIZE_USDC        = 5;               // $5 USDC per bet — min 2 shares on CLOB at $0.51
const MIN_CONFIDENCE         = 5;               // 50.5%+ crowd lean → conf≥5 with new formula
const COOLDOWN_AFTER_LOSS_MS = 30 * 60 * 1000; // 30-min pause after 2 consecutive losses

class PolyBTCAgent extends BaseAgent {
  constructor(options = {}) {
    super('PolyBTCAgent', options);

    this._lastTradeAt     = 0;
    this._lastScanAt      = 0;  // throttle for API fetch (even on NEUTRAL)
    this._lastSignal      = null;
    this._totalTrades     = 0;
    this._wins            = 0;
    this._losses          = 0;
    this._lastLossAt      = 0;
    this._consecutiveLoss = 0;
    this._totalPnl        = 0;
    this._clobClients     = new Map(); // key_id → { client, address }

    this._profile = {
      description: 'Bets UP/DOWN $1 USDC on the "BTC Up or Down 15m" Polymarket market using probability momentum.',
      role: 'Polymarket BTC 15m Trader',
      icon: 'polymarket',
      skills: [
        { id: 'market_scan', name: 'Market Scanner',   description: 'Finds the current active BTC Up or Down 15m market', enabled: true },
        { id: 'poly_signal', name: 'Prob Signal',      description: 'Extremity (Up<35% or >65%) + momentum slope — fires immediately without warm-up', enabled: true },
        { id: 'poly_trade',  name: 'Poly Trade',       description: `Places $${TRADE_SIZE_USDC} USDC on Up/Down tokens via CLOB at 50.5%+ crowd edge`, enabled: true },
        { id: 'cooldown',    name: 'Loss Cooldown',    description: '30-min pause after 2 consecutive losses', enabled: true },
      ],
    };
  }

  // ── Main execute cycle ────────────────────────────────────────

  async execute(context = {}) {
    const now = Date.now();

    // 2-min scan throttle — avoids hammering the API every 30s when NEUTRAL
    if (now - this._lastScanAt < SCAN_INTERVAL_MS) {
      return { skipped: true, reason: 'scan_throttled' };
    }
    this._lastScanAt = now;

    bLog.scan('[POLY-BTC] Tick — fetching signal...');

    // 30-min loss cooldown
    if (this._consecutiveLoss >= 2 && now - this._lastLossAt < COOLDOWN_AFTER_LOSS_MS) {
      const coolMins = Math.round((COOLDOWN_AFTER_LOSS_MS - (now - this._lastLossAt)) / 60_000);
      bLog.scan(`[POLY-BTC] Loss cooldown active — resuming in ${coolMins} min`);
      this.addActivity('warning', `Loss cooldown active — resuming in ${coolMins} min`);
      return { skipped: true, reason: 'loss_cooldown' };
    }

    // Read the Up/Down signal for the current 15m market
    let signal;
    try {
      signal = await getBTCUpDownSignal();
    } catch (err) {
      bLog.error(`[POLY-BTC] Signal fetch THREW: ${err.message}`);
      this.addActivity('error', `Signal fetch failed: ${err.message}`);
      this._lastTradeAt = now; // back off 5 min after error to avoid spam
      return { ok: false, error: err.message };
    }

    if (!signal.upTokenId) {
      this.addActivity('warning', 'BTC Up/Down 15m market not found — retrying in 5 min');
      bLog.error('[POLY-BTC] Market not found via Gamma API');
      return { ok: false, reason: 'no_market' };
    }

    this._lastSignal = signal;

    const upPct   = (signal.upPrice   * 100).toFixed(1);
    const downPct = (signal.downPrice * 100).toFixed(1);
    const chgPct  = ((signal.change ?? 0) * 100).toFixed(2);
    bLog.scan(
      `[POLY-BTC] Signal: ${signal.direction} conf=${signal.confidence} ` +
      `Up=${upPct}% Down=${downPct}% Δ=${Number(chgPct) >= 0 ? '+' : ''}${chgPct}%`
    );
    this.addActivity('info',
      `BTC 15m: ${signal.direction} conf=${signal.confidence} | ` +
      `Up ${upPct}% / Down ${downPct}% (Δ${Number(chgPct) >= 0 ? '+' : ''}${chgPct}%)`
    );

    if (signal.direction === 'NEUTRAL' || signal.confidence < MIN_CONFIDENCE) {
      this.addActivity('skip',
        `Neutral — conf=${signal.confidence} Up=${upPct}% (need conf≥${MIN_CONFIDENCE}, ~50.5%+ edge)`
      );
      return { ok: true, skipped: true, signal };
    }

    // 5-min trade cooldown (separate from scan cooldown)
    if (now - this._lastTradeAt < TRADE_INTERVAL_MS) {
      const nextMins = Math.ceil((TRADE_INTERVAL_MS - (now - this._lastTradeAt)) / 60_000);
      this.addActivity('info', `Trade cooldown — ${nextMins}m until next bet`);
      return { skipped: true, reason: 'trade_cooldown' };
    }

    // Place trade on Polymarket
    try {
      const result = await this._placePolyTrade(signal);
      this._lastTradeAt = now;
      this._totalTrades++;
      if (result.ok) {
        this._consecutiveLoss = 0;
        const side = signal.direction === 'LONG' ? 'UP' : 'DOWN';
        this.addActivity('success',
          `✅ Bought ${side} $${TRADE_SIZE_USDC} | "${signal.market?.slice(0, 40)}" | orderId=${result.orderId}`
        );
        bLog.scan(`[POLY-BTC] ✅ ${side} placed — orderId=${result.orderId}`);
      }
      return result;
    } catch (err) {
      this.addActivity('error', `Trade failed: ${err.message}`);
      bLog.error(`[POLY-BTC] Trade error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  // ── Place $5 on Up or Down token via Polymarket CLOB ─────────

  async _placePolyTrade(signal) {
    // Load DB + crypto
    let db, cryptoUtils;
    try {
      db          = require('../db');
      cryptoUtils = require('../crypto-utils');
    } catch (e) {
      throw new Error(`Cannot load db/crypto: ${e.message}`);
    }

    // Get the first enabled Polymarket key
    const rows = await db.query(
      `SELECT ak.id, ak.api_key_enc, ak.iv, ak.auth_tag, ak.label, u.email
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.platform = 'polymarket' AND ak.enabled = true
       ORDER BY ak.id ASC LIMIT 1`
    );
    if (!rows.length) throw new Error('No Polymarket key configured — add one in API Settings');

    const row        = rows[0];
    const privateKey = cryptoUtils.decrypt(row.api_key_enc, row.iv, row.auth_tag);

    // Build or reuse CLOB client
    if (!this._clobClients.has(row.id)) {
      const built = await buildClobClient(privateKey);
      this._clobClients.set(row.id, built);
      bLog.trade(`[POLY-BTC] CLOB client ready → ${built.address}`);
    }
    const { client } = this._clobClients.get(row.id);

    // Pick token: LONG → buy Up token, SHORT → buy Down token
    const isLong  = signal.direction === 'LONG';
    const tokenId = isLong ? signal.upTokenId : signal.downTokenId;
    const label   = isLong ? 'Up' : 'Down';

    if (!tokenId) throw new Error(`No ${label} token ID in signal`);

    // Fetch a live ask price directly from CLOB orderbook for best fill chance.
    // getMidPrice returns the mid; we add 0.02 buffer to cross the spread.
    // If it fails, fall back to signal's pre-computed ask.
    let liveMid = 0;
    try {
      liveMid = await getMidPrice(tokenId);
    } catch (_) {}
    const baseMid  = liveMid > 0 ? liveMid : (isLong ? signal.upPrice : signal.downPrice);
    // Bid 2 ticks above mid so the FOK actually matches a resting ask
    const bidPrice = Math.min(0.99, Math.max(0.01, parseFloat((baseMid + 0.02).toFixed(2))));

    bLog.trade(
      `[POLY-BTC] mid=${baseMid.toFixed(3)} liveMid=${liveMid.toFixed(3)} bidPrice=${bidPrice}`
    );

    bLog.trade(
      `[POLY-BTC] Placing BUY ${label} | tokenId=${tokenId.slice(0, 10)}... ` +
      `bid=${bidPrice} usdc=$${TRADE_SIZE_USDC}`
    );

    let result;
    try {
      result = await placeCopyOrder({
        client,
        tokenId,
        side:       'BUY',
        price:      bidPrice,
        usdcAmount: TRADE_SIZE_USDC,
        negRisk:    signal.negRisk !== false, // default true — most Polymarket markets use neg-risk exchange
      });
    } catch (orderErr) {
      // If key mismatch, purge cached client so next call rebuilds with fresh deriveApiKey
      if (orderErr.message.includes('order_version_mismatch')) {
        this._clobClients.delete(row.id);
        bLog.error('[POLY-BTC] order_version_mismatch — client cache cleared, will re-derive on next trade');
      }
      throw orderErr;
    }

    // Persist to DB (best-effort)
    await this._recordTrade({ signal, tokenId, label, midPrice: bidPrice, result, row }).catch(() => {});

    return {
      ok:      true,
      orderId: result.orderId,
      side:    label,
      tokenId,
      price:   bidPrice,
      shares:  result.shares,
    };
  }

  // ── DB persistence ────────────────────────────────────────────

  async _recordTrade({ signal, tokenId, label, midPrice, result, row }) {
    const db = require('../db');
    await db.query(
      `INSERT INTO trades
         (symbol, side, direction, entry_price, sl, tp, qty, leverage,
          status, setup_name, score, source, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN',$9,$10,'poly-btc-direct',NOW())
       ON CONFLICT DO NOTHING`,
      [
        signal.market?.slice(0, 60) || 'btc-updown-15m',
        'BUY',
        signal.direction,
        midPrice,
        0,
        0,
        result.shares || 0,
        1,
        `PolyBTC15m_${label}`,
        signal.confidence,
      ]
    ).catch(() => {});
  }

  // ── Record outcome (called by trade monitor on close) ─────────

  recordOutcome(pnl) {
    this._totalPnl += pnl;
    if (pnl >= 0) {
      this._wins++;
      this._consecutiveLoss = 0;
    } else {
      this._losses++;
      this._consecutiveLoss++;
      this._lastLossAt = Date.now();
    }
  }

  // ── Health ────────────────────────────────────────────────────

  getHealth() {
    const wr = this._totalTrades > 0
      ? Math.round((this._wins / this._totalTrades) * 100)
      : 0;
    return {
      ...super.getHealth(),
      totalTrades:     this._totalTrades,
      wins:            this._wins,
      losses:          this._losses,
      winRate:         `${wr}%`,
      totalPnl:        `$${this._totalPnl.toFixed(2)}`,
      lastSignal:      this._lastSignal,
      consecutiveLoss: this._consecutiveLoss,
      currentMarket:   this._lastSignal?.market || null,
    };
  }

  async _getAIContext() {
    return {
      totalTrades:   this._totalTrades,
      winRate:       this._wins / Math.max(1, this._totalTrades),
      totalPnl:      this._totalPnl,
      lastSignal:    this._lastSignal,
      tradeSize:     TRADE_SIZE_USDC,
      currentMarket: this._lastSignal?.market || null,
    };
  }
}

module.exports = { PolyBTCAgent };
