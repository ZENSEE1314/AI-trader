const express = require('express');
const { query } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { USDMClient } = require('binance');
const cryptoUtils = require('../crypto-utils');

const router = express.Router();
router.use(authMiddleware);

// ── Signal board price cache — single bulk Binance call, shared across all users ──
// Replaces N parallel per-symbol calls on every page load (was 50 calls → now 1)
let _priceCache = { data: {}, ts: 0 };
const PRICE_CACHE_TTL = 30000; // 30 seconds

async function getSignalBoardPrices(symbols) {
  if (Date.now() - _priceCache.ts < PRICE_CACHE_TTL && Object.keys(_priceCache.data).length > 0) {
    return _priceCache.data;
  }
  try {
    const fetch = require('node-fetch');
    // Single request for ALL futures tickers — much faster than N individual calls
    const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 8000 });
    if (!r.ok) return _priceCache.data; // return stale on error
    const list = await r.json();
    const map = {};
    const symSet = new Set(symbols);
    for (const d of list) {
      if (symSet.has(d.symbol)) {
        map[d.symbol] = {
          symbol: d.symbol,
          price: parseFloat(d.lastPrice),
          change24h: parseFloat(d.priceChangePercent),
          volume: parseFloat(d.quoteVolume),
        };
      }
    }
    _priceCache = { data: map, ts: Date.now() };
    return map;
  } catch {
    return _priceCache.data; // return stale on error
  }
}

const PERIOD_INTERVALS = {
  '1d':  '1 day',
  '7d':  '7 days',
  '30d': '30 days',
  '6m':  '6 months',
  '1y':  '1 year',
};

