// ============================================================
// Bitunix Futures API Client
// Docs: https://www.bitunix.com/api-docs/futures/
// Auth: double SHA256 signing
// ============================================================

const crypto = require('crypto');
const fetch = require('node-fetch');
const { getFetchOptions } = require('./proxy-agent');

const BASE_URL = 'https://fapi.bitunix.com';
const REQUEST_TIMEOUT = 15000;

class BitunixClient {
  constructor({ apiKey, apiSecret }) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  _sign(queryParamStr, bodyStr) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now().toString();

    // Step 1: SHA256(nonce + timestamp + apiKey + sortedQueryParams + compressedBody)
    const digestInput = nonce + timestamp + this.apiKey + queryParamStr + bodyStr;
    const digest = crypto.createHash('sha256').update(digestInput).digest('hex');

    // Step 2: SHA256(digest + secretKey)
    const sign = crypto.createHash('sha256').update(digest + this.apiSecret).digest('hex');

    return {
      headers: {
        'api-key': this.apiKey,
        'nonce': nonce,
        'timestamp': timestamp,
        'sign': sign,
        'Content-Type': 'application/json',
        'language': 'en-US',
      },
    };
  }

  // Sort query params by key in ASCII order, concat as key1value1key2value2
  _buildQueryParamStr(params) {
    if (!params || !Object.keys(params).length) return '';
    const keys = Object.keys(params).sort();
    return keys.map(k => k + params[k]).join('');
  }

  // Build URL query string ?key1=value1&key2=value2
  _buildQueryString(params) {
    if (!params || !Object.keys(params).length) return '';
    return '?' + Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }

  // Compress body — JSON with no extra whitespace
  _compressBody(body) {
    if (!body || !Object.keys(body).length) return '';
    return JSON.stringify(body);
  }

  async _get(path, params = {}) {
    const queryParamStr = this._buildQueryParamStr(params);
    const queryString = this._buildQueryString(params);
    const { headers } = this._sign(queryParamStr, '');

    const url = `${BASE_URL}${path}${queryString}`;
    const res = await fetch(url, { method: 'GET', headers, timeout: REQUEST_TIMEOUT, ...getFetchOptions() });
    const rawBody = await res.text();
    let json;
    try { json = JSON.parse(rawBody); } catch (e) {
      console.error(`[Bitunix] Invalid JSON from ${url}:`, rawBody.substring(0, 500));
      throw new Error(`Bitunix returned non-JSON: ${rawBody.substring(0, 200)}`);
    }
    if (json.code !== 0) throw new Error(`Bitunix API error: ${json.msg} (code ${json.code})`);
    return json.data;
  }

  async _post(path, body = {}) {
    const bodyStr = this._compressBody(body);
    const { headers } = this._sign('', bodyStr);

    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, { method: 'POST', headers, body: bodyStr, timeout: REQUEST_TIMEOUT, ...getFetchOptions() });
    const rawBody = await res.text();
    let json;
    try { json = JSON.parse(rawBody); } catch (e) {
      console.error(`[Bitunix] Invalid JSON from ${url}:`, rawBody.substring(0, 500));
      throw new Error(`Bitunix returned non-JSON: ${rawBody.substring(0, 200)}`);
    }
    if (json.code !== 0) throw new Error(`Bitunix API error: ${json.msg} (code ${json.code})`);
    return json.data;
  }

  // ── Account ────────────────────────────────────────────────

  async getAccount(marginCoin = 'USDT') {
    return this._get('/api/v1/futures/account', { marginCoin });
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

  // ── TP/SL on existing position ──────────────────────────────

  async placePositionTpSl({ symbol, positionId, tpPrice, slPrice }) {
    const body = { symbol, positionId };
    if (tpPrice) { body.tpPrice = String(tpPrice); body.tpStopType = 'MARK_PRICE'; }
    if (slPrice) { body.slPrice = String(slPrice); body.slStopType = 'MARK_PRICE'; }
    return this._post('/api/v1/futures/tpsl/position/place_order', body);
  }

  // ── Order / Trade History ───────────────────────────────────

  async getHistoryOrders({ symbol, pageNum = 1, pageSize = 10 } = {}) {
    const body = { pageNum, pageSize };
    if (symbol) body.symbol = symbol;
    const data = await this._post('/api/v1/futures/trade/get_history_orders', body);
    if (Array.isArray(data)) return data;
    return data?.orderList || data?.list || [];
  }

  async getHistoryTrades({ symbol, pageNum = 1, pageSize = 10 } = {}) {
    const body = { pageNum, pageSize };
    if (symbol) body.symbol = symbol;
    const data = await this._post('/api/v1/futures/trade/get_history_trades', body);
    if (Array.isArray(data)) return data;
    return data?.tradeList || data?.orderList || data?.list || [];
  }

  async getFills({ symbol, limit = 20 } = {}) {
    const body = { symbol, limit };
    const data = await this._post('/api/v1/futures/trade/get_fills', body);
    if (Array.isArray(data)) return data;
    return data?.fillList || data?.list || data?.fills || [];
  }

  // Raw methods — return full response including code/msg for debugging
  async _rawPost(path, body = {}) {
    const bodyStr = this._compressBody(body);
    const { headers } = this._sign('', bodyStr);
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, { method: 'POST', headers, body: bodyStr, timeout: REQUEST_TIMEOUT, ...getFetchOptions() });
    return res.json();
  }

  async _rawGet(path, params = {}) {
    const queryParamStr = this._buildQueryParamStr(params);
    const queryString = this._buildQueryString(params);
    const { headers } = this._sign(queryParamStr, '');
    const url = `${BASE_URL}${path}${queryString}`;
    const res = await fetch(url, { method: 'GET', headers, timeout: REQUEST_TIMEOUT, ...getFetchOptions() });
    return res.json();
  }

  // ── Market Data ────────────────────────────────────────────

  async getMarketPrice(symbol) {
    const data = await this._get('/api/v1/futures/market/get_latest_price', { symbol });
    // API may return array or object
    if (Array.isArray(data)) return data[0] || {};
    return data;
  }

  // ── Convenience: match Binance-like interface ──────────────

  async getAccountInformation() {
    const data = await this.getAccount();
    const acc = Array.isArray(data) ? data[0] : data;
    if (!acc) throw new Error('Bitunix: no account data returned');

    let positions = [];
    try {
      const posData = await this.getOpenPositions();
      positions = Array.isArray(posData) ? posData : [];
    } catch (_) {}

    return {
      totalWalletBalance: String(parseFloat(acc.available || 0) + parseFloat(acc.margin || 0) + parseFloat(acc.frozen || 0)),
      availableBalance: acc.available || '0',
      totalUnrealizedProfit: String(parseFloat(acc.crossUnrealizedPNL || 0) + parseFloat(acc.isolationUnrealizedPNL || 0)),
      positions: positions.map(p => ({
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
