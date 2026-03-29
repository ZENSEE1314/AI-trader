// ============================================================
// Bitunix Futures API Client
// Docs: https://www.bitunix.com/api-docs/futures/
// Auth: double SHA256 signing
// ============================================================

const crypto = require('crypto');
const fetch = require('node-fetch');

const BASE_URL = 'https://fapi.bitunix.com';

class BitunixClient {
  constructor({ apiKey, apiSecret }) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  _sign(queryParams, body) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now().toString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const queryStr = queryParams || '';

    // Step 1: SHA256(nonce + timestamp + apiKey + queryParams + body)
    const digest = crypto.createHash('sha256')
      .update(nonce + timestamp + this.apiKey + queryStr + bodyStr)
      .digest('hex');

    // Step 2: SHA256(digest + secretKey)
    const sign = crypto.createHash('sha256')
      .update(digest + this.apiSecret)
      .digest('hex');

    return {
      headers: {
        'api-key': this.apiKey,
        'nonce': nonce,
        'timestamp': timestamp,
        'sign': sign,
        'Content-Type': 'application/json',
        'language': 'en-US',
      },
      bodyStr,
    };
  }

  _sortQuery(params) {
    if (!params || !Object.keys(params).length) return '';
    return Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
  }

  async _get(path, params = {}) {
    const queryStr = Object.keys(params).length
      ? '?' + Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&')
      : '';
    const sortedParams = this._sortQuery(params);
    const { headers } = this._sign(sortedParams, null);

    const res = await fetch(`${BASE_URL}${path}${queryStr}`, {
      method: 'GET',
      headers,
      timeout: 15000,
    });
    const json = await res.json();
    if (json.code !== 0) throw new Error(`Bitunix API error: ${json.msg} (code ${json.code})`);
    return json.data;
  }

  async _post(path, body = {}) {
    const { headers, bodyStr } = this._sign('', body);

    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: bodyStr,
      timeout: 15000,
    });
    const json = await res.json();
    if (json.code !== 0) throw new Error(`Bitunix API error: ${json.msg} (code ${json.code})`);
    return json.data;
  }

  // ── Account ────────────────────────────────────────────────

  async getAccount(marginCoin = 'USDT') {
    const data = await this._get('/api/v1/futures/account', { marginCoin });
    return data?.[0] || data;
  }

  async changeLeverage(symbol, leverage, marginCoin = 'USDT') {
    return this._post('/api/v1/futures/account/change_leverage', {
      symbol, leverage: parseInt(leverage), marginCoin,
    });
  }

  async changeMarginMode(symbol, marginMode = 'ISOLATION', marginCoin = 'USDT') {
    return this._post('/api/v1/futures/account/change_margin_mode', {
      symbol, marginMode, marginCoin,
    });
  }

  // ── Positions ──────────────────────────────────────────────

  async getOpenPositions(symbol) {
    const params = symbol ? { symbol } : {};
    return this._get('/api/v1/futures/position/get_pending_positions', params);
  }

  // ── Trading ────────────────────────────────────────────────

  async placeOrder({ symbol, side, qty, orderType = 'MARKET', tradeSide = 'OPEN',
                     price, tpPrice, tpStopType, tpOrderType,
                     slPrice, slStopType, slOrderType, reduceOnly }) {
    const body = { symbol, side, qty: String(qty), orderType, tradeSide };
    if (price) body.price = String(price);
    if (tpPrice) {
      body.tpPrice = String(tpPrice);
      body.tpStopType = tpStopType || 'MARK_PRICE';
      body.tpOrderType = tpOrderType || 'MARKET';
    }
    if (slPrice) {
      body.slPrice = String(slPrice);
      body.slStopType = slStopType || 'MARK_PRICE';
      body.slOrderType = slOrderType || 'MARKET';
    }
    if (reduceOnly) body.reduceOnly = true;
    return this._post('/api/v1/futures/trade/place_order', body);
  }

  // ── Convenience: match Binance-like interface ──────────────

  async getAccountInformation() {
    const acc = await this.getAccount();
    const positions = await this.getOpenPositions();
    return {
      totalWalletBalance: String(parseFloat(acc.available) + parseFloat(acc.margin) + parseFloat(acc.frozen)),
      availableBalance: acc.available,
      totalUnrealizedProfit: String(parseFloat(acc.crossUnrealizedPNL || 0) + parseFloat(acc.isolationUnrealizedPNL || 0)),
      positions: (positions || []).map(p => ({
        symbol: p.symbol,
        positionAmt: p.side === 'LONG' ? p.qty : `-${p.qty}`,
        entryPrice: p.avgOpenPrice,
        unrealizedProfit: p.unrealizedPNL,
        leverage: String(p.leverage),
        positionId: p.positionId,
      })),
    };
  }
}

module.exports = { BitunixClient };