// Cash wallet info for dashboard
router.get('/cash-wallet', async (req, res) => {
  try {
    const user = await query(
      `SELECT cash_wallet, commission_earned, referral_code, usdt_address, usdt_network,
              referral_tier, total_referral_commission, bitunix_referral_link
       FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!user.length) return res.status(404).json({ error: 'User not found' });
    const u = user[0];

    // Referral details: names + commission earned from each
    const referrals = await query(
      `SELECT u.id, u.email, u.created_at,
              COALESCE(SUM(rc.amount), 0) as total_commission
       FROM users u
       LEFT JOIN referral_commissions rc ON rc.referee_id = u.id AND rc.referrer_id = $1
       WHERE u.referred_by = $1
       GROUP BY u.id, u.email, u.created_at
       ORDER BY u.created_at DESC`,
      [req.userId]
    );

    const rawCash = parseFloat(u.cash_wallet) || 0;
    const commissionEarned = parseFloat(u.commission_earned) || 0;
    const cashWallet = rawCash + commissionEarned;

    // Break down cash wallet sources for transparency
    let profitShareTotal = 0;
    let topUpTotal = 0;
    let feesPaid = 0;
    try {
      const sources = await query(
        `SELECT type, COALESCE(SUM(amount), 0) as total
         FROM wallet_transactions
         WHERE user_id = $1 AND status = 'completed'
         GROUP BY type`,
        [req.userId]
      );
      for (const s of sources) {
        if (s.type === 'profit_share') profitShareTotal = parseFloat(s.total) || 0;
        else if (s.type === 'topup' || s.type === 'deposit') topUpTotal = parseFloat(s.total) || 0;
        else if (s.type === 'platform_fee' || s.type === 'weekly_fee') feesPaid += parseFloat(s.total) || 0;
      }
    } catch {}

    res.json({
      cash_wallet: cashWallet,
      commission_earned: commissionEarned,
      total_balance: cashWallet,
      breakdown: {
        top_ups: topUpTotal,
        profit_shares: profitShareTotal,
        referral_commission: commissionEarned,
        fees_paid: feesPaid,
      },
      referral_code: u.referral_code || '',
      referral_count: referrals.length,
      referral_tier: parseInt(u.referral_tier) || 1,
      total_referral_commission: parseFloat(u.total_referral_commission) || 0,
      usdt_address: u.usdt_address || '',
      usdt_network: u.usdt_network || 'BEP20',
      bitunix_referral_link: u.bitunix_referral_link || '',
      referrals: referrals.map(r => ({
        email: r.email,
        joined: r.created_at,
        commission: parseFloat(r.total_commission) || 0,
      })),
    });
  } catch (err) {
    console.error('Cash wallet error:', err.message);
    res.json({ cash_wallet: 0, commission_earned: 0, total_balance: 0, referral_code: '', referral_count: 0 });
  }
});

// Save user's personal Bitunix referral link
router.put('/bitunix-referral-link', async (req, res) => {
  try {
    const { link } = req.body;
    const cleaned = (link || '').trim().slice(0, 500);
    await query('UPDATE users SET bitunix_referral_link = $1 WHERE id = $2', [cleaned || null, req.userId]);
    res.json({ ok: true, bitunix_referral_link: cleaned });
  } catch (err) {
    console.error('Save Bitunix referral link error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Trade history
router.get('/trades', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;
    const period = PERIOD_INTERVALS[req.query.period];

    const params = [req.userId];
    const dateFilter = period
      ? `AND t.created_at > NOW() - INTERVAL '${period}'`
      : '';
    const dateFilterCount = period
      ? `AND created_at > NOW() - INTERVAL '${period}'`
      : '';

    const rows = await query(
      `SELECT t.*, ak.label as key_label, ak.platform
       FROM trades t
       LEFT JOIN api_keys ak ON t.api_key_id = ak.id
       WHERE t.user_id = $1 AND t.status != 'ERROR' ${dateFilter}
       ORDER BY t.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset]
    );

    const countRes = await query(
      `SELECT COUNT(*) as cnt FROM trades WHERE user_id = $1 AND status != 'ERROR' ${dateFilterCount}`,
      [req.userId]
    );
    res.json({ trades: rows, total: parseInt(countRes[0].cnt), page, pages: Math.ceil(countRes[0].cnt / limit) });
  } catch (err) {
    console.error('Trades error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Sync full Bitunix trade history
router.post('/sync-trades', async (req, res) => {
  try {
    const { AgentCoordinator } = require('../agents/agent-coordinator');
    const coordinator = AgentCoordinator.getInstance();
    const accAgent = coordinator?.agents?.accountant;
    if (!accAgent) return res.status(503).json({ error: 'Accountant agent not available' });
    const result = await accAgent.syncBitunixHistory();
    res.json(result);
  } catch (err) {
    console.error('Sync trades error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Pause/resume bot for this user
router.post('/toggle-pause', async (req, res) => {
  try {
    const keys = await query(
      'SELECT id, paused_by_user FROM api_keys WHERE user_id = $1 AND enabled = true',
      [req.userId]
    );
    if (!keys.length) return res.status(404).json({ error: 'No active keys found' });

    const currentlyPaused = keys[0].paused_by_user === true;
    const newState = !currentlyPaused;

    await query(
      `UPDATE api_keys SET paused_by_user = $1, paused_at = $2
       WHERE user_id = $3 AND enabled = true`,
      [newState, newState ? new Date() : null, req.userId]
    );

    // If pausing, also pause the weekly timer by recording pause time on user
    if (newState) {
      await query(
        'UPDATE users SET timer_paused_at = NOW() WHERE id = $1',
        [req.userId]
      );
    } else {
      // Resuming: add paused duration to last_paid_at so timer doesn't count paused time
      const user = await query('SELECT timer_paused_at, last_paid_at FROM users WHERE id = $1', [req.userId]);
      if (user.length && user[0].timer_paused_at) {
        const pausedMs = Date.now() - new Date(user[0].timer_paused_at).getTime();
        await query(
          `UPDATE users SET last_paid_at = last_paid_at + ($1 || ' milliseconds')::interval,
                           timer_paused_at = NULL WHERE id = $2`,
          [pausedMs, req.userId]
        );
      }
    }

    res.json({ paused: newState });
  } catch (err) {
    console.error('Toggle pause error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get pause status
router.get('/pause-status', async (req, res) => {
  try {
    const keys = await query(
      'SELECT paused_by_user FROM api_keys WHERE user_id = $1 AND enabled = true LIMIT 1',
      [req.userId]
    );
    const paused = keys.length > 0 && keys[0].paused_by_user === true;
    res.json({ paused });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// CSV export of all trades
router.get('/trades/csv', async (req, res) => {
  try {
    const period = PERIOD_INTERVALS[req.query.period];
    const dateFilter = period
      ? `AND t.created_at > NOW() - INTERVAL '${period}'`
      : '';

    const rows = await query(
      `SELECT t.created_at, t.symbol, t.direction, t.entry_price, t.exit_price,
              t.sl_price, t.tp_price, t.pnl_usdt, t.status, t.closed_at,
              ak.label as key_label, ak.platform
       FROM trades t
       LEFT JOIN api_keys ak ON t.api_key_id = ak.id
       WHERE t.user_id = $1 ${dateFilter}
       ORDER BY t.created_at DESC`,
      [req.userId]
    );

    const header = 'Date,Symbol,Direction,Entry Price,Exit Price,SL Price,TP Price,PnL (USDT),Status,Closed At,Key Label,Platform';
    const csvRows = rows.map(r => {
      const date = r.created_at ? new Date(r.created_at).toISOString() : '';
      const closedAt = r.closed_at ? new Date(r.closed_at).toISOString() : '';
      return [
        date, r.symbol || '', r.direction || '', r.entry_price || '', r.exit_price || '',
        r.sl_price || '', r.tp_price || '', r.pnl_usdt || '0', r.status || '', closedAt,
        (r.key_label || '').replace(/,/g, ' '), (r.platform || '').replace(/,/g, ' '),
      ].join(',');
    });

    const csv = '\uFEFF' + ['sep=,', header, ...csvRows].join('\r\n');
    const filename = `trades_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('CSV export error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// P&L summary (supports ?period=1d|7d|30d|6m|1y filter)
// Cache summaries for 45s — longer than the 30s frontend refresh so every
// refresh hits the cache instead of running a DB scan.
const summaryCache = new Map();
const SUMMARY_CACHE_TTL = 45_000;

router.get('/summary', async (req, res) => {
  try {
    const cacheKey = `${req.userId}:${req.query.period || 'all'}`;
    const cached = summaryCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SUMMARY_CACHE_TTL) {
      return res.json(cached.data);
    }

    const period = PERIOD_INTERVALS[req.query.period];
    const dateFilter = period
      ? `AND created_at > NOW() - INTERVAL '${period}'`
      : '';

    const rows = await query(
      `SELECT
        COUNT(*) as total_trades,
        COUNT(*) FILTER (WHERE status = 'WIN' OR status LIKE 'TP%' OR (status = 'CLOSED' AND pnl_usdt > 0)) as wins,
        COUNT(*) FILTER (WHERE status = 'LOSS' OR status = 'SL' OR (status = 'CLOSED' AND pnl_usdt < 0)) as losses,
        COUNT(*) FILTER (WHERE status = 'OPEN') as open_trades,
        COALESCE(SUM(pnl_usdt), 0) as total_pnl,
        COALESCE(SUM(pnl_usdt) FILTER (WHERE pnl_usdt > 0), 0) as total_won,
        COALESCE(SUM(pnl_usdt) FILTER (WHERE pnl_usdt < 0), 0) as total_lost,
        COALESCE(SUM(pnl_usdt) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0) as pnl_24h,
        COALESCE(SUM(pnl_usdt) FILTER (WHERE created_at > NOW() - INTERVAL '7 days'), 0) as pnl_7d
       FROM trades WHERE user_id = $1 ${dateFilter}`,
      [req.userId]
    );

    const perKey = await query(
      `SELECT ak.label, ak.platform, COUNT(t.id) as trades,
              COALESCE(SUM(t.pnl_usdt), 0) as pnl
       FROM api_keys ak
       LEFT JOIN trades t ON t.api_key_id = ak.id
       WHERE ak.user_id = $1
       GROUP BY ak.id, ak.label, ak.platform`,
      [req.userId]
    );

    const summary = rows[0];
    const total = parseInt(summary.total_trades);
    const wins = parseInt(summary.wins);
    const losses = parseInt(summary.losses);
    summary.win_rate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0';
    summary.per_key = perKey;

    summaryCache.set(cacheKey, { data: summary, ts: Date.now() });
    res.json(summary);
  } catch (err) {
    console.error('Summary error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Futures wallet balances from ALL connected exchanges
// Cache per user for 60s — exchange API calls are the #1 page load bottleneck.
// Wallet balance doesn't change faster than this in practice.
const walletCache = new Map();
const WALLET_CACHE_TTL = 60_000; // 60 seconds

router.get('/futures-wallet', async (req, res) => {
  try {
    // Serve from cache if fresh (avoids expensive exchange API calls)
    const cached = walletCache.get(req.userId);
    if (cached && Date.now() - cached.ts < WALLET_CACHE_TTL) {
      return res.json(cached.data);
    }

    const keys = await query(
      `SELECT id, platform, label, api_key_enc, iv, auth_tag, api_secret_enc, secret_iv, secret_auth_tag
       FROM api_keys WHERE user_id = $1 AND enabled = true ORDER BY id`,
      [req.userId]
    );

    // Fetch all exchange wallets in parallel
    const results = await Promise.allSettled(keys.map(async (key) => {
      const apiKey = cryptoUtils.decrypt(key.api_key_enc, key.iv, key.auth_tag);
      const apiSecret = cryptoUtils.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);

      let balance = 0, available = 0, unrealizedPnl = 0, positions = 0;

      if (key.platform === 'binance') {
        const { getBinanceRequestOptions } = require('../proxy-agent');
        const client = new USDMClient({ api_key: apiKey, api_secret: apiSecret }, getBinanceRequestOptions());
        const account = await client.getAccountInformation({ omitZeroBalances: false });
        balance = parseFloat(account.totalWalletBalance) || 0;
        available = parseFloat(account.availableBalance) || 0;
        unrealizedPnl = parseFloat(account.totalUnrealizedProfit) || 0;
        positions = (account.positions || []).filter(p => parseFloat(p.positionAmt) !== 0).length;
      } else if (key.platform === 'bitunix') {
        const { BitunixClient } = require('../bitunix-client');
        const client = new BitunixClient({ apiKey, apiSecret });
        const account = await client.getAccountInformation();
        balance = parseFloat(account.totalWalletBalance) || 0;
        available = parseFloat(account.availableBalance) || 0;
        unrealizedPnl = parseFloat(account.totalUnrealizedProfit) || 0;
        positions = (account.positions || []).length;
      }

      return { id: key.id, platform: key.platform, label: key.label || `${key.platform} key`, balance, available, unrealizedPnl, positions };
    }));

    const wallets = [];
    let totalBalance = 0;
    let totalAvailable = 0;
    let totalUnrealizedPnl = 0;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        wallets.push(r.value);
        totalBalance += r.value.balance;
        totalAvailable += r.value.available;
        totalUnrealizedPnl += r.value.unrealizedPnl;
      } else {
        wallets.push({
          id: keys[i].id, platform: keys[i].platform,
          label: keys[i].label || `${keys[i].platform} key`,
          balance: 0, available: 0, unrealizedPnl: 0, positions: 0,
          error: r.reason?.message || 'Unknown error',
        });
      }
    }

    const responseData = {
      balance: totalBalance,
      available: totalAvailable,
      unrealizedPnl: totalUnrealizedPnl,
      wallets,
    };
    walletCache.set(req.userId, { data: responseData, ts: Date.now() });
    res.json(responseData);
  } catch (err) {
    console.error('Futures wallet error:', err.message);
    res.json({ balance: 0, available: 0, unrealizedPnl: 0, wallets: [] });
  }
});

// Weekly earnings with profit split (rolling 7-day window from last payment)
router.get('/weekly-earnings', async (req, res) => {
  try {
    const now = new Date();

    // Rolling window: last_paid_at → now. Resets to 0 after each payment.
    const userRow = await query(
      `SELECT created_at, last_paid_at, is_admin FROM users WHERE id = $1`, [req.userId]
    );
    const isAdminUser = userRow[0]?.is_admin === true;

    // Admin accounts are never overdue — keep last_paid_at fresh
    if (isAdminUser) {
      await query(`UPDATE users SET last_paid_at = NOW() WHERE id = $1`, [req.userId]);
      userRow[0].last_paid_at = now;
    }

    const paidAt = userRow[0]?.last_paid_at ? new Date(userRow[0].last_paid_at) : new Date(userRow[0]?.created_at || now);
    const periodStart = paidAt;
    const dueDate = new Date(paidAt.getTime() + 7 * 86400000);
    const msRemaining = dueDate - now;
    const daysRemaining = Math.max(0, Math.ceil(msRemaining / 86400000));
    const isOverdue = isAdminUser ? false : msRemaining <= 0;

    // Get user's profit share settings per key
    const keys = await query(
      `SELECT id, label, platform, profit_share_user_pct, profit_share_admin_pct
       FROM api_keys WHERE user_id = $1`,
      [req.userId]
    );

    // Get trades closed since last payment (rolling window)
    const weeklyTrades = await query(
      `SELECT t.api_key_id, t.pnl_usdt, t.status, t.symbol, t.direction,
              t.entry_price, t.exit_price, t.created_at, t.closed_at
       FROM trades t
       WHERE t.user_id = $1
         AND t.status IN ('WIN', 'LOSS', 'TP', 'SL', 'CLOSED')
         AND t.closed_at >= $2
       ORDER BY t.closed_at DESC`,
      [req.userId, periodStart]
    );

    // Calculate per-key earnings using NET P&L (wins - losses)
    const perKey = [];
    let totalNetPnl = 0;
    let totalUserShare = 0;
    let totalAdminShare = 0;
    let totalTrades = 0;
    let totalWins = 0;

    for (const key of keys) {
      const keyTrades = weeklyTrades.filter(t => t.api_key_id === key.id);
      const wins = keyTrades.filter(t => parseFloat(t.pnl_usdt) > 0);
      const netPnl = keyTrades.reduce((s, t) => s + parseFloat(t.pnl_usdt), 0);
      const userPct = parseFloat(key.profit_share_user_pct) || 60;
      const adminPct = parseFloat(key.profit_share_admin_pct) || 40;
      const shareable = Math.max(0, netPnl);
      const userShare = shareable * userPct / 100;
      const adminShare = shareable * adminPct / 100;

      perKey.push({
        key_id: key.id,
        label: key.label || key.platform,
        platform: key.platform,
        total_trades: keyTrades.length,
        win_count: wins.length,
        loss_count: keyTrades.length - wins.length,
        net_pnl: netPnl,
        user_share_pct: userPct,
        admin_share_pct: adminPct,
        user_share: userShare,
        admin_share: adminShare,
      });

      totalNetPnl += netPnl;
      totalUserShare += userShare;
      totalAdminShare += adminShare;
      totalTrades += keyTrades.length;
      totalWins += wins.length;
    }

    res.json({
      week_start: periodStart.toISOString(),
      week_end: dueDate.toISOString(),
      total_trades: totalTrades,
      total_wins: totalWins,
      total_losses: totalTrades - totalWins,
      net_pnl: totalNetPnl,
      user_share: totalUserShare,
      admin_share: totalAdminShare,
      user_share_pct: keys.length > 0 ? (parseFloat(keys[0].profit_share_user_pct) || 60) : 60,
      admin_share_pct: keys.length > 0 ? (parseFloat(keys[0].profit_share_admin_pct) || 40) : 40,
      per_key: perKey,
      payment_due: dueDate.toISOString(),
      days_remaining: daysRemaining,
      is_overdue: isOverdue,
    });
  } catch (err) {
    console.error('Weekly earnings error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Historical weekly earnings (last 8 weeks)
router.get('/weekly-history', async (req, res) => {
  try {
    const weeks = parseInt(req.query.weeks) || 8;
    const rows = await query(
      `SELECT week_start, week_end,
              SUM(winning_pnl) as winning_pnl,
              SUM(user_share) as user_share,
              SUM(admin_share) as admin_share,
              SUM(trade_count) as trade_count,
              SUM(win_count) as win_count
       FROM weekly_earnings
       WHERE user_id = $1 AND settled = true
       GROUP BY week_start, week_end
       ORDER BY week_start DESC
       LIMIT $2`,
      [req.userId, weeks]
    );
    res.json(rows);
  } catch (err) {
    console.error('Weekly history error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// User self-pay: deduct platform fee from cash wallet
router.post('/pay-weekly', async (req, res) => {
  try {
    const userId = req.userId;
    const now = new Date();

    // Admin accounts never pay — just refresh their timer
    const adminCheck = await query(`SELECT is_admin FROM users WHERE id = $1`, [userId]);
    if (adminCheck[0]?.is_admin === true) {
      await query(`UPDATE users SET last_paid_at = NOW() WHERE id = $1`, [userId]);
      return res.json({ ok: true, admin_exempt: true, message: 'Admin account — no fee required' });
    }

    // Rolling window: last_paid_at → now
    const userInfo = await query(
      `SELECT created_at, last_paid_at FROM users WHERE id = $1`, [userId]
    );
    const paidAt = userInfo[0]?.last_paid_at ? new Date(userInfo[0].last_paid_at) : new Date(userInfo[0]?.created_at || now);
    const periodStart = paidAt;

    // Get user's keys
    const keys = await query(
      `SELECT id, profit_share_user_pct, profit_share_admin_pct FROM api_keys WHERE user_id = $1`,
      [userId]
    );
    if (!keys.length) return res.status(400).json({ error: 'No API keys found' });

    // Get trades closed since last payment
    const trades = await query(
      `SELECT api_key_id, pnl_usdt, status FROM trades
       WHERE user_id = $1 AND status IN ('WIN','LOSS','TP','SL','CLOSED')
         AND closed_at >= $2`,
      [userId, periodStart]
    );

    // Calculate total admin share (platform fee)
    let totalAdminShare = 0;
    for (const key of keys) {
      const keyTrades = trades.filter(t => t.api_key_id === key.id);
      const netPnl = keyTrades.reduce((s, t) => s + parseFloat(t.pnl_usdt), 0);
      const shareable = Math.max(0, netPnl);
      const adminPct = parseFloat(key.profit_share_admin_pct) || 40;
      totalAdminShare += shareable * adminPct / 100;
    }

    if (totalAdminShare <= 0) return res.status(400).json({ error: 'No platform fee to pay (no net profit this week)' });

    // Check user has enough balance
    const userRow = await query(
      `SELECT cash_wallet, commission_earned FROM users WHERE id = $1`, [userId]
    );
    const cashWallet = (parseFloat(userRow[0]?.cash_wallet) || 0) + (parseFloat(userRow[0]?.commission_earned) || 0);
    if (cashWallet < totalAdminShare) {
      const shortfall = totalAdminShare - cashWallet;
      return res.status(400).json({
        error: `Insufficient balance. Fee: $${totalAdminShare.toFixed(2)}, Wallet: $${cashWallet.toFixed(2)}. Please top up at least $${shortfall.toFixed(2)}.`,
        code: 'INSUFFICIENT_BALANCE',
        fee: totalAdminShare,
        balance: cashWallet,
        shortfall,
      });
    }

    // Save per-key earnings to weekly_earnings history
    for (const key of keys) {
      const keyTrades = trades.filter(t => t.api_key_id === key.id);
      const netPnl = keyTrades.reduce((s, t) => s + parseFloat(t.pnl_usdt), 0);
      const wins = keyTrades.filter(t => parseFloat(t.pnl_usdt) > 0);
      const winPnl = wins.reduce((s, t) => s + parseFloat(t.pnl_usdt), 0);
      const shareable = Math.max(0, netPnl);
      const userPct = parseFloat(key.profit_share_user_pct) || 60;
      const adminPct = parseFloat(key.profit_share_admin_pct) || 40;

      await query(
        `INSERT INTO weekly_earnings (user_id, api_key_id, week_start, week_end,
          total_pnl, winning_pnl, user_share, admin_share,
          user_share_pct, admin_share_pct, trade_count, win_count, settled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
         ON CONFLICT (user_id, api_key_id, week_start)
         DO UPDATE SET total_pnl=$5, winning_pnl=$6, user_share=$7, admin_share=$8,
           trade_count=$11, win_count=$12, settled=true`,
        [userId, key.id, periodStart, now, netPnl, winPnl,
         shareable * userPct / 100, shareable * adminPct / 100,
         userPct, adminPct, keyTrades.length, wins.length]
      );
    }

    // Deduct from cash_wallet (prefer cash_wallet first, then commission_earned)
    let remaining = totalAdminShare;
    const rawCash = parseFloat(userRow[0]?.cash_wallet) || 0;
    const commEarned = parseFloat(userRow[0]?.commission_earned) || 0;
    const cashDeduct = Math.min(rawCash, remaining);
    remaining -= cashDeduct;
    const commDeduct = Math.min(commEarned, remaining);

    await query(
      `UPDATE users SET cash_wallet = cash_wallet - $1,
                        commission_earned = commission_earned - $2,
                        last_paid_at = NOW()
       WHERE id = $3`,
      [cashDeduct, commDeduct, userId]
    );

    // Record the payment in wallet_transactions
    await query(
      `INSERT INTO wallet_transactions (user_id, type, amount, status, description)
       VALUES ($1, 'platform_fee', $2, 'completed', $3)`,
      [userId, -totalAdminShare,
       `Weekly platform fee payment for ${periodStart.toISOString().slice(0,10)} to ${now.toISOString().slice(0,10)} | Trades: ${trades.length} | Net P&L: $${trades.reduce((s, t) => s + parseFloat(t.pnl_usdt), 0).toFixed(2)}`]
    );

    // Resume trading (unpause keys)
    await query(
      `UPDATE api_keys SET paused_by_admin = false, enabled = true WHERE user_id = $1`,
      [userId]
    );

    // Pay referral commission from platform's share
    const referrerRow = await query('SELECT referred_by FROM users WHERE id = $1', [userId]);
    if (referrerRow.length > 0 && referrerRow[0].referred_by) {
      const referrerId = referrerRow[0].referred_by;
      const settingsRow = await query("SELECT value FROM settings WHERE key = 'referral_commission_pct'");
      const refPct = settingsRow.length > 0 ? parseFloat(settingsRow[0].value) : 10;
      const referralAmount = parseFloat((totalAdminShare * refPct / 100).toFixed(4));

      if (referralAmount > 0) {
        const userEmail = (await query('SELECT email FROM users WHERE id = $1', [userId]))[0]?.email || `#${userId}`;
        await query(
          `UPDATE users SET cash_wallet = cash_wallet + $1,
                            commission_earned = commission_earned + $1,
                            total_referral_commission = total_referral_commission + $1
           WHERE id = $2`,
          [referralAmount, referrerId]
        );
        await query(
          `INSERT INTO referral_commissions (referrer_id, referee_id, level, amount, description)
           VALUES ($1, $2, 1, $3, $4)`,
          [referrerId, userId, referralAmount,
           `Weekly commission from ${userEmail} (${refPct}% of $${totalAdminShare.toFixed(2)} platform fee)`]
        );
        await query(
          `INSERT INTO wallet_transactions (user_id, type, amount, status, description)
           VALUES ($1, 'referral_commission', $2, 'completed', $3)`,
          [referrerId, referralAmount,
           `Weekly referral commission from ${userEmail}`]
        );
      }
    }

    res.json({ ok: true, message: `Paid $${totalAdminShare.toFixed(2)} platform fee. Trading resumed!` });
  } catch (err) {
    console.error('Pay weekly error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Token Signal Board & Watchlist ───────────────────────────

// GET /api/dashboard/signal-board — top 50 tokens with signals + watchlist
router.get('/signal-board', async (req, res) => {
  try {
    const { getSignalBoard } = require('../token-scanner');
    const { getDailyResults } = require('../token-scanner');
    const board = getSignalBoard();
    const dailyResults = await getDailyResults();

    // Source of truth: admin's global_token_settings defines WHICH tokens are available.
    // Users toggle on/off from that fixed pool — user_watchlist stores their toggle state.
    // This ensures My Tokens always matches what the bot actually scans.
    const adminTokenRows = await query(
      `SELECT symbol FROM global_token_settings
       WHERE enabled = true AND (banned IS NULL OR banned = false)
       ORDER BY symbol ASC`
    );
    const symbols = adminTokenRows.map(r => r.symbol);

    if (!symbols.length) {
      return res.json({ tokens: [], lastScanAt: board.lastScanAt, dailyResults, watchlist: {} });
    }

    // User's toggle state for these symbols
    const watchlist = await query(
      'SELECT symbol, enabled FROM user_watchlist WHERE user_id = $1',
      [req.userId]
    );
    const watchMap = {};
    for (const w of watchlist) watchMap[w.symbol] = w.enabled;
    // Symbols not yet in user's watchlist default to enabled
    for (const sym of symbols) {
      if (watchMap[sym] === undefined) watchMap[sym] = true;
    }

    // Fetch live prices — single bulk request cached 30s server-side
    // One call for all symbols beats N parallel per-symbol calls on every page load
    const priceMap = await getSignalBoardPrices(symbols);

    // Get user's per-token leverage
    let userLevMap = {};
    try {
      const keys = await query('SELECT id FROM api_keys WHERE user_id = $1 LIMIT 1', [req.userId]);
      if (keys.length) {
        const levs = await query('SELECT symbol, leverage FROM user_token_leverage WHERE api_key_id = $1', [keys[0].id]);
        for (const l of levs) userLevMap[l.symbol] = parseInt(l.leverage);
      }
    } catch {}

    // Get admin risk tags
    let riskTags = {};
    try {
      const tags = await query('SELECT symbol, risk_tag, featured FROM global_token_settings WHERE risk_tag IS NOT NULL OR featured = true');
      for (const t of tags) riskTags[t.symbol] = { risk: t.risk_tag, featured: t.featured };
    } catch {}

    // Merge: watchlist tokens + live price + signal status + risk tags
    const tokens = symbols.map(sym => {
      const p = priceMap[sym] || { symbol: sym, price: 0, change24h: 0, volume: 0 };
      return {
        ...p,
        signal: board.tokens[sym] || null,
        direction: board.tokens[sym]?.direction || null,
        score: board.tokens[sym]?.score || 0,
        watching: watchMap[sym] === true,
        riskTag: riskTags[sym]?.risk || null,
        featured: riskTags[sym]?.featured || false,
        userLeverage: userLevMap[sym] || 20,
      };
    });

    res.json({ tokens, lastScanAt: board.lastScanAt, dailyResults, watchlist: watchMap });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/daily-results — token leaderboard
router.get('/daily-results', async (req, res) => {
  try {
    const { getDailyResults } = require('../token-scanner');
    const date = req.query.date || null;
    const results = await getDailyResults(date);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/watchlist — add token to user's watchlist
router.post('/watchlist', async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
    await query(
      `INSERT INTO user_watchlist (user_id, symbol, enabled)
       VALUES ($1, $2, true)
       ON CONFLICT (user_id, symbol) DO UPDATE SET enabled = true`,
      [req.userId, symbol.toUpperCase()]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/dashboard/watchlist/:symbol — remove from watchlist
router.delete('/watchlist/:symbol', async (req, res) => {
  try {
    await query(
      'DELETE FROM user_watchlist WHERE user_id = $1 AND symbol = $2',
      [req.userId, req.params.symbol.toUpperCase()]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/watchlist/bulk — enable/disable all
router.post('/watchlist/bulk', async (req, res) => {
  try {
    const { symbols, enabled } = req.body;
    if (!symbols || !Array.isArray(symbols)) return res.status(400).json({ error: 'Missing symbols array' });
    for (const sym of symbols) {
      await query(
        `INSERT INTO user_watchlist (user_id, symbol, enabled) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, symbol) DO UPDATE SET enabled = $3`,
        [req.userId, sym.toUpperCase(), !!enabled]
      );
    }
    res.json({ ok: true, count: symbols.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/dashboard/watchlist/:symbol/leverage — set user per-token leverage
router.put('/watchlist/:symbol/leverage', async (req, res) => {
  try {
    const { leverage } = req.body;
    const lev = parseInt(leverage) || 20;
    const symbol = req.params.symbol.toUpperCase();
    // Get user's first API key for the leverage override
    const keys = await query('SELECT id FROM api_keys WHERE user_id = $1 LIMIT 1', [req.userId]);
    if (keys.length) {
      await query(
        `INSERT INTO user_token_leverage (api_key_id, symbol, leverage)
         VALUES ($1, $2, $3)
         ON CONFLICT (api_key_id, symbol) DO UPDATE SET leverage = $3`,
        [keys[0].id, symbol, lev]
      );
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/dashboard/watchlist/:symbol/toggle — enable/disable
router.put('/watchlist/:symbol/toggle', async (req, res) => {
  try {
    const { enabled } = req.body;
    await query(
      `UPDATE user_watchlist SET enabled = $1 WHERE user_id = $2 AND symbol = $3`,
      [!!enabled, req.userId, req.params.symbol.toUpperCase()]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kronos AI predictions — read from DB (persisted across processes)
const KRONOS_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const kronosCache = new Map(); // key → { data, ts }
const KRONOS_CACHE_TTL = 60_000; // predictions update every few minutes, cache 60s

router.get('/kronos-predictions', async (req, res) => {
  try {
    const cached = kronosCache.get('global');
    if (cached && Date.now() - cached.ts < KRONOS_CACHE_TTL) return res.json(cached.data);

    // Read from DB — only the 4 trading tokens, predictions fresher than 15 min
    const rows = await query(
      `SELECT symbol, direction, current_price, predicted_price, change_pct,
              confidence, trend, pred_high, pred_low, scanned_at
       FROM kronos_predictions
       WHERE scanned_at > NOW() - INTERVAL '15 minutes'
         AND symbol = ANY($1)
       ORDER BY ABS(change_pct) DESC`,
      [KRONOS_SYMBOLS]
    );

    const predictions = rows.map(r => ({
      symbol: r.symbol,
      direction: r.direction,
      current: parseFloat(r.current_price) || 0,
      predicted: parseFloat(r.predicted_price) || 0,
      change_pct: parseFloat(r.change_pct) || 0,
      confidence: r.confidence,
      trend: r.trend,
      pred_high: parseFloat(r.pred_high) || 0,
      pred_low: parseFloat(r.pred_low) || 0,
      scanned_at: r.scanned_at,
    }));

    const longs = predictions.filter(p => p.direction === 'LONG');
    const shorts = predictions.filter(p => p.direction === 'SHORT');
    const neutrals = predictions.filter(p => p.direction === 'NEUTRAL');

    const payload = {
      total: predictions.length,
      longs: longs.length,
      shorts: shorts.length,
      neutrals: neutrals.length,
      predictions,
    };
    kronosCache.set('global', { data: payload, ts: Date.now() });
    res.json(payload);
  } catch (err) {
    console.error('Kronos predictions error:', err.message);
    res.json({ total: 0, longs: 0, shorts: 0, neutrals: 0, predictions: [] });
  }
});

// ── Hermes Integration Status ────────────────────────────────
router.get('/hermes-status', async (req, res) => {
  try {
    const hermes = require('../hermes-bridge');
    const status = hermes.getHermesStatus();
    const teamMemory = hermes.readTeamMemory();

    res.json({
      ...status,
      teamMemoryEntries: teamMemory.length,
      recentTeamMemory: teamMemory.slice(-5),
    });
  } catch (err) {
    res.json({ installed: false, error: err.message });
  }
});

// ── Strategy Backtests ────────────────────────────────────
router.get('/strategy-backtests', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, name, params, total_trades, wins, losses, win_rate, total_pnl,
              avg_win, avg_loss, max_drawdown, symbols, top_trades, created_at
       FROM strategy_backtests
       ORDER BY created_at DESC
       LIMIT 50`
    );
    res.json({ backtests: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agent Leaderboard ────────────────────────────────────
router.get('/leaderboard', async (req, res) => {
  try {
    const { getCoordinator } = require('../agents/agent-coordinator');
    const coord = getCoordinator();
    const board = coord.getLeaderboard();
    res.json({ leaderboard: board });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agent Jail ───────────────────────────────────────────
router.get('/jail', async (req, res) => {
  try {
    const { getCoordinator } = require('../agents/agent-coordinator');
    const coord = getCoordinator();
    const jailed = coord.getJailedAgents();
    res.json({ jailed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/jail/release', async (req, res) => {
  try {
    const { agentKey } = req.body;
    if (!agentKey) return res.status(400).json({ error: 'agentKey required' });
    const { getCoordinator } = require('../agents/agent-coordinator');
    const coord = getCoordinator();
    const { released, report } = await coord.releaseAgent(agentKey);
    res.json({ ok: released, agentKey, report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/jail/report/:agentKey', async (req, res) => {
  try {
    const { getCoordinator } = require('../agents/agent-coordinator');
    const coord = getCoordinator();
    const report = await coord.getViolationReport(req.params.agentKey);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agent Jail History ───────────────────────────────────
router.get('/jail/history', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, agent_key, agent_name, reason, violation_type, severity, warnings,
              jailed_at, released_at, released_by
       FROM agent_jail ORDER BY jailed_at DESC LIMIT 50`
    );
    res.json({ history: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Backtester ──────────────────────────────────────────────

router.post('/backtest', async (req, res) => {
  try {
    const { symbols, days = 60 } = req.body || {};
    const { runBacktest, applyBestStrategy } = require('../backtester');
    const result = await runBacktest({
      symbols: symbols || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT'],
      days: Math.min(Math.max(days, 7), 90),
    });
    // Auto-apply best strategy
    if (result.bestStrategy) {
      const applied = await applyBestStrategy(result);
      result.applied = applied;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/backtest/results', async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM strategy_backtests ORDER BY win_rate DESC, total_pnl DESC LIMIT 50`
    );
    res.json({ results: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CoderAgent Patch Review ──────────────────────────────────

router.get('/patches/pending', async (req, res) => {
  try {
    const { getCoordinator } = require('../agents');
    const coord = getCoordinator();
    res.json({ patches: coord.coderAgent.getPendingPatches() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/patches/applied', async (req, res) => {
  try {
    const { getCoordinator } = require('../agents');
    const coord = getCoordinator();
    res.json({ patches: coord.coderAgent.getAppliedPatches() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/patches/approve', async (req, res) => {
  try {
    const { patchId } = req.body;
    if (!patchId) return res.status(400).json({ error: 'patchId required' });
    const { getCoordinator } = require('../agents');
    const coord = getCoordinator();
    const result = await coord.coderAgent.approvePatch(patchId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/patches/reject', async (req, res) => {
  try {
    const { patchId } = req.body;
    if (!patchId) return res.status(400).json({ error: 'patchId required' });
    const { getCoordinator } = require('../agents');
    const coord = getCoordinator();
    const result = coord.coderAgent.rejectPatch(patchId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/patches/revert', async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath required' });
    const { getCoordinator } = require('../agents');
    const coord = getCoordinator();
    const result = await coord.coderAgent.revertPatch(filePath);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bot Logs (for emulator live logs panel) ──────────────
router.get('/logs', async (req, res) => {
  try {
    const { getRecentLogs } = require('../bot-logger');
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const logs = getRecentLogs(limit, null, 'all');
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Exhaustive Optimizer Results ──────────────────────────
router.get('/optimizer/results', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const symbol = req.query.symbol || null;
    const minWR  = parseFloat(req.query.min_wr)  || 0;
    const minPF  = parseFloat(req.query.min_pf)  || 0;

    const conditions = ['total_trades >= 10'];
    const params     = [];

    if (symbol) { params.push(symbol); conditions.push(`symbol = $${params.length}`); }
    if (minWR > 0) { params.push(minWR); conditions.push(`win_rate >= $${params.length}`); }
    if (minPF > 0) { params.push(minPF); conditions.push(`profit_factor >= $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);

    const rows = await query(
      `SELECT id, generation, genome, symbol, win_rate, profit_factor, total_return,
              max_drawdown, expectancy, sharpe, avg_win, avg_loss,
              total_trades, wins, losses, fitness, tested_at
       FROM strategy_search_results
       ${where}
       ORDER BY fitness DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = params.slice(0, params.length - 2);
    const countRow = await query(
      `SELECT COUNT(*) as total FROM strategy_search_results ${where}`,
      countParams
    );

    // Optimizer runtime status
    let optimizerStatus = null;
    try { optimizerStatus = require('../exhaustive-optimizer').status(); } catch {}

    res.json({
      total:   parseInt(countRow[0]?.total) || 0,
      limit,
      offset,
      results: rows,
      optimizer: optimizerStatus,
    });
  } catch (err) {
    console.error('[optimizer/results]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Strategy WR report from real closed trades ────────────────────────────────
// GET /api/dashboard/strategy-wr?days=30
router.get('/strategy-wr', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Per-strategy breakdown
    const bySetup = await query(`
      SELECT
        COALESCE(market_structure, 'UNKNOWN') AS setup,
        COUNT(*)                              AS total,
        SUM(CASE WHEN pnl_usdt > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN pnl_usdt <= 0 THEN 1 ELSE 0 END) AS losses,
        ROUND(AVG(pnl_usdt)::numeric, 4)     AS avg_pnl,
        ROUND(SUM(pnl_usdt)::numeric, 4)     AS total_pnl,
        ROUND(AVG(CASE WHEN pnl_usdt > 0 THEN pnl_usdt END)::numeric, 4) AS avg_win,
        ROUND(AVG(CASE WHEN pnl_usdt <= 0 THEN pnl_usdt END)::numeric, 4) AS avg_loss
      FROM trades
      WHERE status IN ('WIN','LOSS','CLOSED','TP','SL')
        AND closed_at IS NOT NULL
        AND closed_at >= $1
        AND pnl_usdt IS NOT NULL
      GROUP BY market_structure
      ORDER BY total DESC
    `, [since]);

    // Per-symbol breakdown
    const bySymbol = await query(`
      SELECT
        symbol,
        COUNT(*)  AS total,
        SUM(CASE WHEN pnl_usdt > 0 THEN 1 ELSE 0 END) AS wins,
        ROUND(SUM(pnl_usdt)::numeric, 4) AS total_pnl
      FROM trades
      WHERE status IN ('WIN','LOSS','CLOSED','TP','SL')
        AND closed_at IS NOT NULL
        AND closed_at >= $1
        AND pnl_usdt IS NOT NULL
      GROUP BY symbol
      ORDER BY total DESC
    `, [since]);

    // Overall
    const overall = await query(`
      SELECT
        COUNT(*)  AS total,
        SUM(CASE WHEN pnl_usdt > 0 THEN 1 ELSE 0 END) AS wins,
        ROUND(SUM(pnl_usdt)::numeric, 4)  AS total_pnl,
        ROUND(AVG(pnl_usdt)::numeric, 4)  AS avg_pnl
      FROM trades
      WHERE status IN ('WIN','LOSS','CLOSED','TP','SL')
        AND closed_at IS NOT NULL
        AND closed_at >= $1
        AND pnl_usdt IS NOT NULL
    `, [since]);

    const o = overall[0] || {};
    const totalT = parseInt(o.total) || 0;
    const wins   = parseInt(o.wins)  || 0;

    res.json({
      days,
      overall: {
        total:    totalT,
        wins,
        losses:   totalT - wins,
        wr:       totalT > 0 ? parseFloat(((wins / totalT) * 100).toFixed(1)) : 0,
        total_pnl: parseFloat(o.total_pnl) || 0,
        avg_pnl:  parseFloat(o.avg_pnl)   || 0,
      },
      by_strategy: bySetup.map(r => ({
        setup:     r.setup,
        total:     parseInt(r.total),
        wins:      parseInt(r.wins),
        losses:    parseInt(r.losses),
        wr:        parseInt(r.total) > 0 ? parseFloat(((parseInt(r.wins) / parseInt(r.total)) * 100).toFixed(1)) : 0,
        avg_pnl:   parseFloat(r.avg_pnl)   || 0,
        total_pnl: parseFloat(r.total_pnl) || 0,
        avg_win:   parseFloat(r.avg_win)   || 0,
        avg_loss:  parseFloat(r.avg_loss)  || 0,
      })),
      by_symbol: bySymbol.map(r => ({
        symbol:    r.symbol,
        total:     parseInt(r.total),
        wins:      parseInt(r.wins),
        wr:        parseInt(r.total) > 0 ? parseFloat(((parseInt(r.wins) / parseInt(r.total)) * 100).toFixed(1)) : 0,
        total_pnl: parseFloat(r.total_pnl) || 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Re-sync all closed Bitunix trades from exchange (admin only) ──────────────
// POST /api/dashboard/resync-bitunix
// Groups trades by API key → fetches position history ONCE per key → matches in memory.
// This avoids hammering the Bitunix API with 200 calls and surfaces auth errors clearly.
router.post('/resync-bitunix', async (req, res) => {
  try {
    const adminCheck = await query(`SELECT is_admin FROM users WHERE id = $1`, [req.userId]);
    if (!adminCheck[0]?.is_admin) return res.status(403).json({ error: 'Admin only' });

    const { BitunixClient } = require('../bitunix-client');
    const cryptoUtils2  = require('../crypto-utils');

    try {
      await query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS bitunix_position_id VARCHAR(64)`);
    } catch (_) {}

    // Only fetch trades that are missing exit data — already-synced WIN/LOSS trades are skipped.
    // CLOSED = bot closed it but never got PnL from exchange.
    // WIN/LOSS without exit_price = opened but never matched to exchange position.
    const trades = await query(`
      SELECT t.*,
             ak.id AS key_id,
             ak.api_key_enc, ak.iv, ak.auth_tag,
             ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag
      FROM trades t
      JOIN api_keys ak ON t.api_key_id = ak.id
      WHERE ak.platform = 'bitunix'
        AND t.status IN ('CLOSED','WIN','LOSS')
        AND (t.exit_price IS NULL OR t.pnl_usdt IS NULL)
      ORDER BY t.created_at DESC
      LIMIT 200
    `);

    if (!trades.length) return res.json({ total: 0, fixed: 0, skipped: 0, failed: 0, results: [], errors: [] });

    // ── Group by api_key_id and build a per-key position history cache ──────
    // Bitunix requires symbol param — fetch per distinct symbol, merge results.
    const keyHistoryCache = new Map(); // key_id → { positions: [], error: string|null }
    const uniqueKeyIds = [...new Set(trades.map(t => t.key_id))];
    const RESYNC_DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];

    for (const kid of uniqueKeyIds) {
      const t0 = trades.find(t => t.key_id === kid);
      try {
        const apiKey    = cryptoUtils2.decrypt(t0.api_key_enc, t0.iv, t0.auth_tag);
        const apiSecret = cryptoUtils2.decrypt(t0.api_secret_enc, t0.secret_iv, t0.secret_auth_tag);
        if (!apiKey || !apiSecret) throw new Error('Decrypt failed — check crypto-utils config');

        const bxClient  = new BitunixClient({ apiKey, apiSecret });
        // Bitunix silently returns empty without symbol param — fetch per symbol.
        const keySymbols = trades.filter(t => t.key_id === kid).map(t => t.symbol);
        const allSymbols = [...new Set([...RESYNC_DEFAULT_SYMBOLS, ...keySymbols])];

        const allPositions = [];
        for (const sym of allSymbols) {
          try {
            const raw = await bxClient._rawGet('/api/v1/futures/position/get_history_positions', {
              symbol: sym, pageNum: 1, pageSize: 100,
            });
            console.log(`[resync-bitunix] ${sym} code=${raw?.code} msg=${raw?.msg}`);
            if (raw?.code !== 0) continue;
            const d = raw?.data;
            const list = Array.isArray(d) ? d
              : (d?.positionList || d?.resultList || d?.list || d?.data || d?.records || []);
            allPositions.push(...list);
          } catch (symErr) {
            console.warn(`[resync-bitunix] ${sym} error: ${symErr.message}`);
          }
        }
        console.log(`[resync-bitunix] key ${kid}: ${allPositions.length} positions across ${allSymbols.length} symbols`);
        keyHistoryCache.set(kid, { positions: allPositions, error: null });
      } catch (e) {
        keyHistoryCache.set(kid, { positions: [], error: e.message });
      }
    }

    // ── Match each trade to a history position ───────────────────────────────
    let fixed = 0, skipped = 0, failed = 0;
    const results  = [];
    const errors   = [];

    for (const trade of trades) {
      const cache = keyHistoryCache.get(trade.key_id);

      if (cache.error) {
        failed++;
        const msg = `API key error: ${cache.error}`;
        results.push({ id: trade.id, symbol: trade.symbol, result: msg });
        if (!errors.find(e => e.key_id === trade.key_id)) {
          errors.push({ key_id: trade.key_id, error: cache.error });
        }
        continue;
      }

      try {
        const isLong       = trade.direction !== 'SHORT';
        const tradeEntry   = parseFloat(trade.entry_price);
        const tradeOpenMs  = trade.created_at ? new Date(trade.created_at).getTime() : 0;
        const storedPosId  = trade.bitunix_position_id;

        let bestMatch   = null;
        let bestTimeDiff = Infinity;

        for (const p of cache.positions) {
          const cp    = parseFloat(p.closePrice || p.avgClosePrice || p.closedPrice || p.close_price || 0);
          const ep    = parseFloat(p.entryPrice  || p.avgOpenPrice  || p.openPrice  || p.open_price  || 0);
          const pid   = String(p.positionId || p.id || p.position_id || '');
          const pSide = (p.side || p.positionSide || p.position_side || '').toUpperCase();
          const pLong = pSide === 'LONG' || pSide === 'BUY';
          const closeMs = parseInt(p.closeTime || p.mtime || p.ctime || p.updateTime || p.close_time || 0);

          if (cp <= 0 || (p.symbol || '').toUpperCase() !== trade.symbol || pLong !== isLong) continue;

          // Exact position ID match = best possible
          if (storedPosId && pid === String(storedPosId)) { bestMatch = p; break; }

          const entryClose  = ep > 0 && Math.abs(ep - tradeEntry) / tradeEntry < 0.005;
          const timingOk    = !tradeOpenMs || !closeMs || closeMs >= tradeOpenMs;
          if (entryClose && timingOk) {
            const diff = closeMs && tradeOpenMs ? Math.abs(closeMs - tradeOpenMs) : 9e12;
            if (diff < bestTimeDiff) { bestTimeDiff = diff; bestMatch = p; }
          }
        }

        if (!bestMatch) {
          skipped++;
          results.push({ id: trade.id, symbol: trade.symbol, result: 'no_match' });
          continue;
        }

        const p        = bestMatch;
        const exitPrice  = parseFloat(p.closePrice || p.avgClosePrice || p.closedPrice || p.close_price || 0);
        const tradingFee = Math.abs(parseFloat(p.fee || p.tradingFee || p.commission || 0));
        const fundingFee = Math.abs(parseFloat(p.funding || p.fundingFee || p.fund_fee || 0));
        const pnlRaw     = p.realizedPNL ?? p.realizedPnl ?? p.pnl ?? p.profit ?? p.realPnl ?? null;

        if (pnlRaw == null || exitPrice === 0) {
          skipped++;
          results.push({ id: trade.id, symbol: trade.symbol, result: 'missing_pnl_or_exit', raw: JSON.stringify(p).substring(0, 200) });
          continue;
        }

        const pnlUsdt  = parseFloat(parseFloat(pnlRaw).toFixed(4));
        const grossPnl = parseFloat((pnlUsdt + tradingFee + fundingFee).toFixed(4));
        const status   = pnlUsdt > 0 ? 'WIN' : 'LOSS';

        await query(`
          UPDATE trades
          SET exit_price = $1, pnl_usdt = $2, gross_pnl = $3,
              trading_fee = $4, funding_fee = $5, status = $6,
              closed_at = COALESCE(closed_at, NOW())
          WHERE id = $7
        `, [exitPrice, pnlUsdt, grossPnl, tradingFee, fundingFee, status, trade.id]);

        fixed++;
        results.push({
          id: trade.id, symbol: trade.symbol,
          old: { exit: trade.exit_price, net: trade.pnl_usdt },
          new: { exit: exitPrice, net: pnlUsdt, gross: grossPnl, fee: tradingFee, status },
        });
      } catch (e) {
        failed++;
        results.push({ id: trade.id, symbol: trade.symbol, result: `error: ${e.message}` });
      }
    }

    res.json({ total: trades.length, fixed, skipped, failed, errors, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Pull recent 100 closed Bitunix positions → insert/update trade records ───
// POST /api/dashboard/pull-bitunix-history
// Fetches 1 page × 100 for each of the user's Bitunix keys and syncs to DB.
router.post('/pull-bitunix-history', async (req, res) => {
  try {
    const { BitunixClient } = require('../bitunix-client');
    const cryptoUtils2 = require('../crypto-utils');

    // Admin pulls history for ALL users; regular users pull only their own
    const adminRow = await query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
    const isAdmin = adminRow[0]?.is_admin;

    const keys = isAdmin
      ? await query(
          `SELECT id, user_id, api_key_enc, iv, auth_tag, api_secret_enc, secret_iv, secret_auth_tag
           FROM api_keys WHERE platform = 'bitunix' AND enabled = true`
        )
      : await query(
          `SELECT id, user_id, api_key_enc, iv, auth_tag, api_secret_enc, secret_iv, secret_auth_tag
           FROM api_keys WHERE user_id = $1 AND platform = 'bitunix' AND enabled = true`,
          [req.userId]
        );
    if (!keys.length) return res.json({ error: 'No Bitunix API keys found' });

    let inserted = 0, updated = 0, skipped = 0;
    const errors = [];

    for (const key of keys) {
      try {
        const apiKey    = cryptoUtils2.decrypt(key.api_key_enc, key.iv, key.auth_tag);
        const apiSecret = cryptoUtils2.decrypt(key.api_secret_enc, key.secret_iv, key.secret_auth_tag);
        const client    = new BitunixClient({ apiKey, apiSecret });

        // Bitunix requires a symbol param — pull history per distinct symbol
        // from this key's trades (same approach used by adminFixTrades, proven working)
        const symRows = await query(
          `SELECT DISTINCT symbol FROM trades WHERE api_key_id = $1 ORDER BY symbol`, [key.id]
        );
        // Also include the 4 default trading symbols in case they have positions not yet in DB
        const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
        const symbols = [...new Set([
          ...DEFAULT_SYMBOLS,
          ...symRows.map(r => r.symbol),
        ])];

        const positions = [];
        for (const sym of symbols) {
          try {
            const raw = await client._rawGet('/api/v1/futures/position/get_history_positions', {
              symbol: sym, pageNum: 1, pageSize: 100,
            });
            // Always log so Railway shows what Bitunix actually returns
            console.log(`[pull-bitunix-history] ${sym} code=${raw?.code} msg=${raw?.msg} dataKeys=${JSON.stringify(Object.keys(raw?.data || {}))}`);
            if (raw?.code !== 0) {
              errors.push(`${sym}: API error code=${raw?.code} msg=${raw?.msg}`);
              continue;
            }
            const d = raw?.data;
            const list = Array.isArray(d) ? d
              : (d?.positionList || d?.resultList || d?.list || d?.data || d?.records || []);
            positions.push(...list);
          } catch (e) {
            console.warn(`[pull-bitunix-history] ${sym} fetch error: ${e.message}`);
            errors.push(`${sym}: ${e.message}`);
          }
        }

        console.log(`[pull-bitunix-history] key ${key.id}: fetched ${positions.length} positions across ${symbols.length} symbols`);
        if (!positions.length) continue;

        // Batch lookup — one query for all positionIds, one for all key trades
        const posIds = positions
          .map(p => String(p.positionId || p.id || p.position_id || ''))
          .filter(Boolean);
        const existingByPosId = new Map();
        if (posIds.length) {
          const rows = await query(
            `SELECT id, bitunix_position_id, exit_price, pnl_usdt FROM trades
             WHERE bitunix_position_id = ANY($1)`, [posIds]
          );
          for (const r of rows) existingByPosId.set(r.bitunix_position_id, r);
        }
        const allKeyTrades = await query(
          `SELECT id, symbol, direction, entry_price, created_at, exit_price, pnl_usdt
           FROM trades WHERE api_key_id = $1`, [key.id]
        );

        for (const p of positions) {
          try {
            const symbol    = (p.symbol || '').toUpperCase();
            const posId     = String(p.positionId || p.id || p.position_id || '');
            const pSide     = (p.side || p.positionSide || '').toUpperCase();
            const direction = (pSide === 'LONG' || pSide === 'BUY') ? 'LONG' : 'SHORT';
            const entryPrice = parseFloat(p.avgOpenPrice  || p.entryPrice  || p.openPrice  || 0);
            const exitPrice  = parseFloat(p.avgClosePrice || p.closePrice  || p.closedPrice || 0);
            const leverage   = parseInt(p.leverage  || 20);
            const qty        = parseFloat(p.qty || p.size || p.quantity || 0);
            const pnlRaw     = p.realizedPNL ?? p.realizedPnl ?? p.pnl ?? p.profit ?? p.realPnl ?? null;
            const pnlUsdt    = pnlRaw != null ? parseFloat(parseFloat(pnlRaw).toFixed(4)) : null;
            const tradingFee = Math.abs(parseFloat(p.fee || p.tradingFee || p.commission || 0));
            const fundingFee = Math.abs(parseFloat(p.funding || p.fundingFee || p.fund_fee || 0));
            const grossPnl   = pnlUsdt != null ? parseFloat((pnlUsdt + tradingFee + fundingFee).toFixed(4)) : null;
            const openMs     = parseInt(p.openTime  || p.ctime   || p.createTime  || 0);
            const closeMs    = parseInt(p.closeTime || p.mtime   || p.updateTime  || 0);
            const openAt     = openMs  ? new Date(openMs)  : null;
            const closeAt    = closeMs ? new Date(closeMs) : null;
            const status     = pnlUsdt != null ? (pnlUsdt > 0 ? 'WIN' : 'LOSS') : 'CLOSED';

            if (!symbol || entryPrice <= 0 || exitPrice <= 0) { skipped++; continue; }

            // Match existing record from in-memory batches (no per-row DB queries)
            let existing = posId ? existingByPosId.get(posId) : null;
            if (!existing && openAt) {
              existing = allKeyTrades.find(t =>
                t.symbol === symbol && t.direction === direction &&
                Math.abs(parseFloat(t.entry_price) - entryPrice) / entryPrice < 0.002 &&
                Math.abs(new Date(t.created_at).getTime() - openMs) < 300_000
              );
            }

            if (existing) {
              if (existing.exit_price == null || existing.pnl_usdt == null) {
                await query(
                  `UPDATE trades SET exit_price=$1, pnl_usdt=$2, gross_pnl=$3, trading_fee=$4,
                   funding_fee=$5, status=$6, closed_at=COALESCE(closed_at,$7),
                   bitunix_position_id=COALESCE(bitunix_position_id,$8) WHERE id=$9`,
                  [exitPrice, pnlUsdt, grossPnl, tradingFee, fundingFee, status, closeAt, posId || null, existing.id]
                );
                updated++;
              } else {
                skipped++;
              }
            } else {
              await query(
                `INSERT INTO trades (api_key_id, user_id, symbol, direction, entry_price, exit_price,
                 sl_price, tp_price, quantity, leverage, status, pnl_usdt, gross_pnl, trading_fee,
                 funding_fee, closed_at, created_at, trailing_sl_price, trailing_sl_last_step,
                 bitunix_position_id)
                 VALUES ($1,$2,$3,$4,$5,$6,0,0,$7,$8,$9,$10,$11,$12,$13,$14,$15,$5,0,$16)
                 ON CONFLICT DO NOTHING`,
                [key.id, key.user_id, symbol, direction, entryPrice, exitPrice,
                 qty, leverage, status, pnlUsdt, grossPnl, tradingFee, fundingFee,
                 closeAt || new Date(), openAt || new Date(), entryPrice, posId || null]
              );
              inserted++;
            }
          } catch (posErr) {
            errors.push(posErr.message);
          }
        }
      } catch (keyErr) {
        errors.push(`key ${key.id}: ${keyErr.message}`);
      }
    }

    console.log(`[pull-bitunix-history] user ${req.userId} — inserted:${inserted} updated:${updated} skipped:${skipped}`);
    res.json({ inserted, updated, skipped, errors: errors.slice(0, 10) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Debug: raw Bitunix position history (admin only) ─────────────────────────
// GET /api/dashboard/debug/bitunix-positions?symbol=SOLUSDT
// Returns the raw API response so we can confirm exact field names + values
router.get('/debug/bitunix-positions', async (req, res) => {
  try {
    const adminCheck = await query(`SELECT is_admin FROM users WHERE id = $1`, [req.userId]);
    if (!adminCheck[0]?.is_admin) return res.status(403).json({ error: 'Admin only' });

    const { symbol } = req.query;
    const { BitunixClient } = require('../bitunix-client');
    const cryptoUtils2 = require('../crypto-utils');

    // Use first Bitunix API key found for this admin
    const keys = await query(
      `SELECT ak.api_key_enc, ak.iv, ak.auth_tag, ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag
       FROM api_keys ak JOIN users u ON ak.user_id = u.id
       WHERE u.id = $1 AND ak.platform = 'bitunix' AND ak.is_active = true
       LIMIT 1`,
      [req.userId]
    );
    if (!keys.length) return res.status(404).json({ error: 'No Bitunix key found' });

    const apiKey    = cryptoUtils2.decrypt(keys[0].api_key_enc, keys[0].iv, keys[0].auth_tag);
    const apiSecret = cryptoUtils2.decrypt(keys[0].api_secret_enc, keys[0].secret_iv, keys[0].secret_auth_tag);
    const bxClient  = new BitunixClient({ apiKey, apiSecret });

    const params = { pageSize: 10 };
    if (symbol) params.symbol = symbol;
    const positions = await bxClient.getHistoryPositions(params);

    res.json({ count: positions.length, positions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Strategy Version Manager ──────────────────────────────────────────────────
// Saves optimizer results as named "versions" — browse, compare, and activate
// the best genome for live trading. Admin-only write operations.

async function ensureVersionsTable() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS strategy_versions (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(200) NOT NULL,
        genome        JSONB        NOT NULL,
        genome_hash   VARCHAR(64),
        win_rate      DECIMAL(8,4),
        profit_factor DECIMAL(8,4),
        total_return  DECIMAL(12,4),
        max_drawdown  DECIMAL(8,4),
        expectancy    DECIMAL(12,4),
        sharpe        DECIMAL(8,4),
        total_trades  INTEGER,
        wins          INTEGER,
        losses        INTEGER,
        fitness       DECIMAL(12,4),
        source        VARCHAR(50)  DEFAULT 'optimizer',
        symbols       TEXT,
        is_active     BOOLEAN      DEFAULT FALSE,
        activated_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ  DEFAULT NOW()
      )
    `);
  } catch (_) {}
  try { await query(`ALTER TABLE strategy_versions ADD COLUMN IF NOT EXISTS genome_hash VARCHAR(64)`); } catch (_) {}
  try { await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sv_genome_hash ON strategy_versions (genome_hash) WHERE genome_hash IS NOT NULL`); } catch (_) {}
}

// GET /api/dashboard/strategy-versions
// Returns a unified list of all versions from three sources:
//   1. ai_versions — old named backtest versions (v3.52, etc.)
//   2. strategy_search_results — optimizer scan results
//   3. strategy_versions — manually saved / activated versions (if table exists)
router.get('/strategy-versions', async (req, res) => {
  try {
    const combined = [];

    // ── Source 1: Named AI versions (old system, has v3.52 etc.) ──────────────
    try {
      const aiRows = await query(
        `SELECT id, version AS name,
                ROUND((win_rate * 100)::numeric, 2) AS win_rate,
                trade_count AS total_trades,
                total_pnl AS total_return,
                params, created_at,
                'named' AS source
         FROM ai_versions
         ORDER BY id DESC LIMIT 100`
      );
      for (const r of aiRows) {
        combined.push({
          _source: 'ai_version',
          _ai_id: r.id,
          name: r.name,
          win_rate: r.win_rate,
          total_trades: r.total_trades,
          total_return: r.total_return,
          params: typeof r.params === 'string' ? JSON.parse(r.params) : r.params,
          source: 'named',
          created_at: r.created_at,
        });
      }
    } catch (_) {}

    // ── Source 2: Optimizer scan results (strategy_search_results) ────────────
    try {
      const optRows = await query(
        `SELECT genome,
                MD5(genome::text) AS ghash,
                ROUND(AVG(win_rate)::numeric, 4)        AS win_rate,
                ROUND(AVG(profit_factor)::numeric, 4)   AS profit_factor,
                ROUND(AVG(total_return)::numeric, 4)    AS total_return,
                ROUND(AVG(max_drawdown)::numeric, 4)    AS max_drawdown,
                ROUND(AVG(fitness)::numeric, 4)         AS fitness,
                SUM(total_trades)                       AS total_trades,
                SUM(wins)                               AS wins,
                SUM(losses)                             AS losses,
                MAX(tested_at)                          AS created_at,
                COUNT(*)                                AS symbol_count
         FROM strategy_search_results
         WHERE total_trades >= 5
         GROUP BY genome
         ORDER BY win_rate DESC
         LIMIT 200`
      );
      for (const r of optRows) {
        combined.push({
          _source: 'optimizer',
          _genome_hash: r.ghash,
          name: `Optimizer ${(parseFloat(r.win_rate || 0) * 100).toFixed(0)}% WR`,
          win_rate: r.win_rate != null ? parseFloat(r.win_rate) * 100 : null,
          profit_factor: r.profit_factor,
          total_return: r.total_return,
          max_drawdown: r.max_drawdown,
          fitness: r.fitness,
          total_trades: r.total_trades,
          wins: r.wins,
          losses: r.losses,
          genome: typeof r.genome === 'string' ? JSON.parse(r.genome) : r.genome,
          source: 'optimizer',
          created_at: r.created_at,
        });
      }
    } catch (_) {}

    // ── Source 3: Manually saved strategy_versions (if table exists) ──────────
    try {
      await ensureVersionsTable();
      const svRows = await query(
        `SELECT * FROM strategy_versions ORDER BY win_rate DESC NULLS LAST LIMIT 100`
      );
      for (const r of svRows) {
        combined.push({
          _source: 'strategy_version',
          _sv_id: r.id,
          name: r.name,
          win_rate: r.win_rate != null ? parseFloat(r.win_rate) : null,
          profit_factor: r.profit_factor,
          total_return: r.total_return,
          max_drawdown: r.max_drawdown,
          fitness: r.fitness,
          total_trades: r.total_trades,
          genome: typeof r.genome === 'string' ? JSON.parse(r.genome) : r.genome,
          source: r.source || 'manual',
          is_active: r.is_active,
          created_at: r.created_at,
        });
      }
    } catch (_) {}

    // Active version from settings
    const activeSetting = await query(
      `SELECT value FROM settings WHERE key = 'active_ai_version'`
    ).catch(() => []);
    const activeVersion = activeSetting[0] ? JSON.parse(activeSetting[0].value) : null;

    // Sort: named versions first, then by win_rate desc
    combined.sort((a, b) => {
      if (a._source === 'ai_version' && b._source !== 'ai_version') return -1;
      if (b._source === 'ai_version' && a._source !== 'ai_version') return 1;
      return (parseFloat(b.win_rate) || 0) - (parseFloat(a.win_rate) || 0);
    });

    res.json({ versions: combined, active_version: activeVersion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/strategy-versions/scan
// Reads ALL strategy_search_results, deduplicates by genome hash, UPSERTS into versions.
// Old versions are NEVER deleted — every unique genome is kept in history so the user
// can browse all past optimizer discoveries and activate any of them.
router.post('/strategy-versions/scan', async (req, res) => {
  try {
    const adminCheck = await query(`SELECT is_admin FROM users WHERE id = $1`, [req.userId]);
    if (!adminCheck[0]?.is_admin) return res.status(403).json({ error: 'Admin only' });

    await ensureVersionsTable();

    const countRow = await query(
      `SELECT COUNT(*) AS total FROM strategy_search_results WHERE total_trades >= 5`
    ).catch(() => [{ total: '0' }]);
    if (parseInt(countRow[0]?.total) === 0) {
      return res.json({
        saved: 0,
        message: 'No optimizer results found yet. Start the optimizer and let it run first.',
      });
    }

    // Group by genome, average metrics across all symbols — no LIMIT so every unique genome
    // discovered by the optimizer ends up as a selectable version.
    const rows = await query(`
      SELECT
        genome,
        MD5(genome::text)                       AS ghash,
        ROUND(AVG(win_rate)::numeric,      4)   AS avg_wr,
        ROUND(AVG(profit_factor)::numeric,  4)  AS avg_pf,
        ROUND(AVG(total_return)::numeric,   4)  AS avg_return,
        ROUND(AVG(max_drawdown)::numeric,   4)  AS avg_dd,
        ROUND(AVG(expectancy)::numeric,     4)  AS avg_exp,
        ROUND(AVG(sharpe)::numeric,         4)  AS avg_sharpe,
        ROUND(AVG(fitness)::numeric,        4)  AS avg_fitness,
        ROUND(AVG(total_trades)::numeric,   0)  AS avg_trades,
        ROUND(AVG(wins)::numeric,           0)  AS avg_wins,
        ROUND(AVG(losses)::numeric,         0)  AS avg_losses,
        string_agg(DISTINCT symbol, ',')        AS symbols,
        COUNT(*)                                AS result_count
      FROM strategy_search_results
      WHERE total_trades >= 5
      GROUP BY genome
      ORDER BY avg_wr DESC, avg_fitness DESC
    `);

    let saved = 0, updated = 0;

    for (let i = 0; i < rows.length; i++) {
      const r    = rows[i];
      const g    = typeof r.genome === 'string' ? JSON.parse(r.genome) : r.genome;
      const wr   = parseFloat(r.avg_wr)      || 0;
      const pf   = parseFloat(r.avg_pf)      || 0;
      const fit  = parseFloat(r.avg_fitness) || 0;
      const hash = r.ghash;

      const medal = wr >= 80 ? '🏆' : wr >= 70 ? '⭐' : wr >= 60 ? '✅' : '·';
      // Name encodes rank by WR so the user can see quality at a glance.
      // If this genome existed before, we keep the original name (updated via DO UPDATE below
      // only for metrics, not name — so the user's picks stay recognisable).
      const name = `${medal} v${i + 1} — WR ${wr.toFixed(1)}% | ${g.entry_type} L${g.leverage}x | PF ${pf.toFixed(2)}`;

      const result = await query(`
        INSERT INTO strategy_versions
          (name, genome, genome_hash, win_rate, profit_factor, total_return, max_drawdown,
           expectancy, sharpe, total_trades, wins, losses, fitness, source, symbols)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'optimizer',$14)
        ON CONFLICT (genome_hash) DO UPDATE SET
          win_rate      = EXCLUDED.win_rate,
          profit_factor = EXCLUDED.profit_factor,
          total_return  = EXCLUDED.total_return,
          max_drawdown  = EXCLUDED.max_drawdown,
          expectancy    = EXCLUDED.expectancy,
          sharpe        = EXCLUDED.sharpe,
          total_trades  = EXCLUDED.total_trades,
          wins          = EXCLUDED.wins,
          losses        = EXCLUDED.losses,
          fitness       = EXCLUDED.fitness,
          symbols       = EXCLUDED.symbols
        RETURNING (xmax = 0) AS inserted
      `, [
        name, JSON.stringify(g), hash,
        wr, pf,
        parseFloat(r.avg_return) || 0,
        parseFloat(r.avg_dd)     || 0,
        parseFloat(r.avg_exp)    || 0,
        parseFloat(r.avg_sharpe) || 0,
        parseInt(r.avg_trades)   || 0,
        parseInt(r.avg_wins)     || 0,
        parseInt(r.avg_losses)   || 0,
        fit,
        r.symbols || 'BTC/ETH/SOL/BNB',
      ]);

      if (result[0]?.inserted) saved++; else updated++;
    }

    const best = await query(
      `SELECT id, name, win_rate FROM strategy_versions ORDER BY win_rate DESC LIMIT 1`
    ).catch(() => []);

    const total = await query(`SELECT COUNT(*) AS c FROM strategy_versions`).catch(() => [{ c: 0 }]);

    res.json({
      saved,
      updated,
      total: parseInt(total[0]?.c) || 0,
      best: best[0] || null,
      message: `${saved} new versions added, ${updated} updated. Total: ${total[0]?.c} versions. Best WR: ${best[0] ? parseFloat(best[0].win_rate).toFixed(1) + '%' : 'N/A'}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/strategy-versions/activate/:id
// Sets a version as active and writes genome to settings for the engine to pick up.
router.post('/strategy-versions/activate/:id', async (req, res) => {
  try {
    const adminCheck = await query(`SELECT is_admin FROM users WHERE id = $1`, [req.userId]);
    if (!adminCheck[0]?.is_admin) return res.status(403).json({ error: 'Admin only' });

    const vId = parseInt(req.params.id);
    if (!vId || isNaN(vId)) return res.status(400).json({ error: 'Invalid version id' });

    await ensureVersionsTable();
    const ver = await query(`SELECT * FROM strategy_versions WHERE id = $1`, [vId]);
    if (!ver.length) return res.status(404).json({ error: 'Version not found' });

    // Clear all active flags, then set this one
    await query(`UPDATE strategy_versions SET is_active = FALSE, activated_at = NULL`);
    await query(
      `UPDATE strategy_versions SET is_active = TRUE, activated_at = NOW() WHERE id = $1`,
      [vId]
    );

    // Write genome to settings so the engine reads it on next scan
    const genomeStr = JSON.stringify(ver[0].genome);
    await query(`
      INSERT INTO settings (key, value) VALUES ('active_strategy_version_id', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [String(vId)]);
    await query(`
      INSERT INTO settings (key, value) VALUES ('active_strategy_genome', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [genomeStr]);

    res.json({ ok: true, activated: { id: vId, name: ver[0].name, win_rate: ver[0].win_rate } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/strategy-versions/deactivate
// Removes the active version, engine reverts to defaults.
router.post('/strategy-versions/deactivate', async (req, res) => {
  try {
    const adminCheck = await query(`SELECT is_admin FROM users WHERE id = $1`, [req.userId]);
    if (!adminCheck[0]?.is_admin) return res.status(403).json({ error: 'Admin only' });

    await ensureVersionsTable();
    await query(`UPDATE strategy_versions SET is_active = FALSE, activated_at = NULL`);
    await query(
      `DELETE FROM settings WHERE key IN ('active_strategy_version_id','active_strategy_genome')`
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/dashboard/strategy-versions/:id
router.delete('/strategy-versions/:id', async (req, res) => {
  try {
    const adminCheck = await query(`SELECT is_admin FROM users WHERE id = $1`, [req.userId]);
    if (!adminCheck[0]?.is_admin) return res.status(403).json({ error: 'Admin only' });

    const vId = parseInt(req.params.id);
    await ensureVersionsTable();
    await query(`DELETE FROM strategy_versions WHERE id = $1`, [vId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/strategy-versions/custom
// Admin creates a named version with hand-tuned parameters — no genome deduplication,
// each manual save is kept as a distinct entry so the admin can track their experiments.
router.post('/strategy-versions/custom', async (req, res) => {
  try {
    const adminCheck = await query(`SELECT is_admin FROM users WHERE id = $1`, [req.userId]);
    if (!adminCheck[0]?.is_admin) return res.status(403).json({ error: 'Admin only' });

    const { name, genome } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!genome || typeof genome !== 'object') {
      return res.status(400).json({ error: 'genome object is required' });
    }

    await ensureVersionsTable();

    const rows = await query(
      `INSERT INTO strategy_versions
         (name, genome, source, win_rate, profit_factor, total_return, max_drawdown,
          expectancy, sharpe, total_trades, wins, losses, fitness, is_active, created_at)
       VALUES ($1, $2, 'manual', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, FALSE, NOW())
       RETURNING id, name`,
      [name.trim(), JSON.stringify(genome)]
    );

    res.json({ ok: true, id: rows[0].id, name: rows[0].name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
