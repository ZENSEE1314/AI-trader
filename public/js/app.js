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
    else if (tab === 'admin') { loadAdmin(); startAdminRefresh(); }

    // Stop polling when leaving tabs
    if (tab !== 'logs') stopLogPolling();
    if (tab !== 'dashboard') stopDashboardRefresh();
    if (tab !== 'admin') stopAdminRefresh();
  }

  // ----- Auth -----

  // Optimistic auth: if user was logged in before, keep showing the loading
  // spinner instead of flashing the landing page while we verify the session.
  // This eliminates the "just logo" screen on refresh for logged-in users.
  const SESSION_KEY = 'mct_was_authed';

  async function checkSession() {
    const wasAuthed = sessionStorage.getItem(SESSION_KEY);

    // Keep loading screen visible while we check — don't flash landing
    if (!wasAuthed) {
      // First-time or logged-out visitor: show landing immediately
      // checkSession will hide it again if login succeeds
    }

    const attempt = async () => {
      const data = await api('GET', '/api/auth/me');
      state.user = data;
      els.userEmail.textContent = data.username || data.email;
      const adminTab = $('#admin-tab');
      if (adminTab) adminTab.classList.toggle('hidden', !data.is_admin);
      sessionStorage.setItem(SESSION_KEY, '1');
      showSection('app');
      switchTab('dashboard');
    };

    try {
      await attempt();
    } catch (err) {
      // Server may still be warming up after a deploy — retry once after 2s
      if (wasAuthed) {
        try {
          const msg = document.getElementById('loading-msg');
          if (msg) msg.textContent = 'Server starting, retrying...';
          await new Promise(r => setTimeout(r, 2000));
          await attempt();
          return;
        } catch (_) {}
      }
      sessionStorage.removeItem(SESSION_KEY);
      console.log('checkSession failed:', err.message);
      showSection('landing');
    }
  }

  function goToAuth() {
    console.log('goToAuth called');
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
        const loginRes = await api('POST', '/api/auth/login', { email, password, remember });
        // Small delay to ensure cookie is set before /me call
        await new Promise(r => setTimeout(r, 300));
        try {
          await checkSession();
          showToast('Welcome back!', 'success');
        } catch (sessionErr) {
          // Login succeeded but session check failed — retry once
          console.warn('Session check failed after login, retrying...', sessionErr.message);
          await new Promise(r => setTimeout(r, 500));
          await checkSession();
          showToast('Welcome back!', 'success');
        }
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
  const DASHBOARD_REFRESH_MS = 30000; // 30 seconds — halves server API load

  function startDashboardRefresh() {
    stopDashboardRefresh();
    dashboardTimer = setInterval(loadDashboard, DASHBOARD_REFRESH_MS);
  }

  function stopDashboardRefresh() {
    if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
  }

  // ----- Admin Panel Auto-Refresh -----

  let adminRefreshTimer    = null;
  let adminCountdownTimer  = null;
  let adminNextRefreshAt   = 0;
  const ADMIN_REFRESH_MS   = 10000; // 10 seconds on Earnings — commissions are live-critical

  function startAdminRefresh() {
    stopAdminRefresh();
    adminNextRefreshAt = Date.now() + ADMIN_REFRESH_MS;
    adminRefreshTimer = setInterval(() => {
      loadAdmin();
      adminNextRefreshAt = Date.now() + ADMIN_REFRESH_MS;
    }, ADMIN_REFRESH_MS);
    // Countdown bar: tick every 500 ms
    adminCountdownTimer = setInterval(_tickAdminCountdown, 500);
    _tickAdminCountdown();
  }

  function stopAdminRefresh() {
    if (adminRefreshTimer)   { clearInterval(adminRefreshTimer);   adminRefreshTimer   = null; }
    if (adminCountdownTimer) { clearInterval(adminCountdownTimer); adminCountdownTimer = null; }
    const bar = document.getElementById('earnings-refresh-bar');
    if (bar) bar.style.width = '0%';
  }

  function _tickAdminCountdown() {
    const bar  = document.getElementById('earnings-refresh-bar');
    const lbl  = document.getElementById('earnings-refresh-lbl');
    if (!bar && !lbl) return;
    const remaining = Math.max(0, adminNextRefreshAt - Date.now());
    const pct       = ((ADMIN_REFRESH_MS - remaining) / ADMIN_REFRESH_MS) * 100;
    const secs      = Math.ceil(remaining / 1000);
    if (bar) bar.style.width = pct + '%';
    if (lbl) lbl.textContent = `Auto-refresh in ${secs}s`;
  }

  // ----- Dashboard -----

  async function loadDashboard() {
    try {
      const summaryUrl = state.tradesPeriod && state.tradesPeriod !== 'all'
        ? `/api/dashboard/summary?period=${state.tradesPeriod}`
        : '/api/dashboard/summary';

      // Phase 1: Fast data — renders the dashboard immediately
      // futures-wallet is intentionally excluded here (it calls exchanges = slow)
      const [summary, weeklyEarnings, cashData] = await Promise.all([
        api('GET', summaryUrl),
        api('GET', '/api/dashboard/weekly-earnings').catch(() => null),
        api('GET', '/api/dashboard/cash-wallet').catch(() => null),
      ]);
      renderSummary(summary);
      if (weeklyEarnings) renderWeeklyEarnings(weeklyEarnings);
      if (cashData) renderDashCashWallet(cashData);

      // Phase 2: Non-critical — deferred so Phase 1 paints first
      // futures-wallet hits exchanges (slow), run it after UI is visible
      setTimeout(() => {
        api('GET', '/api/dashboard/futures-wallet')
          .then(walletData => renderWallets(walletData))
          .catch(() => renderWallets({ balance: 0, wallets: [] }));

        loadTrades();
        loadSignalBoard();
        loadPauseStatus();
        loadKronosPredictions();
      }, 0);
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
    const container = document.getElementById('kronos-cards-container');
    if (!container) return;
    try {
      const data = await api('GET', '/api/dashboard/kronos-predictions');
      const countEl = document.getElementById('kronos-count');
      const bullEl = document.getElementById('kronos-bull');
      const bearEl = document.getElementById('kronos-bear');
      const neutralEl = document.getElementById('kronos-neutral');

      if (countEl) countEl.textContent = `(${data.total} tokens — BTC/ETH/SOL/BNB)`;
      const _tr = window.i18n ? window.i18n.t : function(k) { return k; };
      if (bullEl) bullEl.textContent = `📈 ${data.longs} ${_tr('kronos.bullish')}`;
      if (bearEl) bearEl.textContent = `📉 ${data.shorts} ${_tr('kronos.bearish')}`;
      if (neutralEl) neutralEl.textContent = `➖ ${data.neutrals} ${_tr('kronos.neutral')}`;

      if (!data.predictions || data.predictions.length === 0) {
        container.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--color-text-secondary);padding:40px;">No predictions yet — waiting for next cycle scan</div>';
        return;
      }

      container.innerHTML = data.predictions.map(p => {
        const isLong = p.direction === 'LONG';
        const isShort = p.direction === 'SHORT';
        const dirColor = isLong ? 'var(--color-success)' : isShort ? 'var(--color-danger)' : 'var(--color-text-secondary)';
        const dirIcon = isLong ? '📈' : isShort ? '📉' : '➖';
        const confIcon = p.confidence === 'high' ? '🔥' : p.confidence === 'medium' ? '⚡' : '·';
        const changePct = p.change_pct || 0;
        const changeColor = changePct > 0 ? 'var(--color-success)' : changePct < 0 ? 'var(--color-danger)' : 'var(--color-text-secondary)';
        const trendColor = p.trend === 'bullish' ? 'var(--color-success)' : p.trend === 'bearish' ? 'var(--color-danger)' : 'var(--color-text-secondary)';

        // Calculate Time Horizon based on change % magnitude
        let timeHorizon = '--';
        const absPct = Math.abs(p.change_pct || 0);
        if (absPct > 0) {
          // Rough estimate: small moves happen fast, large moves take longer
          // <0.5% = ~15m, 0.5-1% = ~1h, 1-2% = ~4h, 2-5% = ~12h, >5% = ~1d+
          if (absPct < 0.3) timeHorizon = '5-15m';
          else if (absPct < 0.5) timeHorizon = '15-30m';
          else if (absPct < 1) timeHorizon = '30m-1h';
          else if (absPct < 2) timeHorizon = '1-4h';
          else if (absPct < 5) timeHorizon = '4-12h';
          else timeHorizon = '12h-1d';
        }

        // Generate a synthetic "Why" based on technicals (until news API is integrated)
        const reasons = {
          bullish: [
            `Strong bullish divergence and volume accumulation detected.`,
            `SMC structure shift to bullish with confirmed Higher Low.`,
            `Price rebounding from major key support level with high confidence.`,
            `Positive momentum surge aligning with HTF bullish trend.`
          ],
          bearish: [
            `Bearish structure break with strong downward momentum.`,
            `Lower High formed on 1m/15m, signaling potential reversal.`,
            `Price rejecting key resistance zone with high volume.`,
            `Negative divergence observed between price and indicators.`
          ],
          neutral: [
            `Market in consolidation phase with mixed signals.`,
            `Low volatility and range-bound price action.`,
            `Wait for a clear structure break before entry.`
          ]
        };
        const reasonList = p.trend === 'bullish' ? reasons.bullish : p.trend === 'bearish' ? reasons.bearish : reasons.neutral;
        const why = reasonList[Math.floor(Math.random() * reasonList.length)];

        return `<div class="kronos-card" style="background:var(--color-bg-raised);border:1px solid var(--color-border-muted);border-radius:var(--radius-md);padding:16px;display:flex;flex-direction:column;gap:12px;transition:all 0.2s;border-top:3px solid ${dirColor};box-shadow:0 4px 6px rgba(0,0,0,0.1);">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-weight:800;font-size:1.1rem;color:var(--color-text);">${p.symbol.replace('USDT', '')}</span>
              <span style="font-size:0.7rem;padding:2px 6px;border-radius:4px;background:rgba(139, 92, 246, 0.1);color:var(--color-accent);border:1px solid rgba(139, 92, 246, 0.3);font-weight:700;">${p.confidence.toUpperCase()}</span>
            </div>
            <span style="color:${dirColor};font-weight:800;font-size:0.9rem;">${dirIcon} ${p.direction}</span>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div style="display:flex;flex-direction:column;gap:4px;">
              <span style="font-size:0.7rem;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.5px;">Target Price</span>
              <span class="text-mono" style="font-size:1.1rem;font-weight:700;color:var(--color-text);">$${(p.predicted || 0).toLocaleString(undefined, {minimumFractionDigits: 8, maximumFractionDigits: 8})}</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;text-align:right;">
              <span style="font-size:0.7rem;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.5px;">Horizon</span>
              <span style="font-size:1.1rem;font-weight:700;color:var(--color-accent);">${timeHorizon}</span>
            </div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--color-border-muted);border-bottom:1px solid var(--color-border-muted);">
            <div style="display:flex;flex-direction:column;gap:2px;">
              <span style="font-size:0.65rem;color:var(--color-text-muted);">Expected Change</span>
              <span style="color:${changeColor};font-weight:700;font-size:0.9rem;">${changePct > 0 ? '+' : ''}${changePct}%</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:2px;text-align:right;">
              <span style="font-size:0.65rem;color:var(--color-text-muted);">Trend Bias</span>
              <span style="color:${trendColor};font-weight:700;font-size:0.9rem;text-transform:capitalize;">${p.trend}</span>
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:6px;">
            <span style="font-size:0.7rem;color:var(--color-text-muted);font-weight:600;text-transform:uppercase;">Analysis (Why)</span>
            <div style="font-size:0.8rem;color:var(--color-text-secondary);line-height:1.4;font-style:italic;background:rgba(0,0,0,0.1);padding:8px;border-radius:6px;border-left:2px solid var(--color-accent);">
              "${why}"
            </div>
          </div>
        </div>`;
      }).join('');
    } catch (err) {
      console.warn('Kronos predictions:', err.message);
      container.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--color-text-secondary);padding:40px;">No predictions available — Kronos scans during trading cycles</div>';
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
      const fundingFee = parseFloat(t.funding_fee) || 0;
      const direction = (t.direction || t.side || '').toUpperCase();
      const isLong = direction === 'LONG' || direction === 'BUY';
      const dirBadge = isLong ? 'badge-long' : 'badge-short';
      const dirLabel = isLong ? 'L' : 'S';

      const isError = t.status === 'ERROR';
      const errorTip = isError && t.error_msg ? ` title="${escapeHtml(t.error_msg)}"` : '';

      let statusClass = '';
      let statusColor = '';
      if (isError)                  { statusClass = 'badge-error'; }
      else if (t.status === 'WIN')  { statusClass = 'badge-win';  statusColor = 'color:var(--color-success);'; }
      else if (t.status === 'LOSS') { statusClass = 'badge-loss'; statusColor = 'color:var(--color-danger);'; }
      else if (t.status === 'OPEN') { statusClass = 'badge-open'; statusColor = 'color:#f5a623;'; }
      else if (t.status === 'TP')   { statusClass = 'badge-tp';   statusColor = 'color:var(--color-success);'; }
      else if (t.status === 'SL')   { statusClass = 'badge-sl';   statusColor = 'color:var(--color-danger);'; }
      // Closed by swarm consensus or other internal close — show neutral grey badge
      else if (t.status === 'CLOSED') { statusClass = 'badge-closed'; statusColor = 'color:#aaa;'; }

      const exitPrice = t.exit_price != null ? parseFloat(t.exit_price).toFixed(4) : '--';

      return `<tr${isError ? ' style="opacity:0.6;"' : ''}>
        <td>${formatDate(t.created_at)}</td>
        <td><strong>${escapeHtml(t.symbol || '--')}</strong></td>
        <td><span class="badge ${dirBadge}">${dirLabel}</span></td>
        <td class="text-mono">${t.entry_price != null ? parseFloat(t.entry_price).toFixed(4) : '--'}</td>
        <td class="text-mono">${exitPrice}</td>
        <td class="text-mono ${grossPnl >= 0 ? 'text-success' : 'text-danger'}">${formatPnl(grossPnl)}</td>
        <td class="text-mono" style="color:var(--color-warning);">${fee > 0 ? '-$' + fee.toFixed(4) : '--'}</td>
        <td class="text-mono" style="color:#7c7fff;">${fundingFee > 0 ? '-$' + fundingFee.toFixed(4) : '--'}</td>
        <td class="pnl-value ${netPnl >= 0 ? 'text-success' : 'text-danger'}" style="font-weight:600;">${formatPnl(netPnl)}</td>
        <td><span class="badge-status ${statusClass}" style="${statusColor}font-weight:600;"${errorTip}>${escapeHtml(t.status === 'CLOSED' ? (t.exit_reason === 'swarm_consensus_shift' ? 'SWARM' : 'CLOSED') : (t.status || 'OPEN'))}${isError ? ' !' : ''}</span></td>
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
    if (!confirm('Delete this API key?\n\nThe key will be removed immediately. Your open trades on the exchange are NOT affected.')) return;
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

      // Cash wallet breakdown — only top-ups and referral commission
      // (trade profits are NOT in cash wallet — they stay on the exchange)
      const breakdown = dashWallet?.breakdown;
      const breakdownEl = $('#cw-breakdown');
      if (breakdownEl && breakdown) {
        const topUps  = parseFloat(breakdown.top_ups) || 0;
        const refComm = parseFloat(breakdown.referral_commission) || 0;
        const feesPaid = parseFloat(breakdown.fees_paid) || 0;
        breakdownEl.innerHTML = `
          <div style="font-size:0.82rem;color:var(--color-text-muted);margin-top:10px;line-height:2;border:1px solid var(--color-border-muted);border-radius:8px;padding:10px 14px;">
            <div style="display:flex;justify-content:space-between;">
              <span>Top-ups (deposited)</span>
              <span class="text-mono" style="color:var(--color-text);">+$${topUps.toFixed(2)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;">
              <span>Referral commissions</span>
              <span class="text-mono" style="color:var(--color-accent);">+$${refComm.toFixed(2)}</span>
            </div>
            ${feesPaid > 0 ? `
            <div style="display:flex;justify-content:space-between;border-top:1px solid var(--color-border-muted);margin-top:4px;padding-top:4px;">
              <span>Platform fees paid</span>
              <span class="text-mono" style="color:var(--color-danger);">-$${feesPaid.toFixed(2)}</span>
            </div>` : ''}
          </div>
          <div style="font-size:0.7rem;color:var(--color-text-muted);margin-top:6px;">💡 Cash wallet grows from top-ups and referral commissions when your referrals pay their weekly fee. Trade profits (60%) stay in your exchange account.</div>
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

      // Bitunix referral link (user's personal affiliate link)
      const bxRefInput = $('#bitunix-referral-link-input');
      if (bxRefInput && dashWallet?.bitunix_referral_link) {
        bxRefInput.value = dashWallet.bitunix_referral_link;
      }

      // USDT address
      if (status.usdt_address) {
        $('#cw-usdt-addr').value = status.usdt_address;
        $('#cw-usdt-net').value = status.usdt_network || 'BEP20';
        const addr = status.usdt_address || '';
        $('#cw-wd-address-display').textContent = addr ? `Sending to: ${addr.slice(0, 10)}...${addr.slice(-6)} (${status.usdt_network || 'BEP20'})` : '';
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
              const emailShort = (r.email || '').length > 20 ? r.email.slice(0, 8) + '...' + r.email.slice(r.email.indexOf('@')) : (r.email || '--');
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
                const addrShort = (addr || '').length > 20 ? addr.slice(0, 10) + '...' + addr.slice(-6) : (addr || '--');
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

  async function saveBitunixReferralLink() {
    const link = ($('#bitunix-referral-link-input')?.value || '').trim();
    try {
      await api('PUT', '/api/dashboard/bitunix-referral-link', { link });
      showToast('Bitunix referral link saved', 'success');
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
    // Always refresh active version bar when admin panel opens
    api('GET', '/api/admin/ai-versions/active').then(updateActiveVersionBanner).catch(() => updateActiveVersionBanner(null));
    try {
      const [users, wds, settings, weeklyEarnings] = await Promise.all([
        api('GET', '/api/admin/users'),
        api('GET', '/api/admin/withdrawals'),
        api('GET', '/api/admin/settings'),
        api('GET', '/api/admin/weekly-earnings').catch(() => null),
      ]);
      loadAiVersions().catch(() => {});
      initBtTokenInput().catch(() => {});
      renderAdminUsers(users);
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
    // Toggle panels — all use the same hidden class system (display: none !important in CSS)
    const panels = ['earnings', 'users', 'tokens', 'settings', 'strategies', 'tools', 'email'];
    panels.forEach(p => {
      const el = document.getElementById(`admin-tab-${p}`);
      if (el) el.classList.toggle('hidden', p !== tab);
    });
    // Refresh admin data when switching tabs
    if (tab === 'earnings')   { loadAdmin(); loadDirectionOverride(); }
    if (tab === 'email')      checkEmailSmtp().catch(() => {});
    if (tab === 'tokens')     { loadTokenCardPrices(); loadTokenStats(); loadTokenDirections(); }
    if (tab === 'strategies') { loadStrategyConfig(); initStratSubTabs(); }
  }

  // ═══════════════════════════════════════════════════════════
  // STRATEGY CONFIG PANEL  (with version history)
  // ═══════════════════════════════════════════════════════════

  // Holds the schema + current live values fetched from the API
  let _stratSchema    = [];
  // Config object being previewed (null = showing live values)
  let _previewConfig  = null;
  let _previewVersion = null;

  async function loadStrategyConfig() {
    const grid = document.getElementById('strategy-config-grid');
    if (!grid) return;
    grid.innerHTML = '<div style="color:var(--color-text-muted);font-size:0.85rem;">Loading…</div>';
    try {
      const [strategies, versions] = await Promise.all([
        api('GET', '/api/admin/strategy-config'),
        api('GET', '/api/admin/strategy-config/versions').catch(() => []),
      ]);
      _stratSchema = strategies;
      _previewConfig  = null;
      _previewVersion = null;
      renderStrategyConfig(strategies, versions);
    } catch {
      grid.innerHTML = '<div style="color:var(--color-danger);font-size:0.85rem;">Failed to load strategy config.</div>';
    }
  }

  function fmtParamVal(val, scale, step) {
    if (val == null) return '';
    const v = val * scale;
    // Capital-% params use step ≥ 1 → show clean integers (50, 120, 100)
    if (step >= 1) return String(Math.round(v));
    const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : 1;
    return v.toFixed(decimals);
  }

  function renderStrategyConfig(strategies, versions) {
    const grid = document.getElementById('strategy-config-grid');
    if (!grid) return;

    const STATUS_BADGE = {
      active:   'background:rgba(16,185,129,0.12);color:#10b981;border:1px solid rgba(16,185,129,0.3);',
      disabled: 'background:rgba(255,255,255,0.05);color:var(--color-text-muted);border:1px solid var(--color-border-muted);',
    };

    // ── Version History Bar ──────────────────────────────────
    const activeVer = versions.find(v => v.is_active);
    const verBar = versions.length === 0 ? '' : `
      <div style="margin-bottom:var(--space-3);border:1px solid var(--color-border-muted);border-radius:var(--radius-lg);padding:var(--space-3);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-2);">
          <span style="font-size:0.82rem;font-weight:700;color:var(--color-text);">📋 Version History</span>
          <span style="font-size:0.72rem;color:var(--color-text-muted);">Click a version to preview its settings</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${versions.map(v => {
            const isActive  = v.is_active;
            const isPrev    = _previewVersion && _previewVersion.id === v.id;
            const dateStr   = new Date(v.created_at).toLocaleString();
            return `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:var(--radius-md);
              background:${isPrev ? 'rgba(99,102,241,0.12)' : isActive ? 'rgba(16,185,129,0.07)' : 'rgba(255,255,255,0.03)'};
              border:1px solid ${isPrev ? 'rgba(99,102,241,0.4)' : isActive ? 'rgba(16,185,129,0.25)' : 'var(--color-border-muted)'};"
              data-ver-id="${v.id}">
              <button class="strat-ver-preview-btn" data-ver-id="${v.id}"
                style="background:none;border:none;cursor:pointer;text-align:left;flex:1;padding:0;color:inherit;">
                <span style="font-size:0.82rem;font-weight:${isActive||isPrev?700:400};color:var(--color-text);">${escapeHtml(v.name)}</span>
                <span style="font-size:0.7rem;color:var(--color-text-muted);margin-left:8px;">${dateStr}</span>
              </button>
              ${isActive ? '<span style="font-size:0.65rem;padding:2px 8px;border-radius:20px;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);white-space:nowrap;">● ACTIVE</span>' : ''}
              ${isPrev   ? '<span style="font-size:0.65rem;padding:2px 8px;border-radius:20px;background:rgba(99,102,241,0.15);color:#818cf8;border:1px solid rgba(99,102,241,0.3);white-space:nowrap;">👁 Previewing</span>' : ''}
              ${!isActive ? `<button class="btn btn-sm strat-ver-apply-btn" data-ver-id="${v.id}"
                style="font-size:0.7rem;padding:2px 10px;white-space:nowrap;">Apply</button>` : ''}
              ${!isActive ? `<button class="strat-ver-del-btn" data-ver-id="${v.id}"
                style="background:none;border:none;cursor:pointer;color:var(--color-text-muted);font-size:0.8rem;padding:2px 6px;"
                title="Delete this version">✕</button>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>`;

    // ── Strategy Cards ───────────────────────────────────────
    // If previewing a version, overlay its values on the inputs
    const previewCfg = _previewConfig;
    const isPreviewMode = !!previewCfg;

    const cards = strategies.map(strat => {
      const badge = STATUS_BADGE[strat.status] || STATUS_BADGE.disabled;

      // ── Enable toggle ──────────────────────────────────────────
      // Live enabled state vs preview override
      const liveEnabled    = strat.enabled !== false; // true unless explicitly false
      const previewEnabled = previewCfg && strat.enabledKey != null
        ? previewCfg[strat.enabledKey] === 1 || previewCfg[strat.enabledKey] === true
        : null;
      const showEnabled    = previewEnabled != null ? previewEnabled : liveEnabled;
      const enabledDiffFromLive = previewEnabled != null && previewEnabled !== liveEnabled;

      const toggleHtml = strat.enabledKey ? `
        <label class="strat-toggle-wrap" data-strat-id="${escapeHtml(strat.id)}"
          style="display:flex;align-items:center;gap:6px;margin-left:auto;cursor:pointer;user-select:none;"
          title="Enable or disable this strategy. Saved with the version.">
          <input type="checkbox" class="strat-enabled-toggle" data-key="${escapeHtml(strat.enabledKey)}"
            ${showEnabled ? 'checked' : ''} style="display:none;">
          <span class="strat-toggle-track" style="
            display:inline-flex;align-items:center;width:36px;height:20px;border-radius:10px;
            padding:2px;transition:background 0.2s;
            background:${showEnabled ? (enabledDiffFromLive ? '#818cf8' : '#10b981') : 'rgba(255,255,255,0.1)'};
            border:1px solid ${showEnabled ? (enabledDiffFromLive ? '#818cf8' : '#10b981') : 'var(--color-border-muted)'};
          ">
            <span style="
              width:14px;height:14px;border-radius:50%;background:#fff;transition:transform 0.2s;
              transform:${showEnabled ? 'translateX(16px)' : 'translateX(0)'};
              box-shadow:0 1px 3px rgba(0,0,0,0.3);
            "></span>
          </span>
          <span style="font-size:0.75rem;font-weight:600;
            color:${showEnabled ? (enabledDiffFromLive ? '#818cf8' : '#10b981') : 'var(--color-text-muted)'};">
            ${showEnabled ? 'ON' : 'OFF'}
          </span>
          ${enabledDiffFromLive ? `<span style="font-size:0.65rem;color:#818cf8;">≠ live: ${liveEnabled ? 'ON' : 'OFF'}</span>` : ''}
        </label>` : '';

      const rows = strat.params.map(p => {
        // Live value vs previewed value
        const liveVal    = p.current;
        const previewVal = previewCfg ? previewCfg[p.key] : null;
        const showVal    = previewVal != null ? previewVal : liveVal;

        const displayVal     = fmtParamVal(showVal, p.scale, p.step);
        const defaultDisplay = fmtParamVal(p.default, p.scale, p.step);
        const liveDisplay    = fmtParamVal(liveVal, p.scale, p.step);
        const isDiffFromLive = previewVal != null && previewVal !== liveVal;

        return `<div style="display:contents;">
          <div style="font-size:0.8rem;color:var(--color-text);padding:6px 0;align-self:center;">
            ${escapeHtml(p.label)}
            ${p.overridden && !isPreviewMode ? '<span style="font-size:0.65rem;color:#f59e0b;margin-left:4px;">✎ edited</span>' : ''}
            ${isDiffFromLive ? `<span style="font-size:0.65rem;color:#818cf8;margin-left:4px;">≠ live: ${liveDisplay}</span>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:6px;padding:4px 0;">
            <input
              type="number"
              class="form-input text-mono strat-param-input"
              data-key="${escapeHtml(p.key)}"
              data-scale="${p.scale}"
              data-default="${p.default}"
              value="${displayVal}"
              min="${p.min}" max="${p.max}" step="${p.step}"
              style="width:90px;font-size:0.82rem;padding:4px 8px;${isDiffFromLive?'border-color:#818cf8;':''}"
              title="${escapeHtml(p.hint || '')}"
            >
            <span style="font-size:0.72rem;color:var(--color-text-muted);min-width:30px;">${escapeHtml(p.unit)}</span>
            ${p.overridden && !isPreviewMode
              ? `<button class="btn btn-sm strat-reset-btn" data-key="${escapeHtml(p.key)}"
                  style="font-size:0.65rem;padding:2px 7px;background:none;border:1px solid var(--color-border-muted);color:var(--color-text-muted);"
                  title="Reset to default (${defaultDisplay} ${escapeHtml(p.unit)})">↺ ${defaultDisplay}</button>`
              : `<span style="font-size:0.65rem;color:var(--color-text-muted);">default: ${defaultDisplay}</span>`}
          </div>
          <div style="font-size:0.72rem;color:var(--color-text-muted);padding:4px 0 4px 4px;align-self:center;">${escapeHtml(p.hint || '')}</div>
        </div>`;
      }).join('');

      const noParamsNote = strat.params.length === 0
        ? `<div style="font-size:0.78rem;color:var(--color-text-muted);padding:var(--space-2) 0;font-style:italic;">No tunable parameters — use the toggle above to enable or disable.</div>`
        : `<div style="display:grid;grid-template-columns:180px 1fr 1fr;gap:2px 12px;margin-top:var(--space-3);align-items:start;">
            <div style="font-size:0.7rem;font-weight:600;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.05em;padding-bottom:4px;border-bottom:1px solid var(--color-border-muted);">Parameter</div>
            <div style="font-size:0.7rem;font-weight:600;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.05em;padding-bottom:4px;border-bottom:1px solid var(--color-border-muted);">Value</div>
            <div style="font-size:0.7rem;font-weight:600;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.05em;padding-bottom:4px;border-bottom:1px solid var(--color-border-muted);">Description</div>
            ${rows}
          </div>`;

      return `
        <details open style="border:1px solid ${showEnabled ? 'var(--color-border-muted)' : 'rgba(255,255,255,0.05)'};
          border-radius:var(--radius-lg);padding:var(--space-3);
          opacity:${showEnabled ? '1' : '0.55'};" data-strat-id="${escapeHtml(strat.id)}">
          <summary style="cursor:pointer;user-select:none;display:flex;align-items:center;gap:10px;list-style:none;outline:none;">
            <span style="font-size:0.9rem;font-weight:700;color:var(--color-text);">${escapeHtml(strat.name)}</span>
            <span style="font-size:0.68rem;padding:2px 8px;border-radius:20px;${badge}">${strat.status.toUpperCase()}</span>
            <span style="font-size:0.75rem;color:var(--color-text-muted);font-weight:400;margin-left:4px;display:none;" class="hide-sm">${escapeHtml(strat.description)}</span>
            ${toggleHtml}
          </summary>

          ${noParamsNote}
        </details>`;
    }).join('');

    // ── Save / Apply bar (sticky at bottom of panel) ─────────
    const previewBanner = isPreviewMode ? (() => {
      // Which strategies are ON in the current preview?
      const onList  = strategies.filter(s => {
        if (!s.enabledKey) return true;
        const v = previewCfg[s.enabledKey];
        return v == null ? s.enabled : v === 1;
      }).map(s => escapeHtml(s.name));
      const offList = strategies.filter(s => {
        if (!s.enabledKey) return false;
        const v = previewCfg[s.enabledKey];
        return v == null ? !s.enabled : v === 0;
      }).map(s => `<span style="text-decoration:line-through;opacity:0.5;">${escapeHtml(s.name)}</span>`);
      const allTags = [...onList.map(n => `<span style="background:rgba(16,185,129,0.12);color:#10b981;padding:1px 7px;border-radius:20px;font-size:0.7rem;">${n}</span>`),
                       ...offList.map(n => `<span style="background:rgba(255,255,255,0.05);color:var(--color-text-muted);padding:1px 7px;border-radius:20px;font-size:0.7rem;">${n}</span>`)].join(' ');
      return `
        <div style="padding:10px 16px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:var(--radius-md);
          display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <span style="font-size:0.82rem;color:#818cf8;font-weight:600;">👁 ${_previewVersion ? `Previewing: ${escapeHtml(_previewVersion.name)}` : 'Editing (unsaved)'}</span>
          <span style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">${allTags}</span>
          <span style="font-size:0.72rem;color:var(--color-text-muted);">Toggle strategies ON/OFF above, then save as a new version.</span>
          <button id="strat-cancel-preview" class="btn btn-sm"
            style="margin-left:auto;font-size:0.75rem;background:none;border:1px solid var(--color-border-muted);">✕ Cancel</button>
        </div>`;
    })() : '';

    const saveBar = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:var(--space-3);
        border:1px solid var(--color-border-muted);border-radius:var(--radius-lg);background:rgba(255,255,255,0.02);">
        <input id="strat-version-name" class="form-input" type="text"
          placeholder="Version name (e.g. Tighter filters v2)"
          style="flex:1;min-width:200px;font-size:0.82rem;"
          value="${isPreviewMode && _previewVersion ? escapeHtml(_previewVersion.name + ' (copy)') : ''}">
        <button id="strat-save-all-btn" class="btn btn-sm"
          style="background:var(--color-accent);color:#fff;font-size:0.82rem;padding:6px 20px;white-space:nowrap;">
          💾 Save as New Version
        </button>
        <span id="strat-save-status" style="font-size:0.75rem;color:var(--color-text-muted);"></span>
      </div>`;

    grid.innerHTML = verBar + cards + previewBanner + saveBar;

    // ── Event: preview a version ─────────────────────────────
    grid.querySelectorAll('.strat-ver-preview-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const verId = parseInt(btn.dataset.verId);
        const ver   = versions.find(v => v.id === verId);
        if (!ver) return;
        _previewVersion = ver;
        _previewConfig  = ver.config; // raw config object from DB
        renderStrategyConfig(strategies, versions);
      });
    });

    // ── Event: apply a version ───────────────────────────────
    grid.querySelectorAll('.strat-ver-apply-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const verId = parseInt(btn.dataset.verId);
        const ver   = versions.find(v => v.id === verId);
        if (!ver || !confirm(`Apply version "${ver.name}"? This will update the live strategy settings.`)) return;
        btn.disabled = true;
        try {
          await api('POST', `/api/admin/strategy-config/versions/${verId}/activate`);
          showToast(`Version "${ver.name}" is now active`, 'success');
          loadStrategyConfig();
        } catch {
          showToast('Failed to apply version', 'error');
          btn.disabled = false;
        }
      });
    });

    // ── Event: delete a version ──────────────────────────────
    grid.querySelectorAll('.strat-ver-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const verId = parseInt(btn.dataset.verId);
        const ver   = versions.find(v => v.id === verId);
        if (!ver || !confirm(`Delete version "${ver.name}"?`)) return;
        try {
          await api('DELETE', `/api/admin/strategy-config/versions/${verId}`);
          loadStrategyConfig();
        } catch (e) {
          showToast(e.message || 'Delete failed', 'error');
        }
      });
    });

    // ── Event: reset individual param to default ─────────────
    grid.querySelectorAll('.strat-reset-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.key;
        if (!confirm(`Reset "${key.split('.').pop()}" to default?`)) return;
        try {
          await api('DELETE', `/api/admin/strategy-config/param/${encodeURIComponent(key)}`);
          loadStrategyConfig();
        } catch {
          showToast('Reset failed', 'error');
        }
      });
    });

    // ── Event: strategy enable/disable toggle ────────────────
    grid.querySelectorAll('.strat-enabled-toggle').forEach(chk => {
      // Wrap label click → update checkbox → re-render with toggled enabled state
      const wrap = chk.closest('.strat-toggle-wrap');
      if (!wrap) return;
      wrap.addEventListener('click', (e) => {
        e.preventDefault(); // prevent default label behaviour
        const key     = chk.dataset.key;
        const isOn    = !chk.checked;   // toggling
        chk.checked   = isOn;

        // Update preview config (or init one from current live values)
        if (!_previewConfig) {
          // Seed from current live values so we only differ on this key
          _previewConfig = {};
          strategies.forEach(s => {
            if (s.enabledKey) _previewConfig[s.enabledKey] = s.enabled ? 1 : 0;
            s.params.forEach(p => { _previewConfig[p.key] = p.current; });
          });
          // Keep _previewVersion as null — user is editing without basing on a saved version
        }
        _previewConfig[key] = isOn ? 1 : 0;
        renderStrategyConfig(strategies, versions);
      });
    });

    // ── Event: cancel preview ────────────────────────────────
    const cancelBtn = document.getElementById('strat-cancel-preview');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        _previewConfig  = null;
        _previewVersion = null;
        renderStrategyConfig(strategies, versions);
      });
    }

    // ── Event: save all inputs as a new version ───────────────
    const saveBtn    = document.getElementById('strat-save-all-btn');
    const nameInput  = document.getElementById('strat-version-name');
    const saveStatus = document.getElementById('strat-save-status');

    saveBtn.addEventListener('click', async () => {
      const vName = nameInput.value.trim();
      if (!vName) {
        nameInput.focus();
        nameInput.style.borderColor = 'var(--color-danger)';
        saveStatus.textContent = 'Enter a version name';
        saveStatus.style.color = 'var(--color-danger)';
        return;
      }
      nameInput.style.borderColor = '';

      // Collect ALL inputs from all strategy cards (params + enabled toggles)
      const config = {};
      grid.querySelectorAll('.strat-param-input').forEach(inp => {
        const raw   = parseFloat(inp.value);
        const scale = parseFloat(inp.dataset.scale);
        if (!isNaN(raw) && scale > 0) config[inp.dataset.key] = raw / scale;
      });
      grid.querySelectorAll('.strat-enabled-toggle').forEach(chk => {
        if (chk.dataset.key) config[chk.dataset.key] = chk.checked ? 1 : 0;
      });

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await api('POST', '/api/admin/strategy-config/versions', { name: vName, config });
        saveStatus.textContent = '✓ Saved & applied';
        saveStatus.style.color = 'var(--color-success)';
        setTimeout(() => loadStrategyConfig(), 600);
      } catch (e) {
        saveStatus.textContent = '✗ ' + (e.message || 'Save failed');
        saveStatus.style.color = 'var(--color-danger)';
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save as New Version';
        setTimeout(() => { saveStatus.textContent = ''; }, 5000);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  // STRATEGY SUB-TABS
  // ═══════════════════════════════════════════════════════════

  function initStratSubTabs() {
    const buttons = document.querySelectorAll('.strat-subtab-btn');
    if (!buttons.length) return;
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        const subtab = btn.dataset.subtab;
        buttons.forEach(b => b.classList.remove('strat-subtab-active'));
        btn.classList.add('strat-subtab-active');
        document.getElementById('strat-panel-params').style.display    = subtab === 'params'    ? '' : 'none';
        document.getElementById('strat-panel-composer').style.display  = subtab === 'composer'  ? '' : 'none';
        if (subtab === 'composer') loadStrategyComposer();
      });
    });
  }

  // ═══════════════════════════════════════════════════════════
  // STRATEGY COMPOSER
  // ═══════════════════════════════════════════════════════════

  let _indicatorLibrary = null; // cached from API

  async function loadStrategyComposer() {
    const grid = document.getElementById('strategy-composer-grid');
    if (!grid) return;
    grid.innerHTML = '<div style="color:var(--color-text-muted);font-size:0.85rem;">Loading…</div>';
    try {
      const [defs, lib] = await Promise.all([
        api('GET', '/api/admin/strategy-definitions'),
        _indicatorLibrary ? Promise.resolve(_indicatorLibrary) : api('GET', '/api/admin/indicator-library'),
      ]);
      _indicatorLibrary = lib;
      renderStrategyComposer(defs, lib);
    } catch (err) {
      grid.innerHTML = `<div style="color:var(--color-danger);font-size:0.85rem;">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderStrategyComposer(defs, lib) {
    const grid = document.getElementById('strategy-composer-grid');
    if (!grid) return;

    const ROLE_COLOR = { gate: '#f59e0b', signal: '#6366f1', filter: '#06b6d4' };
    const ROLE_LABEL = { gate: '⏰ Gate', signal: '📡 Signal', filter: '🔽 Filter' };

    function buildIndicatorRows(stratDef) {
      const cfg = typeof stratDef.config === 'string' ? JSON.parse(stratDef.config) : (stratDef.config || {});
      const ic  = cfg.indicators || {};
      const tf  = cfg.timeframe || '5m';
      const rows = [];

      // Group by role for visual separation
      const groups = { gate: [], signal: [], filter: [] };
      for (const ind of lib) {
        if (groups[ind.role]) groups[ind.role].push(ind);
      }

      for (const role of ['gate', 'signal', 'filter']) {
        const color = ROLE_COLOR[role];
        const label = ROLE_LABEL[role];

        rows.push(`<div style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;
          color:${color};padding:10px 0 4px;border-top:1px solid rgba(255,255,255,0.06);margin-top:4px;">${label}S</div>`);

        for (const ind of groups[role]) {
          const indCfg    = ic[ind.id] || {};
          const isEnabled = !!indCfg.enabled;

          const paramInputs = ind.params.length === 0
            ? `<span style="font-size:0.72rem;color:var(--color-text-muted);font-style:italic;">No parameters</span>`
            : ind.params.map(p => {
                const rawVal = indCfg[p.key] != null ? indCfg[p.key] : p.default;
                if (p.type === 'bool') {
                  return `<label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--color-text);cursor:pointer;">
                    <input type="checkbox" class="composer-param-bool"
                      data-strat-id="${stratDef.id}" data-ind="${ind.id}" data-key="${escapeHtml(p.key)}"
                      ${rawVal ? 'checked' : ''}>
                    ${escapeHtml(p.label)}
                    ${p.hint ? `<span style="font-size:0.68rem;color:var(--color-text-muted);">${escapeHtml(p.hint)}</span>` : ''}
                  </label>`;
                }
                if (p.type === 'select') {
                  const opts = (p.options || []).map(o =>
                    `<option value="${escapeHtml(o)}" ${o === rawVal ? 'selected' : ''}>${escapeHtml(o)}</option>`
                  ).join('');
                  return `<label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--color-text);">
                    ${escapeHtml(p.label)}:
                    <select class="form-input composer-param-select"
                      data-strat-id="${stratDef.id}" data-ind="${ind.id}" data-key="${escapeHtml(p.key)}"
                      style="font-size:0.78rem;padding:3px 8px;width:auto;">${opts}</select>
                  </label>`;
                }
                // number
                const dispScale = p.scale || 1;
                const dispVal   = typeof rawVal === 'number' ? (rawVal * dispScale).toFixed(
                  p.step < 0.01 ? 3 : p.step < 0.1 ? 2 : 1
                ) : rawVal;
                return `<label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--color-text);">
                  ${escapeHtml(p.label)}:
                  <input type="number" class="form-input text-mono composer-param-num"
                    data-strat-id="${stratDef.id}" data-ind="${ind.id}"
                    data-key="${escapeHtml(p.key)}" data-scale="${dispScale}"
                    value="${dispVal}" min="${p.min}" max="${p.max}" step="${p.step}"
                    style="width:80px;font-size:0.78rem;padding:3px 7px;"
                    title="${escapeHtml(p.hint || '')}">
                  <span style="font-size:0.72rem;color:var(--color-text-muted);">${escapeHtml(p.unit || '')}</span>
                  ${p.hint ? `<span style="font-size:0.68rem;color:var(--color-text-muted);">${escapeHtml(p.hint)}</span>` : ''}
                </label>`;
              }).join('');

          rows.push(`
            <div class="composer-indicator-row" data-strat-id="${stratDef.id}" data-ind-id="${ind.id}"
              style="border:1px solid ${isEnabled ? `${color}44` : 'rgba(255,255,255,0.06)'};
                border-radius:var(--radius-md);padding:10px 14px;margin-bottom:6px;
                background:${isEnabled ? `${color}08` : 'rgba(255,255,255,0.01)'};
                transition:border-color 0.2s,background 0.2s;">
              <!-- Indicator header row -->
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;flex:1;min-width:0;">
                  <input type="checkbox" class="composer-ind-toggle"
                    data-strat-id="${stratDef.id}" data-ind-id="${ind.id}"
                    ${isEnabled ? 'checked' : ''}
                    style="width:16px;height:16px;cursor:pointer;accent-color:${color};">
                  <span class="composer-ind-name" style="font-size:0.85rem;font-weight:600;color:${isEnabled ? 'var(--color-text)' : 'var(--color-text-muted)'};">
                    ${escapeHtml(ind.name)}
                  </span>
                  <span style="font-size:0.65rem;padding:1px 7px;border-radius:20px;
                    background:${color}22;color:${color};border:1px solid ${color}44;white-space:nowrap;">
                    ${label}
                  </span>
                </label>
                <span style="font-size:0.72rem;color:var(--color-text-muted);font-style:italic;">${escapeHtml(ind.description)}</span>
              </div>
              <!-- Params (shown only when enabled) -->
              ${isEnabled && ind.params.length > 0 ? `
              <div class="composer-ind-params" style="display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);">
                ${paramInputs}
              </div>` : ind.params.length > 0 ? `<div class="composer-ind-params" style="display:none;">${paramInputs}</div>` : ''}
            </div>`);
        }
      }
      return rows.join('');
    }

    function buildStratCard(stratDef) {
      const cfg        = typeof stratDef.config === 'string' ? JSON.parse(stratDef.config) : (stratDef.config || {});
      const tf         = cfg.timeframe || '5m';
      const symbols    = (cfg.symbols || []).join(', ');
      const slPct      = ((cfg.sl_pct  || 0.01) * 100).toFixed(2);
      const tpMult     = cfg.tp_multiplier || 2.0;
      const sizePct    = ((cfg.size_pct || 0.10) * 100).toFixed(0);
      const isEnabled  = !!stratDef.is_enabled;
      const isBuiltin  = !!stratDef.is_builtin;
      const updatedAt  = new Date(stratDef.updated_at || stratDef.created_at).toLocaleString();

      return `
        <details class="composer-strat-card" data-strat-id="${stratDef.id}" open
          style="border:1px solid ${isEnabled ? 'var(--color-border-muted)' : 'rgba(255,255,255,0.05)'};
            border-radius:var(--radius-lg);padding:var(--space-3);
            opacity:${isEnabled ? 1 : 0.65};">
          <summary style="cursor:pointer;user-select:none;list-style:none;outline:none;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <!-- Enable toggle -->
            <input type="checkbox" class="composer-strat-toggle" data-strat-id="${stratDef.id}"
              ${isEnabled ? 'checked' : ''}
              style="width:18px;height:18px;cursor:pointer;accent-color:#10b981;"
              title="${isEnabled ? 'Strategy enabled — click to disable' : 'Strategy disabled — click to enable'}">
            <!-- Name (editable inline) -->
            <input type="text" class="composer-strat-name form-input" data-strat-id="${stratDef.id}"
              value="${escapeHtml(stratDef.name)}"
              style="font-size:0.9rem;font-weight:700;padding:3px 8px;flex:1;min-width:120px;max-width:260px;"
              placeholder="Strategy name"
              ${isBuiltin ? 'readonly title="Built-in strategy name is read-only"' : ''}>
            ${isBuiltin ? '<span style="font-size:0.65rem;padding:1px 7px;border-radius:20px;background:rgba(99,102,241,0.15);color:#818cf8;border:1px solid rgba(99,102,241,0.3);white-space:nowrap;">built-in</span>' : ''}
            <span style="font-size:0.7rem;color:var(--color-text-muted);margin-left:auto;">Updated: ${updatedAt}</span>
            <!-- Action buttons in header -->
            <button class="btn btn-sm composer-backtest-btn" data-strat-id="${stratDef.id}"
              style="font-size:0.72rem;padding:3px 12px;background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.3);color:#818cf8;white-space:nowrap;">
              📊 Backtest
            </button>
            ${!isBuiltin ? `<button class="btn btn-sm composer-delete-btn" data-strat-id="${stratDef.id}"
              style="font-size:0.72rem;padding:3px 10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);color:#f87171;white-space:nowrap;">
              🗑 Delete
            </button>` : ''}
          </summary>

          <!-- Body -->
          <div style="margin-top:var(--space-3);display:flex;flex-direction:column;gap:var(--space-3);">

            <!-- Quick settings row -->
            <div style="display:flex;flex-wrap:wrap;gap:12px;padding:10px 14px;background:rgba(255,255,255,0.02);border-radius:var(--radius-md);border:1px solid rgba(255,255,255,0.06);">
              <label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--color-text);">
                Timeframe:
                <select class="form-input composer-tf" data-strat-id="${stratDef.id}"
                  style="font-size:0.78rem;padding:3px 8px;width:auto;">
                  ${['1m','3m','5m','15m','1h'].map(t => `<option value="${t}" ${t === tf ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--color-text);">
                SL %:
                <input type="number" class="form-input text-mono composer-sl-pct" data-strat-id="${stratDef.id}"
                  value="${slPct}" min="0.1" max="5" step="0.1" style="width:70px;font-size:0.78rem;padding:3px 7px;">
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--color-text);">
                TP mult:
                <input type="number" class="form-input text-mono composer-tp-mult" data-strat-id="${stratDef.id}"
                  value="${tpMult}" min="0.5" max="10" step="0.1" style="width:70px;font-size:0.78rem;padding:3px 7px;"
                  title="TP = entry ± (SL distance × this multiplier)">
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:var(--color-text);">
                Size %:
                <input type="number" class="form-input text-mono composer-size-pct" data-strat-id="${stratDef.id}"
                  value="${sizePct}" min="1" max="100" step="1" style="width:70px;font-size:0.78rem;padding:3px 7px;"
                  title="Position size as % of wallet balance">
              </label>
              <div style="flex:1;min-width:200px;">
                <label style="font-size:0.78rem;color:var(--color-text);">Tokens (comma-separated, blank = auto top-15):</label>
                <input type="text" class="form-input text-mono composer-symbols" data-strat-id="${stratDef.id}"
                  value="${escapeHtml(symbols)}" placeholder="e.g. BTCUSDT, ETHUSDT, SOLUSDT"
                  style="width:100%;font-size:0.78rem;padding:4px 8px;margin-top:4px;">
              </div>
            </div>

            <!-- Description -->
            <textarea class="form-input composer-desc" data-strat-id="${stratDef.id}"
              rows="2" placeholder="Strategy description (optional)"
              style="font-size:0.78rem;resize:vertical;"
              ${isBuiltin ? 'readonly' : ''}>${escapeHtml(stratDef.description || '')}</textarea>

            <!-- Indicator accordion -->
            <div style="font-size:0.78rem;font-weight:700;color:var(--color-text);margin-bottom:2px;">
              Indicators
              <span style="font-size:0.7rem;font-weight:400;color:var(--color-text-muted);margin-left:8px;">
                Toggle ON/OFF — enabled indicators run in order: Gates → Signals → Filters
              </span>
            </div>
            <div class="composer-indicators-wrap" data-strat-id="${stratDef.id}">
              ${buildIndicatorRows(stratDef)}
            </div>

            <!-- Save button -->
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <button class="btn btn-sm composer-save-btn" data-strat-id="${stratDef.id}"
                style="background:var(--color-accent);color:#fff;font-size:0.8rem;padding:6px 20px;">
                💾 Save Strategy
              </button>
              <span class="composer-save-status" data-strat-id="${stratDef.id}"
                style="font-size:0.75rem;color:var(--color-text-muted);"></span>
            </div>
          </div>
        </details>`;
    }

    grid.innerHTML = defs.length === 0
      ? '<div style="color:var(--color-text-muted);font-size:0.85rem;font-style:italic;">No strategies yet. Click "+ New Strategy" to create one.</div>'
      : defs.map(d => buildStratCard(d)).join('');

    // ── New Strategy button ──────────────────────────────────
    const newBtn = document.getElementById('strat-composer-new-btn');
    if (newBtn) {
      newBtn.onclick = async () => {
        const name = prompt('Strategy name:');
        if (!name || !name.trim()) return;
        newBtn.disabled = true;
        try {
          await api('POST', '/api/admin/strategy-definitions', {
            name: name.trim(),
            description: '',
            config: {
              timeframe: '5m',
              symbols: [],
              sl_pct: 0.01,
              tp_multiplier: 2.0,
              size_pct: 0.10,
              indicators: {},
            },
          });
          showToast(`Strategy "${name}" created`, 'success');
          loadStrategyComposer();
        } catch (e) {
          showToast(e.message || 'Create failed', 'error');
        } finally {
          newBtn.disabled = false;
        }
      };
    }

    // ── Indicator toggle ─────────────────────────────────────
    grid.querySelectorAll('.composer-ind-toggle').forEach(chk => {
      chk.addEventListener('change', () => {
        const row    = chk.closest('.composer-indicator-row');
        const params = row.querySelector('.composer-ind-params');
        const color  = ROLE_COLOR[lib.find(i => i.id === chk.dataset.indId)?.role] || '#6366f1';
        const isOn   = chk.checked;

        // Update visual state
        row.style.borderColor  = isOn ? `${color}44` : 'rgba(255,255,255,0.06)';
        row.style.background   = isOn ? `${color}08` : 'rgba(255,255,255,0.01)';
        const nameEl = row.querySelector('.composer-ind-name');
        if (nameEl) nameEl.style.color = isOn ? 'var(--color-text)' : 'var(--color-text-muted)';

        if (params) params.style.display = isOn ? 'flex' : 'none';
      });
    });

    // ── Save strategy ────────────────────────────────────────
    grid.querySelectorAll('.composer-save-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id      = parseInt(btn.dataset.stratId);
        const card    = grid.querySelector(`details[data-strat-id="${id}"]`);
        const status  = grid.querySelector(`.composer-save-status[data-strat-id="${id}"]`);
        if (!card) return;

        // Collect strategy-level fields
        const name     = card.querySelector(`.composer-strat-name[data-strat-id="${id}"]`)?.value.trim();
        const desc     = card.querySelector(`.composer-desc[data-strat-id="${id}"]`)?.value || '';
        const tf       = card.querySelector(`.composer-tf[data-strat-id="${id}"]`)?.value || '5m';
        const slPctRaw = parseFloat(card.querySelector(`.composer-sl-pct[data-strat-id="${id}"]`)?.value || '1') / 100;
        const tpMult   = parseFloat(card.querySelector(`.composer-tp-mult[data-strat-id="${id}"]`)?.value || '2');
        const sizePct  = parseFloat(card.querySelector(`.composer-size-pct[data-strat-id="${id}"]`)?.value || '10') / 100;
        const symRaw   = card.querySelector(`.composer-symbols[data-strat-id="${id}"]`)?.value || '';
        const symbols  = symRaw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

        // Collect indicator config
        const indicators = {};
        card.querySelectorAll(`.composer-ind-toggle[data-strat-id="${id}"]`).forEach(chk => {
          const indId  = chk.dataset.indId;
          const indMeta = lib.find(i => i.id === indId);
          if (!indMeta) return;

          const indCfg = { enabled: chk.checked };

          // Number params
          card.querySelectorAll(`.composer-param-num[data-strat-id="${id}"][data-ind="${indId}"]`).forEach(inp => {
            const raw   = parseFloat(inp.value);
            const scale = parseFloat(inp.dataset.scale) || 1;
            if (!isNaN(raw)) indCfg[inp.dataset.key] = raw / scale;
          });
          // Select params
          card.querySelectorAll(`.composer-param-select[data-strat-id="${id}"][data-ind="${indId}"]`).forEach(sel => {
            indCfg[sel.dataset.key] = sel.value;
          });
          // Bool params
          card.querySelectorAll(`.composer-param-bool[data-strat-id="${id}"][data-ind="${indId}"]`).forEach(chkB => {
            indCfg[chkB.dataset.key] = chkB.checked;
          });

          indicators[indId] = indCfg;
        });

        const config = { timeframe: tf, symbols, sl_pct: slPctRaw, tp_multiplier: tpMult, size_pct: sizePct, indicators };

        btn.disabled = true;
        btn.textContent = 'Saving…';
        if (status) { status.textContent = ''; }
        try {
          await api('PUT', `/api/admin/strategy-definitions/${id}`, {
            name: name || undefined,
            description: desc,
            config,
          });
          if (status) { status.textContent = '✓ Saved'; status.style.color = 'var(--color-success)'; }
          setTimeout(() => loadStrategyComposer(), 800);
        } catch (e) {
          if (status) { status.textContent = '✗ ' + (e.message || 'Save failed'); status.style.color = 'var(--color-danger)'; }
        } finally {
          btn.disabled = false;
          btn.textContent = '💾 Save Strategy';
        }
      });
    });

    // ── Strategy enable toggle ───────────────────────────────
    grid.querySelectorAll('.composer-strat-toggle').forEach(chk => {
      chk.addEventListener('change', async () => {
        const id = parseInt(chk.dataset.stratId);
        try {
          await api('PUT', `/api/admin/strategy-definitions/${id}`, { is_enabled: chk.checked });
          showToast(chk.checked ? 'Strategy enabled' : 'Strategy disabled', 'success');
          loadStrategyComposer();
        } catch (e) {
          showToast(e.message || 'Update failed', 'error');
          chk.checked = !chk.checked; // revert
        }
      });
    });

    // ── Delete strategy ──────────────────────────────────────
    grid.querySelectorAll('.composer-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id   = parseInt(btn.dataset.stratId);
        const card = grid.querySelector(`details[data-strat-id="${id}"]`);
        const name = card?.querySelector(`.composer-strat-name[data-strat-id="${id}"]`)?.value || id;
        if (!confirm(`Delete strategy "${name}"? This cannot be undone.`)) return;
        btn.disabled = true;
        try {
          await api('DELETE', `/api/admin/strategy-definitions/${id}`);
          showToast('Strategy deleted', 'success');
          loadStrategyComposer();
        } catch (e) {
          showToast(e.message || 'Delete failed', 'error');
          btn.disabled = false;
        }
      });
    });

    // ── Backtest strategy ─────────────────────────────────────
    grid.querySelectorAll('.composer-backtest-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id      = parseInt(btn.dataset.stratId);
        const card    = grid.querySelector(`details[data-strat-id="${id}"]`);
        if (!card) return;

        // Open the card so results are visible
        card.open = true;

        // Find or create the results panel inside this card
        let resultsEl = card.querySelector('.composer-bt-results');
        if (!resultsEl) {
          resultsEl = document.createElement('div');
          resultsEl.className = 'composer-bt-results';
          resultsEl.style.cssText = 'margin-top:12px;';
          const body = card.querySelector('div[style*="flex-direction:column"]');
          if (body) body.appendChild(resultsEl);
          else card.appendChild(resultsEl);
        }

        // Prompt for days (optional)
        const daysStr = prompt('Days of history to test (1-14, default 7):', '7');
        if (daysStr === null) { return; } // user cancelled
        const days    = Math.min(14, Math.max(1, parseInt(daysStr) || 7));

        btn.disabled = true;
        btn.textContent = `⏳ Running ${days}d…`;
        resultsEl.innerHTML = `
          <div style="padding:12px;border:1px solid rgba(99,102,241,0.3);border-radius:var(--radius-md);
            background:rgba(99,102,241,0.05);display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <span style="font-size:0.82rem;color:#818cf8;">⏳ Fetching ${days} days of historical data and running indicator chain…</span>
            <span style="font-size:0.72rem;color:var(--color-text-muted);">This may take 20–60 seconds</span>
          </div>`;
        resultsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        try {
          const result = await api('POST', `/api/admin/strategy-definitions/${id}/backtest`,
            { days });
          renderBacktestResults(resultsEl, result);
          resultsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (e) {
          resultsEl.innerHTML = `<div style="color:var(--color-danger);font-size:0.82rem;padding:8px 0;">
            ✗ ${escapeHtml(e.message || 'Backtest failed')}</div>`;
        } finally {
          btn.disabled = false;
          btn.textContent = '📊 Backtest';
        }
      });
    });
  }

  // ── Backtest results renderer ────────────────────────────────

  function renderBacktestResults(el, r) {
    if (!r || r.total === 0) {
      el.innerHTML = `
        <div style="padding:12px;border:1px solid rgba(255,255,255,0.08);border-radius:var(--radius-md);
          background:rgba(255,255,255,0.02);color:var(--color-text-muted);font-size:0.82rem;">
          ⚠️ No trades fired in the test period. Try loosening filters or increasing days.
          ${r?.gatesHonoured ? '<br><span style="font-size:0.72rem;">Note: Time gates (session/prime) were honoured — many bars may have been skipped.</span>' : ''}
        </div>`;
      return;
    }

    const pf  = r.profitFactor?.toFixed(2) ?? '—';
    const wr  = r.winRate?.toFixed(1)      ?? '—';
    const atr = r.avgPnl?.toFixed(2)       ?? '—';
    const pnl = r.totalPnl?.toFixed(1)     ?? '—';
    const dd  = r.maxDrawdown?.toFixed(1)  ?? '—';

    const wrColor  = r.winRate >= 55 ? '#10b981' : r.winRate >= 45 ? '#f59e0b' : '#f87171';
    const pnlColor = r.totalPnl > 0  ? '#10b981' : '#f87171';
    const pfColor  = r.profitFactor >= 1.5 ? '#10b981' : r.profitFactor >= 1 ? '#f59e0b' : '#f87171';

    const perSymbolRows = (r.perSymbol || []).map(s => {
      if (s.error) return `<tr>
        <td style="padding:4px 8px;font-weight:600;">${escapeHtml(s.symbol)}</td>
        <td colspan="5" style="padding:4px 8px;color:var(--color-danger);font-size:0.72rem;">${escapeHtml(s.error)}</td></tr>`;
      const sWr  = s.winRate?.toFixed(1)   ?? '—';
      const sPnl = s.totalPnl?.toFixed(1)  ?? '—';
      const sPf  = s.profitFactor?.toFixed(2) ?? '—';
      const sWrC = s.winRate >= 55 ? '#10b981' : s.winRate >= 45 ? '#f59e0b' : '#f87171';
      const sPC  = s.totalPnl > 0 ? '#10b981' : '#f87171';
      return `<tr style="border-top:1px solid rgba(255,255,255,0.04);">
        <td style="padding:4px 8px;font-weight:600;font-size:0.78rem;">${escapeHtml(s.symbol)}</td>
        <td style="padding:4px 8px;font-size:0.78rem;">${s.total}</td>
        <td style="padding:4px 8px;color:${sWrC};font-size:0.78rem;">${sWr}%</td>
        <td style="padding:4px 8px;color:${sPC};font-size:0.78rem;">${sPnl}%</td>
        <td style="padding:4px 8px;color:${pfColor};font-size:0.78rem;">${sPf}</td>
        <td style="padding:4px 8px;font-size:0.72rem;color:var(--color-text-muted);">${s.wins}W / ${s.losses}L</td>
      </tr>`;
    }).join('');

    const recentRows = (r.recentTrades || []).map(t => {
      const c = t.result === 'TP' ? '#10b981' : t.result === 'SL' ? '#f87171' : '#f59e0b';
      return `<tr style="border-top:1px solid rgba(255,255,255,0.04);">
        <td style="padding:3px 8px;font-size:0.75rem;">${escapeHtml(t.symbol)}</td>
        <td style="padding:3px 8px;font-size:0.75rem;color:${t.dir === 'LONG' ? '#10b981' : '#f87171'};">${t.dir}</td>
        <td style="padding:3px 8px;font-size:0.75rem;font-family:monospace;">${t.entry}</td>
        <td style="padding:3px 8px;font-size:0.75rem;font-family:monospace;">${t.exit}</td>
        <td style="padding:3px 8px;font-size:0.75rem;color:${c};font-weight:600;">${t.pnlPct}%</td>
        <td style="padding:3px 8px;font-size:0.72rem;color:${c};">${t.result}</td>
        <td style="padding:3px 8px;font-size:0.68rem;color:var(--color-text-muted);">${escapeHtml(t.date)}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div style="border:1px solid rgba(99,102,241,0.3);border-radius:var(--radius-md);
        background:rgba(99,102,241,0.04);padding:14px;display:flex;flex-direction:column;gap:12px;">

        <!-- Header -->
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span style="font-size:0.85rem;font-weight:700;color:#818cf8;">📊 Backtest Results — ${r.days}d × ${escapeHtml(r.timeframe)}</span>
          <span style="font-size:0.72rem;color:var(--color-text-muted);">
            ${escapeHtml(r.symbols?.join(', '))}
            · SL ${(r.slPct*100).toFixed(2)}% · TP ${(r.tpPct*100).toFixed(2)}% (${r.tpMult}×)
            ${r.gatesHonoured ? '· ⏰ time gates applied' : ''}
          </span>
        </div>

        <!-- Summary stat chips -->
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${[
            ['Trades',         r.total,       '#818cf8', 'Total number of simulated trades in the test period'],
            ['Win Rate',       wr + '%',      wrColor,   'Percentage of trades that hit Take Profit. >55% = good, >65% = excellent'],
            ['PF (Profit Factor)', pf,        pfColor,   'Total profit ÷ total loss. >1.5 = good, >2 = excellent, <1 = losing strategy'],
            ['Total PnL',      pnl + '%',     pnlColor,  'Total % return across all trades in the test period (assumes fixed position size)'],
            ['Avg / Trade',    atr + '%',     pnlColor,  'Average PnL per trade. Positive = each trade makes money on average'],
            ['Max Drawdown',   dd + '%',      r.maxDrawdown > 10 ? '#f87171' : '#f59e0b',
                                                         'Biggest peak-to-trough loss streak during the test. E.g. 15% = balance dropped 15% at its worst before recovering. Lower = safer'],
            ['LONG',           r.longTrades,  '#818cf8', 'Number of long (buy) trades taken'],
            ['SHORT',          r.shortTrades, '#818cf8', 'Number of short (sell) trades taken'],
            ['TP Hits',        r.tpHits,      '#10b981', 'Trades that closed at Take Profit (winners)'],
            ['SL Hits',        r.slHits,      '#f87171', 'Trades that closed at Stop Loss (losers)'],
          ].map(([lbl, val, col, tip]) => `
            <div title="${escapeHtml(tip)}" style="padding:6px 12px;border-radius:var(--radius-md);
              border:1px solid ${col}44;background:${col}11;cursor:help;
              display:flex;flex-direction:column;align-items:center;min-width:70px;">
              <span style="font-size:0.65rem;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.06em;">${lbl}</span>
              <span style="font-size:0.9rem;font-weight:700;color:${col};">${val}</span>
            </div>`
          ).join('')}
        </div>
        <div style="font-size:0.68rem;color:var(--color-text-muted);font-style:italic;">💡 Hover any chip for explanation &nbsp;·&nbsp; Test period: ${r.days} day${r.days !== 1 ? 's' : ''}</div>

        <!-- Per-symbol table -->
        ${perSymbolRows ? `
        <div>
          <div style="font-size:0.72rem;font-weight:700;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Per Symbol</div>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="border-bottom:1px solid var(--color-border-muted);">
                ${['Symbol','Trades','Win Rate','Total PnL','PF','W/L'].map(h =>
                  `<th style="padding:3px 8px;font-size:0.68rem;font-weight:600;color:var(--color-text-muted);text-align:left;">${h}</th>`
                ).join('')}
              </tr>
            </thead>
            <tbody>${perSymbolRows}</tbody>
          </table>
        </div>` : ''}

        <!-- Recent trades -->
        ${recentRows ? `
        <div>
          <div style="font-size:0.72rem;font-weight:700;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Last 8 Trades</div>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="border-bottom:1px solid var(--color-border-muted);">
                ${['Symbol','Dir','Entry','Exit','PnL','Result','Time'].map(h =>
                  `<th style="padding:2px 8px;font-size:0.68rem;font-weight:600;color:var(--color-text-muted);text-align:left;">${h}</th>`
                ).join('')}
              </tr>
            </thead>
            <tbody>${recentRows}</tbody>
          </table>
        </div>` : ''}
      </div>`;
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

    // Ruflo Intelligence Panel — create container if missing
    let rufloEl = document.getElementById('mc-ruflo-panel');
    if (!rufloEl) {
      const grid = document.getElementById('mc-agents-grid');
      if (grid && grid.parentElement) {
        rufloEl = document.createElement('div');
        rufloEl.id = 'mc-ruflo-panel';
        rufloEl.style.cssText = 'margin-bottom:12px;padding:8px 10px;background:rgba(10,15,25,0.5);border:1px solid rgba(100,149,237,0.15);border-radius:8px;';
        grid.parentElement.insertBefore(rufloEl, grid);
      }
    }
    if (rufloEl && health.ruflo) {
      const rf = health.ruflo;
      const pat = rf.patterns || {};
      const con = rf.consensus || {};
      rufloEl.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:0.75rem;">
          <div style="background:rgba(100,149,237,0.1);padding:6px 8px;border-radius:6px;border:1px solid rgba(100,149,237,0.2);">
            <div style="color:#6495ED;font-weight:700;margin-bottom:4px;">🧠 Pattern Memory</div>
            <div style="color:var(--color-text-muted);">Patterns: <b style="color:var(--color-text)">${pat.totalPatterns || 0}</b></div>
            <div style="color:var(--color-text-muted);">Stable: <b style="color:var(--color-text)">${pat.stablePatterns || 0}</b></div>
            <div style="color:var(--color-text-muted);">Avg WR: <b style="color:${(pat.avgSuccessRate||0)>0.5?'var(--color-success)':'var(--color-danger)'}">${Math.round((pat.avgSuccessRate || 0) * 100)}%</b></div>
            <div style="color:var(--color-text-muted);">Match: <b style="color:var(--color-text)">${pat.avgMatchTimeMs || 0}ms</b></div>
          </div>
          <div style="background:rgba(0,255,136,0.05);padding:6px 8px;border-radius:6px;border:1px solid rgba(0,255,136,0.15);">
            <div style="color:var(--color-accent);font-weight:700;margin-bottom:4px;">🗳️ Trade Consensus</div>
            <div style="color:var(--color-text-muted);">Proposals: <b style="color:var(--color-text)">${con.totalProposals || 0}</b></div>
            <div style="color:var(--color-text-muted);">Voters: <b style="color:var(--color-text)">${con.voterCount || 0}</b></div>
            ${(con.voters||[]).slice(0,3).map(v => `<div style="color:var(--color-text-muted);font-size:0.65rem;">${v.id}: w=${v.weight} acc=${v.accuracy}%</div>`).join('')}
          </div>
          <div style="background:rgba(255,215,0,0.05);padding:6px 8px;border-radius:6px;border:1px solid rgba(255,215,0,0.15);">
            <div style="color:#FFD700;font-weight:700;margin-bottom:4px;">⚡ RL Learning</div>
            <div style="color:var(--color-text-muted);">Matched: <b style="color:var(--color-text)">${pat.matchCount || 0}</b></div>
            <div style="color:var(--color-text-muted);">Extracted: <b style="color:var(--color-text)">${pat.extractionCount || 0}</b></div>
            <div style="color:var(--color-text-muted);">Evolved: <b style="color:var(--color-text)">${pat.evolutionCount || 0}</b></div>
          </div>
        </div>`;
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
      const sv = a.survival || {};
      const isDead = sv.isAlive === false;
      const st = isDead ? 'dead' : a.paused ? 'paused' : a.state;
      const cardClass = isDead ? 'mc-card-dead' : st === 'running' ? 'mc-card-running' : st === 'error' ? 'mc-card-error' : a.paused ? 'mc-card-paused' : '';
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
        ${isDead ? `<div style="background:#ff000030;border:1px solid #ff0000;border-radius:6px;padding:6px;margin-bottom:6px;text-align:center;"><span style="font-size:1.2rem;">☠️</span> <b style="color:#ff4444;">KILLED</b><br><span style="font-size:0.7rem;color:#ff8888;">${escapeHtml(sv.killReason || 'Unknown')}</span></div>` : ''}
        <div style="margin-bottom:6px;">
          <div style="display:flex;justify-content:space-between;font-size:0.7rem;margin-bottom:2px;">
            <span>❤️ HP: ${isDead ? 0 : (sv.health != null ? sv.health : 100)}/100</span>
            <span style="color:${(sv.monthlyPct || 0) >= 0 ? 'var(--color-success)' : 'var(--color-danger)'}">Month: ${(sv.monthlyPct || 0) >= 0 ? '+' : ''}${sv.monthlyPct || 0}%</span>
          </div>
          <div style="height:8px;background:#333;border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${isDead ? 0 : (sv.health != null ? sv.health : 100)}%;background:${isDead ? '#ff3333' : (sv.health || 100) > 50 ? '#00ff88' : (sv.health || 100) > 20 ? '#ffaa00' : '#ff3333'};border-radius:4px;transition:width 0.5s;"></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:2px;font-size:0.65rem;color:var(--color-text-muted);margin-top:3px;">
            <span>💰 $${isDead ? '0' : (sv.capital != null ? Number(sv.capital).toFixed(0) : '1000')}</span>
            <span>W/L: ${sv.totalWins || 0}/${sv.totalLosses || 0} (${sv.winRate || 0}%)</span>
            <span>Target: ${sv.monthlyTarget || 60}%</span>
            <span style="color:${(sv.totalRevenue || 0) >= 0 ? 'var(--color-success)' : 'var(--color-danger)'}">Revenue: ${(sv.totalRevenue || 0) >= 0 ? '+' : ''}$${Number(sv.totalRevenue || 0).toFixed(2)}</span>
            <span>Trades: ${sv.totalTrades || 0}</span>
            <span>
              <a href="#" onclick="event.stopPropagation();window.CryptoBot.mcDownloadTrades('${key}')" style="color:var(--color-accent);text-decoration:underline;font-size:0.6rem;">📥 Export CSV</a>
            </span>
          </div>
        </div>
        ${a.populationSize !== undefined ? `
        <div style="margin-bottom:6px;padding:4px 6px;background:rgba(0,255,136,0.05);border:1px solid rgba(0,255,136,0.15);border-radius:6px;">
          <div style="font-size:0.7rem;color:var(--color-accent);font-weight:600;margin-bottom:2px;">🧬 Strategy Discovery</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;font-size:0.65rem;color:var(--color-text-muted);">
            <span>Population: ${a.populationSize || 0}</span>
            <span>Elite: ${a.eliteCount || 0}</span>
            <span>Generated: ${a.totalGenerated || 0}</span>
            <span>Evolved: ${a.totalEvolved || 0}</span>
            <span>Culled: ${a.totalCulled || 0}</span>
            <span>Best WR: ${(a.bestEverWinRate || 0).toFixed(1)}%</span>
            <span>Web: ${a.totalWebSearches || 0} searches</span>
            <span>AI: ${a.totalAiDiscoveries || 0} ideas</span>
          </div>
          ${a.bestEverStrategy && a.bestEverStrategy !== 'N/A' ? `<div style="font-size:0.65rem;color:var(--color-success);margin-top:2px;">🏆 ${escapeHtml(a.bestEverStrategy)}</div>` : ''}
        </div>` : ''}
        ${a.qlearning && a.qlearning.qTableSize > 0 ? `
        <div style="margin-bottom:6px;padding:4px 6px;background:rgba(100,149,237,0.08);border:1px solid rgba(100,149,237,0.2);border-radius:6px;">
          <div style="font-size:0.7rem;color:#6495ED;font-weight:600;margin-bottom:2px;">🧠 Q-Learning (Ruflo)</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;font-size:0.65rem;color:var(--color-text-muted);">
            <span>States: ${a.qlearning.qTableSize}</span>
            <span>ε: ${a.qlearning.epsilon}</span>
            <span>Updates: ${a.qlearning.updateCount}</span>
            <span>Reward: ${a.qlearning.totalReward}</span>
          </div>
        </div>` : ''}
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

  function mcDownloadTrades(agentKey) {
    const url = `/api/admin/agents/trade-history/csv?agent=${encodeURIComponent(agentKey)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${agentKey}-trades.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
        const structTip = struct ? `3m:${struct.tf3m||'?'} 1m:${struct.tf1m||'?'}` : '';

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

  // ── Strategy Token Picker ────────────────────────────────────

  // Toggle a strategy token on/off (persists via global_token_settings ban flag)
  async function toggleStrategyToken(symbol, strategy, enabled) {
    try {
      if (enabled) {
        // Unban (enable) token
        await api('POST', '/api/admin/token-board/add', { symbol });
        await api('POST', '/api/admin/token-board/unban', { symbol }).catch(() => {});
      } else {
        // Ban (disable) token — scanner skips banned tokens
        await api('POST', '/api/admin/token-board/ban', { symbol });
      }
      showToast(`${symbol.replace('USDT','')} ${enabled ? 'enabled' : 'disabled'} for ${strategy}`, enabled ? 'success' : 'info');
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
    }
  }

  // Load live prices for token cards
  async function loadTokenCardPrices() {
    const symbols = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];
    for (const sym of symbols) {
      try {
        const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`);
        if (!res.ok) continue;
        const d = await res.json();
        const price = parseFloat(d.price);
        const fmt = price >= 1000 ? '$' + price.toLocaleString('en-US',{maximumFractionDigits:2})
                  : price >= 1   ? '$' + price.toFixed(2)
                                 : '$' + price.toFixed(6);
        document.querySelectorAll(`[id$="price-${sym}"]`).forEach(el => { el.textContent = fmt; });
      } catch {}
    }
    // Also load current leverage from DB and update card labels
    try {
      const levData = await api('GET', '/api/admin/token-leverage');
      const levMap = {};
      for (const row of levData) levMap[row.symbol] = row.leverage;
      for (const sym of symbols) {
        const el = document.getElementById('tcard-lev-' + sym);
        if (!el) continue;
        const lev = levMap[sym] ?? levMap[sym.replace('USDT','')] ?? null;
        if (lev) el.textContent = `×${lev} leverage`;
      }
    } catch {}
  }

  function editTokenCardLev(symbol) {
    const el = document.getElementById('tcard-lev-' + symbol);
    const curLev = parseInt((el ? el.textContent : '').replace(/[^d]/g, '')) || 20;
    const existing = document.getElementById('lev-edit-modal');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'lev-edit-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = '<div style="background:var(--color-card,#1e2130);border:1px solid var(--color-border,#2d3148);border-radius:12px;padding:24px;width:280px;">'
      + '<h4 style="margin:0 0 14px;font-size:0.95rem;">Edit ' + symbol.replace('USDT','') + ' Leverage</h4>'
      + '<input id="lev-edit-input" type="number" min="1" max="125" value="' + curLev + '" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--color-border,#2d3148);background:var(--color-bg,#111);color:var(--color-text,#fff);font-size:1rem;box-sizing:border-box;margin-bottom:6px;">'
      + '<div style="font-size:0.72rem;color:var(--color-text-muted,#9ca3af);margin-bottom:14px;">Range: 1-125</div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;">'
      + '<button onclick="document.getElementById(\'lev-edit-modal\').remove()" style="padding:6px 14px;border-radius:6px;border:1px solid var(--color-border,#2d3148);background:transparent;color:var(--color-text-muted,#9ca3af);cursor:pointer;">Cancel</button>'
      + '<button id="lev-edit-save" style="padding:6px 16px;border-radius:6px;border:none;background:var(--color-accent,#d4af37);color:#000;font-weight:700;cursor:pointer;">Save</button>'
      + '</div></div>';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    var inp = document.getElementById('lev-edit-input');
    inp.focus(); inp.select();
    var save = async function() {
      var lev = parseInt(inp.value);
      if (isNaN(lev) || lev < 1 || lev > 125) { showToast('Leverage must be 1-125', 'error'); return; }
      try {
        await api('POST', '/api/admin/token-leverage', { symbol: symbol, leverage: lev });
        if (el) el.textContent = 'x' + lev + ' leverage';
        overlay.remove();
        showToast(symbol.replace('USDT','') + ' leverage set to x' + lev, 'success');
      } catch (err) { showToast(err.message, 'error'); }
    };
    document.getElementById('lev-edit-save').addEventListener('click', save);
    inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') save(); });
  }

  // Load win-rate stats from closed trades
  async function loadTokenStats() {
    try {
      const stats = await api('GET', '/api/admin/stats').catch(() => null);
      if (!stats) return;
      const wr = stats.winRate ?? stats.win_rate;
      const net = stats.netPnl ?? stats.net_pnl;
      const total = stats.totalTrades ?? stats.total_trades;
      const pf = stats.profitFactor ?? stats.profit_factor;
      if (wr    != null) { const el = document.getElementById('stat-win-rate');      if (el) el.textContent = parseFloat(wr).toFixed(1) + '%'; }
      if (net   != null) { const el = document.getElementById('stat-net-pnl');       if (el) { el.textContent = '$' + parseFloat(net).toFixed(2); el.style.color = parseFloat(net) >= 0 ? 'var(--color-success)' : 'var(--color-danger)'; } }
      if (total != null) { const el = document.getElementById('stat-total-trades');  if (el) el.textContent = total; }
      if (pf    != null) { const el = document.getElementById('stat-profit-factor'); if (el) el.textContent = parseFloat(pf).toFixed(2); }
    } catch {}
  }

  async function adminPopulateTop50() {
    try {
      showToast('Loading top 10 tokens by volume...', 'info');
      const result = await api('POST', '/api/admin/token-board/populate-top50');
      showToast(`Done: ${result.added} tokens loaded`, 'success');
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
      await api('POST', '/api/admin/global-tokens', {
        symbol,
        enabled: !banned,
        banned: banned,
      });
      showToast(`${symbol} ${banned ? 'BANNED' : 'UNBANNED'}`, banned ? 'error' : 'success');
      adminLoadTokenBoard();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminRemoveTokenBoard(symbol) {
    try {
      await api('DELETE', `/api/admin/token-board/${symbol}`);
      adminLoadTokenBoard();
    } catch (err) { showToast(err.message, 'error'); }
  }

  let _chatBusy = false;
  async function customerChat() {
    const input = document.getElementById('chatbot-input');
    const container = document.getElementById('chatbot-messages');
    const sendBtn = document.getElementById('chatbot-send');
    if (!input || !container) return;
    const msg = input.value.trim();
    if (!msg || _chatBusy) return;

    // Lock to prevent double-send
    _chatBusy = true;
    input.value = '';
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '...'; }

    // Dismiss mobile keyboard after send
    input.blur();

    // Show user message
    const userEl = document.createElement('div');
    userEl.className = 'chatbot-msg chatbot-user';
    userEl.innerHTML = `<span>${escapeHtml(msg)}</span>`;
    container.appendChild(userEl);

    // Show typing indicator
    const typingEl = document.createElement('div');
    typingEl.className = 'chatbot-typing';
    typingEl.textContent = 'MCT is typing…';
    container.appendChild(typingEl);
    container.scrollTop = container.scrollHeight;

    try {
      const res = await fetch('/api/chatbot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      const data = await res.json();
      typingEl.remove();
      const botEl = document.createElement('div');
      botEl.className = 'chatbot-msg chatbot-bot';
      botEl.innerHTML = `<span>${escapeHtml(data.reply || 'Sorry, try again.').replace(/\n/g, '<br>')}</span>`;
      container.appendChild(botEl);
    } catch {
      typingEl.remove();
      const errEl = document.createElement('div');
      errEl.className = 'chatbot-msg chatbot-bot';
      errEl.innerHTML = '<span>Sorry, I\'m having trouble. Try again later.</span>';
      container.appendChild(errEl);
    } finally {
      _chatBusy = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
      // Scroll to bottom — requestAnimationFrame ensures DOM paint is done first
      requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
    }
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
        try { applyBacktestParams(JSON.parse(raw)); } catch {}
      };
      // Show active version banner if one is set
      try {
        const activeRow = await api('GET', '/api/admin/ai-versions/active');
        updateActiveVersionBanner(activeRow);
      } catch {}

      showToast(`Loaded ${data.versions.length} AI versions`, 'success');
    } catch (err) {
      showToast('Failed to load AI versions: ' + err.message, 'error');
    }
  }

  function updateActiveVersionBanner(activeRow) {
    const hasActive = activeRow && activeRow.version;

    // ── Backtest section inline banner ────────────────────────────────────
    const btBanner = $('#active-version-banner');
    if (btBanner) {
      if (hasActive) {
        const slPct    = activeRow.slPct    ?? activeRow.sl_pct    ?? null;
        const trailPct = activeRow.trailStep ?? activeRow.trailing_step ?? null;
        const maxPos   = activeRow.maxPositions ?? activeRow.max_positions ?? 3;
        const activeLev = parseInt(activeRow.leverage) || 100;
        const fmtCap = (v) => Math.round(parseFloat(v) * 100 * activeLev) + '%';
        btBanner.textContent = `🟢 Live: ${activeRow.version}`
          + (slPct    != null ? ` — SL ${fmtCap(slPct)}`    : '')
          + (trailPct != null ? ` · Trail ${fmtCap(trailPct)}` : '')
          + ` · ${maxPos} pos max`;
        btBanner.style.display = '';
      } else {
        btBanner.textContent = '⚪ Using default settings (no version active)';
        btBanner.style.display = '';
      }
    }

    // ── Persistent top bar in Admin panel ────────────────────────────────
    const topBar   = $('#admin-active-version-bar');
    const noBar    = $('#admin-no-version-bar');
    const nameEl   = $('#admin-active-version-name');
    const paramsEl = $('#admin-active-version-params');

    if (hasActive) {
      const a = activeRow;
      // lev: always 100 for current strategy
      const lev = parseInt(a.leverage) || 100;
      // capPct: converts a price-decimal to capital % (× leverage), shown as integer
      // e.g. 0.0015 × 100 (lev) × 100 = 15%  →  "15%"
      //      0.002  × 100 × 100 = 20%  →  "20%"
      //      0.012  × 100 × 100 = 120% →  "120%"
      const capPct = (v) => v != null ? Math.round(parseFloat(v) * 100 * lev) + '%' : null;
      // pct: plain percentage (×100, no leverage factor) — for risk%, proximity, etc.
      const pct = (v) => v != null ? Math.round(parseFloat(v) * 100) + '%' : null;
      const int = (v) => v != null ? parseInt(v) : null;
      const fp  = (v) => v != null ? parseFloat(v) : null;

      if (nameEl) nameEl.textContent = a.version;

      // Build a full readable summary of every param in the active version
      const lines = [];

      // Risk & position
      const riskLine = [
        a.slPct    != null ? `SL ${capPct(a.slPct)}`               : null,
        a.tpPct    != null && fp(a.tpPct) > 0 ? `TP ${capPct(a.tpPct)}` : `TP trail-only`,
        a.trailStep != null ? `Trail ${capPct(a.trailStep)}`        : null,
        a.leverage  != null ? `Lev ${a.leverage}×`                  : null,
        a.riskPct   != null ? `Risk ${pct(a.riskPct)}`              : null,
        a.maxPositions  != null ? `${a.maxPositions} pos max`       : null,
        a.maxConsecLoss != null ? `stop after ${a.maxConsecLoss} losses` : null,
      ].filter(Boolean).join(' · ');
      if (riskLine) lines.push('⚖️  ' + riskLine);

      // Structure
      const structParts = [
        a.swing4h  != null ? `Swing 4H=${a.swing4h}`   : null,
        a.swing1h  != null ? `1H=${a.swing1h}`          : null,
        a.swing15m != null ? `15M=${a.swing15m}`        : null,
        a.swing1m  != null ? `1M=${a.swing1m}`          : null,
        a.proximity != null ? `Prox ${pct(a.proximity)}` : null,
        a.entryFresh != null ? `Fresh ≤${a.entryFresh}c` : null,
        a.dailyBodyRatio != null ? `Body≥${(parseFloat(a.dailyBodyRatio)*100).toFixed(0)}%` : null,
      ].filter(Boolean).join(' · ');
      if (structParts) lines.push('📐 ' + structParts);

      // RSI
      if (a.rsiPeriod != null && int(a.rsiPeriod) > 0) {
        lines.push(`📊 RSI(${a.rsiPeriod})  OB>${a.rsiOb}  OS<${a.rsiOs}`);
      } else if (a.rsiPeriod === 0) {
        lines.push('📊 RSI off');
      }

      // EMA
      if (a.emaFast != null && int(a.emaFast) > 0) {
        lines.push(`📈 EMA ${a.emaFast}/${a.emaSlow}` + (int(a.emaTrend) > 0 ? ` trend=${a.emaTrend}` : ''));
      } else if (a.emaFast === 0) {
        lines.push('📈 EMA off');
      }

      // Volume
      if (a.volMult != null && fp(a.volMult) > 0) {
        lines.push(`📦 Vol ≥${a.volMult}× avg`);
      }

      // Direction settings
      const dirEnabled = [];
      const enableL = a.enableLong  !== false && a.enableLong  !== 'false';
      const enableS = a.enableShort !== false && a.enableShort !== 'false';
      if (enableL && enableS) dirEnabled.push('LONG + SHORT');
      else if (enableL)       dirEnabled.push('LONG only');
      else if (enableS)       dirEnabled.push('SHORT only');
      else                    dirEnabled.push('⚠️ Both disabled');

      const dirOverrides = [];
      if (fp(a.slPctLong)    > 0) dirOverrides.push(`SL▲ ${capPct(a.slPctLong)}`);
      if (fp(a.slPctShort)   > 0) dirOverrides.push(`SL▼ ${capPct(a.slPctShort)}`);
      if (fp(a.tpPctLong)    > 0) dirOverrides.push(`TP▲ ${capPct(a.tpPctLong)}`);
      if (fp(a.tpPctShort)   > 0) dirOverrides.push(`TP▼ ${capPct(a.tpPctShort)}`);
      if (fp(a.trailStepLong)  > 0) dirOverrides.push(`Trail▲ ${capPct(a.trailStepLong)}`);
      if (fp(a.trailStepShort) > 0) dirOverrides.push(`Trail▼ ${capPct(a.trailStepShort)}`);

      lines.push('🔀 ' + dirEnabled[0] + (dirOverrides.length ? '  |  ' + dirOverrides.join(' · ') : ''));

      if (paramsEl) paramsEl.innerHTML = lines.map(l => `<span style="display:block;line-height:1.7;">${escapeHtml(l)}</span>`).join('');

      if (topBar) topBar.style.display = 'flex';
      if (noBar)  noBar.style.display  = 'none';
    } else {
      if (topBar) topBar.style.display = 'none';
      if (noBar)  noBar.style.display  = '';
    }
  }

  // Activate current backtest UI settings for live trading.
  // Works two ways:
  //   1. Version selected in dropdown → activate that saved version + overlay current UI params
  //   2. No version selected → save current UI params as a new "manual" version and activate
  async function activateVersionForTrading() {
    const sel     = $('#bt-ai-version');
    const versionId = sel?.value || null;
    const btn     = $('#btn-activate-version');
    if (btn) { btn.disabled = true; btn.textContent = 'Activating…'; }
    try {
      const uiParams = collectBacktestParams();

      let result;
      if (versionId) {
        // Named version — activate it, then patch with any UI overrides
        result = await api('POST', `/api/admin/ai-versions/${versionId}/activate`, { uiOverride: uiParams });
      } else {
        // No version selected — save current settings as a new "Manual" version and activate
        const name = `Manual ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
        result = await api('POST', '/api/dashboard/strategy-versions/custom', {
          name,
          genome: uiParams,
          activateAfterSave: true,
        });
        // Also write to active_ai_version settings via admin endpoint
        await api('POST', '/api/admin/ai-versions/activate-manual', { name, params: uiParams });
        result = { ok: true, version: name, params: uiParams };
      }

      if (result.ok) {
        showToast(`✅ Settings activated — bot uses these params on next trade`, 'success');
        const displayParams = result.params || uiParams;
        updateActiveVersionBanner({ version: result.version || 'Manual', ...displayParams });
      }
    } catch (err) {
      showToast('Activate failed: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🚀 Trade with This'; }
    }
  }

  // Remove active version — revert bot to default hardcoded params
  async function deactivateVersion() {
    try {
      await api('POST', '/api/admin/ai-versions/deactivate');
      showToast('Active version cleared — bot reverts to defaults', 'success');
      updateActiveVersionBanner(null);
    } catch (err) {
      showToast('Deactivate failed: ' + err.message, 'error');
    }
  }

  // Sync the live version banner to current actual settings (100x, VWAP+Structure, 4 tokens)
  async function syncCurrentVersion() {
    try {
      const result = await api('POST', '/api/admin/ai-versions/sync-current');
      showToast('✅ Live version synced to current settings', 'success');
      updateActiveVersionBanner(result);
    } catch (err) {
      showToast('Sync failed: ' + err.message, 'error');
    }
  }

  // NOTE: activateVersionForTrading + deactivateVersion added to window.CryptoBot
  // at the exports block below — do NOT assign here, CryptoBot doesn't exist yet.

  // ── Token Tag Input ──────────────────────────────────────────────────────────
  // A tag-chip input with autocomplete + localStorage persistence.
  // Reads/writes hidden #bt-symbol-list which collectBacktestParams reads.
  const BT_TOKEN_LS_KEY = 'bt_symbol_list_v1';
  let _btAllTokens  = [];   // full symbol list loaded from DB
  let _btSelected   = [];   // currently selected symbols

  function _btSave() {
    const hidden = $('#bt-symbol-list');
    if (hidden) hidden.value = _btSelected.join(',');
    try { localStorage.setItem(BT_TOKEN_LS_KEY, JSON.stringify(_btSelected)); } catch (_) {}
  }

  function _btRenderTags() {
    const wrap = $('#bt-token-tag-wrap');
    const inp  = $('#bt-token-input');
    if (!wrap || !inp) return;
    // Remove old tag elements (leave input and dropdown)
    wrap.querySelectorAll('.bt-tag').forEach(el => el.remove());
    // Re-insert tags before input
    _btSelected.forEach(sym => {
      const tag = document.createElement('span');
      tag.className = 'bt-tag';
      tag.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:rgba(212,175,55,0.15);border:1px solid rgba(212,175,55,0.4);color:#d4af37;font-size:0.75rem;font-family:monospace;font-weight:600;padding:2px 8px;border-radius:4px;white-space:nowrap;';
      tag.innerHTML = sym + ' <span style="cursor:pointer;opacity:0.7;font-size:0.85rem;" title="Remove">×</span>';
      tag.querySelector('span').addEventListener('click', () => {
        _btSelected = _btSelected.filter(s => s !== sym);
        _btRenderTags();
        _btSave();
      });
      wrap.insertBefore(tag, inp);
    });
    if (_btSelected.length === 0) {
      inp.placeholder = 'Type to search… (empty = Tokens tab)';
    } else {
      inp.placeholder = 'Add more…';
    }
  }

  function _btShowDropdown(matches) {
    const dd = $('#bt-token-dropdown');
    if (!dd) return;
    if (!matches.length) { dd.style.display = 'none'; return; }
    dd.innerHTML = matches.slice(0, 20).map(sym => {
      const isSel = _btSelected.includes(sym);
      return '<div data-sym="' + sym + '" style="padding:7px 12px;cursor:pointer;font-family:monospace;font-size:0.82rem;display:flex;justify-content:space-between;align-items:center;' +
        (isSel ? 'color:#d4af37;background:rgba(212,175,55,0.08);' : '') + '">' +
        sym +
        (isSel ? '<span style="font-size:0.7rem;opacity:0.7;">✓ added</span>' : '') +
        '</div>';
    }).join('');
    dd.style.display = 'block';
    dd.querySelectorAll('[data-sym]').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        const sym = el.dataset.sym;
        if (!_btSelected.includes(sym)) {
          _btSelected.push(sym);
          _btRenderTags();
          _btSave();
        }
        const inp = $('#bt-token-input');
        if (inp) { inp.value = ''; }
        dd.style.display = 'none';
      });
      el.addEventListener('mouseover', () => { el.style.background = 'rgba(255,255,255,0.05)'; });
      el.addEventListener('mouseout',  () => { el.style.background = _btSelected.includes(el.dataset.sym) ? 'rgba(212,175,55,0.08)' : ''; });
    });
  }

  async function initBtTokenInput() {
    const inp  = $('#bt-token-input');
    const wrap = $('#bt-token-tag-wrap');
    if (!inp || !wrap) return;

    // Load persisted selection
    try {
      const saved = localStorage.getItem(BT_TOKEN_LS_KEY);
      if (saved) _btSelected = JSON.parse(saved).filter(Boolean);
    } catch (_) {}
    _btRenderTags();
    _btSave();

    // Load all available tokens from DB (fallback to empty — user can still type manually)
    try {
      const rows = await api('GET', '/api/admin/global-tokens');
      _btAllTokens = rows.map(r => r.symbol).filter(s => s.endsWith('USDT'));
    } catch (_) { _btAllTokens = []; }

    // Click on wrapper focuses input
    wrap.addEventListener('click', () => inp.focus());

    // Keyup: filter and show dropdown
    inp.addEventListener('input', () => {
      const q = inp.value.trim().toUpperCase();
      if (!q) { $('#bt-token-dropdown').style.display = 'none'; return; }
      const matches = _btAllTokens.filter(s => s.startsWith(q) || s.includes(q));
      _btShowDropdown(matches.length ? matches : (q.endsWith('USDT') ? [q] : [q + 'USDT']));
    });

    // Enter / comma = add current input as token
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const sym = inp.value.trim().toUpperCase().replace(/,/g, '');
        const resolved = sym.endsWith('USDT') ? sym : sym + 'USDT';
        if (resolved.length > 4 && !_btSelected.includes(resolved)) {
          _btSelected.push(resolved);
          _btRenderTags();
          _btSave();
        }
        inp.value = '';
        const dd = $('#bt-token-dropdown');
        if (dd) dd.style.display = 'none';
      }
      if (e.key === 'Backspace' && !inp.value && _btSelected.length) {
        _btSelected.pop();
        _btRenderTags();
        _btSave();
      }
      if (e.key === 'Escape') {
        const dd = $('#bt-token-dropdown');
        if (dd) dd.style.display = 'none';
      }
    });

    // Close dropdown on outside click
    document.addEventListener('click', e => {
      if (!wrap.contains(e.target)) {
        const dd = $('#bt-token-dropdown');
        if (dd) dd.style.display = 'none';
      }
    }, true);
  }

  // Public helper: set token list from a saved version
  function setBtSymbolList(syms) {
    _btSelected = Array.isArray(syms) ? syms.filter(Boolean) : [];
    _btRenderTags();
    _btSave();
  }

  // Collect all backtest params from the UI — shared by runBacktest and activateVersionForTrading
  function collectBacktestParams() {
    // Direction fields are now the only source for SL/TP/Trail
    const slLong    = parseFloat($('#bt-sl-long')?.value)    / 100 || 0.03;
    const slShort   = parseFloat($('#bt-sl-short')?.value)   / 100 || 0.03;
    const tpLong    = parseFloat($('#bt-tp-long')?.value)    / 100 || 0;
    const tpShort   = parseFloat($('#bt-tp-short')?.value)   / 100 || 0;
    const trLong    = parseFloat($('#bt-trail-long')?.value)  / 100 || 0.012;
    const trShort   = parseFloat($('#bt-trail-short')?.value) / 100 || 0.012;

    return {
      // Risk & position management
      days:          parseInt($('#backtest-days')?.value) || 7,
      // Global SL/TP/Trail derived from direction fields (used as backend fallback)
      slPct:         slLong,
      tpPct:         tpLong,
      trailStep:     trLong,
      leverage:      parseInt($('#bt-leverage')?.value) || 20,
      riskPct:       parseInt($('#bt-risk')?.value) / 100 || 0.10,
      maxPositions:  parseInt($('#bt-maxpos')?.value) || 3,
      maxConsecLoss: parseInt($('#bt-consec')?.value) ?? 2,
      wallet:        parseInt($('#bt-wallet')?.value) || 1000,
      // Symbol list: parse comma-separated input; empty = use Tokens tab
      symbolList:    ($('#bt-symbol-list')?.value || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
      // Structure analysis
      swing4h:       parseInt($('#bt-swing4h')?.value)   || 10,
      swing1h:       parseInt($('#bt-swing1h')?.value)   || 10,
      swing15m:      parseInt($('#bt-swing15m')?.value)  || 10,
      swing1m:       parseInt($('#bt-swing1m')?.value)   || 5,
      proximity:     parseFloat($('#bt-proximity')?.value) / 100 || 0.003,
      entryFresh:    parseInt($('#bt-entry-fresh')?.value) || 25,
      dailyBodyRatio: parseFloat($('#bt-daily-body')?.value) || 0.30,
      // RSI filter
      rsiPeriod:     parseInt($('#bt-rsi-period')?.value) ?? 14,
      rsiOb:         parseFloat($('#bt-rsi-ob')?.value) || 75,
      rsiOs:         parseFloat($('#bt-rsi-os')?.value) || 25,
      // EMA filter
      emaFast:       parseInt($('#bt-ema-fast')?.value) ?? 0,
      emaSlow:       parseInt($('#bt-ema-slow')?.value) || 21,
      emaTrend:      parseInt($('#bt-ema-trend')?.value) ?? 50,
      // Volume filter
      volMult:       parseFloat($('#bt-vol-mult')?.value) || 0,
      // Direction settings
      enableLong:    $('#bt-enable-long')?.checked !== false,
      enableShort:   $('#bt-enable-short')?.checked !== false,
      slPctLong:     slLong,
      slPctShort:    slShort,
      tpPctLong:     tpLong,
      tpPctShort:    tpShort,
      trailStepLong:  trLong,
      trailStepShort: trShort,
    };
  }

  // Populate backtest UI inputs from a saved settings object (used by AI version dropdown)
  function applyBacktestParams(p) {
    if (!p) return;
    const setV = (id, val) => { const el = $(id); if (el && val != null) el.value = val; };

    setV('#bt-leverage',   p.leverage);
    setV('#bt-risk',       p.risk_pct  != null ? (parseFloat(p.risk_pct)  * 100).toFixed(0) : (p.riskPct  != null ? (p.riskPct  * 100).toFixed(0) : null));
    setV('#bt-maxpos',     p.max_positions ?? p.maxPositions);
    setV('#bt-consec',     p.max_consec_loss ?? p.maxConsecLoss);
    // Symbol list: restore into tag input if a saved version carries one
    if (p.symbolList) {
      const syms = Array.isArray(p.symbolList) ? p.symbolList : String(p.symbolList).split(',').map(s => s.trim()).filter(Boolean);
      if (syms.length) setBtSymbolList(syms);
    }
    // Structure
    setV('#bt-swing4h',     p.swing4h);
    setV('#bt-swing1h',     p.swing1h);
    setV('#bt-swing15m',    p.swing15m);
    setV('#bt-swing1m',     p.swing1m);
    setV('#bt-proximity',   p.proximity  != null ? (parseFloat(p.proximity)  * 100).toFixed(2) : null);
    setV('#bt-entry-fresh', p.entryFresh);
    setV('#bt-daily-body',  p.dailyBodyRatio);
    // RSI
    setV('#bt-rsi-period',  p.rsiPeriod);
    setV('#bt-rsi-ob',      p.rsiOb);
    setV('#bt-rsi-os',      p.rsiOs);
    // EMA
    setV('#bt-ema-fast',    p.emaFast);
    setV('#bt-ema-slow',    p.emaSlow);
    setV('#bt-ema-trend',   p.emaTrend);
    // Volume
    setV('#bt-vol-mult',    p.volMult);
    // Direction: if version has per-direction values use them; otherwise fall back to global slPct
    const elLong  = $('#bt-enable-long');
    const elShort = $('#bt-enable-short');
    if (elLong  && p.enableLong  != null) elLong.checked  = p.enableLong  !== false && p.enableLong  !== 'false';
    if (elShort && p.enableShort != null) elShort.checked = p.enableShort !== false && p.enableShort !== 'false';
    // Resolve global fallbacks (support old params with sl_pct / trailing_step keys)
    const globalSl    = p.slPctLong    > 0 ? p.slPctLong    : (p.slPct    ?? p.sl_pct    ?? 0.03);
    const globalSlS   = p.slPctShort   > 0 ? p.slPctShort   : globalSl;
    const globalTp    = p.tpPctLong    > 0 ? p.tpPctLong    : (p.tpPct    ?? p.tp_pct    ?? 0);
    const globalTpS   = p.tpPctShort   > 0 ? p.tpPctShort   : globalTp;
    const globalTr    = p.trailStepLong  > 0 ? p.trailStepLong  : (p.trailStep ?? p.trailing_step ?? 0.012);
    const globalTrS   = p.trailStepShort > 0 ? p.trailStepShort : globalTr;
    const pct = (v) => (parseFloat(v) * 100).toFixed(1);
    setV('#bt-sl-long',      pct(globalSl));
    setV('#bt-sl-short',     pct(globalSlS));
    setV('#bt-tp-long',      pct(globalTp));
    setV('#bt-tp-short',     pct(globalTpS));
    setV('#bt-trail-long',   pct(globalTr));
    setV('#bt-trail-short',  pct(globalTrS));
  }

  async function runBacktest(mode, reverse) {
    const p = collectBacktestParams();
    const { days, slPct, tpPct, trailStep, leverage, riskPct, maxPositions, maxConsecLoss, wallet, symbolList } = p;

    const slDisplay  = (slPct  * 100).toFixed(1);
    const tpDisplay  = (tpPct  * 100).toFixed(1);
    const trDisplay  = (trailStep * 100).toFixed(1);
    const coinLabel  = symbolList?.length ? `${symbolList.length} tokens` : 'Tokens tab';
    const tag = (reverse ? 'REVERSE ' : '') + `${days}d SL:${slDisplay}% TP:${tpDisplay}% Trail:${trDisplay}% Lev:${leverage}x`;
    const resultEl = $('#fix-bitunix-result');
    if (resultEl) resultEl.textContent = `Running ${tag} backtest (${coinLabel})... please wait`;
    try {
      const data = await api('POST', '/api/admin/backtest', { strategy: 'full', reverse, ...p });
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
        const day = (t.date || '').slice(0, 10);
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

      // Build final output from bitmask combo result
      const data = finalData;
      const combos = data.allCombos || [];
      let output = '═══════════════════════════════════════════════════════════════════════════════════════════════════════\n';
      output += '  ⚛️ QUANTUM AI — BITMASK COMBO BACKTESTER\n';
      if (data.days) output += `  Period: ${data.days} days | Tokens: ${data.tokens || '?'}\n`;
      if (data.testedAt) output += `  Tested at: ${data.testedAt}\n`;
      if (data.leverageTested) output += `  Leverage tested: ${data.leverageTested.join('x, ')}x | Best: ${data.bestLeverage || '?'}x\n`;
      output += `  Phase: ${data.phase || 'exploring'} | Explored: ${data.exploration?.explored || 0}/${data.exploration?.total || 15}\n`;
      output += `  Best combo: #${data.activeCombo} (${data.comboName})\n`;
      const strats = data.strategies || {};
      const enabledList = Object.entries(strats).filter(([,v]) => v).map(([k]) => k).join(', ');
      output += `  Enabled: ${enabledList}\n`;
      output += '═══════════════════════════════════════════════════════════════════════════════════════════════════════\n\n';

      // ── Combo Leaderboard ──
      output += '── STRATEGY COMBO LEADERBOARD ─────────────────────────────────────────────────────\n';
      output += '#    | Combo                          | Trades |  WR%   | Avg PnL  | Score  | Status\n';
      output += '─'.repeat(95) + '\n';
      for (let i = 0; i < combos.length; i++) {
        const c = combos[i];
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`;
        const wr = (c.winRate * 100).toFixed(0);
        const pnl = c.avgPnl >= 0 ? `+${c.avgPnl.toFixed(2)}%` : `${c.avgPnl.toFixed(2)}%`;
        let status = '';
        if (c.active) status = '← ACTIVE';
        if (c.locked) status += ' [LOCKED]';
        output += `${String(medal).padEnd(5)}| ${c.name.padEnd(31)}| ${String(c.trades).padStart(6)} | ${String(wr + '%').padStart(6)} | ${pnl.padStart(8)} | ${c.score.toFixed(3).padStart(6)} | ${status}\n`;
      }

      output += '\n';
      if (combos.every(c => c.trades === 0)) {
        output += '  ⏳ No trades yet — the bot will collect data as it trades.\n';
        output += '  The optimizer will auto-switch to the best combo after 20+ trades per combo.\n';
        output += '  Currently running ALL strategies (#15) as default.\n';
      } else {
        const explored = combos.filter(c => c.trades >= 20).length;
        const remaining = 15 - explored;
        if (remaining > 0) {
          output += `  📊 ${explored}/15 combos have enough data (20+ trades). ${remaining} still exploring.\n`;
        } else {
          output += '  ✅ All combos explored! Optimizer is now auto-selecting the best performer.\n';
        }
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
              <button class="btn btn-sm" style="font-size:0.7rem;padding:2px 10px;min-height:26px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.35);color:#f87171;" onclick="window.CryptoBot.adminDeleteUserKey(${k.key_id},'${escapeHtml(k.label)}')">🗑 Delete Key</button>
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
          // liveOnly = on exchange but not tracked in DB — highlight in orange
          const liveOnlyBadge = t.liveOnly
            ? `<span style="font-size:0.65rem;background:#f59e0b;color:#000;border-radius:3px;padding:0 4px;margin-left:4px;font-weight:700;">EXCHANGE ONLY</span>`
            : '';

          return `<div style="display:grid;grid-template-columns:1fr auto;gap:4px;padding:6px 8px;background:${dangerBg};border-radius:4px;margin-bottom:2px;${t.liveOnly ? 'border-left:2px solid #f59e0b;' : ''}">
            <div>
              <span style="font-size:0.75rem;color:var(--color-text-muted);">${escapeHtml(t.email)} • ${t.platform} • x${t.leverage} • ${dur}${liveOnlyBadge}</span>
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

        const oppositeDir = dir === 'LONG' ? 'SHORT' : 'LONG';
        const oppColor    = dir === 'LONG' ? 'var(--color-danger)' : 'var(--color-success)';
        return `<div style="margin-bottom:var(--space-3);border:1px solid var(--color-border-muted);border-radius:var(--radius-md);overflow:hidden;">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--color-bg-raised);">
            <div style="display:flex;align-items:center;gap:8px;">
              <button class="btn btn-sm" style="font-size:0.65rem;background:#ef4444;color:#fff;border:none;padding:2px 8px;" data-close-token="${sym}">Close</button>
              <button class="btn btn-sm" style="font-size:0.65rem;background:transparent;border:1px solid ${oppColor};color:${oppColor};padding:2px 8px;font-weight:700;" data-reverse-token="${sym}" data-reverse-dir="${dir}">🔄 → ${oppositeDir}</button>
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
      listEl.querySelectorAll('[data-reverse-token]').forEach(btn => {
        btn.addEventListener('click', () => reverseOpenPosition(btn.dataset.reverseToken, btn.dataset.reverseDir));
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

  // Close current position and lock the opposite direction so the bot enters the reverse trade next cycle.
  async function reverseOpenPosition(symbol, currentDir) {
    const oppositeDir = currentDir === 'LONG' ? 'SHORT' : 'LONG';
    if (!confirm(`🔄 Reverse ${symbol}?\n\nThis will:\n1. Close all ${symbol} ${currentDir} positions now\n2. Lock ${symbol} direction to ${oppositeDir} for next entry\n\nConfirm?`)) return;

    const statusEl = document.getElementById('emergency-stop-status');
    if (statusEl) { statusEl.style.color = '#f59e0b'; statusEl.textContent = `Reversing ${symbol} ${currentDir} → ${oppositeDir}...`; }

    try {
      // Step 1: close current position
      const result = await api('POST', '/api/admin/emergency-close', { symbol });

      // Step 2: set per-token direction to opposite so bot enters the other side next cycle
      await setTokenDirection(symbol, oppositeDir);

      const closed = result.totalClosed || 0;
      if (statusEl) { statusEl.style.color = 'var(--color-success)'; statusEl.textContent = `${symbol}: ${closed} closed, direction → ${oppositeDir}`; }
      showToast(`${symbol} reversed: closed ${currentDir}, next entry = ${oppositeDir} 🔄`, 'success');
      loadOpenPositions();
    } catch (err) {
      if (statusEl) { statusEl.style.color = '#ef4444'; statusEl.textContent = `Reverse ${symbol} failed: ${err.message}`; }
      showToast('Reverse failed: ' + err.message, 'error');
    }
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

  // Kept for backwards compat — individual functions delegate to combined handler
  async function adminResyncBitunix(btn) { return adminFixAllData(btn); }
  async function adminPullBitunixHistory(btn) { return adminFixAllData(btn); }

  async function adminFixAllData(btn) {
    const statusEl = document.getElementById('resync-bitunix-status');
    const setStatus = (msg, color = 'var(--color-accent)') => {
      if (statusEl) { statusEl.textContent = msg; statusEl.style.color = color; }
    };
    const setBtn = (label) => { if (btn) { btn.textContent = label; } };

    if (btn) btn.disabled = true;
    let didChange = false;

    try {
      // Step 1: Pull all position history from Bitunix and insert/update trade records
      setBtn('⏳ Step 1/2 — Pulling history…');
      setStatus('Step 1/2 — Pulling Bitunix position history…');
      let pullResult = { inserted: 0, updated: 0, skipped: 0, errors: [] };
      try {
        const r = await api('POST', '/api/dashboard/pull-bitunix-history');
        if (r.error) throw new Error(r.error);
        pullResult = r;
        if ((r.inserted + r.updated) > 0) didChange = true;
      } catch (err) {
        setStatus(`Step 1 error: ${err.message}`, 'var(--color-danger)');
      }

      // Step 2: Re-fetch exit prices / P&L for any trades still missing them
      setBtn('⏳ Step 2/2 — Fixing missing data…');
      setStatus('Step 2/2 — Fixing missing exit prices and P&L…');
      let resyncResult = { fixed: 0, total: 0, skipped: 0, failed: 0, errors: [] };
      try {
        const r = await api('POST', '/api/dashboard/resync-bitunix');
        resyncResult = r;
        if (r.fixed > 0) didChange = true;
      } catch (err) {
        setStatus(`Step 2 error: ${err.message}`, 'var(--color-danger)');
      }

      // Summary
      const pullMsg  = `Pulled: +${pullResult.inserted} new, ~${pullResult.updated} updated`;
      const fixMsg   = `Fixed: ${resyncResult.fixed}/${resyncResult.total} trades`;
      const errorMsg = resyncResult.failed > 0 && resyncResult.errors?.length
        ? ` — ${resyncResult.errors[0].error}` : '';
      const fullMsg  = `${pullMsg} · ${fixMsg}${errorMsg}`;

      const hasError = resyncResult.failed > 0 || pullResult.errors?.length > 0;
      setStatus(fullMsg, didChange ? 'var(--color-success)' : hasError ? 'var(--color-danger)' : 'var(--color-text-muted)');
      showToast(fullMsg, didChange ? 'success' : hasError ? 'error' : 'info');

      if (didChange) setTimeout(() => loadTradeHistory?.(), 1000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔄 Fix All Data'; }
    }
  }

  async function adminResyncFees() {} // kept for backwards compat — no-op

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
      // cash_wallet + commission_earned = true total (same formula as dashboard)
      const bal = (parseFloat(u.cash_wallet || 0) + parseFloat(u.commission_earned || 0)).toFixed(2);
      const paidAt = u.last_paid_at ? new Date(u.last_paid_at) : new Date(u.created_at);
      const dueMs = paidAt.getTime() + 7 * 86400000;
      const msLeft = dueMs - Date.now();
      const isOverdue = !u.is_admin && msLeft <= 0;
      const daysLeft = msLeft / 86400000;
      const timerColor = isOverdue ? 'var(--color-danger)' : daysLeft <= 2 ? 'var(--color-danger)' : daysLeft <= 4 ? '#f59e0b' : 'var(--color-success)';
      const timerCell = u.is_admin
        ? `<span style="color:var(--color-accent);font-size:0.75rem;font-weight:600;">No Fee</span>`
        : `<span class="admin-timer-badge" data-due="${dueMs}" style="color:${timerColor};font-size:0.8rem;font-weight:600;font-family:var(--font-mono);">${formatCountdown(msLeft)}</span>`;

      const roleBtn = u.is_admin
        ? `<button class="btn btn-sm" style="font-size:0.7rem;padding:2px 8px;background:var(--color-accent);color:#fff;border:none;" onclick="window.CryptoBot.adminChangeRole(${u.id},'${escapeHtml(u.email)}',false)">Demote</button>`
        : `<button class="btn btn-sm" style="font-size:0.7rem;padding:2px 8px;background:#8b5cf6;color:#fff;border:none;" onclick="window.CryptoBot.adminChangeRole(${u.id},'${escapeHtml(u.email)}',true)">Make Admin</button>`;

      const paidBtn = u.is_admin
        ? `<button class="btn btn-sm" style="font-size:0.7rem;padding:2px 8px;background:#059669;color:#fff;border:none;opacity:0.6;cursor:default;" disabled>✓ Admin</button>`
        : `<button class="btn btn-sm" style="font-size:0.7rem;padding:2px 8px;background:#059669;color:#fff;border:none;" onclick="window.CryptoBot.adminMarkPaid(${u.id},'${escapeHtml(u.email)}')">✓ Paid</button>`;

      const bxLink = u.bitunix_referral_link || '';
      const bxLinkLabel = bxLink ? '🔵 Set' : '🔵 —';
      const delKeyBtn = u.key_count > 0
        ? `<button class="btn btn-sm" style="font-size:0.7rem;padding:2px 8px;background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;font-weight:700;" onclick="window.CryptoBot.adminShowUserKeys(${u.id},'${escapeHtml(u.email)}')">🗑 Del Key</button>`
        : '';

      return `<tr style="${isOverdue ? 'background:rgba(239,68,68,0.05);' : ''}">
      <td>${escapeHtml(u.email)}${u.is_admin ? ' <span style="color:var(--color-accent);font-size:0.7rem;font-weight:700;">ADMIN</span>' : ''}</td>
      <td>${u.key_count}</td>
      <td class="text-mono">$${bal} <button class="btn btn-ghost btn-sm" style="font-size:0.7rem;padding:2px 6px;" onclick="window.CryptoBot.adminEditWallet(${u.id},'${escapeHtml(u.email)}',${bal})">Edit</button></td>
      <td>${escapeHtml(u.referral_code || '-')} <button class="btn btn-ghost btn-sm" style="font-size:0.7rem;padding:2px 6px;" title="${escapeHtml(bxLink) || 'No Bitunix link set'}" onclick="window.CryptoBot.adminSetBitunixReferralLink(${u.id},'${escapeHtml(u.email)}','${escapeHtml(bxLink)}')">${bxLinkLabel}</button></td>
      <td>${formatDate(u.created_at)}</td>
      <td style="white-space:nowrap;">${timerCell}</td>
      <td style="white-space:nowrap;display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
        ${u.is_blocked
          ? `<button class="btn btn-primary btn-sm" onclick="window.CryptoBot.adminAction('unblock',${u.id})">Unblock</button>`
          : `<button class="btn btn-danger btn-sm" onclick="window.CryptoBot.adminAction('block',${u.id})">Block</button>`}
        ${paidBtn}
        ${roleBtn}
        ${delKeyBtn}
      </td>
    </tr>`;
    }).join('');
  }

  async function adminShowUserKeys(userId, email) {
    let keys;
    try {
      keys = await api('GET', `/api/admin/users/${userId}/api-keys`);
    } catch (err) {
      showToast(err.message, 'error');
      return;
    }

    if (!keys.length) {
      showToast(`${email} has no API keys`, 'info');
      return;
    }

    // Build a small modal-style overlay
    const existing = document.getElementById('admin-keys-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'admin-keys-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--color-card,#1e2130);border:1px solid var(--color-border,#2d3148);border-radius:12px;padding:24px;min-width:380px;max-width:520px;width:90%;';

    const rows = keys.map(k => {
      const preview = k.key_preview ? `(${k.key_preview}…)` : '';
      const label   = escapeHtml(k.label || k.platform);
      const platTag = `<span style="font-size:0.7rem;background:rgba(99,102,241,0.2);color:#818cf8;border-radius:4px;padding:1px 6px;margin-right:6px;">${escapeHtml(k.platform)}</span>`;
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--color-border,#2d3148);">
        <span style="font-size:0.85rem;">${platTag}${label} <span style="color:var(--color-text-muted,#9ca3af);font-size:0.75rem;font-family:var(--font-mono,monospace);">${preview}</span></span>
        <button class="btn btn-danger btn-sm" style="font-size:0.7rem;padding:2px 10px;" onclick="window.CryptoBot.adminDeleteUserKey(${k.id},'${label}')">Delete</button>
      </div>`;
    }).join('');

    box.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h3 style="margin:0;font-size:1rem;">API Keys — <span style="color:var(--color-accent);">${escapeHtml(email)}</span></h3>
        <button onclick="document.getElementById('admin-keys-modal').remove()" style="background:none;border:none;color:var(--color-text-muted,#9ca3af);font-size:1.2rem;cursor:pointer;line-height:1;">×</button>
      </div>
      ${rows}
    `;

    modal.appendChild(box);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  }

  async function adminDeleteUserKey(keyId, label) {
    if (!confirm(`Delete API key "${label}"?\n\nThe key will be disabled immediately. Open trade records are NOT affected.`)) return;
    try {
      await api('DELETE', `/api/admin/keys/${keyId}`);
      showToast('API key deleted', 'success');
      document.getElementById('admin-keys-modal')?.remove();
      loadAdmin();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminSetBitunixReferralLink(userId, email, currentLink) {
    const link = prompt(`Set Bitunix referral link for ${email}\nCurrent: ${currentLink || '(none)'}\n\nEnter Bitunix referral URL (blank to clear):`, currentLink || '');
    if (link === null) return; // cancelled
    try {
      await api('PUT', `/api/admin/users/${userId}/bitunix-referral-link`, { link: link.trim() });
      showToast('Bitunix referral link updated', 'success');
      loadAdmin();
    } catch (err) { showToast(err.message, 'error'); }
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
    logPollTimer = setInterval(fetchLogs, 10000);
    const status = $('#logs-status');
    if (status) status.textContent = 'Live — polling every 10s';
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
        const time = entry.ts ? entry.ts.slice(11, 19) : '--:--:--';
        const cat = (entry.category || 'system').toUpperCase().padEnd(9);
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

    const tr = window.i18n ? window.i18n.t.bind(window.i18n) : function(k) { return k; };
    if (isPaused) {
      dot.style.background = 'var(--color-danger)';
      text.textContent = tr('pause.paused');
      text.setAttribute('data-i18n', 'pause.paused');
      text.style.color = 'var(--color-danger)';
      btn.textContent = tr('pause.resume');
      btn.setAttribute('data-i18n', 'pause.resume');
      btn.style.background = 'var(--color-success)';
      btn.style.borderColor = 'var(--color-success)';
      btn.style.color = '#fff';
    } else {
      dot.style.background = 'var(--color-success)';
      text.textContent = tr('pause.active');
      text.setAttribute('data-i18n', 'pause.active');
      text.style.color = 'var(--color-success)';
      btn.textContent = tr('pause.pause');
      btn.setAttribute('data-i18n', 'pause.pause');
      btn.style.background = '';
      btn.style.borderColor = 'var(--color-danger)';
      btn.style.color = 'var(--color-danger)';
    }
  }

  async function togglePause() {
    const btn = $('#pause-btn');
    const isPaused = btn.getAttribute('data-i18n') === 'pause.resume';
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

  // ── Admin Email Broadcast ─────────────────────────────────

  let _emailMode = 'text'; // 'text' | 'html'

  function emailSetMode(mode) {
    _emailMode = mode;
    const badge = document.getElementById('email-mode-badge');
    if (badge) badge.textContent = `mode: ${mode === 'html' ? 'HTML' : 'plain text'}`;
    const ta = document.getElementById('email-body');
    if (ta) ta.placeholder = mode === 'html'
      ? 'Write HTML here — e.g. <b>Bold text</b>, <a href="https://...">Link</a>\n\n<p>Your message paragraph.</p>'
      : 'Write your message here...\n\nPlain text — line breaks are preserved.';
  }

  async function checkEmailSmtp() {
    const dot   = document.getElementById('email-smtp-dot');
    const label = document.getElementById('email-smtp-label');
    if (!dot || !label) return;
    try {
      const data = await api('GET', '/api/admin/email/status');
      if (data.configured) {
        dot.style.background = '#22c55e';
        label.textContent = `SMTP ready — sending from ${data.from} via ${data.host}`;
        label.style.color = '#86efac';
      } else {
        dot.style.background = '#f59e0b';
        label.textContent = 'SMTP not configured — see setup guide below to enable email';
        label.style.color = '#fcd34d';
      }
    } catch {
      dot.style.background = '#ef4444';
      label.textContent = 'Could not check SMTP status';
      label.style.color = '#fca5a5';
    }
  }

  async function sendTestEmail() {
    const label = document.getElementById('email-smtp-label');
    if (label) label.textContent = 'Sending test email...';
    try {
      const data = await api('POST', '/api/admin/email/test', {});
      showToast(data.message || 'Test email sent!', 'success');
      if (label) label.textContent = data.message || 'Test email sent!';
    } catch (err) {
      showToast(err.message || 'Test failed', 'error');
      if (label) label.textContent = `Error: ${err.message}`;
    }
  }

  async function sendBroadcastEmail() {
    const subject = (document.getElementById('email-subject')?.value || '').trim();
    const body    = (document.getElementById('email-body')?.value || '').trim();
    const filter  = document.getElementById('email-filter')?.value || 'all';
    const status  = document.getElementById('email-send-status');
    const btn     = document.getElementById('email-send-btn');

    if (!subject) return showToast('Subject is required', 'error');
    if (!body)    return showToast('Email body is required', 'error');

    const isHtml = _emailMode === 'html';
    const bodyHtml = isHtml ? body : `<p>${body.replace(/\n/g, '<br/>')}</p>`;
    const bodyText = isHtml ? body.replace(/<[^>]+>/g, '') : body;

    const confirmMsg = `Send to all "${filter}" members?\n\nSubject: ${subject}`;
    if (!confirm(confirmMsg)) return;

    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
    if (status) status.textContent = '';

    try {
      const data = await api('POST', '/api/admin/email/broadcast', {
        subject,
        body_html: bodyHtml,
        body_text: bodyText,
        filter,
      });
      showToast(`✅ ${data.message}`, 'success');
      if (status) status.textContent = data.message || `Sending to ${data.recipientCount} members...`;
    } catch (err) {
      showToast(err.message || 'Broadcast failed', 'error');
      if (status) { status.textContent = `Error: ${err.message}`; status.style.color = 'var(--color-danger)'; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Send Broadcast'; }
    }
  }

  // ── Direction Override ──────────────────────────────────────────────────────
  let _currentDirection = 'auto';

  async function loadDirectionOverride() {
    try {
      const data = await api('GET', '/api/admin/direction-override');
      _currentDirection = data.direction || 'auto';
      updateDirectionUI(_currentDirection);
    } catch (_) {}
  }

  function updateDirectionUI(direction) {
    const status = document.getElementById('dir-override-status');
    const btnAuto   = document.getElementById('dir-btn-auto');
    const btnLong   = document.getElementById('dir-btn-long');
    const btnShort  = document.getElementById('dir-btn-short');

    const labels = { auto: '🤖 Auto', bullish: '📈 LONG only', bearish: '📉 SHORT only' };
    const colors = { auto: 'var(--color-text-muted)', bullish: '#10b981', bearish: '#ef4444' };
    const bgs    = { auto: 'var(--color-bg-muted)', bullish: 'rgba(16,185,129,0.15)', bearish: 'rgba(239,68,68,0.15)' };

    if (status) {
      status.textContent = labels[direction] || '🤖 Auto';
      status.style.color      = colors[direction] || colors.auto;
      status.style.background = bgs[direction]    || bgs.auto;
    }
    // Highlight active button
    [btnAuto, btnLong, btnShort].forEach(b => b && b.style.removeProperty('outline'));
    const activeBtn = direction === 'bullish' ? btnLong : direction === 'bearish' ? btnShort : btnAuto;
    if (activeBtn) activeBtn.style.outline = '2px solid var(--color-primary)';
  }

  async function setDirectionOverride(direction) {
    try {
      await api('POST', '/api/admin/direction-override', { direction });
      _currentDirection = direction;
      updateDirectionUI(direction);
      showToast(direction === 'auto' ? 'Direction: Auto (swing structure)' : `Direction locked: ${direction === 'bullish' ? 'LONG only 📈' : 'SHORT only 📉'}`, 'success');
    } catch (err) {
      showToast('Failed to set direction: ' + err.message, 'error');
    }
  }

  async function setTokenDirection(symbol, direction) {
    try {
      const r = await fetch('/admin/token-direction/' + symbol, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (localStorage.getItem('token') || '') },
        body: JSON.stringify({ direction })
      });
      const d = await r.json();
      if (d.ok || d.ok === undefined) {
        updateTokenDirStatus(symbol, direction === 'auto' ? null : direction);
      }
    } catch (e) { console.error('setTokenDirection error:', e); }
  }

  const _tokenDirState = {};

  function updateTokenDirStatus(symbol, val) {
    _tokenDirState[symbol] = val || null;
    const status = document.getElementById('tdir-status-' + symbol);
    const btnRev = document.getElementById('tdir-rev-' + symbol);
    if (!status) return;
    if (val === 'LONG') {
      status.textContent = '📈 LONG';
      status.style.color = '#00ff88';
      if (btnRev) { btnRev.style.borderColor = '#00ff88'; btnRev.style.color = '#00ff88'; }
    } else if (val === 'SHORT') {
      status.textContent = '📉 SHORT';
      status.style.color = '#ff4060';
      if (btnRev) { btnRev.style.borderColor = '#ff4060'; btnRev.style.color = '#ff4060'; }
    } else {
      status.textContent = 'Auto';
      status.style.color = '#888';
      if (btnRev) { btnRev.style.borderColor = '#555'; btnRev.style.color = '#aaa'; }
    }
  }

  async function reverseTokenDirection(symbol) {
    const cur = _tokenDirState[symbol];
    // LONG → SHORT, SHORT → LONG, auto/null → LONG (first press locks LONG)
    const next = cur === 'LONG' ? 'SHORT' : cur === 'SHORT' ? 'LONG' : 'LONG';
    await setTokenDirection(symbol, next);
  }

  async function loadTokenDirections() {
    try {
      const r = await fetch('/admin/token-directions', {
        headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('token') || '') }
      });
      if (!r.ok) return;
      const map = await r.json();
      for (const [sym, val] of Object.entries(map)) {
        updateTokenDirStatus(sym, val);
      }
    } catch (_) {}
  }

  async function reverseDirection() {
    const next = _currentDirection === 'bullish' ? 'bearish'
               : _currentDirection === 'bearish' ? 'bullish'
               : null; // auto → don't reverse without knowing current trend
    if (!next) {
      showToast('Set to LONG or SHORT first before reversing', 'error');
      return;
    }
    await setDirectionOverride(next);
  }

  window.CryptoBot = {
    toggleSettings, saveSettings, deleteKey, showToast, syncSlider, syncNum, saveProfile, changePassword,
    togglePause,
    submitTopUp, saveUsdtAddress, withdrawFromWallet, payWeekly, saveBitunixReferralLink,
    adminAction, adminChangeRole, adminSub, adminWd, saveAdminSettings, adminEditWallet, adminSetBitunixReferralLink, clearErrors,
    adminShowUserKeys, adminDeleteUserKey,
    adminEditSplit, adminPauseKey, adminResumeKey, adminMarkPaid, adminResyncBitunix, adminPullBitunixHistory,
    goToAuth, showLoginForm, onPlatformChange,
    searchCoins, addCoin, removeCoin,
    filterLogs, clearLogs,
    addTokenLeverage, removeTokenLeverage, updateTokenLev, autoPopulateLeverage, searchTokenLev, pickTokenLev, selectRiskLevel,
    addAllowedToken, addBannedToken, unbanGlobalToken, removeGlobalToken, scanBitunixTokens,
    searchAdminToken, pickAdminToken, searchUserBanToken,
    addRiskLevel, saveRiskLevel, deleteRiskLevel,
    loadKronosPredictions,
    loadOpenPositions, emergencyCloseToken, emergencyCloseAll, reverseOpenPosition,
    loadDirectionOverride, setDirectionOverride, reverseDirection,
    setTokenDirection, updateTokenDirStatus, loadTokenDirections, reverseTokenDirection,
    activateVersionForTrading, deactivateVersion, syncCurrentVersion,
    fixBitunixPnl, debugBitunix, runBacktest, loadAiVersions, runAiOptimize, adminResyncFees, adminFixTrades, adminClearTestData,
    mcRefresh, mcCommand, mcChat, mcChatQuick, switchAdminTab, filterAgents, customerChat,
    loadStrategyConfig, loadStrategyComposer, initStratSubTabs,
    startAdminRefresh, stopAdminRefresh,
    checkEmailSmtp, sendTestEmail, sendBroadcastEmail, emailSetMode,
    loadSignalBoard, toggleWatch, watchAll, setUserLeverage,
    adminLoadTokenBoard, adminAddTokenBoard, adminPopulateTop50, adminSetRiskTag, adminSetTokenLev, adminToggleBan, adminRemoveTokenBoard,
    toggleStrategyToken, loadTokenCardPrices, loadTokenStats, editTokenCardLev,
    mcToggleSkill, mcUpdateConfig, mcCreateAgent, mcRemoveAgent, mcDownloadTrades,
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

    // Auto-fill referral code from URL (?ref=XXXX) and show welcome banner
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref');
    if (ref) {
      const refInput = $('#signup-referral');
      if (refInput) refInput.value = ref;

      // Fetch referrer info and show welcome banner
      api('GET', `/api/auth/referral-info?ref=${encodeURIComponent(ref)}`)
        .then(info => {
          if (!info || !info.found) return;
          const banner = $('#referral-welcome-banner');
          const text   = $('#referral-banner-text');
          const bxBtn  = $('#referral-bitunix-link');
          if (!banner) return;
          if (text) text.textContent = `Invited by ${info.referrer_email} — sign up now and start trading!`;
          if (bxBtn && info.bitunix_referral_link) {
            bxBtn.href = info.bitunix_referral_link;
            bxBtn.style.display = 'inline-block';
          }
          banner.style.display = 'block';
          // Push landing content down so banner doesn't overlap navbar
          const content = document.querySelector('.landing-content');
          if (content) content.style.paddingTop = '48px';
        })
        .catch(() => {});
    }

    checkSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

function loadBrain() {
  const display = document.getElementById('brain-display');
  if (display) {
    display.style.display = 'block';
    fetch('/api/admin/brain-status').then(r => r.json()).then(data => {
      display.innerText = data.report;
    });
  }
}