// ============================================================
// PolymarketClient — leaderboard, trade monitoring, order execution
//
// Uses:
//   Data API  (public) — leaderboard, user activity
//   CLOB API  (signed) — place orders on behalf of a wallet
//
// Auth: private key → EIP-712 L1 signature → derive L2 API creds
// Chain: Polygon (137)
// ============================================================

const fetch = require('node-fetch');
const { ethers } = require('ethers');
const { ClobClient } = require('@polymarket/clob-client');

const DATA_API  = 'https://data-api.polymarket.com';
const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID  = 137;
const TIMEOUT   = 15_000;

// ── internal helpers ─────────────────────────────────────────

async function _get(url) {
  const res = await fetch(url, { timeout: TIMEOUT });
  if (!res.ok) throw new Error(`Polymarket API ${res.status}: ${url}`);
  return res.json();
}

// ── Public: Data API ─────────────────────────────────────────

/**
 * Fetch the monthly profit leaderboard.
 * Returns array sorted by profit desc.
 * @param {'1d'|'1w'|'1m'|'all'} window
 * @param {number} limit
 */
async function getLeaderboard(window = '1m', limit = 20) {
  // Try several known endpoint patterns — Polymarket has changed paths before.
  const candidates = [
    `${DATA_API}/leaderboard?window=${window}&limit=${limit}`,
    `${DATA_API}/leaderboard?interval=${window}&limit=${limit}`,
    `${DATA_API}/profit-leaderboard?window=${window}&limit=${limit}`,
  ];

  for (const url of candidates) {
    try {
      const data = await _get(url);
      const list  = Array.isArray(data) ? data : (data?.data || data?.leaderboard || data?.results || []);
      if (list.length) return _normaliseLeaderboard(list);
    } catch (_) {}
  }

  // Fallback: scrape the Polymarket leaderboard page for the #1 address
  return _scrapeLeaderboard();
}

function _normaliseLeaderboard(list) {
  return list.map(u => ({
    address:  u.proxyWallet || u.address || u.user || u.wallet || '',
    name:     u.name || u.pseudonym || u.username || '',
    pnl:      parseFloat(u.pnl || u.profit || u.profitLoss || u.totalProfit || 0),
    volume:   parseFloat(u.volume || u.totalVolume || 0),
    trades:   parseInt(u.tradesCount || u.trades || u.numTrades || 0),
  })).filter(u => u.address);
}

async function _scrapeLeaderboard() {
  // Parse the rendered HTML leaderboard as a last resort.
  // Returns best-effort data from the top-10 visible rows.
  try {
    const res = await fetch('https://polymarket.com/leaderboard', { timeout: TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CopyTradeBot/1.0)' },
    });
    const html = await res.text();
    // Extract wallet addresses (42-char 0x strings) from the page source
    const addresses = [...new Set([...html.matchAll(/0x[0-9a-fA-F]{40}/g)].map(m => m[0]))];
    return addresses.slice(0, 20).map((address, i) => ({ address, name: `Trader #${i + 1}`, pnl: 0, volume: 0, trades: 0 }));
  } catch (e) {
    return [];
  }
}

/**
 * Fetch recent trade activity for a wallet.
 * @param {string} address  Polygon wallet address
 * @param {number} limit
 * @param {number} sinceMs  Only return trades after this timestamp (ms)
 */
async function getUserActivity(address, limit = 50, sinceMs = 0) {
  const candidates = [
    `${DATA_API}/activity?user=${address}&limit=${limit}&type=TRADE`,
    `${DATA_API}/activity?proxyWallet=${address}&limit=${limit}`,
    `${DATA_API}/trades?user=${address}&limit=${limit}`,
  ];

  for (const url of candidates) {
    try {
      const data = await _get(url);
      const list = Array.isArray(data) ? data : (data?.data || data?.activity || data?.trades || []);
      if (list.length || !sinceMs) {
        return list
          .map(t => _normaliseActivity(t))
          .filter(t => t.tokenId && (!sinceMs || t.timestampMs > sinceMs));
      }
    } catch (_) {}
  }
  return [];
}

