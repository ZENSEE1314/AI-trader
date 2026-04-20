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
// Cache summaries for 15s to avoid repeated DB hits on page load/refresh
const summaryCache = new Map();
const SUMMARY_CACHE_TTL = 15_000;

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
// Cache per user for 30s — exchange API calls are the #1 page load bottleneck
const walletCache = new Map();
const WALLET_CACHE_TTL = 30_000; // 30 seconds

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

router.get('/kronos-predictions', async (req, res) => {
  try {
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

    res.json({
      total: predictions.length,
      longs: longs.length,
      shorts: shorts.length,
      neutrals: neutrals.length,
      predictions,
    });
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

// ── Re-sync all closed Bitunix trades from exchange (admin only) ──────────────
// POST /api/dashboard/resync-bitunix
// Fetches real data from Bitunix for every CLOSED trade and corrects the DB
router.post('/resync-bitunix', async (req, res) => {
  try {
    const adminCheck = await query(`SELECT is_admin FROM users WHERE id = $1`, [req.userId]);
    if (!adminCheck[0]?.is_admin) return res.status(403).json({ error: 'Admin only' });

    const BitunixClient = require('../bitunix-client');
    const cryptoUtils2 = require('../crypto-utils');

    // Ensure column exists — startup migration may have silently failed on first deploy.
    // Run BEFORE the SELECT that names it explicitly.
    try {
      await query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS bitunix_position_id VARCHAR(64)`);
    } catch (_) {}

    // Get all CLOSED Bitunix trades
    // NOTE: select t.* to avoid crashing if bitunix_position_id column doesn't exist yet
    const trades = await query(`
      SELECT t.*,
             ak.api_key_enc, ak.iv, ak.auth_tag,
             ak.api_secret_enc, ak.secret_iv, ak.secret_auth_tag
      FROM trades t
      JOIN api_keys ak ON t.api_key_id = ak.id
      WHERE ak.platform = 'bitunix'
        AND t.status IN ('CLOSED','WIN','LOSS')
        AND t.closed_at IS NOT NULL
      ORDER BY t.created_at DESC
      LIMIT 200
    `);

    let fixed = 0, skipped = 0, failed = 0;
    const results = [];

    for (const trade of trades) {
      try {
        const apiKey    = cryptoUtils2.decrypt(trade.api_key_enc, trade.iv, trade.auth_tag);
        const apiSecret = cryptoUtils2.decrypt(trade.api_secret_enc, trade.secret_iv, trade.secret_auth_tag);
        const bxClient  = new BitunixClient({ apiKey, apiSecret });

        const isLong = trade.direction !== 'SHORT';
        const tradeEntry = parseFloat(trade.entry_price);
        const qty = parseFloat(trade.quantity || 0);
        const tradeOpenTime = trade.created_at ? new Date(trade.created_at).getTime() : 0;
        const storedPosId = trade.bitunix_position_id;

        const positions = await bxClient.getHistoryPositions({ symbol: trade.symbol, pageSize: 50 });

        let bestMatch = null;
        let bestTimeDiff = Infinity;

        for (const p of positions) {
          const cp  = parseFloat(p.closePrice || p.avgClosePrice || p.closedPrice || p.close_price || 0);
          const ep  = parseFloat(p.entryPrice  || p.avgOpenPrice  || p.openPrice  || p.open_price  || 0);
          const pid = String(p.positionId || p.id || p.position_id || '');
          const pSide = (p.side || p.positionSide || p.position_side || '').toUpperCase();
          const pSideLong = pSide === 'LONG' || pSide === 'BUY';
          const closeMs = parseInt(p.closeTime || p.mtime || p.ctime || p.updateTime || p.close_time || 0);

          if (cp <= 0 || p.symbol !== trade.symbol || pSideLong !== isLong) continue;

          // ID match = best
          if (storedPosId && pid === String(storedPosId)) { bestMatch = p; break; }

          const entryMatch = ep > 0 && Math.abs(ep - tradeEntry) / tradeEntry < 0.005;
          const closedAfterOpen = !tradeOpenTime || !closeMs || closeMs >= tradeOpenTime;
          if (entryMatch && closedAfterOpen) {
            const timeDiff = closeMs && tradeOpenTime ? Math.abs(closeMs - tradeOpenTime) : 9e12;
            if (timeDiff < bestTimeDiff) { bestTimeDiff = timeDiff; bestMatch = p; }
          }
        }

        if (!bestMatch) { skipped++; results.push({ id: trade.id, symbol: trade.symbol, result: 'no_match' }); continue; }

        const p = bestMatch;
        const exitPrice  = parseFloat(p.closePrice || p.avgClosePrice || p.closedPrice || p.close_price || 0);
        const tradingFee = Math.abs(parseFloat(p.fee || p.tradingFee || p.commission || 0));
        const fundingFee = Math.abs(parseFloat(p.funding || p.fundingFee || p.fund_fee || 0));
        const pnlRaw     = p.realizedPNL ?? p.realizedPnl ?? p.pnl ?? p.profit ?? p.realPnl ?? null;

        if (pnlRaw == null || exitPrice === 0) {
          skipped++;
          results.push({ id: trade.id, symbol: trade.symbol, result: 'missing_pnl_or_exit' });
          continue;
        }

        const pnlUsdt  = parseFloat(parseFloat(pnlRaw).toFixed(4));
        const grossPnl = parseFloat((pnlUsdt + tradingFee + fundingFee).toFixed(4));
        const status   = pnlUsdt > 0 ? 'WIN' : 'LOSS';

        await query(`
          UPDATE trades SET
            exit_price   = $1,
            pnl_usdt     = $2,
            gross_pnl    = $3,
            trading_fee  = $4,
            funding_fee  = $5,
            status       = $6
          WHERE id = $7
        `, [exitPrice, pnlUsdt, grossPnl, tradingFee, fundingFee, status, trade.id]);

        fixed++;
        results.push({
          id: trade.id, symbol: trade.symbol,
          old: { exit: trade.exit_price, net: trade.pnl_usdt },
          new: { exit: exitPrice, net: pnlUsdt, gross: grossPnl, fee: tradingFee, status }
        });

        await new Promise(r => setTimeout(r, 200)); // rate-limit: 5 req/s
      } catch (e) {
        failed++;
        results.push({ id: trade.id, symbol: trade.symbol, result: `error: ${e.message}` });
      }
    }

    res.json({ total: trades.length, fixed, skipped, failed, results });
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
    const BitunixClient = require('../bitunix-client');
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

module.exports = router;
