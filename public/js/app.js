/* ============================================================
   CryptoBot — Frontend Application
   Plain JS, no frameworks, no build tools.
   ============================================================ */

(function () {
  'use strict';

  // ----- State -----
  const state = {
    user: null,
    currentTab: 'dashboard',
    tradesPage: 1,
    tradesTotal: 0,
    tradesPages: 1,
    tradesPeriod: 'all',
    selectedPlan: 'bot', // 'bot' or 'signal'
  };

  // ----- DOM References -----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const els = {
    loadingScreen:  $('#loading-screen'),
    sectionAuth:    $('#section-auth'),
    sectionApp:     $('#section-app'),
    userEmail:      $('#user-email'),
    toastContainer: $('#toast-container'),
    // Auth
    formLogin:    $('#form-login'),
    formSignup:   $('#form-signup'),
    loginError:   $('#login-error'),
    signupError:  $('#signup-error'),
    // Dashboard
    tabDashboard:    $('#tab-dashboard'),
    tabKeys:         $('#tab-keys'),
    walletsGrid:     $('#wallets-grid'),
    summaryTotalPnl: $('#summary-total-pnl'),
    summary24hPnl:   $('#summary-24h-pnl'),
    summary7dPnl:    $('#summary-7d-pnl'),
    summaryWinRate:  $('#summary-win-rate'),
    summaryWins:     $('#summary-wins'),
    summaryLosses:   $('#summary-losses'),
    summaryOpenTrades: $('#summary-open-trades'),
    summaryTotalWon: $('#summary-total-won'),
    summaryTotalLost: $('#summary-total-lost'),
    tradesTbody:     $('#trades-tbody'),
    tradesEmpty:     $('#trades-empty'),
    tradesPagination:$('#trades-pagination'),
    paginationInfo:  $('#pagination-info'),
    btnPrevPage:     $('#btn-prev-page'),
    btnNextPage:     $('#btn-next-page'),
    // Keys
    keysList:    $('#keys-list'),
    keysEmpty:   $('#keys-empty'),
    btnAddKey:   $('#btn-add-key'),
    modalAddKey: $('#modal-add-key'),
    formAddKey:  $('#form-add-key'),
    addKeyError: $('#add-key-error'),
    btnSubmitKey:$('#btn-submit-key'),
  };

  // ----- API Helpers -----

  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(text || `Request failed (${res.status})`);
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ----- Toast -----

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toast.setAttribute('role', 'status');
    els.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = `toast-out var(--duration-slow) var(--ease-out) forwards`;
      toast.addEventListener('animationend', () => toast.remove());
    }, 3500);
  }

  // ----- Formatting -----

  function formatPnl(value) {
    const num = parseFloat(value) || 0;
    const prefix = num >= 0 ? '+' : '';
    return `${prefix}$${num.toFixed(2)}`;
  }

  function pnlClass(value) {
    const num = parseFloat(value) || 0;
    if (num > 0) return 'positive';
    if (num < 0) return 'negative';
    return '';
  }

  function formatDate(isoStr) {
    if (!isoStr) return '--';
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-US', {
      timeZone: 'Asia/Jakarta',
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ----- Navigation -----

  function showSection(name) {
    els.loadingScreen.classList.add('hidden');
    const landing = $('#section-landing');
    if (name === 'landing') {
      if (landing) landing.classList.remove('hidden');
      els.sectionAuth.classList.add('hidden');
      els.sectionApp.classList.add('hidden');
    } else if (name === 'auth') {
      if (landing) landing.classList.add('hidden');
      els.sectionAuth.classList.remove('hidden');
      els.sectionApp.classList.add('hidden');
    } else {
      if (landing) landing.classList.add('hidden');
      els.sectionAuth.classList.add('hidden');
      els.sectionApp.classList.remove('hidden');
    }
  }

  function switchTab(tab) {
    state.currentTab = tab;
    $$('.nav-tab').forEach((btn) => {
      const isActive = btn.dataset.tab === tab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive);
    });
    const allTabs = ['dashboard', 'keys', 'cashwallet', 'chart', 'logs', 'profile', 'admin'];
    allTabs.forEach(t => {
      const el = $(`#tab-${t}`);
      if (el) el.classList.toggle('hidden', t !== tab);
    });

    if (tab === 'dashboard') { loadDashboard(); startDashboardRefresh(); }
    else if (tab === 'keys') loadKeys();
    else if (tab === 'cashwallet') loadCashWallet();
    else if (tab === 'chart') {
      window.open('/chart.html', '_blank');
      // Switch back to dashboard since chart opens in new tab
      return switchTab('dashboard');
    }
    else if (tab === 'logs') startLogPolling();
    else if (tab === 'profile') loadProfile();
    else if (tab === 'admin') loadAdmin();

    // Stop polling when leaving tabs
    if (tab !== 'logs') stopLogPolling();
    if (tab !== 'dashboard') stopDashboardRefresh();
    // Admin tab no longer has MC panel — no timer needed
  }

  // ----- Auth -----

  async function checkSession() {
    try {
      const data = await api('GET', '/api/auth/me');
      state.user = data;
      els.userEmail.textContent = data.username || data.email;
      // Show admin tab if admin
      const adminTab = $('#admin-tab');
      if (adminTab) adminTab.classList.toggle('hidden', !data.is_admin);
      showSection('app');
      switchTab('dashboard');
    } catch {
      showSection('landing');
    }
  }

  function goToAuth() {
    showSection('auth');
  }

  function setupAuthTabs() {
    $$('[data-auth-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.authTab;
        $$('[data-auth-tab]').forEach((b) => {
          const isActive = b.dataset.authTab === tab;
          b.classList.toggle('active', isActive);
          b.setAttribute('aria-selected', isActive);
        });
        els.formLogin.classList.toggle('hidden', tab !== 'login');
        els.formSignup.classList.toggle('hidden', tab !== 'signup');
        hideError(els.loginError);
        hideError(els.signupError);
      });
    });
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.classList.add('visible');
  }

  function hideError(el) {
    el.textContent = '';
    el.classList.remove('visible');
  }

  function setupAuthForms() {
    els.formLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError(els.loginError);
      const email = $('#login-email').value.trim();
      const password = $('#login-password').value;
      try {
        const remember = $('#login-remember')?.checked ?? true;
        await api('POST', '/api/auth/login', { email, password, remember });
        await checkSession();
        showToast('Welcome back!', 'success');
      } catch (err) {
        showError(els.loginError, err.message);
      }
    });

    els.formSignup.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError(els.signupError);
      const email = $('#signup-email').value.trim();
      const password = $('#signup-password').value;
      const refInput = $('#signup-referral');
      const referral_code = refInput ? refInput.value.trim() : '';
      try {
        await api('POST', '/api/auth/signup', { email, password, referral_code });
        await checkSession();
        showToast('Account created!', 'success');
      } catch (err) {
        showError(els.signupError, err.message);
      }
    });
  }

  function setupLogout() {
    $('#btn-logout').addEventListener('click', async () => {
      try {
        await api('POST', '/api/auth/logout');
      } catch {
        // Logout even if request fails
      }
      state.user = null;
      showSection('auth');
      showToast('Logged out.', 'success');
    });
  }

  // ----- Dashboard Auto-Refresh -----

  let dashboardTimer = null;
  const DASHBOARD_REFRESH_MS = 15000; // 15 seconds

  function startDashboardRefresh() {
    stopDashboardRefresh();
    dashboardTimer = setInterval(loadDashboard, DASHBOARD_REFRESH_MS);
  }

  function stopDashboardRefresh() {
    if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
  }

  // ----- Dashboard -----

  async function loadDashboard() {
    try {
      const summaryUrl = state.tradesPeriod && state.tradesPeriod !== 'all'
        ? `/api/dashboard/summary?period=${state.tradesPeriod}`
        : '/api/dashboard/summary';
      const [summary, walletData, weeklyEarnings, cashData] = await Promise.all([
        api('GET', summaryUrl),
        api('GET', '/api/dashboard/futures-wallet').catch(() => ({ balance: 0, wallets: [] })),
        api('GET', '/api/dashboard/weekly-earnings').catch(() => null),
        api('GET', '/api/dashboard/cash-wallet').catch(() => null),
        loadTrades(),
      ]);
      renderSummary(summary);
      renderWallets(walletData);
      if (weeklyEarnings) renderWeeklyEarnings(weeklyEarnings);
      loadSignalBoard();
      if (cashData) renderDashCashWallet(cashData);
      loadPauseStatus();
      loadKronosPredictions();
    } catch (err) {
      showToast('Failed to load dashboard.', 'error');
    }
  }

  function renderDashCashWallet(data) {
    const bal = parseFloat(data.cash_wallet) || 0;
    const comm = parseFloat(data.commission_earned) || 0;
    const balEl = document.getElementById('dash-cw-balance');
    const commEl = document.getElementById('dash-cw-commission');
    if (balEl) balEl.textContent = `$${bal.toFixed(2)}`;
    if (commEl) commEl.textContent = `$${comm.toFixed(2)}`;
  }

  async function loadKronosPredictions() {
    const tbody = document.getElementById('kronos-tbody');
    if (!tbody) return;
    try {
      const data = await api('GET', '/api/dashboard/kronos-predictions');
      const countEl = document.getElementById('kronos-count');
      const bullEl = document.getElementById('kronos-bull');
      const bearEl = document.getElementById('kronos-bear');
      const neutralEl = document.getElementById('kronos-neutral');

      if (countEl) countEl.textContent = `(${data.total} tokens)`;
      if (bullEl) bullEl.textContent = `📈 ${data.longs} Bullish`;
      if (bearEl) bearEl.textContent = `📉 ${data.shorts} Bearish`;
      if (neutralEl) neutralEl.textContent = `➖ ${data.neutrals} Neutral`;

      if (!data.predictions || data.predictions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--color-text-secondary);padding:20px;">No predictions yet — waiting for next cycle scan</td></tr>';
        return;
      }

      tbody.innerHTML = data.predictions.map(p => {
        const isLong = p.direction === 'LONG';
        const isShort = p.direction === 'SHORT';
        const dirColor = isLong ? 'var(--color-success)' : isShort ? 'var(--color-danger)' : 'var(--color-text-secondary)';
        const dirIcon = isLong ? '📈' : isShort ? '📉' : '➖';
        const confIcon = p.confidence === 'high' ? '🔥' : p.confidence === 'medium' ? '⚡' : '·';
        const changePct = p.change_pct || 0;
        const changeColor = changePct > 0 ? 'var(--color-success)' : changePct < 0 ? 'var(--color-danger)' : 'var(--color-text-secondary)';
        const trendColor = p.trend === 'bullish' ? 'var(--color-success)' : p.trend === 'bearish' ? 'var(--color-danger)' : 'var(--color-text-secondary)';

        return `<tr>
          <td style="font-weight:600;">${p.symbol.replace('USDT', '')}</td>
          <td style="color:${dirColor};font-weight:700;">${dirIcon} ${p.direction}</td>
          <td style="color:${changeColor};font-weight:600;">${changePct > 0 ? '+' : ''}${changePct}%</td>
          <td>${confIcon} ${p.confidence}</td>
          <td style="color:${trendColor};">${p.trend}</td>
          <td class="text-mono" style="font-size:0.75rem;">$${(p.predicted || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:6})}</td>
        </tr>`;
      }).join('');
    } catch (err) {
      console.warn('Kronos predictions:', err.message);
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--color-text-secondary);padding:20px;">No predictions available — Kronos scans during trading cycles</td></tr>';
    }
  }

  function renderWallets(data) {
    const wallets = data.wallets || [];
    const totalBal = parseFloat(data.balance) || 0;
    const grid = els.walletsGrid;
    if (!grid) return;

    const platformIcon = (p) => p === 'binance' ? '🟡' : p === 'bitunix' ? '🔵' : '⚪';

    let html = `<div class="summary-card">
      <span class="summary-card-label">Total Futures Wallet <span class="tip-btn">?<span class="tip-text">Combined balance across all your connected exchange futures wallets.</span></span></span>
      <span class="summary-card-value text-mono" style="color:var(--color-accent);font-size:1.3rem">$${totalBal.toFixed(2)}</span>
    </div>`;

    for (const w of wallets) {
      const bal = parseFloat(w.balance) || 0;
      const avail = parseFloat(w.available) || 0;
      const pnl = parseFloat(w.unrealizedPnl) || 0;
      const pnlColor = pnl >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
      const pnlSign = pnl >= 0 ? '+' : '';

      html += `<div class="summary-card" style="padding:var(--space-3)">
        <span class="summary-card-label">${platformIcon(w.platform)} ${w.platform.toUpperCase()} <span class="tip-btn">?<span class="tip-text">Futures wallet on ${w.platform.toUpperCase()}. Avail = available margin, uPnL = unrealized profit/loss from open positions, Pos = number of open positions.</span></span></span>
        <span class="summary-card-value text-mono" style="color:var(--color-accent)">$${bal.toFixed(2)}</span>
        <div style="font-size:0.75rem;color:var(--color-text-muted);margin-top:4px">
          <span>Avail: $${avail.toFixed(2)}</span> ·
          <span style="color:${pnlColor}">uPnL: ${pnlSign}$${pnl.toFixed(2)}</span> ·
          <span>Pos: ${w.positions || 0}</span>
        </div>
        ${w.error ? `<div style="font-size:0.7rem;color:var(--color-danger);margin-top:2px">${escapeHtml(w.error)}</div>` : ''}
      </div>`;
    }

    if (wallets.length === 0) {
      html += `<div class="summary-card"><span class="summary-card-label">No exchange accounts connected</span></div>`;
    }

    grid.innerHTML = html;
  }

  let weTimerInterval = null;

  function formatCountdown(ms) {
    if (ms <= 0) return 'OVERDUE';
    const totalSec = Math.floor(ms / 1000);
    const dd = Math.floor(totalSec / 86400);
    const hh = Math.floor((totalSec % 86400) / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    return `${String(dd).padStart(2,'0')}:${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  }

  function startCountdownTimer(dueIso, adminShareAmount) {
    if (weTimerInterval) clearInterval(weTimerInterval);
    const dueMs = new Date(dueIso).getTime();
    const timerEl = document.getElementById('we-timer-countdown');
    const timerBox = document.getElementById('we-timer');
    const payBtn = document.getElementById('we-pay-btn');
    if (!timerEl) return;

    function tick() {
      const remaining = dueMs - Date.now();
      timerEl.textContent = formatCountdown(remaining);
      const isOverdue = remaining <= 0;
      const daysLeft = remaining / 86400000;

      if (isOverdue) {
        timerEl.style.color = 'var(--color-danger)';
        timerBox.style.borderColor = 'var(--color-danger)';
        timerBox.style.background = 'rgba(239,68,68,0.08)';
      } else if (daysLeft <= 2) {
        timerEl.style.color = 'var(--color-danger)';
        timerBox.style.borderColor = 'var(--color-danger)';
        timerBox.style.background = 'var(--color-bg)';
      } else if (daysLeft <= 4) {
        timerEl.style.color = '#f59e0b';
        timerBox.style.borderColor = '#f59e0b';
        timerBox.style.background = 'var(--color-bg)';
      } else {
        timerEl.style.color = 'var(--color-accent)';
        timerBox.style.borderColor = 'var(--color-border-muted)';
        timerBox.style.background = 'var(--color-bg)';
      }

      // Show pay button if there's a fee to pay
      if (payBtn && adminShareAmount > 0) {
        payBtn.classList.remove('hidden');
        payBtn.textContent = `Pay $${adminShareAmount.toFixed(2)}`;
      } else if (payBtn) {
        payBtn.classList.add('hidden');
      }
    }
    tick();
    weTimerInterval = setInterval(tick, 1000);
  }

  function renderWeeklyEarnings(data) {
    const el = (id) => document.getElementById(id);
    const userShare = parseFloat(data.user_share) || 0;
    const adminShare = parseFloat(data.admin_share) || 0;
    const netPnl = parseFloat(data.net_pnl) || 0;
    const netColor = netPnl >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
    const netSign = netPnl >= 0 ? '+' : '';

    // Live countdown timer (dd:hh:mm:ss)
    if (data.payment_due) {
      startCountdownTimer(data.payment_due, adminShare);
    }

    el('we-user-pct').textContent = data.user_share_pct || 60;
    el('we-admin-pct').textContent = data.admin_share_pct || 40;
    el('we-user-share').textContent = `$${userShare.toFixed(2)}`;
    el('we-admin-share').textContent = `$${adminShare.toFixed(2)}`;

    const totalEl = el('we-total-winning');
    totalEl.textContent = `${netSign}$${Math.abs(netPnl).toFixed(2)}`;
    totalEl.style.color = netColor;

    el('we-wins').textContent = data.total_wins || 0;
    el('we-losses').textContent = data.total_losses || 0;

    const totalTrades = (data.total_wins || 0) + (data.total_losses || 0);
    const winRate = totalTrades > 0 ? ((data.total_wins / totalTrades) * 100).toFixed(0) : '0';
    el('we-week-record').textContent = `${winRate}% WR`;

    // Per-key breakdown
    const perKeyEl = el('we-per-key');
    if (data.per_key && data.per_key.length > 1) {
      perKeyEl.innerHTML = data.per_key.map(k => {
        const pnl = parseFloat(k.net_pnl) || 0;
        const pnlColor = pnl >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
        const pnlSign = pnl >= 0 ? '+' : '';
        const us = parseFloat(k.user_share) || 0;
        return `<div class="summary-card" style="padding:var(--space-3);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div>
            <strong style="font-size:0.85rem;">${escapeHtml(k.label || k.platform)}</strong>
            <span style="font-size:0.75rem;color:var(--color-text-muted);margin-left:8px;">${k.win_count}W / ${k.loss_count}L</span>
          </div>
          <div style="text-align:right;">
            <span class="text-mono" style="color:${pnlColor};font-size:0.9rem;">${pnlSign}$${Math.abs(pnl).toFixed(2)}</span>
            <span style="font-size:0.7rem;color:var(--color-text-muted);margin-left:4px;">→ Your share: $${us.toFixed(2)}</span>
          </div>
        </div>`;
      }).join('');
    } else {
      perKeyEl.innerHTML = '';
    }
  }

  function renderSummary(s) {
    const totalPnl = parseFloat(s.total_pnl) || 0;
    const pnl24h = parseFloat(s.pnl_24h) || 0;
    const pnl7d = parseFloat(s.pnl_7d) || 0;

    els.summaryTotalPnl.textContent = formatPnl(totalPnl);
    els.summaryTotalPnl.className = `summary-card-value text-mono ${pnlClass(totalPnl)}`;

    els.summary24hPnl.textContent = formatPnl(pnl24h);
    els.summary24hPnl.className = `summary-card-value text-mono ${pnlClass(pnl24h)}`;

    els.summary7dPnl.textContent = formatPnl(pnl7d);
    els.summary7dPnl.className = `summary-card-value text-mono ${pnlClass(pnl7d)}`;

    const wins = parseInt(s.wins) || 0;
    const losses = parseInt(s.losses) || 0;
    els.summaryWinRate.textContent = `${s.win_rate}%`;
    els.summaryWins.textContent = `${wins}W`;
    els.summaryLosses.textContent = `${losses}L`;
    els.summaryOpenTrades.textContent = s.open_trades;

    const totalWon = parseFloat(s.total_won) || 0;
    const totalLost = parseFloat(s.total_lost) || 0;
    els.summaryTotalWon.textContent = `+$${totalWon.toFixed(2)}`;
    els.summaryTotalLost.textContent = `-$${Math.abs(totalLost).toFixed(2)}`;
  }

  async function loadTrades() {
    let url = `/api/dashboard/trades?page=${state.tradesPage}`;
    if (state.tradesPeriod !== 'all') url += `&period=${state.tradesPeriod}`;
    const data = await api('GET', url);
    state.tradesTotal = data.total;
    state.tradesPages = data.pages;
    renderTrades(data.trades);
    renderPagination();
  }

  function renderTrades(trades) {
    if (!trades || trades.length === 0) {
      els.tradesTbody.innerHTML = '';
      els.tradesEmpty.classList.remove('hidden');
      els.tradesTbody.closest('.table-wrapper').classList.add('hidden');
      return;
    }

    els.tradesEmpty.classList.add('hidden');
    els.tradesTbody.closest('.table-wrapper').classList.remove('hidden');

    // Show clear errors button for admin if there are errors
    const hasErrors = trades.some(t => t.status === 'ERROR');
    const clearBtn = document.getElementById('btn-clear-errors');
    if (clearBtn) {
      clearBtn.classList.toggle('hidden', !hasErrors || !state.user?.is_admin);
    }

    els.tradesTbody.innerHTML = trades.map((t) => {
      const netPnl = parseFloat(t.pnl_usdt) || 0;
      const grossPnl = t.gross_pnl != null ? parseFloat(t.gross_pnl) : netPnl;
      const fee = parseFloat(t.trading_fee) || 0;
      const direction = (t.direction || t.side || '').toUpperCase();
      const isLong = direction === 'LONG' || direction === 'BUY';
      const dirBadge = isLong ? 'badge-long' : 'badge-short';
      const dirLabel = isLong ? 'L' : 'S';

      const isError = t.status === 'ERROR';
      const errorTip = isError && t.error_msg ? ` title="${escapeHtml(t.error_msg)}"` : '';

      let statusClass = '';
      let statusColor = '';
      if (isError) { statusClass = 'badge-error'; }
      else if (t.status === 'WIN') { statusClass = 'badge-win'; statusColor = 'color:var(--color-success);'; }
      else if (t.status === 'LOSS') { statusClass = 'badge-loss'; statusColor = 'color:var(--color-danger);'; }
      else if (t.status === 'OPEN') { statusClass = 'badge-open'; statusColor = 'color:#f5a623;'; }
      else if (t.status === 'TP') { statusClass = 'badge-tp'; statusColor = 'color:var(--color-success);'; }
      else if (t.status === 'SL') { statusClass = 'badge-sl'; statusColor = 'color:var(--color-danger);'; }

      const exitPrice = t.exit_price != null ? parseFloat(t.exit_price).toFixed(4) : '--';

      return `<tr${isError ? ' style="opacity:0.6;"' : ''}>
        <td>${formatDate(t.created_at)}</td>
        <td><strong>${escapeHtml(t.symbol || '--')}</strong></td>
        <td><span class="badge ${dirBadge}">${dirLabel}</span></td>
        <td class="text-mono">${t.entry_price != null ? parseFloat(t.entry_price).toFixed(4) : '--'}</td>
        <td class="text-mono">${exitPrice}</td>
        <td class="text-mono ${grossPnl >= 0 ? 'text-success' : 'text-danger'}">${formatPnl(grossPnl)}</td>
        <td class="text-mono" style="color:var(--color-warning);">${fee > 0 ? '-$' + fee.toFixed(2) : '--'}</td>
        <td class="pnl-value ${netPnl >= 0 ? 'text-success' : 'text-danger'}" style="font-weight:600;">${formatPnl(netPnl)}</td>
        <td><span class="badge-status ${statusClass}" style="${statusColor}font-weight:600;"${errorTip}>${escapeHtml(t.status || '--')}${isError ? ' !' : ''}</span></td>
        <td><span class="badge-platform">${escapeHtml(t.platform || '--')}</span></td>
      </tr>`;
    }).join('');
  }

  function renderPagination() {
    if (state.tradesPages <= 1) {
      els.tradesPagination.classList.add('hidden');
      return;
    }
    els.tradesPagination.classList.remove('hidden');
    els.paginationInfo.textContent = `Page ${state.tradesPage} of ${state.tradesPages}`;
    els.btnPrevPage.disabled = state.tradesPage <= 1;
    els.btnNextPage.disabled = state.tradesPage >= state.tradesPages;
  }

  function setupPagination() {
    els.btnPrevPage.addEventListener('click', () => {
      if (state.tradesPage > 1) {
        state.tradesPage--;
        loadTrades();
      }
    });
    els.btnNextPage.addEventListener('click', () => {
      if (state.tradesPage < state.tradesPages) {
        state.tradesPage++;
        loadTrades();
      }
    });

    document.querySelectorAll('.period-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.tradesPeriod = btn.dataset.period;
        state.tradesPage = 1;
        loadDashboard(); // reload summary cards + trades for selected period
      });
    });
  }

  function setupCsvExport() {
    const btn = document.getElementById('btn-export-csv');
    if (!btn) return;
    btn.addEventListener('click', () => {
      let url = '/api/dashboard/trades/csv';
      if (state.tradesPeriod !== 'all') url += `?period=${state.tradesPeriod}`;
      window.location.href = url;
    });
  }

  // ----- API Keys -----

  let riskLevelsCache = [];

  async function loadKeys() {
    try {
      const [keys, riskLevels] = await Promise.all([
        api('GET', '/api/keys'),
        api('GET', '/api/risk-levels').catch(() => []),
      ]);
      riskLevelsCache = riskLevels;
      renderKeys(keys);
      // Populate risk level dropdowns and token leverage after render
      for (const k of keys) {
        populateRiskLevelDropdown(k.id, k.risk_level_id);
        renderTokenLeverages(k.id, k.token_leverages || []);
      }
    } catch (err) {
      showToast('Failed to load API keys.', 'error');
    }
  }

  function populateRiskLevelDropdown(keyId, selectedId) {
    const container = $(`#risk-boxes-${keyId}`);
    const hidden = $(`#risk-level-${keyId}`);
    if (!container || !hidden) return;

    const RISK_ICONS = { low: '\u{1F6E1}', medium: '\u26A1', high: '\u{1F525}' };
    const RISK_COLORS = {
      low:    { border: '#22c55e', bg: 'rgba(34,197,94,0.08)', glow: 'rgba(34,197,94,0.25)' },
      medium: { border: '#f59e0b', bg: 'rgba(245,158,11,0.08)', glow: 'rgba(245,158,11,0.25)' },
      high:   { border: '#ef4444', bg: 'rgba(239,68,68,0.08)', glow: 'rgba(239,68,68,0.25)' },
    };

    container.innerHTML = riskLevelsCache.map(rl => {
      const isSelected = rl.id === selectedId;
      const nameKey = (rl.name || '').toLowerCase().includes('high') ? 'high'
        : (rl.name || '').toLowerCase().includes('medium') ? 'medium' : 'low';
      const c = RISK_COLORS[nameKey] || RISK_COLORS.medium;
      const icon = RISK_ICONS[nameKey] || '\u26A1';

      return `<div class="risk-box" data-rl-id="${rl.id}" data-key-id="${keyId}"
        onclick="window.CryptoBot.selectRiskLevel(${keyId},${rl.id})"
        style="
          cursor:pointer;border:2px solid ${isSelected ? c.border : 'var(--color-border-muted)'};
          border-radius:var(--radius-lg);padding:16px 14px;text-align:center;
          background:${isSelected ? c.bg : 'var(--color-bg)'};
          box-shadow:${isSelected ? '0 0 12px ' + c.glow : 'none'};
          transition:all 0.2s ease;position:relative;
        ">
        ${isSelected ? `<div style="position:absolute;top:8px;right:10px;font-size:0.7rem;color:${c.border};font-weight:700;">ACTIVE</div>` : ''}
        <div style="font-size:1.8rem;margin-bottom:6px;">${icon}</div>
        <div style="font-size:0.95rem;font-weight:700;color:${isSelected ? c.border : 'var(--color-text)'};">${escapeHtml(rl.name)}</div>
        <div style="font-size:0.7rem;color:var(--color-text-muted);margin:6px 0 10px;line-height:1.3;">${escapeHtml(rl.description || '')}</div>
        <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:0.7rem;background:var(--color-bg-raised);padding:2px 8px;border-radius:10px;">Lev ${rl.max_leverage}x</span>
          <span style="font-size:0.7rem;background:var(--color-bg-raised);padding:2px 8px;border-radius:10px;">Cap ${parseFloat(rl.capital_percentage || 10)}%</span>
          <span style="font-size:0.7rem;background:var(--color-bg-raised);padding:2px 8px;border-radius:10px;">SL ${(parseFloat(rl.sl_pct)*100).toFixed(1)}%</span>
          <span style="font-size:0.7rem;background:var(--color-bg-raised);padding:2px 8px;border-radius:10px;">Trail ${parseFloat(rl.trailing_sl_step || 1.2).toFixed(1)}%</span>
        </div>
      </div>`;
    }).join('');
  }

  function selectRiskLevel(keyId, rlId) {
    const hidden = $(`#risk-level-${keyId}`);
    if (hidden) hidden.value = rlId;
    // Re-render boxes to update selection
    populateRiskLevelDropdown(keyId, rlId);
    // Apply the risk level values to sliders
    applyRiskLevel(keyId);
  }

  function applyRiskLevel(keyId) {
    const raw = $(`#risk-level-${keyId}`)?.value;
    const rlId = parseInt(raw);
    const rl = riskLevelsCache.find(r => r.id === rlId);
    if (!rl) return;
    const tp = (parseFloat(rl.tp_pct) * 100).toFixed(1);
    const sl = (parseFloat(rl.sl_pct) * 100).toFixed(1);
    const lev = parseInt(rl.max_leverage);
    const rawConsec = parseInt(rl.max_consec_loss);
    const consec = isNaN(rawConsec) ? 2 : rawConsec;
    // Update sliders + number inputs
    syncSlider(`tp-${keyId}`, Math.round(tp * 10));
    syncNum(`tp-num-${keyId}`, tp);
    syncSlider(`sl-${keyId}`, Math.round(sl * 10));
    syncNum(`sl-num-${keyId}`, sl);
    syncSlider(`leverage-${keyId}`, lev);
    syncNum(`leverage-num-${keyId}`, lev);
    syncSlider(`maxloss-streak-${keyId}`, consec);
    syncNum(`maxloss-streak-num-${keyId}`, consec);
    const trail = parseFloat(rl.trailing_sl_step || 1.2).toFixed(1);
    syncSlider(`trailing-step-${keyId}`, Math.round(trail * 10));
    syncNum(`trailing-step-num-${keyId}`, trail);
  }

  function renderTokenLeverages(keyId, leverages) {
    const container = $(`#token-lev-${keyId}`);
    if (!container) return;
    if (!leverages.length) { container.innerHTML = ''; return; }
    container.innerHTML = leverages.map(tl =>
      `<span class="coin-chip">${escapeHtml(tl.symbol)} ${tl.leverage}x <span class="coin-chip-x" onclick="window.CryptoBot.removeTokenLeverage(${keyId},'${escapeHtml(tl.symbol)}')">&times;</span></span>`
    ).join('');
  }

  function addTokenLeverage(keyId) {
    const symbol = ($(`#token-lev-symbol-${keyId}`).value || '').toUpperCase().trim();
    const leverage = parseInt($(`#token-lev-value-${keyId}`).value);
    if (!symbol) return showToast('Enter token symbol', 'error');
    if (!leverage || leverage < 1 || leverage > 125) return showToast('Leverage must be 1-125', 'error');
    const container = $(`#token-lev-${keyId}`);
    // Remove existing chip for same symbol
    container.querySelectorAll('.coin-chip').forEach(c => {
      if (c.textContent.startsWith(symbol + ' ')) c.remove();
    });
    container.innerHTML += `<span class="coin-chip">${escapeHtml(symbol)} ${leverage}x <span class="coin-chip-x" onclick="window.CryptoBot.removeTokenLeverage(${keyId},'${escapeHtml(symbol)}')">&times;</span></span>`;
    $(`#token-lev-symbol-${keyId}`).value = '';
    $(`#token-lev-value-${keyId}`).value = '';
  }

  function removeTokenLeverage(keyId, symbol) {
    const container = $(`#token-lev-${keyId}`);
    container.querySelectorAll('.coin-chip').forEach(c => {
      if (c.textContent.startsWith(symbol + ' ')) c.remove();
    });
  }

  function searchTokenLev(input, keyId) {
    loadCoinList();
    const q = (input.value || '').toUpperCase().trim();
    const dd = $(`#token-lev-dropdown-${keyId}`);
    if (!dd) return;
    if (!q) { dd.classList.add('hidden'); return; }
    const matches = coinList.filter(c => c.includes(q)).slice(0, 8);
    if (!matches.length) { dd.classList.add('hidden'); return; }
    dd.innerHTML = matches.map(c =>
      `<div class="coin-dropdown-item" onclick="window.CryptoBot.pickTokenLev(${keyId},'${c}')">${c.replace('USDT', '')}/<span style="opacity:0.5">USDT</span></div>`
    ).join('');
    dd.classList.remove('hidden');
  }

  function pickTokenLev(keyId, symbol) {
    const input = $(`#token-lev-symbol-${keyId}`);
    if (input) input.value = symbol;
    const dd = $(`#token-lev-dropdown-${keyId}`);
    if (dd) dd.classList.add('hidden');
    // Focus the leverage input
    const levInput = $(`#token-lev-value-${keyId}`);
    if (levInput) levInput.focus();
  }

  function getTokenLeverages(keyId) {
    const container = $(`#token-lev-${keyId}`);
    if (!container) return [];
    return Array.from(container.querySelectorAll('.coin-chip')).map(c => {
      const text = c.textContent.replace('\u00d7', '').trim();
      const parts = text.split(' ');
      return { symbol: parts[0], leverage: parseInt(parts[1]) };
    }).filter(tl => tl.symbol && tl.leverage);
  }

  function renderKeys(keys) {
    if (!keys || keys.length === 0) {
      els.keysList.innerHTML = '';
      els.keysEmpty.classList.remove('hidden');
      return;
    }
    els.keysEmpty.classList.add('hidden');

    els.keysList.innerHTML = keys.map((k) => {
      const platformAbbr = getPlatformAbbr(k.platform);
      const isEnabled = k.enabled !== false;
      const leverage = k.leverage || 10;
      const riskPct = k.risk_pct != null ? (parseFloat(k.risk_pct) * 100).toFixed(0) : '5';
      const maxLoss = k.max_loss_usdt || 30;
      const maxPos = k.max_positions || 1;

      const bannedCoins = k.banned_coins || '';
      const tpPct = k.tp_pct != null ? (parseFloat(k.tp_pct) * 100).toFixed(2) : '1.00';
      const slPct = k.sl_pct != null ? (parseFloat(k.sl_pct) * 100).toFixed(2) : '1.00';
      const trailingStep = k.trailing_sl_step != null ? parseFloat(k.trailing_sl_step).toFixed(1) : '1.2';
      const maxConsecLoss = k.max_consec_loss != null ? k.max_consec_loss : 2;

      return `<div class="key-card" data-key-id="${k.id}">
        <div class="key-card-main">
          <div class="key-card-info">
            <div class="key-card-platform ${escapeHtml(k.platform)}">${platformAbbr}</div>
            <div class="key-card-details">
              <div class="key-card-label">${escapeHtml(k.label || k.platform)}</div>
              <div class="key-card-preview">${escapeHtml(k.key_preview || '********')}...</div>
            </div>
          </div>
          <div class="key-card-status">
            <span class="status-dot ${isEnabled ? 'active' : 'inactive'}"></span>
            <span>${isEnabled ? 'Active' : 'Inactive'}</span>
          </div>
          <div class="key-card-actions">
            <button class="btn btn-ghost btn-sm" onclick="window.CryptoBot.toggleSettings(${k.id})" aria-label="Toggle settings for ${escapeHtml(k.label)}">Settings</button>
            <button class="btn btn-danger btn-sm" onclick="window.CryptoBot.deleteKey(${k.id})" aria-label="Delete ${escapeHtml(k.label)}">Delete</button>
          </div>
        </div>
        <div class="key-settings" id="settings-${k.id}">
          <!-- Risk Level Visual Selector -->
          <div style="margin-bottom:var(--space-4);">
            <label class="form-label" style="margin-bottom:var(--space-2);">Risk Level <span class="tip-btn">?<span class="tip-text">Choose a preset risk profile. This auto-fills leverage, SL, TP, and trailing settings. You can still adjust individually after.</span></span></label>
            <input type="hidden" id="risk-level-${k.id}" value="${k.risk_level_id || ''}">
            <div id="risk-boxes-${k.id}" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;"></div>
          </div>
          <div class="settings-grid">
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="leverage-${k.id}">Leverage <span class="tip-btn">?<span class="tip-text">Multiplier for your trade size. Higher leverage = bigger gains but also bigger losses. E.g. 20x means $100 controls $2000.</span></span></label>
                <input type="number" class="slider-num" id="leverage-num-${k.id}" min="1" max="125" step="1" value="${leverage}"
                  oninput="window.CryptoBot.syncSlider('leverage-${k.id}',this.value)">
              </div>
              <input type="range" id="leverage-${k.id}" min="1" max="125" value="${leverage}"
                oninput="window.CryptoBot.syncNum('leverage-num-${k.id}',this.value)"
                aria-label="Leverage">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="risk-${k.id}">Risk per Trade (%) <span class="tip-btn">?<span class="tip-text">Percentage of your wallet used as margin for each trade. E.g. 10% of a $1000 wallet = $100 margin per trade.</span></span></label>
                <input type="number" class="slider-num" id="risk-num-${k.id}" min="1" max="20" step="1" value="${riskPct}"
                  oninput="window.CryptoBot.syncSlider('risk-${k.id}',this.value)">
              </div>
              <input type="range" id="risk-${k.id}" min="1" max="20" value="${riskPct}"
                oninput="window.CryptoBot.syncNum('risk-num-${k.id}',this.value)"
                aria-label="Risk percentage">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="maxloss-${k.id}">Max Loss per Trade (%) <span class="tip-btn">?<span class="tip-text">Maximum loss allowed on a single trade as % of margin. If a trade hits this loss, it auto-closes.</span></span></label>
                <input type="number" class="slider-num" id="maxloss-num-${k.id}" min="1" max="100" step="1" value="${maxLoss}"
                  oninput="window.CryptoBot.syncSlider('maxloss-${k.id}',this.value)">
              </div>
              <input type="range" id="maxloss-${k.id}" min="1" max="100" value="${maxLoss}"
                oninput="window.CryptoBot.syncNum('maxloss-num-${k.id}',this.value)"
                aria-label="Max loss percentage">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="maxpos-${k.id}">Max Open Trades <span class="tip-btn">?<span class="tip-text">Maximum number of trades the bot can have open at the same time. More trades = more risk but more opportunity.</span></span></label>
                <input type="number" class="slider-num" id="maxpos-num-${k.id}" min="1" max="10" step="1" value="${maxPos}"
                  oninput="window.CryptoBot.syncSlider('maxpos-${k.id}',this.value)">
              </div>
              <input type="range" id="maxpos-${k.id}" min="1" max="10" value="${maxPos}"
                oninput="window.CryptoBot.syncNum('maxpos-num-${k.id}',this.value)"
                aria-label="Max concurrent positions">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="tp-${k.id}">Take Profit % <span class="tip-btn">?<span class="tip-text">Target profit % to close the trade. E.g. 1.5% means when price moves 1.5% in your favor, position starts closing. TP3 = 1.5x this value.</span></span></label>
                <input type="number" class="slider-num" id="tp-num-${k.id}" min="0.5" max="20" step="0.1" value="${tpPct}"
                  oninput="window.CryptoBot.syncSlider('tp-${k.id}',Math.round(this.value*10))">
              </div>
              <input type="range" id="tp-${k.id}" min="5" max="200" value="${Math.round(tpPct * 10)}"
                oninput="window.CryptoBot.syncNum('tp-num-${k.id}',(this.value/10).toFixed(1))"
                aria-label="Take profit percentage">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="sl-${k.id}">Initial SL % <span class="tip-btn">?<span class="tip-text">Stop loss placed at this % from entry. E.g. 1.5% means if price drops 1.5% your position closes.</span></span></label>
                <input type="number" class="slider-num" id="sl-num-${k.id}" min="0.5" max="10" step="0.1" value="${slPct}"
                  oninput="window.CryptoBot.syncSlider('sl-${k.id}',Math.round(this.value*10))">
              </div>
              <input type="range" id="sl-${k.id}" min="5" max="100" value="${Math.round(slPct * 10)}"
                oninput="window.CryptoBot.syncNum('sl-num-${k.id}',(this.value/10).toFixed(1))"
                aria-label="Stop loss percentage">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="trailing-step-${k.id}">Trailing SL Step % <span class="tip-btn">?<span class="tip-text">As price moves in your favor, SL moves up in steps of this %. E.g. 1% means every 1% profit gained, SL locks in the previous level.</span></span></label>
                <input type="number" class="slider-num" id="trailing-step-num-${k.id}" min="0.5" max="5" step="0.1" value="${trailingStep}"
                  oninput="window.CryptoBot.syncSlider('trailing-step-${k.id}',Math.round(this.value*10))">
              </div>
              <input type="range" id="trailing-step-${k.id}" min="5" max="50" value="${Math.round(trailingStep * 10)}"
                oninput="window.CryptoBot.syncNum('trailing-step-num-${k.id}',(this.value/10).toFixed(1))"
                aria-label="Trailing stop loss step percentage">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="maxloss-streak-${k.id}">Stop After Losses <span class="tip-btn">?<span class="tip-text">Bot stops trading after this many consecutive losses in one day. Resets at 7am daily. Set 0 for unlimited (never stop).</span></span></label>
                <input type="number" class="slider-num" id="maxloss-streak-num-${k.id}" min="1" max="10" step="1" value="${maxConsecLoss}"
                  oninput="window.CryptoBot.syncSlider('maxloss-streak-${k.id}',this.value)">
              </div>
              <input type="range" id="maxloss-streak-${k.id}" min="1" max="10" value="${maxConsecLoss}"
                oninput="window.CryptoBot.syncNum('maxloss-streak-num-${k.id}',this.value)"
                aria-label="Max consecutive losses before stopping">
            </div>
            <div class="form-group" style="margin-bottom:0;grid-column:1/-1;">
              <label class="form-label">Ban These Coins <span class="tip-btn">?<span class="tip-text">Block specific coins from trading. The bot will never open positions on banned coins.</span></span></label>
              <div class="coin-chips" id="banned-chips-${k.id}">${buildChips(bannedCoins, k.id, 'banned')}</div>
              <div style="position:relative;">
                <input class="form-input text-mono" type="text" id="banned-search-${k.id}" placeholder="Type to search available tokens..." autocomplete="off" style="font-size:0.8rem;" oninput="window.CryptoBot.searchUserBanToken(this,${k.id})" onfocus="window.CryptoBot.searchUserBanToken(this,${k.id})">
                <div class="coin-dropdown hidden" id="banned-dropdown-${k.id}"></div>
              </div>
            </div>
            <!-- Per-Token Leverage -->
            <div class="form-group" style="margin-bottom:0;grid-column:1/-1;">
              <label class="form-label">Per-Token Leverage <span class="tip-btn">?<span class="tip-text">Set different leverage for specific coins. E.g. BTC 10x, DOGE 50x. Overrides the default leverage above for these tokens.</span></span></label>
              <div id="token-lev-${k.id}" style="margin-bottom:8px;"></div>
              <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;position:relative;">
                <div style="position:relative;">
                  <input class="form-input text-mono" type="text" id="token-lev-symbol-${k.id}" placeholder="Type token..." autocomplete="off" style="width:140px;font-size:0.8rem;text-transform:uppercase;" oninput="window.CryptoBot.searchTokenLev(this,${k.id})" onfocus="window.CryptoBot.searchTokenLev(this,${k.id})">
                  <div class="coin-dropdown hidden" id="token-lev-dropdown-${k.id}"></div>
                </div>
                <input class="form-input text-mono" type="number" id="token-lev-value-${k.id}" placeholder="20" min="1" max="125" style="width:80px;font-size:0.8rem;">
                <button class="btn btn-ghost btn-sm" style="font-size:0.7rem;" onclick="window.CryptoBot.addTokenLeverage(${k.id})">Add</button>
              </div>
              <span style="font-size:0.7rem;color:var(--color-text-muted);">Set custom leverage per token (e.g. BTC 10x, DOGE 50x)</span>
            </div>
            <div style="display:flex;align-items:flex-end;">
              <label class="toggle">
                <input type="checkbox" id="enabled-${k.id}" ${isEnabled ? 'checked' : ''}>
                <span class="toggle-track"></span>
                <span class="toggle-label">Enabled</span>
              </label>
            </div>
          </div>
          <div class="settings-actions">
            <button class="btn btn-primary btn-sm" onclick="window.CryptoBot.saveSettings(${k.id})">Save Settings</button>
            <button class="btn btn-ghost btn-sm" onclick="window.CryptoBot.toggleSettings(${k.id})">Cancel</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function getPlatformAbbr(platform) {
    const abbrs = { binance: 'BIN', bitunix: 'BTX', okx: 'OKX' };
    return abbrs[(platform || '').toLowerCase()] || platform?.substring(0, 3).toUpperCase() || '???';
  }

  // Toggle settings panel
  function toggleSettings(keyId) {
    const panel = $(`#settings-${keyId}`);
    if (panel) panel.classList.toggle('open');
  }

  // Save settings
  async function saveSettings(keyId) {
    const leverage = parseInt($(`#leverage-${keyId}`).value);
    const riskPct = parseInt($(`#risk-${keyId}`).value) / 100;
    const maxLossUsdt = parseInt($(`#maxloss-${keyId}`).value);
    const maxPositions = parseInt($(`#maxpos-${keyId}`).value);
    const enabled = $(`#enabled-${keyId}`).checked;
    const bannedCoins = getChipValues(`banned-chips-${keyId}`);
    const tpPct = parseInt($(`#tp-${keyId}`).value) / 1000;
    const slPct = parseInt($(`#sl-${keyId}`).value) / 1000;
    const trailingSlStep = parseInt($(`#trailing-step-${keyId}`).value) / 10;
    const maxConsecLoss = parseInt($(`#maxloss-streak-${keyId}`).value);
    const riskLevelId = $(`#risk-level-${keyId}`).value || null;
    const tokenLeverages = getTokenLeverages(keyId);

    try {
      await api('PUT', `/api/keys/${keyId}/settings`, {
        leverage,
        risk_pct: riskPct,
        max_loss_usdt: maxLossUsdt,
        max_positions: maxPositions,
        enabled,
        banned_coins: bannedCoins,
        tp_pct: tpPct,
        sl_pct: slPct,
        trailing_sl_step: trailingSlStep,
        max_consec_loss: maxConsecLoss,
        risk_level_id: riskLevelId ? parseInt(riskLevelId) : null,
        token_leverages: tokenLeverages,
      });
      showToast('Settings saved.', 'success');
      toggleSettings(keyId);
      loadKeys();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // Delete key
  async function deleteKey(keyId) {
    if (!confirm('Delete this API key? This cannot be undone.')) return;
    try {
      await api('DELETE', `/api/keys/${keyId}`);
      showToast('API key deleted.', 'success');
      loadKeys();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // ----- Add Key Modal -----

  function openModal() {
    els.modalAddKey.classList.add('visible');
    els.formAddKey.reset();
    hideError(els.addKeyError);
    $('#key-platform').focus();
  }

  function closeModal() {
    els.modalAddKey.classList.remove('visible');
  }

  function setupModal() {
    els.btnAddKey.addEventListener('click', openModal);

    els.modalAddKey.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', closeModal);
    });

    // Close on overlay click
    els.modalAddKey.addEventListener('click', (e) => {
      if (e.target === els.modalAddKey) closeModal();
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && els.modalAddKey.classList.contains('visible')) {
        closeModal();
      }
    });

    els.formAddKey.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError(els.addKeyError);
      els.btnSubmitKey.disabled = true;
      els.btnSubmitKey.innerHTML = '<span class="spinner"></span> Validating...';

      try {
        await api('POST', '/api/keys', {
          platform: $('#key-platform').value,
          label: $('#key-label').value.trim(),
          apiKey: $('#key-api-key').value.trim(),
          apiSecret: $('#key-api-secret').value.trim(),
        });
        closeModal();
        showToast('API key added.', 'success');
        loadKeys();
      } catch (err) {
        showError(els.addKeyError, err.message);
      } finally {
        els.btnSubmitKey.disabled = false;
        els.btnSubmitKey.textContent = 'Add Key';
      }
    });
  }

  // ----- Navigation Tabs -----

  function setupNavTabs() {
    $$('.nav-tab[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  // ─── Cash Wallet ─────────────────────────────────────────────

  async function loadCashWallet() {
    try {
      const [status, dashWallet] = await Promise.all([
        api('GET', '/api/subscription/status'),
        api('GET', '/api/dashboard/cash-wallet').catch(() => null),
      ]);

      // Summary cards
      const cashWallet = parseFloat(status.cash_wallet) || 0;
      const commission = parseFloat(status.commission_earned) || 0;
      $('#cw-cash').textContent = `$${cashWallet.toFixed(2)}`;
      $('#cw-commission').textContent = `$${commission.toFixed(2)}`;

      // Cash wallet breakdown (where the money came from)
      const breakdown = dashWallet?.breakdown;
      const breakdownEl = $('#cw-breakdown');
      if (breakdownEl && breakdown) {
        const topUps = parseFloat(breakdown.top_ups) || 0;
        const refComm = parseFloat(breakdown.referral_commission) || 0;
        const feesPaid = parseFloat(breakdown.fees_paid) || 0;
        breakdownEl.innerHTML = `
          <div style="font-size:0.78rem;color:var(--color-text-muted);margin-top:8px;line-height:1.6;">
            <div>Top-ups: <span class="text-mono" style="color:var(--color-text);">$${topUps.toFixed(2)}</span></div>
            <div>Referral commission: <span class="text-mono" style="color:var(--color-accent);">$${refComm.toFixed(2)}</span></div>
            ${feesPaid > 0 ? `<div>Fees paid: <span class="text-mono" style="color:var(--color-danger);">-$${feesPaid.toFixed(2)}</span></div>` : ''}
          </div>
          <div style="font-size:0.7rem;color:var(--color-fg-subtle);margin-top:4px;">Your 60% profit stays in your exchange account</div>
        `;
      }

      // Platform USDT address for top-ups
      if (status.platform_usdt_address) {
        const addrBox = $('#cw-platform-addr');
        if (addrBox) addrBox.classList.remove('hidden');
        const addrVal = $('#cw-platform-addr-val');
        if (addrVal) addrVal.value = status.platform_usdt_address;
        const netEl = $('#cw-platform-net');
        if (netEl) netEl.textContent = `Network: ${status.platform_usdt_network || 'BEP20'}`;
      }

      // Referral link
      const appUrl = window.location.origin;
      $('#referral-link').value = `${appUrl}/?ref=${status.referral_code}`;

      // USDT address
      if (status.usdt_address) {
        $('#cw-usdt-addr').value = status.usdt_address;
        $('#cw-usdt-net').value = status.usdt_network || 'BEP20';
        $('#cw-wd-address-display').textContent = `Sending to: ${status.usdt_address.slice(0, 10)}...${status.usdt_address.slice(-6)} (${status.usdt_network})`;
      }

      // Referral details from dashboard endpoint
      const referrals = dashWallet?.referrals || [];
      const refCount = referrals.length;
      const refTotal = parseFloat(dashWallet?.total_referral_commission || 0);
      $('#cw-ref-count').textContent = refCount;
      const refTotalEl = $('#cw-ref-total');
      if (refTotalEl) refTotalEl.textContent = `$${refTotal.toFixed(2)}`;

      // Referral names + commission table
      const refList = $('#cw-referrals-list');
      if (refList) {
        if (refCount === 0) {
          refList.innerHTML = '<div style="color:var(--color-text-muted);font-size:0.8rem;">No referrals yet. Share your link to start earning!</div>';
        } else {
          refList.innerHTML = `<div class="table-wrap"><table class="data-table" style="font-size:0.85rem;">
            <thead><tr><th>Referral</th><th>Joined</th><th>Commission Earned</th></tr></thead>
            <tbody>${referrals.map(r => {
              const comm = parseFloat(r.commission) || 0;
              const emailShort = r.email.length > 20 ? r.email.slice(0, 8) + '...' + r.email.slice(r.email.indexOf('@')) : r.email;
              return `<tr>
                <td>${escapeHtml(emailShort)}</td>
                <td>${formatDate(r.joined)}</td>
                <td class="text-mono" style="color:${comm > 0 ? 'var(--color-accent)' : 'var(--color-text-muted)'};">${comm > 0 ? '+' : ''}$${comm.toFixed(2)}</td>
              </tr>`;
            }).join('')}</tbody>
          </table></div>`;
        }
      }

      // Transaction history
      const txContainer = $('#cw-transactions');
      if (txContainer) {
        try {
          const txns = await api('GET', '/api/subscription/transactions');
          if (!txns.length) {
            txContainer.innerHTML = '<div style="color:var(--color-text-muted);font-size:0.8rem;">No transactions yet.</div>';
          } else {
            txContainer.innerHTML = `<table class="data-table" style="font-size:0.85rem;">
              <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Status</th><th>Description</th></tr></thead>
              <tbody>${txns.slice(0, 50).map(t => {
                const amt = parseFloat(t.amount) || 0;
                const isPositive = amt >= 0;
                return `<tr>
                  <td>${formatDate(t.created_at)}</td>
                  <td>${escapeHtml(t.type || '-')}</td>
                  <td class="text-mono" style="color:${isPositive ? 'var(--color-success)' : 'var(--color-danger)'};">${isPositive ? '+' : ''}$${Math.abs(amt).toFixed(2)}</td>
                  <td>${escapeHtml(t.status || '-')}</td>
                  <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(t.description || '-')}</td>
                </tr>`;
              }).join('')}</tbody>
            </table>`;
          }
        } catch { txContainer.innerHTML = '<div style="color:var(--color-text-muted);font-size:0.8rem;">Could not load transactions.</div>'; }
      }

      // Withdrawal history
      const wdContainer = $('#cw-withdrawals');
      if (wdContainer) {
        try {
          const wds = await api('GET', '/api/subscription/withdrawals');
          if (!wds.length) {
            wdContainer.innerHTML = '<div style="color:var(--color-text-muted);font-size:0.8rem;">No withdrawals yet.</div>';
          } else {
            wdContainer.innerHTML = `<table class="data-table" style="font-size:0.85rem;">
              <thead><tr><th>Date</th><th>Amount</th><th>Status</th><th>Address</th></tr></thead>
              <tbody>${wds.map(w => {
                const amt = parseFloat(w.amount) || 0;
                const statusColor = w.status === 'completed' ? 'var(--color-success)' : w.status === 'pending' ? '#f59e0b' : 'var(--color-text-muted)';
                const addr = w.usdt_address || w.bank_name || '-';
                const addrShort = addr.length > 20 ? addr.slice(0, 10) + '...' + addr.slice(-6) : addr;
                return `<tr>
                  <td>${formatDate(w.created_at)}</td>
                  <td class="text-mono">$${amt.toFixed(2)}</td>
                  <td style="color:${statusColor};font-weight:600;">${escapeHtml(w.status || '-')}</td>
                  <td style="font-size:0.8rem;">${escapeHtml(addrShort)}</td>
                </tr>`;
              }).join('')}</tbody>
            </table>`;
          }
        } catch { wdContainer.innerHTML = '<div style="color:var(--color-text-muted);font-size:0.8rem;">Could not load withdrawals.</div>'; }
      }
    } catch (err) {
      showToast('Failed to load cash wallet.', 'error');
    }
  }

  async function payWeekly() {
    if (!confirm('Pay the weekly platform fee from your cash wallet?\nThis will deduct the platform fee and reset your 7-day timer.')) return;
    try {
      const result = await api('POST', '/api/dashboard/pay-weekly');
      showToast(result.message || 'Payment successful — timer reset!', 'success');
      loadDashboard();
      loadCashWallet();
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('Insufficient') || msg.includes('top up')) {
        showToast('Insufficient cash wallet balance. Redirecting to top up...', 'error');
        setTimeout(() => {
          document.querySelector('[data-tab="cashwallet"]')?.click();
          const topUpAmount = document.getElementById('cw-topup-amount');
          if (topUpAmount) topUpAmount.focus();
        }, 1000);
      } else {
        showToast(msg, 'error');
      }
    }
  }

  async function submitTopUp() {
    const amount = parseFloat($('#cw-topup-amount').value);
    const txHash = $('#cw-topup-txhash').value.trim();
    if (!amount || amount <= 0) return showToast('Enter a valid amount', 'error');
    if (!txHash) return showToast('Enter TX hash or proof URL', 'error');
    try {
      const data = await api('POST', '/api/subscription/topup', { amount, tx_hash: txHash });
      showToast(data.message, 'success');
      $('#cw-topup-amount').value = '';
      $('#cw-topup-txhash').value = '';
      loadCashWallet();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function saveUsdtAddress() {
    const address = $('#cw-usdt-addr').value.trim();
    const network = $('#cw-usdt-net').value;
    if (!address) return showToast('Enter your USDT address', 'error');
    try {
      await api('POST', '/api/subscription/usdt-address', { address, network });
      showToast('USDT address saved', 'success');
      $('#cw-wd-address-display').textContent = `Sending to: ${address.slice(0, 10)}...${address.slice(-6)} (${network})`;
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function withdrawFromWallet() {
    const amount = parseFloat($('#cw-wd-amount').value);
    if (!amount || amount < 10) return showToast('Minimum withdrawal is $10', 'error');
    if (!confirm(`Withdraw $${amount.toFixed(2)} USDT from cash wallet?`)) return;
    try {
      const data = await api('POST', '/api/subscription/withdraw', { amount });
      showToast(data.message, 'success');
      $('#cw-wd-amount').value = '';
      loadCashWallet();
    } catch (err) { showToast(err.message, 'error'); }
  }

  // ----- Admin -----

  async function loadAdmin() {
    if (!state.user?.is_admin) return;
    try {
      const [users, subs, wds, settings, weeklyEarnings] = await Promise.all([
        api('GET', '/api/admin/users'),
        api('GET', '/api/admin/subscriptions'),
        api('GET', '/api/admin/withdrawals'),
        api('GET', '/api/admin/settings'),
        api('GET', '/api/admin/weekly-earnings').catch(() => null),
      ]);
      loadAiVersions().catch(() => {});
      renderAdminUsers(users);
      renderAdminSubs(subs);
      renderAdminWithdrawals(wds);
      if (weeklyEarnings) renderAdminWeeklyEarnings(weeklyEarnings);
      // Fill settings fields
      $('#admin-referral-pct').value = settings.referral_commission_pct || '10';
      $('#admin-tier1').value = settings.commission_tier1 || '20';
      $('#admin-tier2').value = settings.commission_tier2 || '10';
      $('#admin-tier3').value = settings.commission_tier3 || '5';
      if (settings.platform_usdt_address) $('#admin-usdt-addr').value = settings.platform_usdt_address;
      if (settings.platform_usdt_network) $('#admin-usdt-net').value = settings.platform_usdt_network;
      if (settings.bscscan_api_key) $('#admin-bscscan-key').value = settings.bscscan_api_key;

      // Load global tokens, token leverage, and risk levels
      loadGlobalTokens();
      loadTokenLeverage();
      loadRiskLevels();
      adminLoadTokenBoard();
    } catch (err) { showToast('Failed to load admin.', 'error'); }
  }

  // ═══════════════════════════════════════════════════════════
  // MISSION CONTROL — Agent Dashboard
  // ═══════════════════════════════════════════════════════════

  let mcRefreshTimer = null;

  function switchAdminTab(tab) {
    // Toggle sub-tab buttons
    document.querySelectorAll('.admin-subtab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.admintab === tab);
    });
    // Toggle panels
    const panels = ['earnings', 'users', 'tokens', 'settings', 'tools'];
    panels.forEach(p => {
      const el = document.getElementById(`admin-tab-${p}`);
      if (el) el.classList.toggle('hidden', p !== tab);
    });
    // Refresh admin data when switching tabs
    if (tab === 'earnings') loadAdmin();
  }

  async function mcRefresh() {
    try {
      const data = await api('GET', '/api/admin/agents/health');
      renderMissionControl(data);
    } catch (err) {
      const grid = document.getElementById('mc-agents-grid');
      if (grid) grid.innerHTML = `<div style="color:var(--color-danger);font-size:0.85rem;padding:var(--space-3);">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderMissionControl(data) {
    const { health, activity, uptime } = data;
    if (!health) return;

    // Status dot
    const dot = document.getElementById('mc-status-dot');
    if (dot) {
      const anyRunning = health.cycleRunning || Object.values(health.agents || {}).some(a => a.state === 'running');
      const anyError = Object.values(health.agents || {}).some(a => a.state === 'error');
      dot.style.background = anyRunning ? 'var(--color-accent)' : anyError ? 'var(--color-danger)' : 'var(--color-success)';
      dot.style.boxShadow = anyRunning ? '0 0 8px rgba(212,175,55,0.5)' : '';
    }

    // Coordinator bar
    const coordState = document.getElementById('mc-coord-state');
    if (coordState) {
      const st = health.paused ? 'paused' : health.cycleRunning ? 'running' : health.state;
      coordState.textContent = st;
      coordState.className = `mc-badge mc-badge-${st}`;
    }
    const coordCycles = document.getElementById('mc-coord-cycles');
    if (coordCycles) coordCycles.textContent = `${health.runCount} cycles`;
    const uptimeEl = document.getElementById('mc-uptime');
    if (uptimeEl && uptime) {
      const h = Math.floor(uptime / 3600);
      const m = Math.floor((uptime % 3600) / 60);
      uptimeEl.textContent = `Uptime: ${h}h ${m}m`;
    }

    // Agent stats bar
    if (health.agents) {
      const agents = Object.values(health.agents);
      const totalEl = document.getElementById('mc-total-agents');
      const runningEl = document.getElementById('mc-running-count');
      const signalEl = document.getElementById('mc-signal-count');
      const errorEl = document.getElementById('mc-error-count');
      if (totalEl) totalEl.textContent = agents.length;
      if (runningEl) runningEl.textContent = agents.filter(a => a.state === 'running').length;
      if (signalEl) signalEl.textContent = agents.filter(a => a.signalCount > 0 || a.lastSignalCount > 0).reduce((s, a) => s + (a.signalCount || a.lastSignalCount || 0), 0);
      if (errorEl) errorEl.textContent = agents.filter(a => a.state === 'error').length;
    }

    // Agent cards — load profiles, store all agents for filtering
    mcAllAgents = health.agents || {};
    const grid = document.getElementById('mc-agents-grid');
    if (grid && health.agents) {
      if (!mcProfilesCache || Date.now() - mcProfilesCacheTs > 10000) {
        api('GET', '/api/admin/agents/profiles').then(p => { mcProfilesCache = p; mcProfilesCacheTs = Date.now(); filterAgents(mcCurrentFilter); }).catch(() => filterAgents(mcCurrentFilter));
      } else {
        filterAgents(mcCurrentFilter);
      }
    }

    // Activity feed — detailed view of all agent actions
    const feed = document.getElementById('mc-activity-feed');
    const countEl = document.getElementById('mc-activity-count');
    if (feed && activity) {
      if (countEl) countEl.textContent = `${activity.length} events`;
      if (!activity.length) {
        feed.innerHTML = '<div style="color:var(--color-text-muted);font-size:0.8rem;text-align:center;padding:var(--space-3);">No activity yet</div>';
      } else {
        feed.innerHTML = activity.map(a => {
          const time = new Date(a.ts).toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
          const typeLabel = a.type === 'trade' ? 'TRADE'
            : a.type === 'error' ? 'ERROR'
            : a.type === 'success' ? 'OK'
            : a.type === 'command' ? 'CMD'
            : a.type === 'warning' ? 'WARN'
            : a.type === 'learn' ? 'AI'
            : a.type === 'config' ? 'CFG'
            : a.type === 'skip' ? 'SKIP'
            : a.type === 'info' ? 'INFO'
            : a.type.toUpperCase().substring(0, 4);
          return `<div class="mc-activity-item" data-type="${escapeHtml(a.type)}">
            <span class="mc-activity-dot"></span>
            <span class="mc-activity-ts">${time}</span>
            <span class="mc-activity-agent">${escapeHtml(a.agent)}</span>
            <span style="font-size:0.6rem;font-weight:700;opacity:0.5;min-width:30px;text-transform:uppercase;">${typeLabel}</span>
            <span class="mc-activity-msg">${escapeHtml(a.message)}</span>
          </div>`;
        }).join('');
      }
    }
  }

  let mcProfilesCache = null, mcProfilesCacheTs = 0;
  let mcAllAgents = {};
  let mcCurrentFilter = 'system';

  function filterAgents(filter) {
    mcCurrentFilter = filter;
    // Update tab active state
    document.querySelectorAll('.mc-filter-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    const grid = document.getElementById('mc-agents-grid');
    if (!grid) return;

    const filtered = {};
    for (const [key, agent] of Object.entries(mcAllAgents)) {
      const isToken = agent.tokenAgent || agent.symbol;
      if (filter === 'system' && !isToken) filtered[key] = agent;
      else if (filter === 'token' && isToken) filtered[key] = agent;
      else if (filter === 'all') filtered[key] = agent;
    }
    renderAgentCards(grid, filtered);
  }

  function renderAgentCards(grid, agents) {
    const entries = Object.entries(agents);
    let html = entries.map(([key, a]) => {
      const st = a.paused ? 'paused' : a.state;
      const cardClass = st === 'running' ? 'mc-card-running' : st === 'error' ? 'mc-card-error' : a.paused ? 'mc-card-paused' : '';
      const lastRun = a.lastRunAt ? formatTimeAgo(a.lastRunAt) : 'never';
      const taskHtml = a.currentTask
        ? `<div class="mc-agent-task"><span class="mc-pulse"></span>${escapeHtml(a.currentTask.description)} (${formatTimeAgo(a.currentTask.startedAt)})</div>`
        : '';
      const errHtml = a.lastError
        ? `<div style="font-size:0.7rem;color:var(--color-danger);margin-bottom:4px;">Error: ${escapeHtml(a.lastError.message.substring(0, 80))}</div>`
        : '';

      // Profile data
      const profile = mcProfilesCache && mcProfilesCache[key] ? mcProfilesCache[key] : null;
      const desc = profile ? profile.description : '';
      const role = profile ? profile.role : '';
      const skills = profile ? (profile.skills || []) : [];
      const config = profile ? (profile.config || []) : [];

      // Skills HTML
      const skillsHtml = skills.length ? skills.map(s =>
        `<div class="mc-skill-row">
          <label class="mc-skill-toggle">
            <input type="checkbox" ${s.enabled ? 'checked' : ''} onchange="window.CryptoBot.mcToggleSkill('${key}','${s.id}',this.checked)">
            <span class="mc-skill-name">${escapeHtml(s.name)}</span>
          </label>
          <span class="mc-skill-desc">${escapeHtml(s.description)}</span>
        </div>`
      ).join('') : '';

      // Config HTML
      const configHtml = config.length ? config.map(c => {
        const inputType = c.type === 'number' ? 'number' : 'text';
        return `<div class="mc-config-row">
          <label class="mc-config-label">${escapeHtml(c.label)}</label>
          <input class="form-input text-mono mc-config-input" type="${inputType}" value="${escapeHtml(String(c.value))}"
            ${c.min !== undefined ? `min="${c.min}"` : ''} ${c.max !== undefined ? `max="${c.max}"` : ''}
            data-agent="${key}" data-key="${c.key}" onchange="window.CryptoBot.mcUpdateConfig('${key}','${c.key}',this.value)">
        </div>`;
      }).join('') : '';

      const isCustom = a.custom;

      return `<div class="mc-agent-card ${cardClass}">
        <div class="mc-agent-header" onclick="this.parentElement.classList.toggle('mc-expanded')" style="cursor:pointer;">
          <div>
            <span class="mc-agent-name">${escapeHtml(a.name)}</span>
            ${role ? `<span style="font-size:0.7rem;color:var(--color-text-muted);margin-left:6px;">${escapeHtml(role)}</span>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="mc-badge mc-badge-${st}">${st}</span>
            <span style="font-size:0.7rem;color:var(--color-text-muted);transition:transform 0.2s;" class="mc-expand-arrow">&#9662;</span>
          </div>
        </div>
        ${desc ? `<div style="font-size:0.75rem;color:var(--color-text-muted);margin-bottom:6px;">${escapeHtml(desc)}</div>` : ''}
        ${taskHtml}${errHtml}
        <div class="mc-agent-meta">
          <span class="mc-meta-label">Runs:</span><span>${a.runCount}</span>
          <span class="mc-meta-label">Last run:</span><span>${lastRun}</span>
        </div>
        <div class="mc-agent-actions">
          ${a.paused
            ? `<button class="btn btn-sm" style="background:var(--color-success);color:#000;" onclick="event.stopPropagation();window.CryptoBot.mcCommand('resume-agent',{agent:'${key}'})">Resume</button>`
            : `<button class="btn btn-sm" style="background:var(--color-warning);color:#000;" onclick="event.stopPropagation();window.CryptoBot.mcCommand('pause-agent',{agent:'${key}'})">Pause</button>`
          }
          ${st === 'error' ? `<button class="btn btn-sm" style="border:1px solid var(--color-accent);color:var(--color-accent);" onclick="event.stopPropagation();window.CryptoBot.mcCommand('reset-agent',{agent:'${key}'})">Reset</button>` : ''}
          ${isCustom ? `<button class="btn btn-sm" style="border:1px solid var(--color-danger);color:var(--color-danger);" onclick="event.stopPropagation();window.CryptoBot.mcRemoveAgent('${key}')">Remove</button>` : ''}
        </div>
        <div class="mc-profile-panel">
          ${skills.length ? `<div class="mc-profile-section"><div class="mc-profile-section-title">Skills</div>${skillsHtml}</div>` : ''}
          ${config.length ? `<div class="mc-profile-section"><div class="mc-profile-section-title">Config</div>${configHtml}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    // Add Agent button
    html += `<div class="mc-agent-card mc-add-card" onclick="document.getElementById('mc-add-agent-form').classList.toggle('hidden')" style="cursor:pointer;display:flex;align-items:center;justify-content:center;min-height:120px;border-style:dashed;">
      <div style="text-align:center;">
        <div style="font-size:1.5rem;color:var(--color-accent);margin-bottom:4px;">+</div>
        <div style="font-size:0.8rem;color:var(--color-text-muted);">Add Watcher Agent</div>
      </div>
    </div>`;

    // Add Agent form (hidden)
    html += `<div id="mc-add-agent-form" class="hidden mc-agent-card" style="grid-column:1/-1;">
      <div style="font-weight:600;margin-bottom:var(--space-2);color:var(--color-text);">Create Watcher Agent</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-2);margin-bottom:var(--space-2);">
        <div class="form-group" style="margin:0;">
          <label class="form-label" style="font-size:0.75rem;">Name</label>
          <input class="form-input" type="text" id="mc-new-agent-name" placeholder="e.g. BTC Watcher">
        </div>
        <div class="form-group" style="margin:0;">
          <label class="form-label" style="font-size:0.75rem;">Symbols (comma-separated)</label>
          <input class="form-input text-mono" type="text" id="mc-new-agent-symbols" placeholder="BTCUSDT,ETHUSDT" style="text-transform:uppercase;">
        </div>
        <div class="form-group" style="margin:0;">
          <label class="form-label" style="font-size:0.75rem;">Alert Threshold %</label>
          <input class="form-input text-mono" type="number" id="mc-new-agent-threshold" value="3" min="0.5" max="20" step="0.5">
        </div>
        <div class="form-group" style="margin:0;">
          <label class="form-label" style="font-size:0.75rem;">Description</label>
          <input class="form-input" type="text" id="mc-new-agent-desc" placeholder="What does this agent watch?">
        </div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="window.CryptoBot.mcCreateAgent()">Create Agent</button>
    </div>`;

    grid.innerHTML = html;
  }

  async function mcToggleSkill(agentKey, skillId, enabled) {
    try {
      await api('PUT', `/api/admin/agents/profiles/${agentKey}/skill`, { skillId, enabled });
      showToast(`Skill ${enabled ? 'enabled' : 'disabled'}`, 'success');
      mcProfilesCache = null;
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function mcUpdateConfig(agentKey, key, value) {
    try {
      const numVal = parseFloat(value);
      await api('PUT', `/api/admin/agents/profiles/${agentKey}/config`, { [key]: isNaN(numVal) ? value : numVal });
      showToast('Config updated', 'success');
      mcProfilesCache = null;
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function mcCreateAgent() {
    const name = document.getElementById('mc-new-agent-name')?.value?.trim();
    const symbols = document.getElementById('mc-new-agent-symbols')?.value?.trim();
    const threshold = document.getElementById('mc-new-agent-threshold')?.value;
    const desc = document.getElementById('mc-new-agent-desc')?.value?.trim();
    if (!name) { showToast('Name is required', 'error'); return; }
    try {
      await api('POST', '/api/admin/agents/create', { name, symbols, alertThreshold: threshold, description: desc });
      showToast(`Agent "${name}" created`, 'success');
      mcProfilesCache = null;
      document.getElementById('mc-add-agent-form')?.classList.add('hidden');
      mcRefresh();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function mcRemoveAgent(key) {
    if (!confirm(`Remove agent "${key}"?`)) return;
    try {
      await api('DELETE', `/api/admin/agents/${key}`);
      showToast('Agent removed', 'success');
      mcProfilesCache = null;
      mcRefresh();
    } catch (err) { showToast(err.message, 'error'); }
  }

  function formatTimeAgo(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
    return `${Math.round(diff / 86400000)}d ago`;
  }

  function mcChatQuick(text) {
    const input = document.getElementById('mc-chat-input');
    if (input) input.value = text;
    mcChat();
  }

  function mcChatAddMessage(from, text, isCeo) {
    const container = document.getElementById('mc-chat-messages');
    if (!container) return;
    const msg = document.createElement('div');
    msg.className = `mc-chat-msg ${isCeo ? 'mc-chat-ceo' : 'mc-chat-agent'}`;
    // Format **bold** in agent messages
    const formatted = escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    msg.innerHTML = `<span class="mc-chat-from">${escapeHtml(from)}</span><span class="mc-chat-text">${formatted}</span>`;
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
  }

  async function mcChat() {
    const input = document.getElementById('mc-chat-input');
    if (!input || !input.value.trim()) return;
    const message = input.value.trim();
    input.value = '';

    mcChatAddMessage('You', message, true);

    try {
      const reply = await api('POST', '/api/admin/agents/chat', { message });
      mcChatAddMessage(reply.from || 'Coordinator', reply.message || 'Done.', false);
      setTimeout(mcRefresh, 800);
    } catch (err) {
      mcChatAddMessage('System', `Error: ${err.message}`, false);
    }
  }

  let _allTokenSymbols = [];

  async function loadSignalBoard() {
    try {
      const data = await api('GET', '/api/dashboard/signal-board');
      const board = document.getElementById('signal-board');
      const results = document.getElementById('daily-results');
      const countEl = document.getElementById('watch-count');
      if (!board) return;

      const tokens = data.tokens || [];
      _allTokenSymbols = tokens.map(t => t.symbol);
      const activeCount = tokens.filter(t => t.watching).length;
      if (countEl) countEl.textContent = `(${activeCount} active)`;

      if (!tokens.length) {
        board.innerHTML = '<div style="color:var(--color-text-muted);font-size:0.8rem;grid-column:1/-1;text-align:center;">Loading top 50 tokens...</div>';
      } else {
        board.innerHTML = tokens.map(t => {
          const coin = t.symbol.replace('USDT', '');
          const on = t.watching;
          const dir = t.direction;
          const chg = t.change24h || 0;
          const chgColor = chg >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
          const signalDot = dir === 'LONG' ? '<span style="color:var(--color-success);font-size:0.65rem;">LONG</span>'
            : dir === 'SHORT' ? '<span style="color:var(--color-danger);font-size:0.65rem;">SHORT</span>'
            : '';
          const riskTag = t.riskTag;
          const riskBadge = riskTag === 'low' ? '<span class="risk-badge risk-low">Low</span>'
            : riskTag === 'medium' ? '<span class="risk-badge risk-med">Med</span>'
            : riskTag === 'high' ? '<span class="risk-badge risk-high">High</span>'
            : riskTag === 'popular' ? '<span class="risk-badge risk-pop">Hot</span>'
            : '';

          const dirClass = dir ? (dir === 'LONG' ? 'signal-long' : 'signal-short') : (on ? '' : 'signal-none');
          return `<div class="signal-card ${dirClass} ${on ? 'signal-watching' : ''}" style="position:relative;">
            ${riskBadge}
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span class="signal-card-sym">${coin}</span>
              <label class="token-switch">
                <input type="checkbox" ${on ? 'checked' : ''} onchange="window.CryptoBot.toggleWatch('${t.symbol}',this.checked)">
                <span class="token-slider"></span>
              </label>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px;">
              <span style="font-size:0.7rem;color:${chgColor};">${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%</span>
              ${signalDot}
            </div>
            ${on ? `<input type="number" class="form-input text-mono" value="${t.userLeverage || 20}" min="1" max="125" style="width:100%;font-size:0.68rem;padding:2px 4px;margin-top:3px;text-align:center;" onchange="window.CryptoBot.setUserLeverage('${t.symbol}',this.value)" title="Your leverage">` : ''}
          </div>`;
        }).join('');
      }

      // Daily results
      if (results && data.dailyResults?.length) {
        results.innerHTML = '<div style="background:var(--color-bg-raised);border:1px solid var(--color-border-muted);border-radius:var(--radius-md);overflow:hidden;">' +
          data.dailyResults.map(r => {
            const pnl = parseFloat(r.total_pnl) || 0;
            const coin = r.symbol.replace('USDT', '');
            return `<div class="daily-result-row">
              <span style="font-weight:600;min-width:60px;">${coin}</span>
              <span style="font-size:0.75rem;color:var(--color-text-muted);">${r.wins}W/${r.losses}L</span>
              <span style="font-weight:600;color:${pnl >= 0 ? 'var(--color-success)' : 'var(--color-danger)'};">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</span>
            </div>`;
          }).join('') + '</div>';
      } else if (results) {
        results.innerHTML = '<div style="color:var(--color-text-muted);font-size:0.8rem;text-align:center;padding:var(--space-2);">No results yet today</div>';
      }
    } catch (err) {
      const board = document.getElementById('signal-board');
      if (board) board.innerHTML = `<div style="color:var(--color-text-muted);font-size:0.8rem;grid-column:1/-1;">${err.message}</div>`;
    }
  }

  async function toggleWatch(symbol, enable) {
    try {
      if (enable) {
        await api('POST', '/api/dashboard/watchlist', { symbol });
      } else {
        await api('DELETE', `/api/dashboard/watchlist/${symbol}`);
      }
      loadSignalBoard();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function setUserLeverage(symbol, leverage) {
    try {
      await api('PUT', `/api/dashboard/watchlist/${symbol}/leverage`, { leverage: parseInt(leverage) });
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function watchAll(enable) {
    try {
      if (!_allTokenSymbols.length) await loadSignalBoard();
      await api('POST', '/api/dashboard/watchlist/bulk', { symbols: _allTokenSymbols, enabled: enable });
      showToast(enable ? 'All tokens ON' : 'All tokens OFF', 'success');
      loadSignalBoard();
    } catch (err) { showToast(err.message, 'error'); }
  }

  // ── Admin Token Board ─────────────────────────────────
  async function adminLoadTokenBoard() {
    try {
      const tokens = await api('GET', '/api/admin/token-board');
      const tbody = document.getElementById('admin-board-tbody');
      const empty = document.getElementById('admin-board-empty');
      if (!tbody) return;
      if (!tokens.length) { tbody.innerHTML = ''; if (empty) empty.style.display = ''; return; }
      const activeCount = tokens.filter(t => !t.banned).length;
      const withSignal = tokens.filter(t => t.signal).length;
      const withAgent = tokens.filter(t => t.hasAgent).length;
      const statsEl = document.getElementById('admin-board-stats');
      if (statsEl) statsEl.textContent = `${activeCount} active / ${tokens.length} total | ${withAgent} agents | ${withSignal} signals`;

      tbody.innerHTML = tokens.map(t => {
        const price = t.price || 0;
        const chg = t.change24h || 0;
        const vol = t.volume || 0;
        const chgColor = chg >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
        const fmtPrice = price >= 1000 ? '$' + price.toLocaleString('en-US',{maximumFractionDigits:2}) : price >= 1 ? '$' + price.toFixed(2) : price > 0 ? '$' + price.toFixed(6) : '--';
        const fmtVol = vol >= 1e9 ? (vol/1e9).toFixed(1) + 'B' : vol >= 1e6 ? (vol/1e6).toFixed(0) + 'M' : vol >= 1e3 ? (vol/1e3).toFixed(0) + 'K' : '--';

        // Signal indicator
        let signalHtml = '';
        if (t.signal === 'LONG') signalHtml = '<span style="color:var(--color-success);font-weight:700;font-size:0.72rem;">LONG</span>';
        else if (t.signal === 'SHORT') signalHtml = '<span style="color:var(--color-danger);font-weight:700;font-size:0.72rem;">SHORT</span>';
        else if (t.hasAgent) signalHtml = '<span style="color:var(--color-text-muted);font-size:0.65rem;">watching</span>';
        else signalHtml = '<span style="color:var(--color-border);font-size:0.65rem;">--</span>';

        // Structure label
        const struct = t.structure;
        const structTip = struct ? `15m:${struct.tf15m||'?'} 3m:${struct.tf3m||'?'} 1m:${struct.tf1m||'?'}` : '';

        return `<tr${t.banned ? ' style="opacity:0.4;"' : ''}>
          <td title="${structTip}">${signalHtml}</td>
          <td><strong style="font-size:0.8rem;">${escapeHtml(t.symbol.replace('USDT',''))}</strong></td>
          <td class="text-mono" style="font-size:0.75rem;">${fmtPrice}</td>
          <td style="font-size:0.75rem;color:${chgColor};font-weight:600;">${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%</td>
          <td style="font-size:0.72rem;color:var(--color-text-muted);">${fmtVol}</td>
          <td>
            <select class="form-input" style="font-size:0.7rem;padding:1px 3px;width:70px;" onchange="window.CryptoBot.adminSetRiskTag('${t.symbol}',this.value)">
              <option value="" ${!t.risk_tag ? 'selected' : ''}>-</option>
              <option value="popular" ${t.risk_tag === 'popular' ? 'selected' : ''}>Hot</option>
              <option value="low" ${t.risk_tag === 'low' ? 'selected' : ''}>Low</option>
              <option value="medium" ${t.risk_tag === 'medium' ? 'selected' : ''}>Med</option>
              <option value="high" ${t.risk_tag === 'high' ? 'selected' : ''}>High</option>
            </select>
          </td>
          <td><input class="form-input text-mono" type="number" value="${t.leverage || 20}" min="1" max="125" style="width:46px;font-size:0.7rem;padding:1px 3px;" onchange="window.CryptoBot.adminSetTokenLev('${t.symbol}',this.value)"></td>
          <td>
            <label class="token-switch"><input type="checkbox" ${!t.banned ? 'checked' : ''} onchange="window.CryptoBot.adminToggleBan('${t.symbol}',!this.checked)"><span class="token-slider"></span></label>
          </td>
          <td><button style="font-size:0.6rem;color:var(--color-danger);background:none;border:none;cursor:pointer;padding:0;" onclick="window.CryptoBot.adminRemoveTokenBoard('${t.symbol}')">X</button></td>
        </tr>`;
      }).join('');
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminPopulateTop50() {
    try {
      showToast('Loading top 50 tokens...', 'info');
      const result = await api('POST', '/api/admin/token-board/populate-top50');
      showToast(`Done: ${result.added} active, ${result.banned} banned`, 'success');
      adminLoadTokenBoard();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminAddTokenBoard() {
    const sym = document.getElementById('admin-board-symbol')?.value?.trim().toUpperCase();
    const risk = document.getElementById('admin-board-risk')?.value || null;
    const lev = document.getElementById('admin-board-lev')?.value || 20;
    if (!sym) { showToast('Enter a symbol', 'error'); return; }
    const symbol = sym.endsWith('USDT') ? sym : sym + 'USDT';
    try {
      await api('POST', '/api/admin/token-board/add', { symbol, risk_tag: risk });
      await api('POST', '/api/admin/token-leverage', { symbol, leverage: parseInt(lev) }).catch(() => {});
      showToast(`${symbol} added`, 'success');
      document.getElementById('admin-board-symbol').value = '';
      adminLoadTokenBoard();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminSetRiskTag(symbol, tag) {
    try {
      await api('PUT', `/api/admin/token-board/${symbol}/risk`, { risk_tag: tag || null });
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminSetTokenLev(symbol, lev) {
    try {
      await api('POST', '/api/admin/token-leverage', { symbol, leverage: parseInt(lev) });
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminToggleBan(symbol, banned) {
    try {
      if (banned) {
        await api('POST', '/api/admin/global-tokens', { symbol, type: 'ban' });
      } else {
        await api('POST', '/api/admin/remove-global-token', { symbol, list: 'banned' }).catch(() =>
          api('DELETE', `/api/admin/global-tokens/${symbol}`).catch(() => {})
        );
      }
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminRemoveTokenBoard(symbol) {
    try {
      await api('DELETE', `/api/admin/token-board/${symbol}`);
      adminLoadTokenBoard();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function customerChat() {
    const input = document.getElementById('chatbot-input');
    const container = document.getElementById('chatbot-messages');
    if (!input || !container || !input.value.trim()) return;
    const msg = input.value.trim();
    input.value = '';
    // Add user message
    const userEl = document.createElement('div');
    userEl.className = 'chatbot-msg chatbot-user';
    userEl.innerHTML = `<span>${escapeHtml(msg)}</span>`;
    container.appendChild(userEl);
    container.scrollTop = container.scrollHeight;
    // Fetch reply
    try {
      const res = await fetch('/api/chatbot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      const data = await res.json();
      const botEl = document.createElement('div');
      botEl.className = 'chatbot-msg chatbot-bot';
      botEl.innerHTML = `<span>${escapeHtml(data.reply || 'Sorry, try again.').replace(/\n/g, '<br>')}</span>`;
      container.appendChild(botEl);
    } catch {
      const errEl = document.createElement('div');
      errEl.className = 'chatbot-msg chatbot-bot';
      errEl.innerHTML = '<span>Sorry, I\'m having trouble. Try again later.</span>';
      container.appendChild(errEl);
    }
    container.scrollTop = container.scrollHeight;
  }

  async function mcCommand(command, params) {
    try {
      const result = await api('POST', '/api/admin/agents/command', { command, params });
      if (result.ok === false && result.error) {
        showToast(result.error, 'error');
      } else {
        showToast(`Command "${command}" sent`, 'success');
      }
      setTimeout(mcRefresh, 500);
    } catch (err) {
      showToast(`Command failed: ${err.message}`, 'error');
    }
  }

  async function saveAdminSettings() {
    try {
      await api('PUT', '/api/admin/settings', {
        referral_commission_pct: $('#admin-referral-pct').value,
        commission_tier1: $('#admin-tier1').value,
        commission_tier2: $('#admin-tier2').value,
        commission_tier3: $('#admin-tier3').value,
        platform_usdt_address: $('#admin-usdt-addr').value.trim(),
        platform_usdt_network: $('#admin-usdt-net').value,
        bscscan_api_key: $('#admin-bscscan-key').value.trim(),
      });
      showToast('Settings saved', 'success');
    } catch (err) { showToast(err.message, 'error'); }
  }

  // ----- Risk Level Management (Admin) -----

  async function loadRiskLevels() {
    try {
      const levels = await api('GET', '/api/admin/risk-levels');
      const container = $('#admin-risk-levels');
      if (!container) return;
      if (!levels.length) {
        container.innerHTML = '<div style="color:var(--color-text-muted);font-size:0.85rem;text-align:center;padding:var(--space-3);">No risk levels configured. Add one below.</div>';
        return;
      }
      const tp = (v) => (parseFloat(v)*100).toFixed(1);
      const sl = (v) => (parseFloat(v)*100).toFixed(1);
      container.innerHTML = levels.map(rl => {
        const id = rl.id;
        return `<div style="background:var(--color-bg);border:1px solid var(--color-border-muted);border-radius:var(--radius-md);padding:var(--space-3);margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
          <div>
            <strong style="font-size:0.9rem;">${escapeHtml(rl.name)}</strong>
            <span style="font-size:0.75rem;color:var(--color-text-muted);margin-left:8px;">${escapeHtml(rl.description || '')}</span>
          </div>
          <div style="display:flex;gap:4px;">
            <button class="btn btn-primary btn-sm" style="font-size:0.7rem;" onclick="window.CryptoBot.saveRiskLevel(${id})">Save</button>
            <button class="btn btn-danger btn-sm" style="font-size:0.7rem;" onclick="window.CryptoBot.deleteRiskLevel(${id})">Delete</button>
          </div>
        </div>
        <div class="settings-grid">
          <div class="slider-group">
            <div class="slider-header">
              <label class="form-label">TP %</label>
              <input type="number" class="slider-num" id="rle-tp-num-${id}" min="0.1" max="20" step="0.1" value="${tp(rl.tp_pct)}"
                oninput="window.CryptoBot.syncSlider('rle-tp-range-${id}',Math.round(this.value*10))">
            </div>
            <input type="range" id="rle-tp-range-${id}" min="1" max="200" value="${Math.round(parseFloat(rl.tp_pct)*1000)}"
              oninput="window.CryptoBot.syncNum('rle-tp-num-${id}',(this.value/10).toFixed(1))">
          </div>
          <div class="slider-group">
            <div class="slider-header">
              <label class="form-label">SL %</label>
              <input type="number" class="slider-num" id="rle-sl-num-${id}" min="0.1" max="10" step="0.1" value="${sl(rl.sl_pct)}"
                oninput="window.CryptoBot.syncSlider('rle-sl-range-${id}',Math.round(this.value*10))">
            </div>
            <input type="range" id="rle-sl-range-${id}" min="1" max="100" value="${Math.round(parseFloat(rl.sl_pct)*1000)}"
              oninput="window.CryptoBot.syncNum('rle-sl-num-${id}',(this.value/10).toFixed(1))">
          </div>
          <div class="slider-group">
            <div class="slider-header">
              <label class="form-label">Capital %</label>
              <input type="number" class="slider-num" id="rle-cap-num-${id}" min="1" max="50" step="1" value="${parseFloat(rl.capital_percentage)}"
                oninput="window.CryptoBot.syncSlider('rle-cap-range-${id}',this.value)">
            </div>
            <input type="range" id="rle-cap-range-${id}" min="1" max="50" value="${parseFloat(rl.capital_percentage)}"
              oninput="window.CryptoBot.syncNum('rle-cap-num-${id}',this.value)">
          </div>
          <div class="slider-group">
            <div class="slider-header">
              <label class="form-label">Max Leverage</label>
              <input type="number" class="slider-num" id="rle-lev-num-${id}" min="1" max="125" step="1" value="${rl.max_leverage}"
                oninput="window.CryptoBot.syncSlider('rle-lev-range-${id}',this.value)">
            </div>
            <input type="range" id="rle-lev-range-${id}" min="1" max="125" value="${rl.max_leverage}"
              oninput="window.CryptoBot.syncNum('rle-lev-num-${id}',this.value)">
          </div>
          <div class="slider-group">
            <div class="slider-header">
              <label class="form-label">Max Consec Losses</label>
              <input type="number" class="slider-num" id="rle-consec-num-${id}" min="0" max="10" step="1" value="${rl.max_consec_loss}"
                oninput="window.CryptoBot.syncSlider('rle-consec-range-${id}',this.value)">
            </div>
            <input type="range" id="rle-consec-range-${id}" min="0" max="10" value="${rl.max_consec_loss}"
              oninput="window.CryptoBot.syncNum('rle-consec-num-${id}',this.value)">
          </div>
          <div class="slider-group">
            <div class="slider-header">
              <label class="form-label">Trailing SL Step %</label>
              <input type="number" class="slider-num" id="rle-trail-num-${id}" min="0.5" max="5" step="0.1" value="${parseFloat(rl.trailing_sl_step || 1.2).toFixed(1)}"
                oninput="window.CryptoBot.syncSlider('rle-trail-range-${id}',Math.round(this.value*10))">
            </div>
            <input type="range" id="rle-trail-range-${id}" min="5" max="50" value="${Math.round(parseFloat(rl.trailing_sl_step || 1.2)*10)}"
              oninput="window.CryptoBot.syncNum('rle-trail-num-${id}',(this.value/10).toFixed(1))">
          </div>
          <div class="slider-group">
            <div class="slider-header">
              <label class="form-label">Top Coins</label>
              <input type="number" class="slider-num" id="rle-top-num-${id}" min="5" max="200" step="5" value="${rl.top_n_coins || 50}"
                oninput="window.CryptoBot.syncSlider('rle-top-range-${id}',this.value)">
            </div>
            <input type="range" id="rle-top-range-${id}" min="5" max="200" step="5" value="${rl.top_n_coins || 50}"
              oninput="window.CryptoBot.syncNum('rle-top-num-${id}',this.value)">
          </div>
        </div>
      </div>`;
      }).join('');
    } catch (err) { /* silent */ }
  }

  async function addRiskLevel() {
    const name = ($('#rl-name').value || '').trim();
    if (!name) return showToast('Enter a risk level name', 'error');
    try {
      await api('POST', '/api/admin/risk-levels', {
        name,
        description: ($('#rl-desc').value || '').trim(),
        tp_pct: (parseFloat($('#rl-tp-num').value) || 1.0) / 100,
        sl_pct: (parseFloat($('#rl-sl-num').value) || 1.0) / 100,
        trailing_sl_step: parseFloat($('#rl-trail-num')?.value) || 1.2,
        capital_percentage: parseFloat($('#rl-capital-num').value) || 10,
        max_leverage: parseInt($('#rl-leverage-num').value) || 20,
        max_consec_loss: parseInt($('#rl-consec-num').value),
        top_n_coins: parseInt($('#rl-topcoins-num').value) || 50,
      });
      showToast(`${name} risk level added`, 'success');
      $('#rl-name').value = '';
      $('#rl-desc').value = '';
      loadRiskLevels();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function saveRiskLevel(id) {
    try {
      await api('PUT', `/api/admin/risk-levels/${id}`, {
        tp_pct: (parseFloat($(`#rle-tp-num-${id}`).value) || 1.0) / 100,
        sl_pct: (parseFloat($(`#rle-sl-num-${id}`).value) || 1.0) / 100,
        trailing_sl_step: parseFloat($(`#rle-trail-num-${id}`).value) || 1.2,
        capital_percentage: parseFloat($(`#rle-cap-num-${id}`).value) || 10,
        max_leverage: parseInt($(`#rle-lev-num-${id}`).value) || 20,
        max_consec_loss: parseInt($(`#rle-consec-num-${id}`).value),
        top_n_coins: parseInt($(`#rle-top-num-${id}`).value) || 50,
      });
      showToast('Risk level saved', 'success');
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function deleteRiskLevel(id) {
    if (!confirm('Delete this risk level? Keys using it will be unlinked.')) return;
    try {
      await api('DELETE', `/api/admin/risk-levels/${id}`);
      showToast('Risk level deleted', 'success');
      loadRiskLevels();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function fixBitunixPnl() {
    const resultEl = $('#fix-bitunix-result');
    if (resultEl) resultEl.textContent = 'Fixing...';
    try {
      const data = await api('POST', '/api/admin/fix-bitunix-pnl');
      const msg = `Fixed ${data.fixed} trades: ${(data.results || []).map(r => `${r.symbol} → ${r.status || 'ERROR'} $${(r.pnl || 0).toFixed(2)}`).join(', ')}`;
      if (resultEl) resultEl.textContent = msg;
      showToast(`Fixed ${data.fixed} trades`, 'success');
      loadAdmin();
    } catch (err) {
      if (resultEl) resultEl.textContent = err.message;
      showToast(err.message, 'error');
    }
  }

  async function loadAiVersions() {
    try {
      const data = await api('GET', '/api/admin/ai-versions');
      const sel = $('#bt-ai-version');
      if (!sel || !data.versions) return;
      sel.innerHTML = '<option value="">Manual Settings</option>';
      for (const v of data.versions) {
        const wr = v.win_rate ? (parseFloat(v.win_rate) * 100).toFixed(0) : '?';
        const pnl = v.total_pnl ? parseFloat(v.total_pnl).toFixed(1) : '?';
        const d = new Date(v.created_at);
        const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const desc = v.changes ? ` | ${v.changes}` : '';
        sel.innerHTML += `<option value='${v.id}' data-params='${escapeHtml(JSON.stringify(v.params))}'>${v.version} [${date}] — ${v.trade_count || 0} trades, ${wr}% WR, ${pnl}% PnL${desc}</option>`;
      }
      sel.onchange = function() {
        const opt = sel.options[sel.selectedIndex];
        const raw = opt?.getAttribute('data-params');
        if (!raw) return;
        try {
          const p = JSON.parse(raw);
          if (p.sl_pct != null) $('#bt-sl').value = (parseFloat(p.sl_pct) * 100).toFixed(1);
          if (p.tp_pct != null) $('#bt-tp').value = (parseFloat(p.tp_pct) * 100).toFixed(1);
          if (p.trailing_step != null) $('#bt-trail').value = (parseFloat(p.trailing_step) * 100).toFixed(1);
          if (p.leverage != null) $('#bt-leverage').value = parseInt(p.leverage);
          if (p.risk_pct != null) $('#bt-risk').value = (parseFloat(p.risk_pct) * 100).toFixed(0);
          if (p.max_positions != null) $('#bt-maxpos').value = parseInt(p.max_positions);
          if (p.max_consec_loss != null) $('#bt-consec').value = parseInt(p.max_consec_loss);
          if (p.top_n_coins != null) $('#bt-topn').value = parseInt(p.top_n_coins);
        } catch {}
      };
      showToast(`Loaded ${data.versions.length} AI versions`, 'success');
    } catch (err) {
      showToast('Failed to load AI versions: ' + err.message, 'error');
    }
  }

  async function runBacktest(mode, reverse) {
    const days = parseInt($('#backtest-days')?.value) || 7;
    const slPct = parseFloat($('#bt-sl')?.value) || 3;
    const tpPct = parseFloat($('#bt-tp')?.value) || 0;
    const trailStep = parseFloat($('#bt-trail')?.value) || 1.2;
    const leverage = parseInt($('#bt-leverage')?.value) || 20;
    const riskPct = parseInt($('#bt-risk')?.value) || 10;
    const maxPositions = parseInt($('#bt-maxpos')?.value) || 3;
    const maxConsecLoss = parseInt($('#bt-consec')?.value) ?? 2;
    const wallet = parseInt($('#bt-wallet')?.value) || 1000;
    const topN = parseInt($('#bt-topn')?.value) || 100;

    const tag = (reverse ? 'REVERSE ' : '') + `${days}d SL:${slPct}% TP:${tpPct}% Trail:${trailStep}% Lev:${leverage}x`;
    const resultEl = $('#fix-bitunix-result');
    if (resultEl) resultEl.textContent = `Running ${tag} backtest (${topN} coins)... please wait`;
    try {
      const data = await api('POST', '/api/admin/backtest', {
        strategy: 'full', topN, days, reverse,
        slPct: slPct / 100,
        tpPct: tpPct / 100,
        trailStep: trailStep / 100,
        leverage, riskPct: riskPct / 100,
        maxPositions, maxConsecLoss, wallet,
      });
      const s = data.strategy;
      let output = '═══════════════════════════════════════════════\n';
      output += `  BACKTEST: ${s.label}\n`;
      output += '═══════════════════════════════════════════════\n';
      output += `Period:   ${data.period} | Coins: ${data.coinsScanned}\n`;
      const dpStr = Object.entries(data.dataPoints).map(([k, v]) => `${k}=${v}`).join(' ');
      output += `Data:     ${dpStr}\n`;
      output += `Wallet:   $${s.startWallet} → $${s.finalWallet}\n`;
      output += `P&L:      ${s.totalPnl >= 0 ? '+' : ''}$${s.totalPnl} (${s.totalPnlPct}%)\n`;
      output += `Trades:   ${s.totalTrades}  |  Win: ${s.wins}  Loss: ${s.losses}  |  WR: ${s.winRate}%\n`;
      output += `Avg Win:  +$${s.avgWin}  |  Avg Loss: $${s.avgLoss}  |  Max DD: ${s.maxDrawdown}%\n`;
      output += '═══════════════════════════════════════════════\n\n';

      // Daily trade count breakdown
      const dailyCounts = {};
      for (const t of s.trades) {
        const day = t.date.slice(0, 10);
        dailyCounts[day] = (dailyCounts[day] || 0) + 1;
      }
      output += '─── Daily Trades ──────────────────────────────\n';
      for (const [day, cnt] of Object.entries(dailyCounts)) {
        const dayTrades = s.trades.filter(t => t.date.startsWith(day));
        const dayWins = dayTrades.filter(t => parseFloat(t.pnl) > 0).length;
        const dayPnl = dayTrades.reduce((s, t) => s + parseFloat(t.pnl), 0);
        output += `${day} | ${cnt} trades (${dayWins}W/${cnt-dayWins}L) | ${dayPnl >= 0 ? '+' : ''}$${dayPnl.toFixed(2)}\n`;
      }
      output += '\n';

      if (s.trades.length) {
        output += 'Date             | Symbol        | Dir   | Entry     | Exit      | P&L      | Exit\n';
        output += '─'.repeat(90) + '\n';
        for (const t of s.trades) {
          const pnl = parseFloat(t.pnl);
          output += `${t.date} | ${t.symbol.padEnd(13)} | ${t.dir.padEnd(5)} | ${t.entry.padStart(9)} | ${t.exit.padStart(9)} | ${(pnl >= 0 ? '+' : '') + '$' + t.pnl} | ${t.reason}\n`;
        }
      }
      if (resultEl) resultEl.textContent = output;
    } catch (err) {
      if (resultEl) resultEl.textContent = 'Error: ' + err.message;
    }
  }

  async function runAiOptimize() {
    const days = parseInt($('#backtest-days')?.value) || 7;
    const resultEl = $('#fix-bitunix-result');
    if (resultEl) resultEl.textContent = '⚛️ Starting Quantum AI Optimizer...\n';

    try {
      // Stream NDJSON — read lines as they arrive, 10 min timeout
      const abortCtrl = new AbortController();
      const abortTimer = setTimeout(() => abortCtrl.abort(), 600000);
      const resp = await fetch('/api/admin/ai-optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ days, maxTokens: parseInt($('#bt-max-tokens')?.value) || 50 }),
        signal: abortCtrl.signal,
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(errText || `HTTP ${resp.status}`);
      }

      let logs = '⚛️ QUANTUM AI OPTIMIZER — LIVE LOG\n';
      let finalData = null;

      function processLine(line) {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'ping') return;
          if (msg.type === 'log') {
            logs += msg.message + '\n';
            if (resultEl) { resultEl.textContent = logs; resultEl.scrollTop = resultEl.scrollHeight; }
          } else if (msg.type === 'progress') {
            logs += `  [${msg.phase}] ${msg.pct}%\n`;
            if (resultEl) { resultEl.textContent = logs; resultEl.scrollTop = resultEl.scrollHeight; }
          } else if (msg.type === 'result') {
            finalData = msg;
          } else if (msg.type === 'error') {
            logs += '\nERROR: ' + msg.error + '\n';
            if (resultEl) resultEl.textContent = logs;
          }
        } catch {}
      }

      // Try streaming with ReadableStream, fall back to full-text read
      if (resp.body && resp.body.getReader) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) processLine(line);
        }
        if (buffer.trim()) processLine(buffer);
      } else {
        // Fallback: read entire response then parse lines
        const text = await resp.text();
        for (const line of text.split('\n')) processLine(line);
      }

      if (!finalData) { if (resultEl) resultEl.textContent = logs + '\nNo results received.'; return; }

      // Build final output from result data
      const data = finalData;
      const R = data.results || [];
      let output = '═══════════════════════════════════════════════════════════════════════════════════════════════════════\n';
      output += '  ⚛️🧠 QUANTUM-INSPIRED AI OPTIMIZATION (Strategy Only)\n';
      output += `  Period: ${data.period} | Tokens: ${data.coinsScanned} (admin-allowed)${data.cachedData ? ' [CACHED]' : ''}\n`;
      output += `  Parameters: ${data.paramsSearched||13} strategy params (risk is user-set)\n`;
      output += `  Round 1: ${data.round1Combos} strategy presets\n`;
      output += `  Round 2: ${data.round2Genetic} genetic offspring\n`;
      const qs = data.quantumStats || {};
      output += `  Round 3: ${data.round3Quantum||0} quantum — QAOA:${qs.qaoaCount||0} SPSA:${qs.spsaCount||0} Anneal:${qs.annealCount||0}\n`;
      output += `  Total: ${data.totalCombos} combinations tested ⚛️\n`;
      if (data.riskNote) output += `  ℹ️ ${data.riskNote}\n`;
      output += '═══════════════════════════════════════════════════════════════════════════════════════════════════════\n\n';

      // ── Top 10 Overall ──
      output += '── TOP 10 BEST STRATEGIES ────────────────────────────────────────────────────────────────────────\n';
      output += '#   | Strategy       | Trades |  W / L  | WR%    | P&L        | MaxDD  | Strategy Params\n';
      output += '─'.repeat(120) + '\n';
      for (let i = 0; i < Math.min(10, R.length); i++) {
        const r = R[i], s = r.settings || {};
        const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`#${i+1}`;
        const pnl = (r.totalPnl>=0?'+':'')+`$${r.totalPnl.toFixed(2)}`;
        const htf = s.requireBothHTF!==undefined ? (s.requireBothHTF?'both':'either') : '?';
        const kl = s.requireKeyLevel!==undefined ? (s.requireKeyLevel?'Y':'N') : '?';
        const c1m = s.require1m!==undefined ? (s.require1m?'Y':'N') : '?';
        const c15 = s.require15m!==undefined ? (s.require15m?'Y':'N') : '?';
        const vol = s.requireVolSpike!==undefined ? (s.requireVolSpike?`${(s.volSpikeMultiplier||1.5).toFixed(1)}x`:'N') : '?';
        const stratStr = `sw:${s.swingLen4h||10}/${s.swingLen1h||10}/${s.swingLen15m||10}/${s.swingLen1m||5} HTF:${htf} KL:${kl} 15m:${c15} 1m:${c1m} Vol:${vol}`;
        output += `${String(medal).padEnd(4)}| ${(r.combo||'').padEnd(15)}| ${String(r.trades).padStart(6)} | ${String(r.wins+'W/'+r.losses+'L').padEnd(7)} | ${String(r.winRate+'%').padStart(6)} | ${pnl.padStart(10)} | ${String(r.maxDrawdown+'%').padStart(5)}  | ${stratStr}\n`;
      }

      // ── Per-token scores ──
      const tokens = data.tokenScores || [];
      if (tokens.length) {
        output += '\n── TOKEN SCORES (Best Strategy Applied) ──────────────────────────────────────────\n';
        output += `  ${data.tokenSummary || ''}\n\n`;
        output += 'Symbol          | Rating    | Trades | W / L   | WR%    | P&L\n';
        output += '─'.repeat(80) + '\n';
        for (const t of tokens) {
          const icon = t.rating==='Good'?'✅':t.rating==='OK'?'⚠️':t.rating==='Bad'?'❌':'⬜';
          const pnl = t.trades > 0 ? ((t.totalPnl>=0?'+':'')+`$${t.totalPnl.toFixed(2)}`) : '--';
          const wl = t.trades > 0 ? `${t.wins}W/${t.losses}L` : '--';
          const wr = t.trades > 0 ? `${t.winRate}%` : '--';
          output += `${icon} ${t.symbol.padEnd(14)}| ${t.rating.padEnd(10)}| ${String(t.trades).padStart(6)} | ${wl.padEnd(7)} | ${wr.padStart(6)} | ${pnl}\n`;
        }
        const badList = tokens.filter(t => t.rating === 'Bad' || t.rating === 'No Trades');
        if (badList.length) {
          output += `\n  💡 Consider removing: ${badList.map(t=>t.symbol).join(', ')}\n`;
        }
      }

      // ── Strategy leaderboard ──
      output += '\n── STRATEGY LEADERBOARD ──────────────────────────────────────────────────────────\n';
      const strats = [...new Set(R.map(r=>r.strategy))];
      for (const strat of strats) {
        const stratResults = R.filter(r=>r.strategy===strat);
        const best = stratResults[0];
        if (!best || best.trades === 0) continue;
        const pnl = (best.totalPnl>=0?'+':'')+`$${best.totalPnl.toFixed(2)}`;
        output += `  ${strat.padEnd(20)} | ${best.trades} trades | ${best.winRate}% WR | ${pnl}\n`;
      }

      // ── Saved versions ──
      if (data.saved && data.saved.length) {
        output += '\n── SAVED AS AI VERSIONS ───────────────────────────────────────────────────────────\n';
        for (const s of data.saved) {
          output += `  ${s.rank===1?'🥇':s.rank===2?'🥈':'🥉'} ${s.version} → ${s.combo}\n`;
        }
        output += '\n  ✅ Top 3 saved! Refresh the AI Version dropdown to load them.\n';
      }

      // Show live log + final results
      clearTimeout(abortTimer);
      if (resultEl) resultEl.textContent = logs + '\n' + output;
      loadAiVersions().catch(() => {});
    } catch (err) {
      if (typeof abortTimer !== 'undefined') clearTimeout(abortTimer);
      if (resultEl) resultEl.textContent += '\nError: ' + err.message;
    }
  }

  async function debugBitunix() {
    const resultEl = $('#fix-bitunix-result');
    if (resultEl) resultEl.textContent = 'Testing Bitunix API...';
    try {
      const data = await api('POST', '/api/admin/debug-bitunix');
      if (resultEl) resultEl.textContent = JSON.stringify(data, null, 2);
      console.log('Bitunix debug:', data);
    } catch (err) {
      if (resultEl) resultEl.textContent = 'Error: ' + err.message;
    }
  }

  // ----- Allowed / Banned Token Management (Admin) -----

  async function loadGlobalTokens() {
    try {
      const tokens = await api('GET', '/api/admin/global-tokens');
      const allowed = tokens.filter(t => t.enabled && !t.banned);
      const banned = tokens.filter(t => t.banned);

      const allowedCountEl = $('#allowed-count');
      const bannedCountEl = $('#banned-count');
      if (allowedCountEl) allowedCountEl.textContent = allowed.length;
      if (bannedCountEl) bannedCountEl.textContent = banned.length;

      const allowedBody = $('#admin-allowed-tbody');
      const allowedEmpty = $('#admin-allowed-empty');
      if (!allowed.length) {
        allowedBody.innerHTML = '';
        allowedEmpty.classList.remove('hidden');
      } else {
        allowedEmpty.classList.add('hidden');
        allowedBody.innerHTML = allowed.map(t => `<tr>
          <td class="text-mono"><strong>${escapeHtml(t.symbol)}</strong></td>
          <td><button class="btn btn-danger btn-sm" style="font-size:0.7rem;cursor:pointer;" data-remove-token="${escapeHtml(t.symbol)}">✕ Remove</button></td>
        </tr>`).join('');
        allowedBody.querySelectorAll('[data-remove-token]').forEach(btn => {
          btn.addEventListener('click', () => removeGlobalToken(btn.dataset.removeToken));
        });
      }

      const bannedBody = $('#admin-banned-tbody');
      const bannedEmpty = $('#admin-banned-empty');
      if (!banned.length) {
        bannedBody.innerHTML = '';
        bannedEmpty.classList.remove('hidden');
      } else {
        bannedEmpty.classList.add('hidden');
        bannedBody.innerHTML = banned.map(t => `<tr>
          <td class="text-mono"><strong>${escapeHtml(t.symbol)}</strong></td>
          <td><button class="btn btn-primary btn-sm" style="font-size:0.7rem;cursor:pointer;" data-unban-token="${escapeHtml(t.symbol)}">Unban</button></td>
        </tr>`).join('');
        bannedBody.querySelectorAll('[data-unban-token]').forEach(btn => {
          btn.addEventListener('click', () => unbanGlobalToken(btn.dataset.unbanToken));
        });
      }
    } catch (err) { /* silent */ }
  }

  async function addAllowedToken() {
    const symbol = ($('#admin-allowed-symbol').value || '').toUpperCase().trim();
    if (!symbol) return showToast('Enter a token symbol', 'error');
    try {
      await api('POST', '/api/admin/global-tokens', { symbol, enabled: true, banned: false });
      showToast(`${symbol} added to allowed`, 'success');
      $('#admin-allowed-symbol').value = '';
      loadGlobalTokens();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function scanBitunixTokens() {
    const btn = $('#scan-bitunix-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Scanning...'; }
    try {
      const result = await api('POST', '/api/admin/scan-bitunix-tokens');
      showToast(result.message || `Found ${result.bitunixTotal} tokens`, 'success');
      loadGlobalTokens();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔍 Scan Bitunix'; }
    }
  }

  async function addBannedToken() {
    const symbol = ($('#admin-banned-symbol').value || '').toUpperCase().trim();
    if (!symbol) return showToast('Enter a token symbol', 'error');
    try {
      await api('POST', '/api/admin/global-tokens', { symbol, enabled: false, banned: true });
      showToast(`${symbol} banned`, 'success');
      $('#admin-banned-symbol').value = '';
      loadGlobalTokens();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function unbanGlobalToken(symbol) {
    if (!symbol) return;
    try {
      const resp = await fetch('/api/admin/remove-global-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ symbol }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed');
      showToast(symbol + ' unbanned', 'success');
      loadGlobalTokens();
    } catch (err) {
      alert('Unban failed: ' + (err.message || err));
    }
  }

  async function removeGlobalToken(symbol) {
    console.log('[DEBUG] removeGlobalToken called with:', symbol);
    if (!symbol) { console.log('[DEBUG] No symbol, returning'); return; }
    if (!confirm('Remove ' + symbol + ' from allowed tokens?')) { console.log('[DEBUG] User cancelled'); return; }
    try {
      console.log('[DEBUG] Sending POST /api/admin/remove-global-token', symbol);
      const resp = await fetch('/api/admin/remove-global-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ symbol }),
      });
      console.log('[DEBUG] Response status:', resp.status);
      const data = await resp.json();
      console.log('[DEBUG] Response data:', data);
      if (!resp.ok) throw new Error(data.error || 'Failed');
      showToast(symbol + ' removed', 'success');
      loadGlobalTokens();
    } catch (err) {
      console.error('[DEBUG] Remove error:', err);
      alert('Remove failed: ' + (err.message || err));
    }
  }

  // Admin token search dropdown (uses full Binance coin list)
  function searchAdminToken(input, prefix) {
    loadCoinList();
    const q = (input.value || '').toUpperCase().trim();
    const dd = $(`#${prefix}-dropdown`);
    if (!dd) return;
    if (!q) { dd.classList.add('hidden'); return; }
    const matches = coinList.filter(c => c.includes(q)).slice(0, 10);
    if (!matches.length) { dd.classList.add('hidden'); return; }
    dd.innerHTML = matches.map(c =>
      `<div class="coin-dropdown-item" onclick="window.CryptoBot.pickAdminToken('${prefix}','${c}')">${c.replace('USDT', '')}/<span style="opacity:0.5">USDT</span></div>`
    ).join('');
    dd.classList.remove('hidden');
  }

  function pickAdminToken(prefix, symbol) {
    const input = $(`#${prefix}-symbol`);
    if (input) input.value = symbol;
    const dd = $(`#${prefix}-dropdown`);
    if (dd) dd.classList.add('hidden');
    if (prefix === 'admin-allowed') addAllowedToken();
    else if (prefix === 'admin-banned') addBannedToken();
    // admin-lev: just fill input, don't auto-submit (user sets leverage first)
  }

  // ── Token Leverage Management ──

  async function loadTokenLeverage() {
    try {
      const tokens = await api('GET', '/api/admin/token-leverage');
      const tbody = $('#admin-lev-tbody');
      const empty = $('#admin-lev-empty');
      if (!tbody) return;

      const levCountEl = $('#leverage-count');
      if (levCountEl) levCountEl.textContent = tokens.length;

      if (!tokens.length) {
        tbody.innerHTML = '';
        empty.classList.remove('hidden');
        return;
      }
      empty.classList.add('hidden');

      // Fetch current prices for display
      let priceMap = {};
      try {
        const resp = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        const tickers = await resp.json();
        for (const t of tickers) priceMap[t.symbol] = parseFloat(t.price);
      } catch (_) {}

      tbody.innerHTML = tokens.map(t => {
        const price = priceMap[t.symbol];
        const priceStr = price ? `$${price >= 1 ? price.toFixed(2) : price.toFixed(4)}` : '--';
        return `<tr>
          <td class="text-mono"><strong>${escapeHtml(t.symbol.replace('USDT', ''))}</strong></td>
          <td class="text-mono" style="color:var(--color-text-muted);">${priceStr}</td>
          <td>
            <input type="number" class="form-input text-mono" style="width:70px;padding:2px 6px;font-size:0.85rem;display:inline-block;" value="${t.leverage}" min="1" max="125" data-lev-symbol="${escapeHtml(t.symbol)}">
            <button class="btn btn-sm" style="font-size:0.65rem;padding:2px 8px;cursor:pointer;" onclick="window.CryptoBot.updateTokenLev('${escapeHtml(t.symbol)}', this)">Save</button>
          </td>
          <td><button class="btn btn-danger btn-sm" style="font-size:0.7rem;cursor:pointer;" data-remove-lev="${escapeHtml(t.symbol)}">✕</button></td>
        </tr>`;
      }).join('');

      tbody.querySelectorAll('[data-remove-lev]').forEach(btn => {
        btn.addEventListener('click', () => removeTokenLeverage(btn.dataset.removeLev));
      });
    } catch (err) { /* silent */ }
  }

  async function addTokenLeverage() {
    const symbol = ($('#admin-lev-symbol').value || '').toUpperCase().trim();
    const leverage = parseInt($('#admin-lev-value').value) || 20;
    if (!symbol) return showToast('Enter a token symbol', 'error');
    if (leverage < 1 || leverage > 125) return showToast('Leverage must be 1-125', 'error');
    try {
      await api('POST', '/api/admin/token-leverage', { symbol, leverage });
      showToast(`${symbol} set to ${leverage}x`, 'success');
      $('#admin-lev-symbol').value = '';
      loadTokenLeverage();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function updateTokenLev(symbol, btn) {
    const input = btn.previousElementSibling;
    const leverage = parseInt(input.value);
    if (!leverage || leverage < 1 || leverage > 125) return showToast('Leverage must be 1-125', 'error');
    try {
      await api('POST', '/api/admin/token-leverage', { symbol, leverage });
      showToast(`${symbol} updated to ${leverage}x`, 'success');
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function removeTokenLeverage(symbol) {
    if (!confirm(`Remove leverage setting for ${symbol}? It will use default 20x.`)) return;
    try {
      await api('POST', '/api/admin/remove-token-leverage', { symbol });
      showToast(`${symbol} leverage removed`, 'success');
      loadTokenLeverage();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function autoPopulateLeverage() {
    if (!confirm('Auto-populate leverage for all tokens above $1000?\nBTC/ETH → 100x, others → 20x')) return;
    try {
      const result = await api('POST', '/api/admin/token-leverage/auto-populate', { min_price: 1000, default_leverage: 20 });
      showToast(`Added ${result.added} tokens`, 'success');
      loadTokenLeverage();
    } catch (err) { showToast(err.message, 'error'); }
  }

  // User ban-token search (shows only admin-allowed tokens)
  let allowedTokenCache = [];
  let allowedTokenLoading = false;

  async function loadAllowedTokens() {
    if (allowedTokenCache.length || allowedTokenLoading) return;
    allowedTokenLoading = true;
    try {
      allowedTokenCache = await api('GET', '/api/allowed-tokens');
    } catch { allowedTokenCache = []; }
    allowedTokenLoading = false;
  }

  function searchUserBanToken(input, keyId) {
    loadAllowedTokens();
    const q = (input.value || '').toUpperCase().trim();
    const dd = $(`#banned-dropdown-${keyId}`);
    if (!dd) return;
    const existing = getChipValues(`banned-chips-${keyId}`).split(',').filter(Boolean);
    const source = allowedTokenCache.length ? allowedTokenCache : coinList;
    const matches = source.filter(c => (!q || c.includes(q)) && !existing.includes(c)).slice(0, 10);
    if (!matches.length) { dd.classList.add('hidden'); return; }
    dd.innerHTML = matches.map(c =>
      `<div class="coin-dropdown-item" onclick="window.CryptoBot.addCoin('banned-chips-${keyId}','${c}',${keyId},'banned')">${c.replace('USDT', '')}/<span style="opacity:0.5">USDT</span></div>`
    ).join('');
    dd.classList.remove('hidden');
  }

  function renderAdminWeeklyEarnings(data) {
    const el = (id) => document.getElementById(id);
    const netVal = parseFloat(data.grand_total_net) || 0;
    const netEl = el('awe-total-net');
    netEl.textContent = `${netVal >= 0 ? '+' : ''}$${netVal.toFixed(2)}`;
    netEl.style.color = netVal >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
    el('awe-admin-share').textContent = `$${(parseFloat(data.grand_total_admin_share) || 0).toFixed(2)}`;
    el('awe-user-share').textContent = `$${(parseFloat(data.grand_total_user_share) || 0).toFixed(2)}`;

    const container = document.getElementById('admin-earnings-per-user');
    if (!data.users || data.users.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = data.users.filter(u => u.keys.length > 0).map(u => {
      const net = parseFloat(u.total_net_pnl) || 0;
      const netColor = net >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
      const paidAt = u.last_paid_at ? new Date(u.last_paid_at) : new Date(u.created_at);
      const dueMs = paidAt.getTime() + 7 * 86400000;
      const remaining = dueMs - Date.now();
      const isOverdue = remaining <= 0;
      const daysLeft = remaining / 86400000;
      const timerColor = isOverdue ? 'var(--color-danger)' : daysLeft <= 2 ? 'var(--color-danger)' : daysLeft <= 4 ? '#f59e0b' : 'var(--color-accent)';
      const timerText = formatCountdown(remaining);
      const timerBadge = `<span class="admin-timer-badge" data-due="${dueMs}" style="font-size:0.7rem;font-weight:700;color:${timerColor};background:${isOverdue ? 'rgba(239,68,68,0.12)' : 'rgba(0,0,0,0.06)'};padding:2px 8px;border-radius:10px;margin-left:6px;font-family:var(--font-mono);">${timerText}</span>`;

      const keysHtml = u.keys.map(k => {
        const isPaused = k.paused || !k.enabled;
        const kNet = parseFloat(k.net_pnl) || 0;
        const kNetColor = kNet >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
        return `<div style="background:var(--color-bg);border:1px solid var(--color-border-muted);border-radius:var(--radius-md);padding:var(--space-3);margin-top:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <div>
              <strong style="font-size:0.8rem;">${escapeHtml(k.label)}</strong>
              <span style="font-size:0.7rem;color:var(--color-text-muted);margin-left:4px;">${k.platform?.toUpperCase()}</span>
              ${isPaused ? '<span style="color:var(--color-danger);font-size:0.7rem;margin-left:4px;">⏸ PAUSED</span>' : ''}
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="text-mono" style="font-size:0.85rem;color:${kNetColor};">${kNet >= 0 ? '+' : ''}$${kNet.toFixed(2)}</span>
              <span style="font-size:0.7rem;color:var(--color-text-muted);">${k.win_count}W/${k.loss_count}L</span>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;flex-wrap:wrap;gap:8px;">
            <div style="display:flex;gap:8px;align-items:center;">
              <div style="font-size:0.75rem;">
                <span style="color:var(--color-text-muted);">Split:</span>
                <span style="color:var(--color-success);">${k.user_share_pct||60}% user</span> /
                <span style="color:var(--color-accent);">${k.admin_share_pct||40}% admin</span>
              </div>
              <button class="btn btn-ghost btn-sm" style="font-size:0.7rem;padding:2px 8px;min-height:24px;" onclick="window.CryptoBot.adminEditSplit(${k.key_id},${k.user_share_pct||60},${k.admin_share_pct||40})">Edit</button>
            </div>
            <div style="display:flex;gap:6px;">
              ${isPaused
                ? `<button class="btn btn-primary btn-sm" style="font-size:0.7rem;padding:2px 10px;min-height:26px;" onclick="window.CryptoBot.adminResumeKey(${k.key_id})">▶ Resume</button>`
                : `<button class="btn btn-danger btn-sm" style="font-size:0.7rem;padding:2px 10px;min-height:26px;" onclick="window.CryptoBot.adminPauseKey(${k.key_id})">⏸ Pause</button>`
              }
            </div>
          </div>
          <div style="font-size:0.7rem;color:var(--color-text-muted);margin-top:4px;">
            ${kNet > 0 ? `User: <strong style="color:var(--color-success);">$${(parseFloat(k.user_share)||0).toFixed(2)}</strong> · Admin: <strong style="color:var(--color-accent);">$${(parseFloat(k.admin_share)||0).toFixed(2)}</strong>` : '<span style="color:var(--color-text-muted);">Net negative — no profit to split</span>'}
          </div>
        </div>`;
      }).join('');

      return `<div style="background:var(--color-bg-raised);border:1px solid ${u.is_overdue ? 'var(--color-danger)' : 'var(--color-border-muted)'};border-radius:var(--radius-lg);padding:var(--space-4);margin-bottom:var(--space-3);">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div>
            <strong style="font-size:0.95rem;">${escapeHtml(u.email)}</strong>
            <span style="font-size:0.75rem;color:var(--color-text-muted);margin-left:8px;">${u.total_trades} trades · ${u.total_wins}W/${u.total_losses}L</span>
            ${timerBadge}
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="text-align:right;">
              <div class="text-mono" style="font-size:0.9rem;color:${netColor};">Net: ${net >= 0 ? '+' : ''}$${net.toFixed(2)}</div>
              <div style="font-size:0.7rem;color:var(--color-text-muted);">
                Admin: <span style="color:var(--color-accent);">$${(parseFloat(u.total_admin_share)||0).toFixed(2)}</span> ·
                User: <span style="color:var(--color-success);">$${(parseFloat(u.total_user_share)||0).toFixed(2)}</span>
              </div>
            </div>
            <button class="btn btn-primary btn-sm" style="font-size:0.75rem;padding:4px 12px;min-height:28px;" onclick="window.CryptoBot.adminMarkPaid(${u.user_id},'${escapeHtml(u.email)}')">✓ Paid</button>
          </div>
        </div>
        ${keysHtml}
      </div>`;
    }).join('');

    // Start live ticking for all admin timer badges
    startAdminTimerTick();
  }

  let adminTimerInterval = null;

  function startAdminTimerTick() {
    if (adminTimerInterval) clearInterval(adminTimerInterval);
    adminTimerInterval = setInterval(() => {
      document.querySelectorAll('.admin-timer-badge[data-due]').forEach(badge => {
        const dueMs = parseInt(badge.dataset.due);
        const remaining = dueMs - Date.now();
        badge.textContent = formatCountdown(remaining);
        const isOverdue = remaining <= 0;
        const daysLeft = remaining / 86400000;
        badge.style.color = isOverdue ? 'var(--color-danger)' : daysLeft <= 2 ? 'var(--color-danger)' : daysLeft <= 4 ? '#f59e0b' : 'var(--color-accent)';
      });
    }, 1000);
  }

  async function adminEditSplit(keyId, currentUserPct, currentAdminPct) {
    const newUserPct = prompt(`Set profit split for this key\n\nUser share % (currently ${currentUserPct}%):`, currentUserPct);
    if (newUserPct === null) return;
    const parsed = parseFloat(newUserPct);
    if (isNaN(parsed) || parsed < 0 || parsed > 100) return showToast('Invalid percentage', 'error');
    const adminPct = 100 - parsed;
    try {
      await api('PUT', `/api/admin/keys/${keyId}/profit-share`, { user_pct: parsed, admin_pct: adminPct });
      showToast(`Split updated: ${parsed}% user / ${adminPct}% admin`, 'success');
      loadAdmin();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminMarkPaid(userId, email) {
    if (!confirm(`Mark ${email} as PAID for this week?\nThis saves earnings to history and resumes trading.`)) return;
    try {
      await api('POST', `/api/admin/mark-paid/${userId}`);
      showToast(`${email} marked as paid — trading resumed`, 'success');
      loadAdmin();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminClearTestData() {
    if (!confirm('Clear ALL wallet transactions and withdrawal history?\nThis cannot be undone.')) return;
    const statusEl = document.getElementById('clear-data-status');
    statusEl.textContent = 'Clearing...';
    statusEl.style.color = 'var(--color-accent)';
    try {
      const result = await api('POST', '/api/admin/clear-test-data');
      statusEl.textContent = result.message;
      statusEl.style.color = 'var(--color-success)';
      showToast('Test data cleared', 'success');
    } catch (err) {
      statusEl.textContent = 'Failed';
      statusEl.style.color = 'var(--color-danger)';
      showToast(err.message, 'error');
    }
  }

  async function loadOpenPositions() {
    const listEl = document.getElementById('open-positions-list');
    if (!listEl) return;
    listEl.innerHTML = '<span style="color:var(--color-text-muted);">Loading...</span>';
    try {
      const data = await api('GET', '/api/admin/open-positions');
      if (!data.positions || !data.positions.length) {
        listEl.innerHTML = '<span style="color:var(--color-success);">No open positions</span>';
        return;
      }

      let totalPnl = 0;
      const html = data.positions.map(group => {
        const sym = group.symbol;
        const dir = group.direction;
        const dirColor = dir === 'LONG' ? 'var(--color-success)' : 'var(--color-danger)';

        const tradesHtml = group.trades.map(t => {
          totalPnl += t.pnlUsdt;
          const dangerBg = t.danger === 'critical' ? 'rgba(239,68,68,0.15)' : t.danger === 'danger' ? 'rgba(239,68,68,0.08)' : t.danger === 'warning' ? 'rgba(255,176,32,0.06)' : '';
          const pnlColor = t.pnlUsdt >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
          const fmtEntry = t.entry >= 1 ? t.entry.toFixed(2) : t.entry.toFixed(6);
          const fmtCur = t.curPrice >= 1 ? t.curPrice.toFixed(2) : t.curPrice.toFixed(6);
          const hrs = Math.floor(t.durationMin / 60);
          const mins = t.durationMin % 60;
          const dur = hrs > 0 ? `${hrs}h${mins}m` : `${mins}m`;

          return `<div style="display:grid;grid-template-columns:1fr auto;gap:4px;padding:6px 8px;background:${dangerBg};border-radius:4px;margin-bottom:2px;">
            <div>
              <span style="font-size:0.75rem;color:var(--color-text-muted);">${escapeHtml(t.email)} • ${t.platform} • x${t.leverage} • ${dur}</span>
            </div>
            <div style="text-align:right;">
              <span style="font-weight:700;color:${pnlColor};font-size:0.85rem;">${t.pnlUsdt >= 0 ? '+' : ''}$${t.pnlUsdt.toFixed(2)}</span>
              <span style="font-size:0.7rem;color:${pnlColor};margin-left:4px;">(${t.capitalPnl >= 0 ? '+' : ''}${t.capitalPnl}% cap)</span>
            </div>
            <div style="font-size:0.7rem;color:var(--color-text-muted);">
              Entry: $${fmtEntry} → Now: $${fmtCur} | Price: ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct}%
            </div>
            <div style="text-align:right;font-size:0.7rem;color:var(--color-text-muted);">
              SL: ${t.slDist > 0 ? t.slDist + '% away' : '--'}
            </div>
          </div>`;
        }).join('');

        const groupPnl = group.totalPnl;
        const groupColor = groupPnl >= 0 ? 'var(--color-success)' : 'var(--color-danger)';

        return `<div style="margin-bottom:var(--space-3);border:1px solid var(--color-border-muted);border-radius:var(--radius-md);overflow:hidden;">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--color-bg-raised);">
            <div style="display:flex;align-items:center;gap:8px;">
              <button class="btn btn-sm" style="font-size:0.65rem;background:#ef4444;color:#fff;border:none;padding:2px 8px;" data-close-token="${sym}">Close</button>
              <strong>${sym.replace('USDT','')}</strong>
              <span style="color:${dirColor};font-weight:700;font-size:0.8rem;">${dir}</span>
              <span style="font-size:0.72rem;color:var(--color-text-muted);">${group.trades.length} user(s)</span>
            </div>
            <span style="font-weight:700;color:${groupColor};">${groupPnl >= 0 ? '+' : ''}$${groupPnl.toFixed(2)}</span>
          </div>
          <div style="padding:4px 6px;">${tradesHtml}</div>
        </div>`;
      }).join('');

      const totalColor = totalPnl >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
      listEl.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-2);padding:6px 0;border-bottom:1px solid var(--color-border-muted);">
        <span style="font-size:0.85rem;font-weight:600;">Total Open P&L:</span>
        <span style="font-size:1rem;font-weight:700;color:${totalColor};">${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</span>
      </div>${html}`;

      listEl.querySelectorAll('[data-close-token]').forEach(btn => {
        btn.addEventListener('click', () => emergencyCloseToken(btn.dataset.closeToken));
      });
    } catch (err) {
      listEl.innerHTML = '<span style="color:#ef4444;">Failed: ' + (err.message || err) + '</span>';
    }
  }

  async function emergencyCloseToken(symbol) {
    if (!confirm(`🚨 CLOSE ${symbol} for ALL users?\n\nThis will market-close immediately.`)) return;
    const statusEl = document.getElementById('emergency-stop-status');
    statusEl.textContent = `Closing ${symbol}...`;
    statusEl.style.color = '#ef4444';
    try {
      const result = await api('POST', '/api/admin/emergency-close', { symbol });
      const details = (result.results || []).map(r => `${r.user}: ${r.status}${r.error ? ' — ' + r.error : ''}`).join('\n');
      statusEl.textContent = `${symbol}: ${result.totalClosed} closed`;
      statusEl.style.color = result.totalClosed > 0 ? 'var(--color-success)' : '#ef4444';
      if (details) console.log('[EMERGENCY RESULTS]\n' + details);
      if (result.totalClosed > 0) {
        showToast(`${symbol}: ${result.totalClosed} positions closed`, 'success');
      } else {
        showToast(`${symbol}: no positions closed. Check console for details.`, 'error');
        alert('Close results:\n' + details);
      }
      loadOpenPositions();
    } catch (err) {
      statusEl.textContent = 'Failed: ' + (err.message || err);
      statusEl.style.color = '#ef4444';
      showToast('Close failed: ' + err.message, 'error');
    }
  }

  async function emergencyCloseAll() {
    if (!confirm('🚨 CLOSE ALL POSITIONS for ALL users?\n\nThis will market-close EVERY open position immediately.\n\nAre you absolutely sure?')) return;
    const statusEl = document.getElementById('emergency-stop-status');
    const listEl = document.getElementById('open-positions-list');
    const tokens = listEl ? [...listEl.querySelectorAll('[data-close-token]')].map(b => b.dataset.closeToken) : [];
    if (!tokens.length) { showToast('No open positions to close', 'error'); return; }
    statusEl.textContent = `Closing ${tokens.length} tokens...`;
    statusEl.style.color = '#ef4444';
    let totalClosed = 0;
    for (const symbol of tokens) {
      try {
        const result = await api('POST', '/api/admin/emergency-close', { symbol });
        totalClosed += result.totalClosed;
      } catch {}
    }
    statusEl.textContent = `Done: ${totalClosed} positions closed across ${tokens.length} tokens`;
    statusEl.style.color = 'var(--color-success)';
    showToast(`${totalClosed} positions closed`, 'success');
    loadOpenPositions();
  }

  async function adminFixTrades() {
    if (!confirm('Re-fetch actual PnL from exchanges and fix corrupted trade data?')) return;
    const statusEl = document.getElementById('fix-trades-status');
    statusEl.textContent = 'Fixing... (this may take a minute)';
    statusEl.style.color = 'var(--color-accent)';
    try {
      const result = await api('POST', '/api/admin/fix-trades');
      if (result.fixed > 0) {
        statusEl.textContent = `Fixed ${result.fixed} of ${result.total_checked} trades`;
        statusEl.style.color = 'var(--color-success)';
        showToast(`Fixed ${result.fixed} corrupted trades`, 'success');
        // Show details
        for (const d of result.details || []) {
          if (d.fixed) {
            console.log(`Fixed #${d.id} ${d.email} ${d.symbol}: ${d.old_status} $${d.old_pnl} → ${d.new_status} $${d.new_pnl}`);
          }
        }
        loadAdmin();
      } else {
        statusEl.textContent = `Checked ${result.total_checked} trades — all correct`;
        statusEl.style.color = 'var(--color-success)';
        showToast('All trades look correct', 'info');
      }
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.style.color = 'var(--color-danger)';
      showToast(err.message, 'error');
    }
  }

  async function adminPauseKey(keyId) {
    if (!confirm('Pause this API key? The bot will stop trading for this key.')) return;
    try {
      await api('PUT', `/api/admin/keys/${keyId}/pause`, { paused: true });
      showToast('API key paused', 'success');
      loadAdmin();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminResumeKey(keyId) {
    try {
      await api('PUT', `/api/admin/keys/${keyId}/resume`);
      showToast('API key resumed', 'success');
      loadAdmin();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminApproveNoSub(userId, approved) {
    try {
      await api('PUT', `/api/admin/users/${userId}/approve-no-sub`, { approved });
      showToast(approved ? 'User approved (no sub required)' : 'Approval revoked', 'success');
      loadAdmin();
    } catch (err) { showToast(err.message, 'error'); }
  }

  function renderAdminUsers(users) {
    $('#admin-users-tbody').innerHTML = users.map(u => {
      const bal = parseFloat(u.wallet_balance || 0).toFixed(2);
      const paidAt = u.last_paid_at ? new Date(u.last_paid_at) : new Date(u.created_at);
      const dueMs = paidAt.getTime() + 7 * 86400000;
      const msLeft = dueMs - Date.now();
      const isOverdue = msLeft <= 0;
      const daysLeft = msLeft / 86400000;
      const timerColor = isOverdue ? 'var(--color-danger)' : daysLeft <= 2 ? 'var(--color-danger)' : daysLeft <= 4 ? '#f59e0b' : 'var(--color-success)';
      const timerText = formatCountdown(msLeft);

      const roleBtn = u.is_admin
        ? `<button class="btn btn-sm" style="font-size:0.7rem;padding:2px 8px;background:var(--color-accent);color:#fff;border:none;" onclick="window.CryptoBot.adminChangeRole(${u.id},'${escapeHtml(u.email)}',false)">Demote</button>`
        : `<button class="btn btn-sm" style="font-size:0.7rem;padding:2px 8px;background:#8b5cf6;color:#fff;border:none;" onclick="window.CryptoBot.adminChangeRole(${u.id},'${escapeHtml(u.email)}',true)">Make Admin</button>`;

      return `<tr>
      <td>${escapeHtml(u.email)}${u.is_admin ? ' <span style="color:var(--color-accent);font-size:0.7rem;font-weight:700;">ADMIN</span>' : ''}</td>
      <td>${u.key_count}</td>
      <td class="text-mono">$${bal} <button class="btn btn-ghost btn-sm" style="font-size:0.7rem;padding:2px 6px;" onclick="window.CryptoBot.adminEditWallet(${u.id},'${escapeHtml(u.email)}',${bal})">Edit</button></td>
      <td>${escapeHtml(u.referral_code || '-')}</td>
      <td>${formatDate(u.created_at)}</td>
      <td style="white-space:nowrap;"><span class="admin-timer-badge" data-due="${dueMs}" style="color:${timerColor};font-size:0.8rem;font-weight:600;font-family:var(--font-mono);">${timerText}</span></td>
      <td style="white-space:nowrap;display:flex;gap:4px;align-items:center;">
        ${u.is_blocked
          ? `<button class="btn btn-primary btn-sm" onclick="window.CryptoBot.adminAction('unblock',${u.id})">Unblock</button>`
          : `<button class="btn btn-danger btn-sm" onclick="window.CryptoBot.adminAction('block',${u.id})">Block</button>`}
        ${roleBtn}
      </td>
    </tr>`;
    }).join('');
  }

  async function adminEditWallet(userId, email, currentBal) {
    const newAmount = prompt(`Edit wallet balance for ${email}\nCurrent: $${currentBal}\n\nEnter new balance (USD):`, currentBal);
    if (newAmount === null) return;
    const parsed = parseFloat(newAmount);
    if (isNaN(parsed) || parsed < 0) return showToast('Invalid amount', 'error');
    const reason = prompt('Reason for adjustment (optional):', '') || '';
    try {
      await api('PUT', `/api/admin/users/${userId}/wallet`, { amount: parsed, reason });
      showToast(`Wallet updated to $${parsed.toFixed(2)}`, 'success');
      loadAdmin();
    } catch (err) { showToast(err.message, 'error'); }
  }

  function renderAdminSubs(subs) {
    const pending = subs.filter(s => s.status === 'pending' || s.status === 'stripe_pending');
    $('#admin-subs-tbody').innerHTML = pending.length ? pending.map(s => `<tr>
      <td>${escapeHtml(s.email)}</td>
      <td class="text-mono">$${parseFloat(s.amount).toFixed(2)}</td>
      <td>${escapeHtml(s.payment_method)}</td>
      <td>${s.proof_url ? `<a href="${escapeHtml(s.proof_url)}" target="_blank" style="color:var(--color-accent);">View</a>` : '-'}</td>
      <td>${formatDate(s.created_at)}</td>
      <td>
        <button class="btn btn-primary btn-sm" onclick="window.CryptoBot.adminSub('approve',${s.id})">Approve</button>
        <button class="btn btn-danger btn-sm" onclick="window.CryptoBot.adminSub('reject',${s.id})">Reject</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;color:var(--color-text-muted);">No pending payments</td></tr>';
  }

  function renderAdminWithdrawals(wds) {
    const pending = wds.filter(w => w.status === 'pending');
    $('#admin-wd-tbody').innerHTML = pending.length ? pending.map(w => `<tr>
      <td>${escapeHtml(w.email)}</td>
      <td class="text-mono">$${parseFloat(w.amount).toFixed(2)}</td>
      <td>${escapeHtml(w.bank_name)}</td>
      <td class="text-mono">${escapeHtml(w.account_number)}</td>
      <td>${escapeHtml(w.account_name)}</td>
      <td>${formatDate(w.created_at)}</td>
      <td>
        <button class="btn btn-primary btn-sm" onclick="window.CryptoBot.adminWd('approve',${w.id})">Approve</button>
        <button class="btn btn-danger btn-sm" onclick="window.CryptoBot.adminWd('reject',${w.id})">Reject</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--color-text-muted);">No pending withdrawals</td></tr>';
  }

  async function adminAction(action, userId) {
    try {
      await api('PUT', `/api/admin/users/${userId}/block`, { blocked: action === 'block' });
      showToast(`User ${action}ed`, 'success');
      loadAdmin();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminChangeRole(userId, email, makeAdmin) {
    const action = makeAdmin ? 'promote to Admin' : 'demote to User';
    if (!confirm(`${action} for ${email}?`)) return;
    try {
      await api('PUT', `/api/admin/users/${userId}/role`, { is_admin: makeAdmin });
      showToast(`${email} ${makeAdmin ? 'promoted to Admin' : 'demoted to User'}`, 'success');
      loadAdmin();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminSub(action, subId) {
    try {
      await api('PUT', `/api/admin/subscriptions/${subId}`, { action });
      showToast(`Subscription ${action}d`, 'success');
      loadAdmin();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminWd(action, wdId) {
    try {
      await api('PUT', `/api/admin/withdrawals/${wdId}`, { action });
      showToast(`Withdrawal ${action}d`, 'success');
      loadAdmin();
    } catch (err) { showToast(err.message, 'error'); }
  }

  // ----- Forgot / Reset Password -----

  function showForgotForm() {
    $('#form-login').classList.add('hidden');
    $('#form-signup').classList.add('hidden');
    $('#form-forgot').classList.remove('hidden');
    // Hide auth tabs
    $$('[data-auth-tab]').forEach(b => b.style.opacity = '0.4');
  }

  function showLoginForm() {
    $('#form-forgot').classList.add('hidden');
    $('#form-login').classList.remove('hidden');
    $$('[data-auth-tab]').forEach(b => b.style.opacity = '1');
  }

  function setupForgotPassword() {
    const btn = $('#btn-forgot-password');
    if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); showForgotForm(); });

    const form = $('#form-forgot');
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#forgot-email').value.trim();
      const errEl = $('#forgot-error');
      const successEl = $('#forgot-success');
      errEl.textContent = ''; errEl.classList.remove('visible');
      successEl.classList.add('hidden');
      try {
        const data = await api('POST', '/api/auth/forgot-password', { email });
        successEl.textContent = data.message;
        successEl.classList.remove('hidden');
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.add('visible');
      }
    });
  }

  function checkResetToken() {
    const params = new URLSearchParams(window.location.search);
    const resetToken = params.get('reset');
    const uid = params.get('uid');
    if (!resetToken || !uid) return;

    // Show reset password prompt
    showSection('auth');
    const newPass = prompt('Enter your new password (min 6 characters):');
    if (!newPass || newPass.length < 6) {
      showToast('Password must be at least 6 characters', 'error');
      return;
    }
    api('POST', '/api/auth/reset-password', { token: resetToken, uid, password: newPass })
      .then(data => {
        showToast(data.message, 'success');
        window.history.replaceState({}, '', '/');
      })
      .catch(err => showToast(err.message, 'error'));
  }

  // ----- Clear error trades (admin only) -----
  async function clearErrors() {
    if (!confirm('Delete all ERROR trades from history?')) return;
    try {
      await api('DELETE', '/api/admin/trades/errors');
      showToast('Error trades cleared', 'success');
      loadDashboard();
    } catch (err) { showToast(err.message, 'error'); }
  }

  // ----- Coin list + autocomplete chips -----
  let coinList = [];
  let coinListLoading = false;

  async function loadCoinList() {
    if (coinList.length || coinListLoading) return;
    coinListLoading = true;
    try {
      coinList = await api('GET', '/api/coins');
    } catch { coinList = []; }
    coinListLoading = false;
  }

  function buildChips(coinStr, keyId, type) {
    if (!coinStr) return '';
    return coinStr.split(',').filter(Boolean).map(c =>
      `<span class="coin-chip">${escapeHtml(c.trim())} <span class="coin-chip-x" onclick="window.CryptoBot.removeCoin('${type}-chips-${keyId}','${escapeHtml(c.trim())}')">&times;</span></span>`
    ).join('');
  }

  function getChipValues(containerId) {
    const el = $(`#${containerId}`);
    if (!el) return '';
    const chips = el.querySelectorAll('.coin-chip');
    return Array.from(chips).map(c => c.textContent.replace('×', '').trim()).join(',');
  }

  function addCoin(containerId, coin, keyId, type) {
    const el = $(`#${containerId}`);
    if (!el) return;
    const existing = getChipValues(containerId).split(',').filter(Boolean);
    if (existing.includes(coin)) return;
    el.innerHTML += `<span class="coin-chip">${escapeHtml(coin)} <span class="coin-chip-x" onclick="window.CryptoBot.removeCoin('${containerId}','${escapeHtml(coin)}')">&times;</span></span>`;
    const searchInput = $(`#${type}-search-${keyId}`);
    if (searchInput) { searchInput.value = ''; }
    const dd = $(`#${type}-dropdown-${keyId}`);
    if (dd) dd.classList.add('hidden');
  }

  function removeCoin(containerId, coin) {
    const el = $(`#${containerId}`);
    if (!el) return;
    const chips = el.querySelectorAll('.coin-chip');
    chips.forEach(c => {
      if (c.textContent.replace('×', '').trim() === coin) c.remove();
    });
  }

  function searchCoins(input, keyId, type) {
    loadCoinList();
    const q = (input.value || '').toUpperCase().trim();
    const dd = $(`#${type}-dropdown-${keyId}`);
    if (!dd) return;

    if (!q) { dd.classList.add('hidden'); return; }

    const existing = getChipValues(`${type}-chips-${keyId}`).split(',').filter(Boolean);
    const matches = coinList.filter(c => c.includes(q) && !existing.includes(c)).slice(0, 8);

    if (!matches.length) { dd.classList.add('hidden'); return; }

    dd.innerHTML = matches.map(c =>
      `<div class="coin-dropdown-item" onclick="window.CryptoBot.addCoin('${type}-chips-${keyId}','${c}',${keyId},'${type}')">${c.replace('USDT', '')}/<span style="opacity:0.5">USDT</span></div>`
    ).join('');
    dd.classList.remove('hidden');
  }

  // Close dropdowns on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.coin-dropdown') && !e.target.matches('[id*="-search-"]') && !e.target.matches('[id*="-symbol"]')) {
      $$('.coin-dropdown').forEach(d => d.classList.add('hidden'));
    }
  });

  // ----- Platform change (show static IP info) -----

  function onPlatformChange(val) {
    const guide = $('#bitunix-setup-guide');
    if (!guide) return;
    if (val === 'bitunix') {
      guide.classList.remove('hidden');
    } else {
      guide.classList.add('hidden');
    }
  }

  // ----- Live Logs -----
  let logPollTimer = null;
  let logLastId = 0;
  let logFilter = null;
  const LOG_COLORS = {
    trade: '#00e676', scan: '#00b0ff', sentiment: '#ff9100',
    ai: '#e040fb', system: '#78909c', error: '#ff5252',
  };
  const LOG_ICONS = {
    trade: '\u{1F4B0}', scan: '\u{1F50D}', sentiment: '\u{1F4F0}',
    ai: '\u{1F9E0}', system: '\u{2699}\uFE0F', error: '\u{274C}',
  };

  function startLogPolling() {
    if (logPollTimer) return;
    logLastId = 0;
    const content = $('#logs-content');
    if (content) content.innerHTML = '';
    fetchLogs();
    logPollTimer = setInterval(fetchLogs, 3000);
    const status = $('#logs-status');
    if (status) status.textContent = 'Live — polling every 3s';
  }

  function stopLogPolling() {
    if (logPollTimer) { clearInterval(logPollTimer); logPollTimer = null; }
  }

  async function fetchLogs() {
    try {
      const catParam = logFilter ? `&category=${logFilter}` : '';
      const url = logLastId > 0
        ? `/api/logs?since=${logLastId}${catParam}`
        : `/api/logs?count=200${catParam}`;
      const entries = await api('GET', url);
      if (!entries.length) return;

      const content = $('#logs-content');
      if (!content) return;

      for (const entry of entries) {
        const color = LOG_COLORS[entry.category] || '#aaa';
        const icon = LOG_ICONS[entry.category] || '';
        const time = entry.ts.slice(11, 19);
        const cat = entry.category.toUpperCase().padEnd(9);
        const line = document.createElement('div');
        line.style.marginBottom = '2px';
        line.innerHTML =
          `<span style="color:#666">${escapeHtml(time)}</span> ` +
          `<span style="color:${color};font-weight:600">${icon} ${escapeHtml(cat)}</span> ` +
          `<span style="color:var(--color-text)">${escapeHtml(entry.message)}</span>` +
          (entry.data ? `<span style="color:#666"> ${escapeHtml(JSON.stringify(entry.data))}</span>` : '');
        content.appendChild(line);
        logLastId = Math.max(logLastId, entry.id);
      }

      // Auto-scroll
      const autoScroll = $('#log-auto-scroll');
      if (autoScroll && autoScroll.checked) {
        const container = $('#logs-container');
        if (container) container.scrollTop = container.scrollHeight;
      }

      const status = $('#logs-status');
      if (status) status.textContent = `Live — ${content.childElementCount} entries`;
    } catch (err) {
      const status = $('#logs-status');
      if (status) status.textContent = `Error: ${err.message}`;
    }
  }

  function filterLogs(category, btn) {
    logFilter = category === 'all' ? null : category;
    logLastId = 0;
    const content = $('#logs-content');
    if (content) content.innerHTML = '';
    $$('.log-filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    fetchLogs();
  }

  function clearLogs() {
    const content = $('#logs-content');
    if (content) content.innerHTML = '';
    logLastId = 0;
  }

  // ----- Expose to inline handlers -----
  function syncSlider(sliderId, val) {
    const slider = document.getElementById(sliderId);
    if (slider) slider.value = val;
  }

  function syncNum(numId, val) {
    const numInput = document.getElementById(numId);
    if (numInput) numInput.value = val;
  }

  // ----- Profile -----

  function loadProfile() {
    if (!state.user) return;
    const usernameEl = $('#profile-username');
    const emailEl = $('#profile-email');
    if (usernameEl) usernameEl.value = state.user.username || '';
    if (emailEl) emailEl.value = state.user.email || '';
  }

  async function saveProfile() {
    const username = ($('#profile-username')?.value || '').trim();
    const email = ($('#profile-email')?.value || '').trim();
    if (!email) return showToast('Email is required', 'error');
    try {
      await api('PUT', '/api/auth/profile', { username, email });
      state.user.username = username;
      state.user.email = email;
      els.userEmail.textContent = username || email;
      showToast('Profile updated', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to update profile', 'error');
    }
  }

  async function changePassword() {
    const current = $('#profile-current-pw')?.value;
    const newPw = $('#profile-new-pw')?.value;
    const confirm = $('#profile-confirm-pw')?.value;
    if (!current || !newPw) return showToast('All fields required', 'error');
    if (newPw.length < 6) return showToast('Password must be 6+ characters', 'error');
    if (newPw !== confirm) return showToast('Passwords do not match', 'error');
    try {
      await api('PUT', '/api/auth/change-password', { current_password: current, new_password: newPw });
      showToast('Password changed successfully', 'success');
      $('#profile-current-pw').value = '';
      $('#profile-new-pw').value = '';
      $('#profile-confirm-pw').value = '';
    } catch (err) {
      showToast(err.message || 'Failed to change password', 'error');
    }
  }

  // ── Pause Bot ──────────────────────────────────────────────
  async function loadPauseStatus() {
    try {
      const res = await api('/api/dashboard/pause-status');
      updatePauseUI(res.paused);
    } catch (_) {}
  }

  function updatePauseUI(isPaused) {
    const dot = $('#pause-status-dot');
    const text = $('#pause-status-text');
    const btn = $('#pause-btn');
    if (!dot || !text || !btn) return;

    if (isPaused) {
      dot.style.background = 'var(--color-danger)';
      text.textContent = 'Bot Paused';
      text.style.color = 'var(--color-danger)';
      btn.textContent = 'Resume Bot';
      btn.style.background = 'var(--color-success)';
      btn.style.borderColor = 'var(--color-success)';
      btn.style.color = '#fff';
    } else {
      dot.style.background = 'var(--color-success)';
      text.textContent = 'Bot Active';
      text.style.color = 'var(--color-success)';
      btn.textContent = 'Pause Bot';
      btn.style.background = '';
      btn.style.borderColor = 'var(--color-danger)';
      btn.style.color = 'var(--color-danger)';
    }
  }

  async function togglePause() {
    const btn = $('#pause-btn');
    const isPaused = btn.textContent.trim() === 'Resume Bot';
    const action = isPaused ? 'resume' : 'pause';
    if (!confirm(`Are you sure you want to ${action} the bot? ${isPaused ? 'Trading will resume and the weekly timer will continue.' : 'No new trades will be opened and the weekly timer will pause.'}`)) return;

    try {
      btn.disabled = true;
      btn.textContent = isPaused ? 'Resuming...' : 'Pausing...';
      const res = await api('/api/dashboard/toggle-pause', { method: 'POST' });
      updatePauseUI(res.paused);
      showToast(res.paused ? 'Bot paused — no new trades will open' : 'Bot resumed — trading is active', res.paused ? 'warning' : 'success');
    } catch (err) {
      showToast(err.message || 'Failed to toggle pause', 'error');
      loadPauseStatus();
    } finally {
      btn.disabled = false;
    }
  }

  window.CryptoBot = {
    toggleSettings, saveSettings, deleteKey, showToast, syncSlider, syncNum, saveProfile, changePassword,
    togglePause,
    submitTopUp, saveUsdtAddress, withdrawFromWallet, payWeekly,
    adminAction, adminChangeRole, adminSub, adminWd, saveAdminSettings, adminEditWallet, clearErrors,
    adminEditSplit, adminPauseKey, adminResumeKey, adminMarkPaid, adminFixTrades, adminClearTestData,
    goToAuth, showLoginForm, onPlatformChange,
    searchCoins, addCoin, removeCoin,
    filterLogs, clearLogs,
    addTokenLeverage, removeTokenLeverage, updateTokenLev, autoPopulateLeverage, searchTokenLev, pickTokenLev, selectRiskLevel,
    addAllowedToken, addBannedToken, unbanGlobalToken, removeGlobalToken, scanBitunixTokens,
    searchAdminToken, pickAdminToken, searchUserBanToken,
    addRiskLevel, saveRiskLevel, deleteRiskLevel,
    loadKronosPredictions,
    loadOpenPositions, emergencyCloseToken, emergencyCloseAll,
    fixBitunixPnl, debugBitunix, runBacktest, loadAiVersions, runAiOptimize,
    mcRefresh, mcCommand, mcChat, mcChatQuick, switchAdminTab, filterAgents, customerChat,
    loadSignalBoard, toggleWatch, watchAll, setUserLeverage,
    adminLoadTokenBoard, adminAddTokenBoard, adminPopulateTop50, adminSetRiskTag, adminSetTokenLev, adminToggleBan, adminRemoveTokenBoard,
    mcToggleSkill, mcUpdateConfig, mcCreateAgent, mcRemoveAgent,
  };

  // ----- Init -----

  function init() {
    setupAuthTabs();
    setupAuthForms();
    setupLogout();
    setupNavTabs();
    setupPagination();
    setupCsvExport();
    setupModal();
    setupForgotPassword();

    // Check for password reset token in URL
    checkResetToken();

    // Auto-fill referral code from URL (?ref=XXXX)
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref');
    if (ref) {
      const refInput = $('#signup-referral');
      if (refInput) refInput.value = ref;
    }

    checkSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

<div id='brain-display' style='display:none; padding:20px; background:#1a1a1a; color:#00ff00; font-family:monospace; white-space:pre-wrap;'></div>
function loadBrain() {
  document.getElementById('brain-display').style.display = 'block';
  fetch('/admin/brain-status').then(r => r.json()).then(data => {
    document.getElementById('brain-display').innerText = data.report;
  });
}