function _normaliseActivity(t) {
  // API actual fields (confirmed from live response 2026-05):
  //   transactionHash, asset (token id), usdcSize, timestamp (seconds), side, conditionId
  const rawTs = parseInt(t.timestamp || t.createdAt || t.ts || 0);
  // Polymarket returns timestamp in SECONDS — convert to ms if it looks like seconds (<1e12)
  const timestampMs = rawTs > 0 && rawTs < 1e12 ? rawTs * 1000 : (rawTs || Date.now());
  return {
    id:          t.transactionHash || t.id || t.tradeId || '',
    tokenId:     t.asset || t.asset_id || t.assetId || t.tokenId || t.conditionId || '',
    marketSlug:  t.slug || t.market_slug || t.marketSlug || t.eventSlug || '',
    question:    t.title || t.question || t.event_title || '',
    side:        (t.side || '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
    price:       parseFloat(t.price || t.avgPrice || 0),
    size:        parseFloat(t.size || t.shares || t.amount || 0),
    usdcAmount:  parseFloat(t.usdcSize || t.usdcAmount || t.notional || (t.price * t.size) || 0),
    outcome:     t.outcome || t.outcomeIndex || '',
    timestampMs,
  };
}

/**
 * Get current positions for a wallet.
 */
async function getUserPositions(address) {
  try {
    const data = await _get(`${DATA_API}/positions?user=${address}&limit=100`);
    const list  = Array.isArray(data) ? data : (data?.data || data?.positions || []);
    return list.map(p => ({
      tokenId:    p.asset_id || p.assetId || p.tokenId || '',
      marketSlug: p.market_slug || p.marketSlug || '',
      question:   p.title || p.question || '',
      size:       parseFloat(p.size || p.shares || 0),
      avgPrice:   parseFloat(p.avgPrice || p.price || 0),
      value:      parseFloat(p.currentValue || p.value || 0),
      outcome:    p.outcome || '',
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Get CLOB mid-price for a token.
 */
async function getMidPrice(tokenId) {
  try {
    const data = await _get(`${CLOB_HOST}/midpoint?token_id=${tokenId}`);
    return parseFloat(data?.mid || data?.midpoint || 0);
  } catch {
    return 0;
  }
}

// ── CLOB client cache (keyed by wallet address, TTL 8 hours) ─
const _clobClientCache = new Map();
const CLOB_CLIENT_TTL  = 8 * 3600_000;

// ── Authenticated: CLOB client ────────────────────────────────

/**
 * Build a ClobClient from a raw private key.
 * Derives L2 API credentials automatically.
 * @param {string} privateKey  Hex private key (with or without 0x)
 */
async function buildClobClient(privateKey) {
  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new ethers.Wallet(pk);
  const address = wallet.address;

  const cached = _clobClientCache.get(address);
  if (cached && Date.now() - cached.ts < CLOB_CLIENT_TTL) {
    return { client: cached.client, address };
  }

  // The @polymarket/clob-client SDK (>=5.x) checks for _signTypedData (ethers v5)
  // OR signTypedData (viem). Ethers v6 has signTypedData but no account.address,
  // so the SDK falls into the viem path and fails.
  // Fix: expose a viem-compatible wrapper so the SDK finds account.address.
  const signer = {
    account:         { address },
    signTypedData:   ({ domain, types, primaryType, message }) =>
      wallet.signTypedData(domain, types, message),
    requestAddresses: async () => [address],
    getAddresses:     async () => [address],
  };

  // Derive L2 creds first, then pass into constructor (v5 API — no setApiCreds)
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  const creds = await tempClient.createOrDeriveApiKey();

  // Re-construct with creds as 4th arg so all authenticated calls work
  const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds);

  _clobClientCache.set(address, { client, ts: Date.now() });
  return { client, address };
}

/**
 * Place a copy-trade FOK order.
 *
 * @param {object} params
 * @param {ClobClient} params.client     Authenticated CLOB client
 * @param {string}     params.tokenId    Market token ID
 * @param {string}     params.side       'BUY' | 'SELL'
 * @param {number}     params.price      Max price (BUY) or min price (SELL)
 * @param {number}     params.usdcAmount USDC notional to spend/receive
 * @param {number}     params.tickSize   Market tick size (default 0.01)
 */
async function placeCopyOrder({ client, tokenId, side, price, usdcAmount, tickSize = 0.01 }) {
  if (!tokenId || !price || !usdcAmount) throw new Error('Missing order params');
  if (price <= 0 || price >= 1) throw new Error(`Invalid prediction price: ${price}`);

  const shares = parseFloat((usdcAmount / price).toFixed(2));

  const { Side, OrderType } = require('@polymarket/clob-client');
  const orderSide = side === 'BUY' ? Side.BUY : Side.SELL;

  const resp = await client.createAndPostOrder(
    { tokenID: tokenId, price, size: shares, side: orderSide },
    { tickSize: String(tickSize), negRisk: false },
    OrderType.FOK
  );

  // Log raw response so we can identify the correct orderId field
  console.log('[POLY-CLOB] Raw createAndPostOrder response:', JSON.stringify(resp));

  // v5 SDK wraps the result differently depending on order outcome:
  //   { orderID, status, ... }  (direct)
  //   { order: { id, ... }, status }  (nested)
  //   { transactionHash, ... }  (on-chain tx)
  const orderId =
    resp?.orderID      ||
    resp?.orderId      ||
    resp?.order_id     ||
    resp?.order?.id    ||
    resp?.order?.orderID ||
    resp?.transactionHash ||
    resp?.hash         ||
    resp?.id           ||
    '';

  return {
    orderId,
    status:  resp?.status || resp?.order?.status || 'submitted',
    tokenId,
    side,
    price,
    shares,
    usdcAmount,
  };
}

/**
 * Fetch the full Polymarket wallet snapshot for the dashboard:
 *   - USDC balance available in the CLOB (funds inside Polymarket)
 *   - Open positions with current market value
 *   - Unrealized PnL across open positions
 *
 * @param {string} privateKey  Raw hex private key
 * @returns {Promise<{balance, available, unrealizedPnl, positions, positionList}>}
 */
async function getPolymarketWalletData(privateKey) {
  const { client, address } = await buildClobClient(privateKey);

  // ── CLOB balance (USDC inside Polymarket, ready to trade) ──
  let balance = 0;
  try {
    const ba = await client.getBalanceAllowance({ asset_type: 'USDC', signature_type: 'EOA' });
    // returns { balance: "12.34", allowance: "..." }
    balance = parseFloat(ba?.balance || ba?.data?.balance || 0);
  } catch (e) {
    console.warn(`[polymarket] getBalanceAllowance failed: ${e.message}`);
  }

  // ── Open positions from Data API ───────────────────────────
  let unrealizedPnl = 0;
  let positionList  = [];
  try {
    const positions = await getUserPositions(address);
    positionList = positions;

    for (const pos of positions) {
      if (!pos.tokenId || pos.size <= 0) continue;
      const mid = await getMidPrice(pos.tokenId).catch(() => 0);
      if (mid > 0 && pos.avgPrice > 0) {
        const currentVal = pos.size * mid;
        const costBasis  = pos.size * pos.avgPrice;
        unrealizedPnl += currentVal - costBasis;
      }
    }
  } catch (e) {
    console.warn(`[polymarket] positions fetch failed: ${e.message}`);
  }

  return {
    balance,
    available:     balance,
    unrealizedPnl: parseFloat(unrealizedPnl.toFixed(4)),
    positions:     positionList.length,
    positionList,
    address,
  };
}

module.exports = {
  getLeaderboard,
  getUserActivity,
  getUserPositions,
  getMidPrice,
  buildClobClient,
  placeCopyOrder,
  getPolymarketWalletData,
};
