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
    const allTabs = ['dashboard', 'keys', 'cashwallet', 'chart', 'logs', 'admin'];
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
    else if (tab === 'admin') loadAdmin();

    // Stop polling when leaving tabs
    if (tab !== 'logs') stopLogPolling();
    if (tab !== 'dashboard') stopDashboardRefresh();
  }

  // ----- Auth -----

  async function checkSession() {
    try {
      const data = await api('GET', '/api/auth/me');
      state.user = data;
      els.userEmail.textContent = data.email;
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
      if (cashData) renderDashCashWallet(cashData);
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

  function renderWallets(data) {
    const wallets = data.wallets || [];
    const totalBal = parseFloat(data.balance) || 0;
    const grid = els.walletsGrid;
    if (!grid) return;

    const platformIcon = (p) => p === 'binance' ? '🟡' : p === 'bitunix' ? '🔵' : '⚪';

    let html = `<div class="summary-card">
      <span class="summary-card-label">Total Futures Wallet</span>
      <span class="summary-card-value text-mono" style="color:var(--color-accent);font-size:1.3rem">$${totalBal.toFixed(2)}</span>
    </div>`;

    for (const w of wallets) {
      const bal = parseFloat(w.balance) || 0;
      const avail = parseFloat(w.available) || 0;
      const pnl = parseFloat(w.unrealizedPnl) || 0;
      const pnlColor = pnl >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
      const pnlSign = pnl >= 0 ? '+' : '';

      html += `<div class="summary-card" style="padding:var(--space-3)">
        <span class="summary-card-label">${platformIcon(w.platform)} ${w.platform.toUpperCase()}</span>
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

  function renderWeeklyEarnings(data) {
    const el = (id) => document.getElementById(id);
    const userShare = parseFloat(data.user_share) || 0;
    const adminShare = parseFloat(data.admin_share) || 0;
    const totalWinning = parseFloat(data.winning_pnl) || 0;

    el('we-user-pct').textContent = data.user_share_pct || 60;
    el('we-admin-pct').textContent = data.admin_share_pct || 40;
    el('we-user-share').textContent = `$${userShare.toFixed(2)}`;
    el('we-admin-share').textContent = `$${adminShare.toFixed(2)}`;
    el('we-total-winning').textContent = `$${totalWinning.toFixed(2)}`;
    el('we-wins').textContent = data.total_wins || 0;
    el('we-losses').textContent = data.total_losses || 0;

    const totalTrades = (data.total_wins || 0) + (data.total_losses || 0);
    const winRate = totalTrades > 0 ? ((data.total_wins / totalTrades) * 100).toFixed(0) : '0';
    el('we-week-record').textContent = `${winRate}% WR`;

    // Per-key breakdown
    const perKeyEl = el('we-per-key');
    if (data.per_key && data.per_key.length > 1) {
      perKeyEl.innerHTML = data.per_key.map(k => {
        const pnl = parseFloat(k.winning_pnl) || 0;
        const us = parseFloat(k.user_share) || 0;
        return `<div class="summary-card" style="padding:var(--space-3);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div>
            <strong style="font-size:0.85rem;">${escapeHtml(k.label || k.platform)}</strong>
            <span style="font-size:0.75rem;color:var(--color-text-muted);margin-left:8px;">${k.win_count}W / ${k.loss_count}L</span>
          </div>
          <div style="text-align:right;">
            <span class="text-mono" style="color:var(--color-success);font-size:0.9rem;">+$${pnl.toFixed(2)}</span>
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
      const pnl = parseFloat(t.pnl_usdt) || 0;
      const direction = (t.direction || t.side || '').toUpperCase();
      const isLong = direction === 'LONG' || direction === 'BUY';
      const dirBadge = isLong ? 'badge-long' : 'badge-short';
      const dirLabel = isLong ? 'Long' : 'Short';

      const isError = t.status === 'ERROR';
      const errorTip = isError && t.error_msg ? ` title="${escapeHtml(t.error_msg)}"` : '';
      const statusClass = isError ? 'badge-error' : (t.status === 'OPEN' ? 'badge-open' : (t.status === 'TP' ? 'badge-tp' : (t.status === 'SL' ? 'badge-sl' : '')));

      return `<tr${isError ? ' style="opacity:0.6;"' : ''}>
        <td>${formatDate(t.created_at)}</td>
        <td><strong>${escapeHtml(t.symbol || '--')}</strong></td>
        <td><span class="badge ${dirBadge}">${dirLabel}</span></td>
        <td class="text-mono">${t.entry_price != null ? parseFloat(t.entry_price).toFixed(4) : '--'}</td>
        <td class="text-mono text-danger">${t.sl_price != null ? parseFloat(t.sl_price).toFixed(4) : '--'}</td>
        <td class="text-mono text-success">${t.tp_price != null ? parseFloat(t.tp_price).toFixed(4) : '--'}</td>
        <td class="pnl-value ${pnl >= 0 ? 'text-success' : 'text-danger'}">${formatPnl(pnl)}</td>
        <td><span class="badge-status ${statusClass}"${errorTip}>${escapeHtml(t.status || '--')}${isError ? ' ⚠️' : ''}</span></td>
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
    const sel = $(`#risk-level-${keyId}`);
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Select Risk Level --</option>' +
      riskLevelsCache.map(rl =>
        `<option value="${rl.id}" ${rl.id === selectedId ? 'selected' : ''}>${escapeHtml(rl.name)} (TP:${(parseFloat(rl.tp_pct)*100).toFixed(1)}% SL:${(parseFloat(rl.sl_pct)*100).toFixed(1)}% Lev:${rl.max_leverage}x)</option>`
      ).join('');
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
      const maxConsecLoss = k.max_consec_loss || 2;

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
          <div class="settings-grid">
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="leverage-${k.id}">Leverage</label>
                <input type="number" class="slider-num" id="leverage-num-${k.id}" min="1" max="125" step="1" value="${leverage}"
                  oninput="window.CryptoBot.syncSlider('leverage-${k.id}',this.value)">
              </div>
              <input type="range" id="leverage-${k.id}" min="1" max="125" value="${leverage}"
                oninput="window.CryptoBot.syncNum('leverage-num-${k.id}',this.value)"
                aria-label="Leverage">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="risk-${k.id}">Risk per Trade (%)</label>
                <input type="number" class="slider-num" id="risk-num-${k.id}" min="1" max="20" step="1" value="${riskPct}"
                  oninput="window.CryptoBot.syncSlider('risk-${k.id}',this.value)">
              </div>
              <input type="range" id="risk-${k.id}" min="1" max="20" value="${riskPct}"
                oninput="window.CryptoBot.syncNum('risk-num-${k.id}',this.value)"
                aria-label="Risk percentage">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="maxloss-${k.id}">Max Loss per Trade (%)</label>
                <input type="number" class="slider-num" id="maxloss-num-${k.id}" min="1" max="100" step="1" value="${maxLoss}"
                  oninput="window.CryptoBot.syncSlider('maxloss-${k.id}',this.value)">
              </div>
              <input type="range" id="maxloss-${k.id}" min="1" max="100" value="${maxLoss}"
                oninput="window.CryptoBot.syncNum('maxloss-num-${k.id}',this.value)"
                aria-label="Max loss percentage">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="maxpos-${k.id}">Max Open Trades</label>
                <input type="number" class="slider-num" id="maxpos-num-${k.id}" min="1" max="10" step="1" value="${maxPos}"
                  oninput="window.CryptoBot.syncSlider('maxpos-${k.id}',this.value)">
              </div>
              <input type="range" id="maxpos-${k.id}" min="1" max="10" value="${maxPos}"
                oninput="window.CryptoBot.syncNum('maxpos-num-${k.id}',this.value)"
                aria-label="Max concurrent positions">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="tp-${k.id}">Take Profit %</label>
                <input type="number" class="slider-num" id="tp-num-${k.id}" min="0.5" max="20" step="0.1" value="${tpPct}"
                  oninput="window.CryptoBot.syncSlider('tp-${k.id}',Math.round(this.value*10))">
              </div>
              <input type="range" id="tp-${k.id}" min="5" max="200" value="${Math.round(tpPct * 10)}"
                oninput="window.CryptoBot.syncNum('tp-num-${k.id}',(this.value/10).toFixed(1))"
                aria-label="Take profit percentage">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="sl-${k.id}">Stop Loss %</label>
                <input type="number" class="slider-num" id="sl-num-${k.id}" min="0.5" max="10" step="0.1" value="${slPct}"
                  oninput="window.CryptoBot.syncSlider('sl-${k.id}',Math.round(this.value*10))">
              </div>
              <input type="range" id="sl-${k.id}" min="5" max="100" value="${Math.round(slPct * 10)}"
                oninput="window.CryptoBot.syncNum('sl-num-${k.id}',(this.value/10).toFixed(1))"
                aria-label="Stop loss percentage">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="maxloss-streak-${k.id}">Stop After Losses</label>
                <input type="number" class="slider-num" id="maxloss-streak-num-${k.id}" min="1" max="10" step="1" value="${maxConsecLoss}"
                  oninput="window.CryptoBot.syncSlider('maxloss-streak-${k.id}',this.value)">
              </div>
              <input type="range" id="maxloss-streak-${k.id}" min="1" max="10" value="${maxConsecLoss}"
                oninput="window.CryptoBot.syncNum('maxloss-streak-num-${k.id}',this.value)"
                aria-label="Max consecutive losses before stopping">
            </div>
            <div class="form-group" style="margin-bottom:0;grid-column:1/-1;">
              <label class="form-label">Ban These Coins <span style="font-weight:400;color:var(--color-text-muted);">(select from available tokens)</span></label>
              <div class="coin-chips" id="banned-chips-${k.id}">${buildChips(bannedCoins, k.id, 'banned')}</div>
              <div style="position:relative;">
                <input class="form-input text-mono" type="text" id="banned-search-${k.id}" placeholder="Type to search available tokens..." autocomplete="off" style="font-size:0.8rem;" oninput="window.CryptoBot.searchUserBanToken(this,${k.id})" onfocus="window.CryptoBot.searchUserBanToken(this,${k.id})">
                <div class="coin-dropdown hidden" id="banned-dropdown-${k.id}"></div>
              </div>
            </div>
            <!-- Risk Level -->
            <div class="form-group" style="margin-bottom:0;grid-column:1/-1;">
              <label class="form-label">Risk Level</label>
              <select class="form-input" id="risk-level-${k.id}" style="max-width:250px;">
                <option value="">-- Select Risk Level --</option>
              </select>
              <span style="font-size:0.7rem;color:var(--color-text-muted);">Overrides TP/SL/leverage with preset values</span>
            </div>
            <!-- Per-Token Leverage -->
            <div class="form-group" style="margin-bottom:0;grid-column:1/-1;">
              <label class="form-label">Per-Token Leverage</label>
              <div id="token-lev-${k.id}" style="margin-bottom:8px;"></div>
              <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;">
                <input class="form-input text-mono" type="text" id="token-lev-symbol-${k.id}" placeholder="BTCUSDT" style="width:120px;font-size:0.8rem;text-transform:uppercase;">
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
      const [status, txns, withdrawals] = await Promise.all([
        api('GET', '/api/subscription/status'),
        api('GET', '/api/subscription/transactions').catch(() => []),
        api('GET', '/api/subscription/withdrawals').catch(() => []),
      ]);

      // Summary cards
      const cashWallet = parseFloat(status.cash_wallet) || 0;
      const commission = parseFloat(status.commission_earned) || 0;
      $('#cw-cash').textContent = `$${cashWallet.toFixed(2)}`;
      $('#cw-commission').textContent = `$${commission.toFixed(2)}`;

      // Platform USDT address for top-ups
      if (status.platform_usdt_address) {
        const addrBox = $('#cw-platform-addr');
        if (addrBox) addrBox.classList.remove('hidden');
        const addrVal = $('#cw-platform-addr-val');
        if (addrVal) addrVal.value = status.platform_usdt_address;
        const netEl = $('#cw-platform-net');
        if (netEl) netEl.textContent = `Network: ${status.platform_usdt_network || 'BEP20'}`;
      }

      // Referral
      const appUrl = window.location.origin;
      $('#referral-link').value = `${appUrl}/?ref=${status.referral_code}`;
      $('#cw-ref-count').textContent = status.referral_count;

      // USDT address
      if (status.usdt_address) {
        $('#cw-usdt-addr').value = status.usdt_address;
        $('#cw-usdt-net').value = status.usdt_network || 'BEP20';
        $('#cw-wd-address-display').textContent = `Sending to: ${status.usdt_address.slice(0, 10)}...${status.usdt_address.slice(-6)} (${status.usdt_network})`;
      }

      // Transaction history
      const typeColors = {
        topup: 'var(--color-success)', commission: 'var(--color-accent)',
        withdrawal: 'var(--color-danger)', topup_pending: '#f0a030',
        topup_rejected: 'var(--color-danger)', commission_transfer: 'var(--color-text-muted)',
        refund: 'var(--color-success)', profit_share: 'var(--color-success)',
        platform_fee: '#f0a030',
      };
      const typeLabels = {
        topup: 'Top Up', commission: 'Commission', withdrawal: 'Withdrawal',
        topup_pending: 'Top Up (Pending)', topup_rejected: 'Top Up (Rejected)',
        commission_transfer: 'Transfer', refund: 'Refund', admin_adjustment: 'Admin Adjust',
        profit_share: 'Profit Share (60%)', platform_fee: 'Platform Fee (40%)',
      };

      const tbody = $('#cw-txns-tbody');
      if (!txns.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--color-text-muted);">No transactions yet</td></tr>';
      } else {
        tbody.innerHTML = txns.map(t => {
          const amt = parseFloat(t.amount);
          return `<tr>
            <td>${formatDate(t.created_at)}</td>
            <td style="color:${typeColors[t.type] || 'var(--color-text)'}">${typeLabels[t.type] || t.type}</td>
            <td class="text-mono ${amt >= 0 ? 'positive' : 'negative'}">${amt >= 0 ? '+' : ''}$${Math.abs(amt).toFixed(2)}</td>
            <td>${escapeHtml(t.description || '')}</td>
            <td>${t.status || '-'}</td>
          </tr>`;
        }).join('');
      }

      // Withdrawal history
      const wdBody = $('#cw-wds-tbody');
      if (!withdrawals.length) {
        wdBody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--color-text-muted);">No withdrawals yet</td></tr>';
      } else {
        wdBody.innerHTML = withdrawals.map(w => {
          const statusColor = w.status === 'approved' ? 'var(--color-success)' : w.status === 'rejected' ? 'var(--color-danger)' : '#f0a030';
          return `<tr>
            <td>${formatDate(w.created_at)}</td>
            <td class="text-mono">$${parseFloat(w.amount).toFixed(2)}</td>
            <td>${escapeHtml(w.bank_name || '-')}</td>
            <td class="text-mono" style="font-size:0.8rem;">${escapeHtml((w.account_number || '').slice(0, 12))}...</td>
            <td style="color:${statusColor}">${w.status}</td>
          </tr>`;
        }).join('');
      }
    } catch (err) {
      showToast('Failed to load cash wallet.', 'error');
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

      // Load global tokens and risk levels
      loadGlobalTokens();
      loadRiskLevels();
    } catch (err) { showToast('Failed to load admin.', 'error'); }
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
      container.innerHTML = levels.map(rl => `<div style="background:var(--color-bg);border:1px solid var(--color-border-muted);border-radius:var(--radius-md);padding:var(--space-3);margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <strong style="font-size:0.9rem;">${escapeHtml(rl.name)}</strong>
          <div style="display:flex;gap:4px;">
            <button class="btn btn-danger btn-sm" style="font-size:0.7rem;" onclick="window.CryptoBot.deleteRiskLevel(${rl.id})">Delete</button>
          </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:0.8rem;color:var(--color-text-muted);">
          <span>TP: <strong class="text-mono">${(parseFloat(rl.tp_pct)*100).toFixed(1)}%</strong></span>
          <span>SL: <strong class="text-mono">${(parseFloat(rl.sl_pct)*100).toFixed(1)}%</strong></span>
          <span>Capital: <strong class="text-mono">${parseFloat(rl.capital_percentage)}%</strong></span>
          <span>Max Lev: <strong class="text-mono">${rl.max_leverage}x</strong></span>
          <span>Consec Loss: <strong class="text-mono">${rl.max_consec_loss}</strong></span>
        </div>
      </div>`).join('');
    } catch (err) { /* silent */ }
  }

  async function addRiskLevel() {
    const name = ($('#rl-name').value || '').trim();
    if (!name) return showToast('Enter a risk level name', 'error');
    try {
      await api('POST', '/api/admin/risk-levels', {
        name,
        tp_pct: parseFloat($('#rl-tp').value) || 0.01,
        sl_pct: parseFloat($('#rl-sl').value) || 0.01,
        capital_percentage: parseFloat($('#rl-capital').value) || 10,
        max_leverage: parseInt($('#rl-leverage').value) || 20,
        max_consec_loss: parseInt($('#rl-consec').value) || 2,
      });
      showToast(`${name} risk level added`, 'success');
      $('#rl-name').value = '';
      loadRiskLevels();
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

  // ----- Allowed / Banned Token Management (Admin) -----

  async function loadGlobalTokens() {
    try {
      const tokens = await api('GET', '/api/admin/global-tokens');
      const allowed = tokens.filter(t => t.enabled && !t.banned);
      const banned = tokens.filter(t => t.banned);

      const allowedBody = $('#admin-allowed-tbody');
      const allowedEmpty = $('#admin-allowed-empty');
      if (!allowed.length) {
        allowedBody.innerHTML = '';
        allowedEmpty.classList.remove('hidden');
      } else {
        allowedEmpty.classList.add('hidden');
        allowedBody.innerHTML = allowed.map(t => `<tr>
          <td class="text-mono"><strong>${escapeHtml(t.symbol)}</strong></td>
          <td><button class="btn btn-ghost btn-sm" style="font-size:0.7rem;" onclick="window.CryptoBot.removeGlobalToken('${escapeHtml(t.symbol)}')">Remove</button></td>
        </tr>`).join('');
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
          <td><button class="btn btn-primary btn-sm" style="font-size:0.7rem;" onclick="window.CryptoBot.unbanGlobalToken('${escapeHtml(t.symbol)}')">Unban</button></td>
        </tr>`).join('');
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
    try {
      await api('DELETE', `/api/admin/global-tokens/${symbol}`);
      showToast(`${symbol} unbanned`, 'success');
      loadGlobalTokens();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function removeGlobalToken(symbol) {
    try {
      await api('DELETE', `/api/admin/global-tokens/${symbol}`);
      showToast(`${symbol} removed`, 'success');
      loadGlobalTokens();
    } catch (err) { showToast(err.message, 'error'); }
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
    el('awe-total-winning').textContent = `$${(parseFloat(data.grand_total_winning) || 0).toFixed(2)}`;
    el('awe-admin-share').textContent = `$${(parseFloat(data.grand_total_admin_share) || 0).toFixed(2)}`;
    el('awe-user-share').textContent = `$${(parseFloat(data.grand_total_user_share) || 0).toFixed(2)}`;

    const container = document.getElementById('admin-earnings-per-user');
    if (!data.users || data.users.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = data.users.filter(u => u.keys.length > 0).map(u => {
      const keysHtml = u.keys.map(k => {
        const isPaused = k.paused || !k.enabled;
        return `<div style="background:var(--color-bg);border:1px solid var(--color-border-muted);border-radius:var(--radius-md);padding:var(--space-3);margin-top:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <div>
              <strong style="font-size:0.8rem;">${escapeHtml(k.label)}</strong>
              <span style="font-size:0.7rem;color:var(--color-text-muted);margin-left:4px;">${k.platform?.toUpperCase()}</span>
              ${isPaused ? '<span class="badge-status" style="color:var(--color-danger);margin-left:4px;">⏸ PAUSED</span>' : ''}
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="text-mono" style="font-size:0.85rem;color:var(--color-success);">+$${(parseFloat(k.winning_pnl)||0).toFixed(2)}</span>
              <span style="font-size:0.7rem;color:var(--color-text-muted);">${k.win_count}W</span>
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
            User earns: <strong style="color:var(--color-success);">$${(parseFloat(k.user_share)||0).toFixed(2)}</strong> ·
            Admin earns: <strong style="color:var(--color-accent);">$${(parseFloat(k.admin_share)||0).toFixed(2)}</strong>
          </div>
        </div>`;
      }).join('');

      return `<div style="background:var(--color-bg-raised);border:1px solid var(--color-border-muted);border-radius:var(--radius-lg);padding:var(--space-4);margin-bottom:var(--space-3);">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div>
            <strong style="font-size:0.95rem;">${escapeHtml(u.email)}</strong>
            <span style="font-size:0.75rem;color:var(--color-text-muted);margin-left:8px;">${u.total_trades} trades · ${u.total_wins}W</span>
          </div>
          <div style="text-align:right;">
            <div class="text-mono" style="font-size:0.9rem;color:var(--color-success);">Winnings: $${(parseFloat(u.total_winning_pnl)||0).toFixed(2)}</div>
            <div style="font-size:0.7rem;color:var(--color-text-muted);">
              Admin: <span style="color:var(--color-accent);">$${(parseFloat(u.total_admin_share)||0).toFixed(2)}</span> ·
              User: <span style="color:var(--color-success);">$${(parseFloat(u.total_user_share)||0).toFixed(2)}</span>
            </div>
          </div>
        </div>
        ${keysHtml}
      </div>`;
    }).join('');
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
      return `<tr>
      <td>${escapeHtml(u.email)}${u.is_admin ? ' <b>(admin)</b>' : ''}</td>
      <td>${u.key_count}</td>
      <td class="text-mono">$${bal} <button class="btn btn-ghost btn-sm" style="font-size:0.7rem;padding:2px 6px;" onclick="window.CryptoBot.adminEditWallet(${u.id},'${escapeHtml(u.email)}',${bal})">Edit</button></td>
      <td>${escapeHtml(u.referral_code || '-')}</td>
      <td>${formatDate(u.created_at)}</td>
      <td style="white-space:nowrap;">
        ${u.is_blocked
          ? `<button class="btn btn-primary btn-sm" onclick="window.CryptoBot.adminAction('unblock',${u.id})">Unblock</button>`
          : `<button class="btn btn-danger btn-sm" onclick="window.CryptoBot.adminAction('block',${u.id})">Block</button>`}
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
    const ipInfo = $('#static-ip-info');
    const noteEl = $('#ip-platform-note');
    if (!ipInfo || !noteEl) return;
    if (val === 'binance') {
      ipInfo.classList.remove('hidden');
      noteEl.innerHTML = '<strong>Binance:</strong> Add both IPs to your API key whitelist, or you can also <strong>disable IP restriction</strong> in your Binance API settings.';
    } else if (val === 'bitunix') {
      ipInfo.classList.remove('hidden');
      noteEl.innerHTML = '<strong>Bitunix:</strong> Add both IPs to your Bitunix API key "Bind IP address" field.';
    } else {
      ipInfo.classList.add('hidden');
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

  window.CryptoBot = {
    toggleSettings, saveSettings, deleteKey, showToast, syncSlider, syncNum,
    submitTopUp, saveUsdtAddress, withdrawFromWallet,
    adminAction, adminSub, adminWd, saveAdminSettings, adminEditWallet, clearErrors,
    adminEditSplit, adminPauseKey, adminResumeKey,
    goToAuth, showLoginForm, onPlatformChange,
    searchCoins, addCoin, removeCoin,
    filterLogs, clearLogs,
    addTokenLeverage, removeTokenLeverage,
    addAllowedToken, addBannedToken, unbanGlobalToken, removeGlobalToken,
    searchAdminToken, pickAdminToken, searchUserBanToken,
    addRiskLevel, deleteRiskLevel,
    fixBitunixPnl,
  };

  // ----- Init -----

  function init() {
    setupAuthTabs();
    setupAuthForms();
    setupLogout();
    setupNavTabs();
    setupPagination();
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
