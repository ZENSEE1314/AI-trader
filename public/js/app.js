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
    summaryTotalPnl: $('#summary-total-pnl'),
    summary24hPnl:   $('#summary-24h-pnl'),
    summary7dPnl:    $('#summary-7d-pnl'),
    summaryWinRate:  $('#summary-win-rate'),
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
    const data = await res.json();
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
    const allTabs = ['dashboard', 'keys', 'subscription', 'wallet', 'logs', 'admin'];
    allTabs.forEach(t => {
      const el = $(`#tab-${t}`);
      if (el) el.classList.toggle('hidden', t !== tab);
    });

    if (tab === 'dashboard') { loadDashboard(); startDashboardRefresh(); }
    else if (tab === 'keys') loadKeys();
    else if (tab === 'subscription') loadSubscription();
    else if (tab === 'wallet') loadWallet();
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
      const [summary] = await Promise.all([
        api('GET', '/api/dashboard/summary'),
        loadTrades(),
      ]);
      renderSummary(summary);
    } catch (err) {
      showToast('Failed to load dashboard.', 'error');
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
    els.summaryWinRate.textContent = `${s.win_rate}%  (${wins}W / ${losses}L)`;
    els.summaryOpenTrades.textContent = s.open_trades;

    const totalWon = parseFloat(s.total_won) || 0;
    const totalLost = parseFloat(s.total_lost) || 0;
    els.summaryTotalWon.textContent = `+$${totalWon.toFixed(2)}`;
    els.summaryTotalLost.textContent = `-$${Math.abs(totalLost).toFixed(2)}`;
  }

  async function loadTrades() {
    const data = await api('GET', `/api/dashboard/trades?page=${state.tradesPage}`);
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
  }

  // ----- API Keys -----

  async function loadKeys() {
    try {
      const keys = await api('GET', '/api/keys');
      renderKeys(keys);
    } catch (err) {
      showToast('Failed to load API keys.', 'error');
    }
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
      const allowedCoins = k.allowed_coins || '';
      const bannedCoins = k.banned_coins || '';

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
                <span class="slider-value" id="leverage-val-${k.id}">${leverage}x</span>
              </div>
              <input type="range" id="leverage-${k.id}" min="1" max="125" value="${leverage}"
                oninput="document.getElementById('leverage-val-${k.id}').textContent=this.value+'x'"
                aria-label="Leverage">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="risk-${k.id}">Risk per Trade</label>
                <span class="slider-value" id="risk-val-${k.id}">${riskPct}%</span>
              </div>
              <input type="range" id="risk-${k.id}" min="1" max="20" value="${riskPct}"
                oninput="document.getElementById('risk-val-${k.id}').textContent=this.value+'%'"
                aria-label="Risk percentage">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="maxloss-${k.id}">Max Loss per Trade</label>
                <span class="slider-value" id="maxloss-val-${k.id}">${maxLoss}%</span>
              </div>
              <input type="range" id="maxloss-${k.id}" min="1" max="100" value="${maxLoss}"
                oninput="document.getElementById('maxloss-val-${k.id}').textContent=this.value+'%'"
                aria-label="Max loss percentage">
            </div>
            <div class="slider-group">
              <div class="slider-header">
                <label class="form-label" for="maxpos-${k.id}">Max Open Trades</label>
                <span class="slider-value" id="maxpos-val-${k.id}">${maxPos}</span>
              </div>
              <input type="range" id="maxpos-${k.id}" min="1" max="10" value="${maxPos}"
                oninput="document.getElementById('maxpos-val-${k.id}').textContent=this.value"
                aria-label="Max concurrent positions">
            </div>
            <div class="form-group" style="margin-bottom:0;grid-column:1/-1;">
              <label class="form-label">Only Trade These Coins <span style="font-weight:400;color:var(--color-text-muted);">(empty = all)</span></label>
              <div class="coin-chips" id="allowed-chips-${k.id}">${buildChips(allowedCoins, k.id, 'allowed')}</div>
              <div style="position:relative;">
                <input class="form-input text-mono" type="text" id="allowed-search-${k.id}" placeholder="Search coin..." autocomplete="off" style="font-size:0.8rem;" oninput="window.CryptoBot.searchCoins(this,${k.id},'allowed')" onfocus="window.CryptoBot.searchCoins(this,${k.id},'allowed')">
                <div class="coin-dropdown hidden" id="allowed-dropdown-${k.id}"></div>
              </div>
            </div>
            <div class="form-group" style="margin-bottom:0;grid-column:1/-1;">
              <label class="form-label">Ban These Coins</label>
              <div class="coin-chips" id="banned-chips-${k.id}">${buildChips(bannedCoins, k.id, 'banned')}</div>
              <div style="position:relative;">
                <input class="form-input text-mono" type="text" id="banned-search-${k.id}" placeholder="Search coin to ban..." autocomplete="off" style="font-size:0.8rem;" oninput="window.CryptoBot.searchCoins(this,${k.id},'banned')" onfocus="window.CryptoBot.searchCoins(this,${k.id},'banned')">
                <div class="coin-dropdown hidden" id="banned-dropdown-${k.id}"></div>
              </div>
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
    const allowedCoins = getChipValues(`allowed-chips-${keyId}`);
    const bannedCoins = getChipValues(`banned-chips-${keyId}`);

    try {
      await api('PUT', `/api/keys/${keyId}/settings`, {
        leverage,
        risk_pct: riskPct,
        max_loss_usdt: maxLossUsdt,
        max_positions: maxPositions,
        enabled,
        allowed_coins: allowedCoins,
        banned_coins: bannedCoins,
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

  // ----- Subscription -----

  async function loadSubscription() {
    try {
      const data = await api('GET', '/api/subscription/status');
      const el = $('#sub-status-text');
      const paySection = $('#sub-pay-section');

      // Build status display for both plans
      let statusHtml = '';

      // Bot plan status
      if (data.active) {
        const exp = new Date(data.subscription.expires_at);
        const days = data.days_left;
        const expStr = exp.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
        const daysColor = days <= 5 ? 'var(--color-danger)' : days <= 10 ? '#f0a030' : 'var(--color-accent)';
        statusHtml += `<div style="display:flex;align-items:center;gap:var(--space-4);flex-wrap:wrap;margin-bottom:var(--space-3);">` +
          `<div><span style="color:var(--color-accent);font-size:1rem;">&#10003; Auto Trading Bot</span><br>` +
          `<span style="color:var(--color-text-muted);font-size:0.8rem;">Expires: ${expStr}</span></div>` +
          `<div style="text-align:center;"><span style="font-size:1.8rem;font-weight:700;color:${daysColor};font-family:var(--font-display);">${days}</span><br>` +
          `<span style="color:var(--color-text-muted);font-size:0.75rem;">days left</span></div></div>`;
      } else {
        statusHtml += `<div style="margin-bottom:var(--space-3);"><span style="color:var(--color-danger);">&#10007; Auto Trading Bot — Inactive</span></div>`;
      }

      // Signal plan status
      if (data.signal_active) {
        const exp = new Date(data.signal_sub.expires_at);
        const days = data.signal_days_left;
        const expStr = exp.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
        const daysColor = days <= 5 ? 'var(--color-danger)' : days <= 10 ? '#f0a030' : '#d4af37';
        statusHtml += `<div style="display:flex;align-items:center;gap:var(--space-4);flex-wrap:wrap;">` +
          `<div><span style="color:#d4af37;font-size:1rem;">&#10003; VIP Telegram Signals</span><br>` +
          `<span style="color:var(--color-text-muted);font-size:0.8rem;">Expires: ${expStr}</span></div>` +
          `<div style="text-align:center;"><span style="font-size:1.8rem;font-weight:700;color:${daysColor};font-family:var(--font-display);">${days}</span><br>` +
          `<span style="color:var(--color-text-muted);font-size:0.75rem;">days left</span></div></div>`;
      }

      if (!data.active && !data.signal_active) {
        statusHtml = `<span style="color:var(--color-danger);font-size:1.1rem;">&#10007; No Active Subscription</span><br>` +
          `<span style="color:var(--color-text-muted);font-size:0.85rem;">Choose a plan below to get started</span>`;
      }

      el.innerHTML = statusHtml;

      // Update prices on plan cards
      const botPriceEl = $('#sub-bot-price');
      const sigPriceEl = $('#sub-signal-price');
      if (botPriceEl) botPriceEl.textContent = `$${data.price}/mo`;
      if (sigPriceEl) sigPriceEl.textContent = `$${data.signal_price}/mo`;

      // Pre-fill telegram ID
      const tgInput = $('#sub-telegram-id');
      if (tgInput && data.telegram_id) tgInput.value = data.telegram_id;

      paySection.classList.remove('hidden');
      $('#sub-wallet-bal').textContent = `$${data.wallet_balance.toFixed(2)}`;
      const bankInfo = data.bank_details;
      $('#sub-bank-info').textContent = `${bankInfo.bank} | ${bankInfo.account} | ${bankInfo.name}`;
    } catch (err) {
      showToast('Failed to load subscription.', 'error');
    }
  }

  function selectPlan(plan) {
    state.selectedPlan = plan;
    const botCard = $('#plan-card-bot');
    const sigCard = $('#plan-card-signal');
    const tgSection = $('#sub-telegram-section');
    if (botCard) botCard.style.borderColor = plan === 'bot' ? 'var(--color-accent)' : 'var(--color-border-muted)';
    if (sigCard) sigCard.style.borderColor = plan === 'signal' ? '#d4af37' : 'var(--color-border-muted)';
    if (tgSection) tgSection.classList.toggle('hidden', plan !== 'signal');
  }

  async function saveTelegramId() {
    const tid = $('#sub-telegram-id').value.trim();
    if (!tid) return showToast('Enter your Telegram ID', 'error');
    try {
      await api('POST', '/api/subscription/telegram-id', { telegram_id: tid });
      showToast('Telegram ID saved', 'success');
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function payWithWallet() {
    if (state.selectedPlan === 'signal') await saveTelegramId();
    try {
      const data = await api('POST', '/api/subscription/pay-wallet', { plan: state.selectedPlan });
      showToast(data.message, 'success');
      loadSubscription();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function payBankTransfer() {
    if (state.selectedPlan === 'signal') await saveTelegramId();
    const proof = $('#sub-proof-url').value.trim();
    if (!proof) return showToast('Paste proof URL first', 'error');
    try {
      const data = await api('POST', '/api/subscription/bank-transfer', { proof_url: proof, plan: state.selectedPlan });
      showToast(data.message, 'success');
      $('#sub-proof-url').value = '';
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function payStripe() {
    if (state.selectedPlan === 'signal') await saveTelegramId();
    try {
      const data = await api('POST', '/api/subscription/stripe-checkout', { plan: state.selectedPlan });
      if (data.url) window.location.href = data.url;
    } catch (err) { showToast(err.message, 'error'); }
  }

  // ----- Wallet -----

  async function loadWallet() {
    try {
      const [balance, txns] = await Promise.all([
        api('GET', '/api/wallet/balance'),
        api('GET', '/api/wallet/transactions'),
      ]);
      $('#wallet-balance').textContent = `$${balance.balance.toFixed(2)}`;
      $('#wallet-commission').textContent = `$${balance.total_commission.toFixed(2)}`;
      $('#wallet-referrals').textContent = balance.referral_count;

      const appUrl = window.location.origin;
      $('#referral-link').value = `${appUrl}/?ref=${balance.referral_code}`;

      const tbody = $('#wallet-txns-tbody');
      if (!txns.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--color-text-muted);">No transactions yet</td></tr>';
      } else {
        tbody.innerHTML = txns.map(t => `<tr>
          <td>${formatDate(t.created_at)}</td>
          <td>${escapeHtml(t.type)}</td>
          <td class="text-mono ${parseFloat(t.amount) >= 0 ? 'positive' : 'negative'}">${parseFloat(t.amount) >= 0 ? '+' : ''}$${parseFloat(t.amount).toFixed(2)}</td>
          <td>${escapeHtml(t.description || '')}</td>
        </tr>`).join('');
      }
    } catch (err) { showToast('Failed to load wallet.', 'error'); }
  }

  async function requestWithdraw() {
    const amount = parseFloat($('#wd-amount').value);
    const bank_name = $('#wd-bank').value.trim();
    const account_number = $('#wd-accno').value.trim();
    const account_name = $('#wd-accname').value.trim();
    if (!amount || !bank_name || !account_number || !account_name) {
      return showToast('Fill in all fields', 'error');
    }
    try {
      const data = await api('POST', '/api/wallet/withdraw', { amount, bank_name, account_number, account_name });
      showToast(data.message, 'success');
      $('#wd-amount').value = '';
      $('#wd-bank').value = '';
      $('#wd-accno').value = '';
      $('#wd-accname').value = '';
      loadWallet();
    } catch (err) { showToast(err.message, 'error'); }
  }

  // ----- Admin -----

  async function loadAdmin() {
    if (!state.user?.is_admin) return;
    try {
      const [users, subs, wds, settings] = await Promise.all([
        api('GET', '/api/admin/users'),
        api('GET', '/api/admin/subscriptions'),
        api('GET', '/api/admin/withdrawals'),
        api('GET', '/api/admin/settings'),
      ]);
      renderAdminUsers(users);
      renderAdminSubs(subs);
      renderAdminWithdrawals(wds);
      // Fill settings fields
      $('#admin-price').value = settings.sub_price || '29.99';
      $('#admin-signal-price').value = settings.signal_price || '500';
      $('#admin-tier1').value = settings.commission_tier1 || '20';
      $('#admin-tier2').value = settings.commission_tier2 || '10';
      $('#admin-tier3').value = settings.commission_tier3 || '5';
    } catch (err) { showToast('Failed to load admin.', 'error'); }
  }

  async function saveAdminSettings() {
    try {
      await api('PUT', '/api/admin/settings', {
        sub_price: $('#admin-price').value,
        signal_price: $('#admin-signal-price').value,
        commission_tier1: $('#admin-tier1').value,
        commission_tier2: $('#admin-tier2').value,
        commission_tier3: $('#admin-tier3').value,
      });
      showToast('Settings saved', 'success');
    } catch (err) { showToast(err.message, 'error'); }
  }

  function renderAdminUsers(users) {
    $('#admin-users-tbody').innerHTML = users.map(u => {
      const bal = parseFloat(u.wallet_balance || 0).toFixed(2);
      return `<tr>
      <td>${escapeHtml(u.email)}${u.is_admin ? ' <b>(admin)</b>' : ''}</td>
      <td>${u.sub_status === 'active' ? '<span style="color:var(--color-accent);">Active</span>' : (u.sub_status || 'None')}</td>
      <td>${u.key_count}</td>
      <td class="text-mono">$${bal} <button class="btn btn-ghost btn-sm" style="font-size:0.7rem;padding:2px 6px;" onclick="window.CryptoBot.adminEditWallet(${u.id},'${escapeHtml(u.email)}',${bal})">Edit</button></td>
      <td>${escapeHtml(u.referral_code || '-')}</td>
      <td>${formatDate(u.created_at)}</td>
      <td>
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
    if (!e.target.closest('.coin-dropdown') && !e.target.matches('[id*="-search-"]')) {
      $$('.coin-dropdown').forEach(d => d.classList.add('hidden'));
    }
  });

  // ----- Platform change (show Bitunix IP info) -----
  let serverIpLoaded = false;

  function onPlatformChange(val) {
    const ipInfo = $('#bitunix-ip-info');
    if (!ipInfo) return;
    if (val === 'bitunix') {
      ipInfo.classList.remove('hidden');
      if (!serverIpLoaded) {
        fetch('/api/server-ip').then(r => r.json()).then(data => {
          const el = $('#server-ip-display');
          if (el && data.ip) el.value = data.ip;
          serverIpLoaded = true;
        }).catch(() => {});
      }
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
  window.CryptoBot = {
    toggleSettings, saveSettings, deleteKey, showToast,
    payWithWallet, payBankTransfer, payStripe, requestWithdraw,
    adminAction, adminSub, adminWd, saveAdminSettings, adminEditWallet, clearErrors,
    goToAuth, selectPlan, showLoginForm, onPlatformChange,
    searchCoins, addCoin, removeCoin,
    filterLogs, clearLogs,
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

    // Load landing page prices
    fetch('/api/subscription/prices').then(r => r.json()).then(data => {
      const bp = $('#landing-bot-price');
      const sp = $('#landing-signal-price');
      if (bp && data.price) bp.innerHTML = `$${data.price}<span>/month</span>`;
      if (sp && data.signal_price) sp.innerHTML = `$${data.signal_price}<span>/month</span>`;
    }).catch(() => {});

    checkSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
