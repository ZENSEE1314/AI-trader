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

const TRADE_INTERVAL_MS      = 5 * 60 * 1000;  // 5 minutes — poll every 5m, bet when signal is clear
const TRADE_SIZE_USDC        = 1;               // $1 USDC per bet
const MIN_CONFIDENCE         = 20;              // minimum confidence to place trade
const COOLDOWN_AFTER_LOSS_MS = 30 * 60 * 1000; // 30-min pause after 2 consecutive losses

class PolyBTCAgent extends BaseAgent {
  constructor(options = {}) {
    super('PolyBTCAgent', options);

    this._lastTradeAt     = 0;
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
        { id: 'poly_trade',  name: 'Poly Trade',       description: `Places $${TRADE_SIZE_USDC} USDC on Up or Down tokens via CLOB every 5 min`, enabled: true },
        { id: 'cooldown',    name: 'Loss Cooldown',    description: '30-min pause after 2 consecutive losses', enabled: true },
      ],
    };
  }

  // ── Main execute cycle ────────────────────────────────────────

  async execute(context = {}) {
    const now = Date.now();

    // 15-min throttle
    if (now - this._lastTradeAt < TRADE_INTERVAL_MS) {
      const nextMins = Math.round((TRADE_INTERVAL_MS - (now - this._lastTradeAt)) / 60_000);
      this.addActivity('info', `Next BTC 15m scan in ${nextMins} min`);
      return { skipped: true, reason: 'throttled' };
    }

    // 30-min loss cooldown
    if (this._consecutiveLoss >= 2 && now - this._lastLossAt < COOLDOWN_AFTER_LOSS_MS) {
      const coolMins = Math.round((COOLDOWN_AFTER_LOSS_MS - (now - this._lastLossAt)) / 60_000);
      this.addActivity('warning', `Loss cooldown active — resuming in ${coolMins} min`);
      return { skipped: true, reason: 'loss_cooldown' };
    }

    // Read the Up/Down signal for the current 15m market
    let signal;
    try {
      signal = await getBTCUpDownSignal({ lookbackReadings: 3, minChange: 0.003 });
    } catch (err) {
      this.addActivity('error', `Signal fetch failed: ${err.message}`);
      return { ok: false, error: err.message };
    }

    if (!signal.upTokenId) {
      this.addActivity('warning', 'BTC Up/Down 15m market not found on Polymarket — retrying in 5 min');
      bLog.error('[POLY-BTC] Market not found via Gamma API');
      return { ok: false, reason: 'no_market' };
    }

    this._lastSignal = signal;

    const upPct   = (signal.upPrice   * 100).toFixed(1);
    const downPct = (signal.downPrice * 100).toFixed(1);
    const chgPct  = (signal.change    * 100).toFixed(2);
    bLog.scan(
      `[POLY-BTC] Signal: ${signal.direction} conf=${signal.confidence}% ` +
      `Up=${upPct}% Down=${downPct}% Δ=${chgPct}%`
    );
    this.addActivity('info',
      `BTC 15m: ${signal.direction} ${signal.confidence}% conf | ` +
      `Up ${upPct}% / Down ${downPct}% (Δ${Number(chgPct) >= 0 ? '+' : ''}${chgPct}%)`
    );

    if (signal.direction === 'NEUTRAL' || signal.confidence < MIN_CONFIDENCE) {
      this.addActivity('skip', `Weak signal (${signal.direction} ${signal.confidence}%) — no trade`);
      return { ok: true, skipped: true, signal };
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

  // ── Place $1 on Up or Down token via Polymarket CLOB ─────────

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

    if (!tokenId) throw new Error(`No ${label} token ID in signal — market not found`);

    // Get live mid-price for this token
    const midPrice = await getMidPrice(tokenId);
    if (!midPrice || midPrice <= 0 || midPrice >= 1) {
      throw new Error(`Invalid ${label} token mid-price: ${midPrice}`);
    }

    bLog.trade(
      `[POLY-BTC] Placing BUY ${label} | tokenId=${tokenId.slice(0, 10)} ` +
      `price=${midPrice} usdc=$${TRADE_SIZE_USDC}`
    );

    const result = await placeCopyOrder({
      client,
      tokenId,
      side:       'BUY',
      price:      midPrice,
      usdcAmount: TRADE_SIZE_USDC,
    });

    // Persist to DB (best-effort)
    await this._recordTrade({ signal, tokenId, label, midPrice, result, row }).catch(() => {});

    return {
      ok:      true,
      orderId: result.orderId,
      side:    label,
      tokenId,
      price:   midPrice,
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
