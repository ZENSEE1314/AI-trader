// ============================================================
// PolyBTCAgent — Polymarket-driven BTC micro-trader
//
// Every 15 minutes:
//   1. Reads the 15-min probability trend of Polymarket BTC markets
//   2. If crowd is getting more bullish (prob rising) → LONG BTC on Bitunix
//      If crowd is getting more bearish (prob falling) → SHORT BTC on Bitunix
//   3. Fixed $5 margin per trade (minimum viable on Bitunix futures)
//   4. Uses 20× leverage → ~$100 notional, small but executable
//
// This agent is INDEPENDENT of SMC Pro. It's a pure sentiment
// momentum play based on prediction-market crowd wisdom.
// ============================================================

const { BaseAgent } = require('./base-agent');
const { getBTCSignal } = require('../polymarket-btc-signal');
const { log: bLog }   = require('../bot-logger');

const TRADE_INTERVAL_MS = 15 * 60 * 1000;   // 15 minutes
const TRADE_SIZE_USDT   = 5;                 // $5 margin per trade
const LEVERAGE          = 20;                // 20× → $100 notional
const MIN_CONFIDENCE    = 55;               // skip trades below this confidence
const SYMBOL            = 'BTCUSDT';
const COOLDOWN_AFTER_LOSS_MS = 30 * 60 * 1000; // 30-min pause after a loss

class PolyBTCAgent extends BaseAgent {
  constructor(options = {}) {
    super('PolyBTCAgent', options);

    this._lastTradeAt      = 0;
    this._lastSignal       = null;
    this._totalTrades      = 0;
    this._wins             = 0;
    this._losses           = 0;
    this._lastLossAt       = 0;
    this._consecutiveLoss  = 0;
    this._totalPnl         = 0;

    this._profile = {
      description: 'Trades BTC every 15 min based on Polymarket prediction-market probability momentum.',
      role: 'Polymarket BTC Sentiment Trader',
      icon: 'polymarket',
      skills: [
        { id: 'poly_signal',  name: 'Poly Signal Reader', description: 'Reads 15-min YES-token momentum on Polymarket BTC markets', enabled: true },
        { id: 'micro_trade',  name: 'Micro Trade',        description: `Places $${TRADE_SIZE_USDT} BTC trade every 15 min when signal is clear`, enabled: true },
        { id: 'cooldown',     name: 'Loss Cooldown',      description: '30-min pause after a losing trade', enabled: true },
      ],
    };
  }

  // ── Main execute (called from CEO micro-cycle) ─────────────

