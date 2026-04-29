// ── Trading Floor — Pixel Art Bot Visualization ───────────────────────────
// 4 trader characters (BTC, ETH, SOL, BNB) animated based on live bot state.
// Canvas-only, no external assets. Each pixel = SCALE canvas pixels.

(function (global) {
  'use strict';

  const SCALE = 5; // each "pixel" = 5×5 canvas px  →  char is 40×70 canvas px

  // ── Token config ──────────────────────────────────────────────────────────
  const TOKENS = [
    { symbol: 'BTCUSDT', label: 'BTC', shirt: '#f7931a', shirtD: '#c87817', hair: '#3d2b1f' },
    { symbol: 'ETHUSDT', label: 'ETH', shirt: '#627eea', shirtD: '#4a60c4', hair: '#111' },
    { symbol: 'SOLUSDT', label: 'SOL', shirt: '#14f195', shirtD: '#0db87a', hair: '#1a1a2e' },
    { symbol: 'BNBUSDT', label: 'BNB', shirt: '#f3ba2f', shirtD: '#d9a520', hair: '#5c3d00' },
  ];

  // ── Colour helpers ────────────────────────────────────────────────────────
  const SKIN   = '#f5cba7';
  const SKIND  = '#e8b48a';
  const EYE    = '#222';
  const PANT   = '#1e293b';
  const PANTL  = '#334155';
  const SHOE   = '#0f172a';
  const DESK   = '#4a3728';
  const DESKD  = '#2d1f14';
  const MON    = '#0d1117';

  // ── Character drawing ─────────────────────────────────────────────────────
  // px(ctx, gx, gy, w, h, color, ox, oy) — draw at grid position
  function px(ctx, gx, gy, w, h, color, ox, oy) {
    if (!color) return;
    ctx.fillStyle = color;
    ctx.fillRect(ox + gx * SCALE, oy + gy * SCALE, w * SCALE, h * SCALE);
  }

  function drawChar(ctx, ox, oy, tok, state, frame) {
    const { shirt, shirtD, hair } = tok;

    let yOff = 0;
    if (state === 'idle' && frame === 1) yOff = -1;
    if (state === 'win')  yOff = frame === 0 ? -3 : -2;

    const o = oy + yOff * SCALE;

    // Head
    px(ctx, 1, 0, 6, 1, hair,  ox, o);  // hair top
    px(ctx, 0, 1, 8, 2, hair,  ox, o);  // hair bulk
    px(ctx, 1, 3, 6, 3, SKIN,  ox, o);  // face
    // Eyes
    px(ctx, 2, 3, 1, 1, EYE,   ox, o);
    px(ctx, 5, 3, 1, 1, EYE,   ox, o);
    // Mouth — smile on happy states, flat on loss/bear
    const mouthColor = (state === 'loss') ? SKIND : shirt;
    px(ctx, 3, 5, 2, 1, mouthColor, ox, o);

    // Neck
    px(ctx, 3, 6, 2, 1, SKIN,  ox, o);

    // Shoulders / body
    px(ctx, 0, 7, 8, 1, shirt, ox, o);  // shoulder bar
    px(ctx, 1, 8, 6, 3, shirt, ox, o);  // torso
    px(ctx, 2, 9, 4, 1, shirtD, ox, o); // chest shadow

    // Arms — position depends on state
    if (state === 'win' || state === 'bull') {
      // Arms raised
      px(ctx, 0, 4, 1, 4, shirt, ox, o);
      px(ctx, 7, 4, 1, 4, shirt, ox, o);
    } else if (state === 'bear') {
      // Arms forward / leaning
      px(ctx, 0, 7, 1, 5, shirt, ox, o);
      px(ctx, 7, 7, 1, 5, shirt, ox, o);
    } else if (state === 'loss') {
      // Slumped — arms hang low
      px(ctx, 0, 9, 1, 4, shirtD, ox, o);
      px(ctx, 7, 9, 1, 4, shirtD, ox, o);
    } else {
      // Idle / normal
      px(ctx, 0, 7, 1, 4, shirt, ox, o);
      px(ctx, 7, 7, 1, 4, shirt, ox, o);
    }

    // Pants
    px(ctx, 1, 11, 2, 3, PANT,  ox, o);
    px(ctx, 5, 11, 2, 3, PANT,  ox, o);
    px(ctx, 2, 11, 1, 2, PANTL, ox, o);
    px(ctx, 5, 11, 1, 2, PANTL, ox, o);

    // Shoes
    px(ctx, 0, 14, 3, 1, SHOE, ox, o);
    px(ctx, 5, 14, 3, 1, SHOE, ox, o);
  }

  // ── Desk & monitor ────────────────────────────────────────────────────────
  function drawDesk(ctx, cx, deskY, screenColor, price, label) {
    const dw = 110, dh = 28;
    const dx = cx - dw / 2;

    // Desk surface
    ctx.fillStyle = DESKD;
    ctx.fillRect(dx, deskY + 4, dw, dh);
    ctx.fillStyle = DESK;
    ctx.fillRect(dx, deskY, dw, dh - 4);

    // Monitor base
    ctx.fillStyle = '#1e1e2e';
    ctx.fillRect(cx - 24, deskY - 38, 48, 6);

    // Monitor screen
    ctx.fillStyle = MON;
    ctx.fillRect(cx - 36, deskY - 80, 72, 44);
    ctx.fillStyle = screenColor;
    ctx.fillRect(cx - 32, deskY - 76, 64, 36);

    // Screen content — price text
    ctx.fillStyle = '#000';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(price, cx, deskY - 63);
    ctx.font = '8px monospace';
    ctx.fillText(label, cx, deskY - 52);

    // Desk legs
    ctx.fillStyle = DESKD;
    ctx.fillRect(dx + 6,      deskY + dh,  6, 14);
    ctx.fillRect(dx + dw - 12, deskY + dh,  6, 14);

    // Keyboard hint
    ctx.fillStyle = '#333';
    ctx.fillRect(cx - 16, deskY + 6, 32, 8);
    ctx.fillStyle = '#555';
    for (let k = 0; k < 6; k++) ctx.fillRect(cx - 14 + k * 5, deskY + 8, 3, 4);
  }

  // ── Nameplate ─────────────────────────────────────────────────────────────
  function drawNameplate(ctx, cx, y, tok, state, pnl) {
    const color = tok.shirt;
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.fillText(tok.label, cx, y);

    // State badge
    const badgeMap = {
      idle:  ['IDLE',    '#334155'],
      scan:  ['SCANNING','#1e3a5f'],
      bull:  ['LONG  ▲', '#14532d'],
      bear:  ['SHORT ▼', '#7f1d1d'],
      win:   ['WIN  🎉', '#14532d'],
      loss:  ['LOSS  ↘', '#7f1d1d'],
    };
    const [text, bg] = badgeMap[state] || ['IDLE', '#334155'];
    const bw = 80, bh = 18;
    const bx = cx - bw / 2;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(bx, y + 6, bw, bh, 4) : ctx.rect(bx, y + 6, bw, bh);
    ctx.fill();
    ctx.font = 'bold 9px monospace';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(text, cx, y + 19);

    // PnL if in trade
    if (pnl !== null && pnl !== undefined) {
      const sign  = pnl >= 0 ? '+' : '';
      ctx.font = '10px monospace';
      ctx.fillStyle = pnl >= 0 ? '#4ade80' : '#f87171';
      ctx.fillText(`${sign}$${pnl.toFixed(2)}`, cx, y + 38);
    }
  }

  // ── Background ────────────────────────────────────────────────────────────
  function drawBackground(ctx, w, h) {
    // Base
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0,   '#0a0e1a');
    bg.addColorStop(1,   '#0d1117');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = 'rgba(99,102,241,0.06)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // Floor strip
    const floor = ctx.createLinearGradient(0, h - 60, 0, h);
    floor.addColorStop(0, 'rgba(99,102,241,0.08)');
    floor.addColorStop(1, 'rgba(99,102,241,0.02)');
    ctx.fillStyle = floor;
    ctx.fillRect(0, h - 60, w, 60);

    // Ceiling light strip
    ctx.fillStyle = 'rgba(99,102,241,0.04)';
    ctx.fillRect(0, 0, w, 3);
  }

  function drawTitle(ctx, w) {
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(148,163,184,0.6)';
    ctx.fillText('⬛ TRADING FLOOR', 16, 22);

    // Live dot
    ctx.fillStyle = '#4ade80';
    ctx.beginPath();
    ctx.arc(w - 24, 15, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#4ade80';
    ctx.fillText('LIVE', w - 32, 19);
  }

  // ── Main floor class ──────────────────────────────────────────────────────
  function TradingFloor(canvasEl) {
    this.canvas  = canvasEl;
    this.ctx     = canvasEl.getContext('2d');
    this.frame   = 0;
    this.tick    = 0;
    this.rafId   = null;
    this.states  = {};           // symbol → { state, pnl, price, screenColor }
    this.running = false;

    // Init default states
    TOKENS.forEach(t => {
      this.states[t.symbol] = {
        state: 'idle', pnl: null,
        price: '--', screenColor: 'rgba(30,58,138,0.4)',
      };
    });
  }

  TradingFloor.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this._fetchState();
    this._loop();
    this._pollTimer = setInterval(() => this._fetchState(), 8000);
  };

  TradingFloor.prototype.stop = function () {
    this.running = false;
    if (this.rafId)    cancelAnimationFrame(this.rafId);
    if (this._pollTimer) clearInterval(this._pollTimer);
  };

  TradingFloor.prototype._fetchState = async function () {
    try {
      // Prices from token card data
      const priceEls = { BTCUSDT: 'smc-price-BTCUSDT', ETHUSDT: 'smc-price-ETHUSDT', SOLUSDT: 'smc-price-SOLUSDT', BNBUSDT: 'smc-price-BNBUSDT' };
      TOKENS.forEach(t => {
        const el = document.getElementById(priceEls[t.symbol]);
        if (el && el.textContent !== '--') this.states[t.symbol].price = el.textContent;
      });

      // Open positions
      const resp = await fetch('/api/admin/open-positions', {
        headers: { Authorization: 'Bearer ' + (localStorage.getItem('token') || '') },
      });
      if (!resp.ok) return;
      const positions = await resp.json();

      // Reset to idle
      TOKENS.forEach(t => {
        this.states[t.symbol].state = 'idle';
        this.states[t.symbol].pnl   = null;
        this.states[t.symbol].screenColor = 'rgba(30,58,138,0.3)';
      });

      // Apply open positions
      (Array.isArray(positions) ? positions : []).forEach(pos => {
        const sym = pos.symbol;
        if (!this.states[sym]) return;
        const isLong  = pos.direction === 'LONG';
        const pnl     = parseFloat(pos.unrealized_pnl || pos.pnl || 0);
        this.states[sym].state       = isLong ? 'bull' : 'bear';
        this.states[sym].pnl         = pnl;
        this.states[sym].screenColor = isLong
          ? (pnl >= 0 ? 'rgba(20,83,45,0.7)'  : 'rgba(120,53,15,0.5)')
          : (pnl >= 0 ? 'rgba(20,83,45,0.7)'  : 'rgba(127,29,29,0.7)');
      });
    } catch (_) {}
  };

  TradingFloor.prototype._loop = function () {
    if (!this.running) return;
    this.tick++;
    // Animate at ~8 fps (every 8 animation frames at 60fps)
    if (this.tick % 8 === 0) this.frame = (this.frame + 1) % 4;
    this._draw();
    this.rafId = requestAnimationFrame(() => this._loop());
  };

  TradingFloor.prototype._draw = function () {
    const ctx  = this.ctx;
    const W    = this.canvas.width;
    const H    = this.canvas.height;

    drawBackground(ctx, W, H);
    drawTitle(ctx, W);

    const colW = W / TOKENS.length;

    TOKENS.forEach((tok, i) => {
      const st  = this.states[tok.symbol];
      const cx  = colW * i + colW / 2;

      // Character sits just above the desk
      const deskY    = H - 160;
      const charY    = deskY - 80;
      const charX    = cx - 4 * SCALE; // center the 8-wide char

      // Animate frame: bob on idle, bounce on win
      const animFrame = (st.state === 'idle') ? (this.frame % 2)
                      : (st.state === 'win')  ? (this.frame % 2) : 0;

      drawChar(ctx, charX, charY, tok, st.state, animFrame);

      // Screen label
      const priceLabel = st.price;
      const dirLabel   = st.state === 'bull' ? '▲ LONG'
                       : st.state === 'bear' ? '▼ SHORT'
                       : st.pnl !== null     ? `P&L $${st.pnl.toFixed(1)}`
                       : 'SCANNING...';

      drawDesk(ctx, cx, deskY, st.screenColor, priceLabel, dirLabel);
      drawNameplate(ctx, cx, deskY + 50, tok, st.state, st.pnl);

      // Glow under active characters
      if (st.state !== 'idle') {
        const grd = ctx.createRadialGradient(cx, deskY, 0, cx, deskY, 60);
        grd.addColorStop(0, tok.shirt + '22');
        grd.addColorStop(1, 'transparent');
        ctx.fillStyle = grd;
        ctx.fillRect(cx - 60, deskY - 60, 120, 120);
      }
    });
  };

  // ── Init hook ─────────────────────────────────────────────────────────────
  function init() {
    const container = document.getElementById('trading-floor-container');
    if (!container) return;

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;border-radius:12px;display:block;';

    const resize = () => {
      const W = container.clientWidth || 800;
      const H = Math.max(400, Math.round(W * 0.45));
      canvas.width  = W;
      canvas.height = H;
    };
    resize();
    container.innerHTML = '';
    container.appendChild(canvas);

    const floor = new TradingFloor(canvas);
    container.dataset.floor = 'active';

    // Store reference for tab show/hide
    window._tradingFloor = floor;

    window.addEventListener('resize', () => { resize(); });

    return floor;
  }

  global.TradingFloor = { init };

})(window);
