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
    if (name === 'auth') {
      els.sectionAuth.classList.remove('hidden');
      els.sectionApp.classList.add('hidden');
    } else {
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
    els.tabDashboard.classList.toggle('hidden', tab !== 'dashboard');
    els.tabKeys.classList.toggle('hidden', tab !== 'keys');

    if (tab === 'dashboard') {
      loadDashboard();
    } else {
      loadKeys();
    }
  }

  // ----- Auth -----

  async function checkSession() {
    try {
      const data = await api('GET', '/api/auth/me');
      state.user = data;
      els.userEmail.textContent = data.email;
      showSection('app');
      switchTab('dashboard');
    } catch {
      showSection('auth');
    }
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
        await api('POST', '/api/auth/login', { email, password });
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
      try {
        await api('POST', '/api/auth/signup', { email, password });
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

    els.summaryWinRate.textContent = `${s.win_rate}%`;
    els.summaryOpenTrades.textContent = s.open_trades;
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

    els.tradesTbody.innerHTML = trades.map((t) => {
      const pnl = parseFloat(t.pnl_usdt) || 0;
      const direction = (t.direction || t.side || '').toUpperCase();
      const isLong = direction === 'LONG' || direction === 'BUY';
      const dirBadge = isLong ? 'badge-long' : 'badge-short';
      const dirLabel = isLong ? 'Long' : 'Short';

      return `<tr>
        <td>${formatDate(t.created_at)}</td>
        <td><strong>${escapeHtml(t.symbol || '--')}</strong></td>
        <td><span class="badge ${dirBadge}">${dirLabel}</span></td>
        <td class="text-mono">${t.entry_price != null ? parseFloat(t.entry_price).toFixed(4) : '--'}</td>
        <td class="text-mono text-danger">${t.sl_price != null ? parseFloat(t.sl_price).toFixed(4) : '--'}</td>
        <td class="text-mono text-success">${t.tp_price != null ? parseFloat(t.tp_price).toFixed(4) : '--'}</td>
        <td class="pnl-value ${pnl >= 0 ? 'text-success' : 'text-danger'}">${formatPnl(pnl)}</td>
        <td><span class="badge-status">${escapeHtml(t.status || '--')}</span></td>
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
      const maxLoss = k.max_loss_usdt || 50;
      const maxPos = k.max_positions || 1;

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
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label" for="maxloss-${k.id}">Max Loss (USDT)</label>
              <input class="form-input text-mono" type="number" id="maxloss-${k.id}" min="1" max="100000" step="1" value="${maxLoss}">
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
    const maxLossUsdt = parseFloat($(`#maxloss-${keyId}`).value);
    const maxPositions = parseInt($(`#maxpos-${keyId}`).value);
    const enabled = $(`#enabled-${keyId}`).checked;

    try {
      await api('PUT', `/api/keys/${keyId}/settings`, {
        leverage,
        risk_pct: riskPct,
        max_loss_usdt: maxLossUsdt,
        max_positions: maxPositions,
        enabled,
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

  // ----- Expose to inline handlers -----
  window.CryptoBot = { toggleSettings, saveSettings, deleteKey };

  // ----- Init -----

  function init() {
    setupAuthTabs();
    setupAuthForms();
    setupLogout();
    setupNavTabs();
    setupPagination();
    setupModal();
    checkSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