  async execute(context = {}) {
    const now = Date.now();

    // 15-min throttle
    if (now - this._lastTradeAt < TRADE_INTERVAL_MS) {
      const nextMins = Math.round((TRADE_INTERVAL_MS - (now - this._lastTradeAt)) / 60_000);
      this.addActivity('info', `Next Poly scan in ${nextMins} min`);
      return { skipped: true, reason: 'throttled' };
    }

    // 30-min loss cooldown
    if (this._consecutiveLoss >= 2 && now - this._lastLossAt < COOLDOWN_AFTER_LOSS_MS) {
      const coolMins = Math.round((COOLDOWN_AFTER_LOSS_MS - (now - this._lastLossAt)) / 60_000);
      this.addActivity('warning', `Loss cooldown active — resuming in ${coolMins} min`);
      return { skipped: true, reason: 'loss_cooldown' };
    }

    // Read Polymarket signal
    let signal;
    try {
      signal = await getBTCSignal({ lookbackCandles: 3, minChange: 0.003 });
    } catch (err) {
      this.addActivity('error', `Poly signal fetch failed: ${err.message}`);
      return { ok: false, error: err.message };
    }

    this._lastSignal = signal;
    const probPct = (signal.currentProb * 100).toFixed(1);
    const deltaPct = (signal.probChange * 100).toFixed(2);
    bLog.scan(
      `[POLY-BTC] Signal: ${signal.direction} conf=${signal.confidence}% ` +
      `prob=${probPct}% Δ=${deltaPct}% candles=${signal.candles}`
    );
    this.addActivity('info',
      `Polymarket BTC: ${signal.direction} ${signal.confidence}% conf | ` +
      `prob ${probPct}% (Δ${deltaPct >= 0 ? '+' : ''}${deltaPct}%)`
    );

    if (signal.direction === 'NEUTRAL' || signal.confidence < MIN_CONFIDENCE) {
      this.addActivity('skip', `Signal too weak (${signal.direction} ${signal.confidence}%) — sitting out`);
      return { ok: true, skipped: true, signal };
    }

    // ── Place $5 BTC trade via BitunixClient ─────────────────
    const coordinator = context.coordinator;
    if (!coordinator) {
      bLog.error('[POLY-BTC] No coordinator context — cannot place trade');
      return { ok: false, error: 'No coordinator' };
    }

    try {
      const result = await this._placeTrade(signal, coordinator);
      this._lastTradeAt = now;
      this._totalTrades++;
      if (result.ok) {
        this._consecutiveLoss = 0;
        this.addActivity('success',
          `✅ Placed ${signal.direction} $${TRADE_SIZE_USDT} BTC | ` +
          `entry≈${result.entry} SL=${result.sl} | orderId=${result.orderId}`
        );
        bLog.scan(`[POLY-BTC] ✅ ${signal.direction} placed — orderId=${result.orderId} entry=${result.entry}`);
      }
      return result;
    } catch (err) {
      this.addActivity('error', `Trade failed: ${err.message}`);
      bLog.error(`[POLY-BTC] Trade error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  // ── Trade placement ────────────────────────────────────────

  async _placeTrade(signal, coordinator) {
    // Load BitunixClient from the first available key
    let BitunixClient, keys, db;
    try {
      BitunixClient = require('../bitunix-client');
      db = require('../db');
    } catch (e) {
      throw new Error(`Cannot load dependencies: ${e.message}`);
    }

    // Fetch enabled Bitunix keys
    const rows = await db.query(
      `SELECT ak.id, ak.api_key_enc, ak.iv, ak.auth_tag, ak.label, u.email
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
       WHERE ak.platform = 'bitunix' AND ak.enabled = true
       ORDER BY ak.id ASC LIMIT 1`
    );
    if (!rows.length) throw new Error('No enabled Bitunix keys found');

    const cryptoUtils = require('../crypto-utils');
    const row = rows[0];
    const { apiKey, secretKey } = cryptoUtils.decrypt(row.api_key_enc, row.iv, row.auth_tag);
    const client = new BitunixClient({ apiKey, secretKey });

    // Get current BTC price
    const ticker = await client.getTicker(SYMBOL).catch(() => null);
    const price  = parseFloat(ticker?.lastPrice || ticker?.price || 0);
    if (!price) throw new Error('Cannot fetch BTC price from Bitunix');

    // Calculate quantity from fixed margin size
    // qty = (margin × leverage) / price
    const notional = TRADE_SIZE_USDT * LEVERAGE;
    const qty      = parseFloat((notional / price).toFixed(4));

    // SL: 3% price move against position (at 20x = 60% capital loss, caps at -$3)
    const slPct    = 0.03;
    const side     = signal.direction === 'LONG' ? 'BUY' : 'SELL';
    const sl       = signal.direction === 'LONG'
      ? parseFloat((price * (1 - slPct)).toFixed(2))
      : parseFloat((price * (1 + slPct)).toFixed(2));
    const tp       = signal.direction === 'LONG'
      ? parseFloat((price * 1.04).toFixed(2))    // 4% TP = 2:1 RR vs 3% SL
      : parseFloat((price * 0.96).toFixed(2));

    // Set leverage + margin mode
    await client.changeMarginMode(SYMBOL, 'ISOLATION').catch(() => {});
    await client.changeLeverage(SYMBOL, LEVERAGE).catch(() => {});

    // Place order
    const order = await client.placeOrder({
      symbol:    SYMBOL,
      side,
      qty:       String(qty),
      orderType: 'MARKET',
      tradeSide: 'OPEN',
    });

    const orderId = order?.orderId || order?.data?.orderId || 'unknown';

    // Record in DB
    await this._recordTrade({ signal, price, qty, sl, tp, side, orderId, row }).catch(() => {});

    return { ok: true, orderId, entry: price, sl, tp, qty, side };
  }

  // ── DB persistence ─────────────────────────────────────────

  async _recordTrade({ signal, price, qty, sl, tp, side, orderId, row }) {
    const db = require('../db');
    await db.query(
      `INSERT INTO trades
         (symbol, side, direction, entry_price, sl, tp, qty, leverage,
          status, setup_name, score, source, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN',$9,$10,'poly-btc',NOW())
       ON CONFLICT DO NOTHING`,
      [
        SYMBOL,
        side,
        signal.direction,
        price,
        sl,
        tp,
        qty,
        LEVERAGE,
        `PolymarketMomentum`,
        signal.confidence,
      ]
    ).catch(() => {});
  }

  // ── Record outcome (called by trade monitor on close) ──────

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

  // ── Health ─────────────────────────────────────────────────

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
    };
  }

  async _getAIContext() {
    return {
      totalTrades:  this._totalTrades,
      winRate:      this._wins / Math.max(1, this._totalTrades),
      totalPnl:     this._totalPnl,
      lastSignal:   this._lastSignal,
      tradeSize:    TRADE_SIZE_USDT,
      leverage:     LEVERAGE,
    };
  }
}

module.exports = { PolyBTCAgent };
