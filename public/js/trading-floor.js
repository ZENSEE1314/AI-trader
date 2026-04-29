// ── Trading Floor — Pixel Art Office Visualization ───────────────────────
// Full-scene office: wood floors, back wall with windows, trader characters
// at their desks, potted plants, live state from open positions.
// Canvas-only, no external assets. Inspired by pixel-agents style.

(function (global) {
  'use strict';

  const SCALE = 4; // 4 canvas px per sprite pixel — large, clear characters

  // ── Token config ──────────────────────────────────────────────────────────
  const TOKENS = [
    { symbol: 'BTCUSDT', label: 'BTC', shirt: '#f7931a', shirtD: '#c87817', hair: '#3d2b1f', hairD: '#291a10' },
    { symbol: 'ETHUSDT', label: 'ETH', shirt: '#627eea', shirtD: '#4a60c4', hair: '#111111', hairD: '#000' },
    { symbol: 'SOLUSDT', label: 'SOL', shirt: '#14f195', shirtD: '#0db87a', hair: '#1a1a2e', hairD: '#0d0d1f' },
    { symbol: 'BNBUSDT', label: 'BNB', shirt: '#f3ba2f', shirtD: '#d9a520', hair: '#5c3d00', hairD: '#3d2900' },
  ];

  // ── Colour palette ────────────────────────────────────────────────────────
  const C = {
    skin:      '#f5cba7',
    skinD:     '#e8b48a',
    eye:       '#222',
    eyeShine:  '#fff',
    mouth:     '#a04030',
    mouthSmil: '#c0392b',
    pant:      '#1e3a5f',
    pantL:     '#2a4f7c',
    shoe:      '#111',
    shoeL:     '#333',

    floorA:    '#c28b54',
    floorB:    '#a8733d',
    floorLine: '#8b5a28',
    floorGrain:'#b07a45',

    wall:      '#2a1f3d',
    wallTop:   '#150d24',
    wallBase:  '#4a3560',
    winFrame:  '#3a2d50',
    winGlass0: '#0d1b3e',
    winGlass1: '#1a3566',
    winRefl:   'rgba(255,255,255,0.07)',

    deskTop:   '#a0522d',
    deskHi:    '#bf6a38',
    deskFront: '#6b3515',
    deskDark:  '#3d1f08',
    deskLeg:   '#2d1508',
    keyboard:  '#334155',
    kbKey:     '#475569',

    monFrame:  '#1a1a2e',
    monScrDef: '#0a192f',

    potBody:   '#cd7f32',
    potRim:    '#b86e28',
    potSoil:   '#3d2510',
    stem:      '#4a7a18',
    leafA:     '#3cb44b',
    leafB:     '#2ea43c',
    leafC:     '#56c96b',

    badge:     'rgba(0,0,0,0.65)',
    hud:       'rgba(10,6,20,0.72)',
    accent:    '#d4af37',
  };

  // ── Pixel helper ──────────────────────────────────────────────────────────
  function r(ctx, gx, gy, w, h, color, ox, oy) {
    if (!color || !w || !h) return;
    ctx.fillStyle = color;
    ctx.fillRect(ox + gx * SCALE, oy + gy * SCALE, w * SCALE, h * SCALE);
  }

  // ── Character sprite — 12 px wide × 26 px tall grid ──────────────────────
  function drawChar(ctx, ox, oy, tok, state, frame) {
    const { shirt, shirtD, hair, hairD } = tok;

    let yOff = 0;
    if (state === 'idle' && frame === 1) yOff =  1;
    if (state === 'win')  yOff = frame === 0 ? -4 : -2;
    if (state === 'loss') yOff =  1;

    const dy = oy + yOff * SCALE;

    // Drop shadow
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(ox + 1 * SCALE, dy + 26 * SCALE, 10 * SCALE, 2 * SCALE);

    // Hair
    r(ctx,  3,  0,  6, 1, hairD, ox, dy);
    r(ctx,  2,  1,  8, 1, hair,  ox, dy);
    r(ctx,  1,  2, 10, 3, hair,  ox, dy);
    r(ctx,  2,  3,  8, 1, hairD, ox, dy);

    // Face
    r(ctx,  2,  3,  8, 6, C.skin,  ox, dy);
    r(ctx,  1,  4,  1, 4, C.skin,  ox, dy); // left ear
    r(ctx, 10,  4,  1, 4, C.skin,  ox, dy); // right ear

    // Eyes
    r(ctx,  3,  4,  2, 2, C.eye,      ox, dy);
    r(ctx,  7,  4,  2, 2, C.eye,      ox, dy);
    r(ctx,  4,  4,  1, 1, C.eyeShine, ox, dy);
    r(ctx,  8,  4,  1, 1, C.eyeShine, ox, dy);

    // Mouth
    if (state === 'win') {
      r(ctx,  3, 7,  6, 1, C.mouthSmil, ox, dy);
      r(ctx,  4, 8,  4, 1, C.mouthSmil, ox, dy);
    } else if (state === 'loss') {
      r(ctx,  4, 8,  4, 1, C.eye,  ox, dy);
    } else {
      r(ctx,  4, 7,  4, 1, C.mouth, ox, dy);
    }

    // Neck
    r(ctx,  4,  9,  4, 2, C.skinD, ox, dy);

    // Torso
    r(ctx,  2, 11,  8, 6, shirt,  ox, dy);

    // Arms (state-dependent)
    if (state === 'bull') {
      // Arms raised — celebrating
      r(ctx,  0,  7, 2, 6, shirtD, ox, dy);
      r(ctx, 10,  7, 2, 6, shirtD, ox, dy);
      r(ctx,  0,  6, 2, 2, C.skin, ox, dy);
      r(ctx, 10,  6, 2, 2, C.skin, ox, dy);
    } else if (state === 'bear') {
      // Arms forward — typing
      r(ctx,  0, 14, 3, 3, shirtD, ox, dy);
      r(ctx,  9, 14, 3, 3, shirtD, ox, dy);
      r(ctx,  0, 16, 2, 2, C.skin, ox, dy);
      r(ctx, 10, 16, 2, 2, C.skin, ox, dy);
    } else if (state === 'loss') {
      // Arms down — slumped
      r(ctx,  0, 14, 2, 5, shirtD, ox, dy);
      r(ctx, 10, 14, 2, 5, shirtD, ox, dy);
    } else {
      // Idle — relaxed at sides
      r(ctx,  0, 11, 2, 6, shirtD, ox, dy);
      r(ctx, 10, 11, 2, 6, shirtD, ox, dy);
      r(ctx,  0, 16, 2, 2, C.skin, ox, dy);
      r(ctx, 10, 16, 2, 2, C.skin, ox, dy);
    }

    // Pants
    r(ctx,  2, 17,  8, 5, C.pant,  ox, dy);
    r(ctx,  3, 22,  3, 2, C.pantL, ox, dy);
    r(ctx,  6, 22,  3, 2, C.pant,  ox, dy);

    // Shoes
    r(ctx,  2, 24,  4, 2, C.shoe,  ox, dy);
    r(ctx,  2, 24,  4, 1, C.shoeL, ox, dy);
    r(ctx,  6, 24,  4, 2, C.shoe,  ox, dy);
    r(ctx,  6, 24,  4, 1, C.shoeL, ox, dy);
  }

  // ── Desk (canvas coordinates) ─────────────────────────────────────────────
  function drawDesk(ctx, x, y, deskW) {
    const S = SCALE;
    // Highlight edge
    ctx.fillStyle = C.deskHi;
    ctx.fillRect(x, y, deskW, S);
    // Surface
    ctx.fillStyle = C.deskTop;
    ctx.fillRect(x, y + S, deskW, 4 * S);
    // Keyboard
    ctx.fillStyle = C.keyboard;
    ctx.fillRect(x + 12, y + 2 * S, deskW - 24, 2 * S);
    ctx.fillStyle = C.kbKey;
    for (let kx = x + 16; kx < x + deskW - 16; kx += 7) {
      ctx.fillRect(kx, y + 2 * S + 2, 5, S - 2);
    }
    // Front panel
    ctx.fillStyle = C.deskFront;
    ctx.fillRect(x, y + 5 * S, deskW, 7 * S);
    // Drawer line
    ctx.fillStyle = C.deskDark;
    ctx.fillRect(x + Math.round(deskW * 0.3), y + 7 * S, Math.round(deskW * 0.4), S);
    // Bottom shadow
    ctx.fillStyle = C.deskDark;
    ctx.fillRect(x, y + 12 * S, deskW, S);
    // Legs
    ctx.fillStyle = C.deskLeg;
    ctx.fillRect(x + 4, y + 13 * S, 3 * S, 7 * S);
    ctx.fillRect(x + deskW - 4 - 3 * S, y + 13 * S, 3 * S, 7 * S);
  }

  // ── Monitor ───────────────────────────────────────────────────────────────
  function drawMonitor(ctx, cx, deskTopY, screenColor, line1, line2) {
    const S = SCALE;
    const mW = 14 * S, mH = 11 * S;
    const mx = cx - Math.round(mW / 2);
    const my = deskTopY - mH - 6 * S;

    // Stand
    ctx.fillStyle = '#444';
    ctx.fillRect(cx - 3 * S, deskTopY, 6 * S, S);
    ctx.fillStyle = '#333';
    ctx.fillRect(cx - S, deskTopY - 6 * S, 2 * S, 6 * S);

    // Outer frame
    ctx.fillStyle = C.monFrame;
    ctx.fillRect(mx - S, my - S, mW + 2 * S, mH + 2 * S);

    // Screen
    ctx.fillStyle = screenColor || C.monScrDef;
    ctx.fillRect(mx, my, mW, mH);

    // Scanlines
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    for (let sy = my; sy < my + mH; sy += 3) ctx.fillRect(mx, sy, mW, 1);

    // Content
    ctx.save();
    ctx.textAlign = 'center';
    if (line1) {
      ctx.fillStyle = '#7dd3fc';
      ctx.font = `bold ${S * 2.2}px "JetBrains Mono", monospace`;
      ctx.fillText(line1, cx, my + Math.round(mH * 0.44));
    }
    if (line2) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = `${S * 1.8}px "JetBrains Mono", monospace`;
      ctx.fillText(line2, cx, my + Math.round(mH * 0.78));
    }
    ctx.restore();

    // Glare
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(mx + S, my + S, Math.round(mW * 0.35), Math.round(mH * 0.28));
  }

  // ── Potted plant ──────────────────────────────────────────────────────────
  function drawPlant(ctx, cx, baseY, size) {
    const S = SCALE * (size || 1);
    // Pot
    ctx.fillStyle = C.potRim;
    ctx.fillRect(cx - 4 * S, baseY - 5 * S, 8 * S, 2 * S);
    ctx.fillStyle = C.potBody;
    ctx.fillRect(cx - 3 * S, baseY - 3 * S, 6 * S, 4 * S);
    ctx.fillStyle = C.potSoil;
    ctx.fillRect(cx - 3 * S + 1, baseY - 5 * S + 2, 6 * S - 2, 2);

    // Stems
    ctx.fillStyle = C.stem;
    ctx.fillRect(cx - S, baseY - 12 * S, 2 * S, 7 * S);
    ctx.fillRect(cx - 4 * S, baseY - 10 * S, 4 * S, S);
    ctx.fillRect(cx + 2 * S, baseY -  9 * S, 4 * S, S);

    // Leaves
    ctx.fillStyle = C.leafA;
    ctx.fillRect(cx - 7 * S, baseY - 15 * S, 5 * S, 6 * S);
    ctx.fillRect(cx + 2 * S, baseY - 14 * S, 5 * S, 6 * S);
    ctx.fillRect(cx - 3 * S, baseY - 18 * S, 6 * S, 7 * S);
    // Highlights
    ctx.fillStyle = C.leafC;
    ctx.fillRect(cx - 6 * S, baseY - 14 * S, 2 * S, 3 * S);
    ctx.fillRect(cx + 3 * S, baseY - 13 * S, 2 * S, 3 * S);
    ctx.fillRect(cx - S,     baseY - 17 * S, 2 * S, 3 * S);
    // Shadows
    ctx.fillStyle = C.leafB;
    ctx.fillRect(cx - 3 * S, baseY - 11 * S, 2 * S, 2 * S);
    ctx.fillRect(cx + S,     baseY - 10 * S, 2 * S, 2 * S);
  }

  // ── Wood floor tiles ──────────────────────────────────────────────────────
  function drawFloor(ctx, W, H, startY) {
    const tW = Math.round(W / 8);
    const tH = Math.max(22, Math.round(tW * 0.48));
    for (let ty = startY; ty < H + tH; ty += tH) {
      for (let tx = 0; tx < W + tW; tx += tW) {
        const even = (Math.floor(tx / tW) + Math.floor((ty - startY) / tH)) % 2 === 0;
        ctx.fillStyle = even ? C.floorA : C.floorB;
        ctx.fillRect(tx, ty, tW, tH);
        ctx.fillStyle = C.floorGrain;
        ctx.fillRect(tx + 5, ty + Math.round(tH * 0.3), tW - 10, 1);
        ctx.fillRect(tx + 5, ty + Math.round(tH * 0.65), tW - 10, 1);
        ctx.fillStyle = C.floorLine;
        ctx.fillRect(tx, ty, tW, 1);
        ctx.fillRect(tx, ty, 1, tH);
      }
    }
  }

  // ── Back wall with windows and MCT banner ─────────────────────────────────
  function drawWall(ctx, W, floorY) {
    const grad = ctx.createLinearGradient(0, 0, 0, floorY);
    grad.addColorStop(0, C.wallTop);
    grad.addColorStop(1, C.wall);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, floorY);

    // Baseboard
    ctx.fillStyle = C.wallBase;
    ctx.fillRect(0, floorY - 5, W, 5);

    // Windows
    const winW = Math.round(W * 0.13);
    const winH = Math.round(floorY * 0.56);
    const winY = Math.round(floorY * 0.1);
    const count = 3;
    for (let wi = 0; wi < count; wi++) {
      const wx = Math.round(W * (wi + 1) / (count + 1) - winW / 2);
      ctx.fillStyle = C.winFrame;
      ctx.fillRect(wx - 4, winY - 4, winW + 8, winH + 8);
      const wg = ctx.createLinearGradient(wx, winY, wx, winY + winH);
      wg.addColorStop(0, C.winGlass0);
      wg.addColorStop(1, C.winGlass1);
      ctx.fillStyle = wg;
      ctx.fillRect(wx, winY, winW, winH);
      // Dividers
      ctx.fillStyle = C.winFrame;
      ctx.fillRect(wx + winW / 2 - 1, winY, 2, winH);
      ctx.fillRect(wx, winY + winH / 2 - 1, winW, 2);
      // Glare
      ctx.fillStyle = C.winRefl;
      ctx.fillRect(wx + 3, winY + 3, Math.round(winW * 0.38), Math.round(winH * 0.44));
      // Stars
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      [[0.1, 0.12], [0.65, 0.08], [0.3, 0.35], [0.8, 0.55], [0.5, 0.2]].forEach(([fx, fy]) => {
        ctx.fillRect(wx + fx * winW, winY + fy * winH, 2, 2);
      });
    }

    // MCT banner
    const banW = Math.round(W * 0.26);
    const banH = 22;
    const banX = Math.round(W / 2 - banW / 2);
    const banY = Math.round(floorY * 0.02);
    ctx.fillStyle = 'rgba(212,175,55,0.12)';
    ctx.fillRect(banX, banY, banW, banH);
    ctx.strokeStyle = 'rgba(212,175,55,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(banX, banY, banW, banH);
    ctx.fillStyle = C.accent;
    ctx.font = `bold ${Math.max(10, Math.round(banH * 0.54))}px "Space Grotesk", monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('🏢  MCT TRADING FLOOR', W / 2, banY + Math.round(banH * 0.71));
  }

  // ── State badge below desk ────────────────────────────────────────────────
  function drawStateBadge(ctx, cx, y, tok, st) {
    const stLabel = st.state === 'bull'  ? '▲ LONG'
                  : st.state === 'bear'  ? '▼ SHORT'
                  : '· IDLE';
    const stColor = st.state === 'bull'  ? '#22c55e'
                  : st.state === 'bear'  ? '#ef4444'
                  : '#475569';
    const bW = 66, bH = 14;
    const bx = cx - Math.round(bW / 2);

    // Token name row
    ctx.fillStyle = C.badge;
    ctx.fillRect(bx, y, bW, 16);
    ctx.fillStyle = tok.shirt;
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(tok.label, cx, y + 11);

    // State row
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(bx, y + 18, bW, bH);
    ctx.fillStyle = stColor;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillText(stLabel, cx, y + 28);

    // PnL row (active positions only)
    if (st.pnl !== null) {
      const pStr = (st.pnl >= 0 ? '+' : '') + st.pnl.toFixed(2) + ' U';
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(bx, y + 34, bW, bH);
      ctx.fillStyle = st.pnl >= 0 ? '#4ade80' : '#f87171';
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.fillText(pStr, cx, y + 44);
    }
  }

  // ── TradingFloor class ────────────────────────────────────────────────────
  function TradingFloor(canvas) {
    this.canvas     = canvas;
    this.ctx        = canvas.getContext('2d');
    this.running    = false;
    this.rafId      = null;
    this._pollTimer = null;
    this.tick       = 0;
    this.frame      = 0;
    this.states     = {};
    TOKENS.forEach(t => {
      this.states[t.symbol] = { state: 'idle', pnl: null, price: '--', screenColor: C.monScrDef };
    });
  }

  TradingFloor.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this._fetchState();
    this._pollTimer = setInterval(() => this._fetchState(), 8000);
    this._loop();
  };

  TradingFloor.prototype.stop = function () {
    this.running = false;
    if (this.rafId)      cancelAnimationFrame(this.rafId);
    if (this._pollTimer) clearInterval(this._pollTimer);
  };

  TradingFloor.prototype._fetchState = async function () {
    try {
      const priceIds = {
        BTCUSDT: 'smc-price-BTCUSDT', ETHUSDT: 'smc-price-ETHUSDT',
        SOLUSDT: 'smc-price-SOLUSDT', BNBUSDT: 'smc-price-BNBUSDT',
      };
      TOKENS.forEach(t => {
        const el = document.getElementById(priceIds[t.symbol]);
        if (el && el.textContent && el.textContent !== '--')
          this.states[t.symbol].price = el.textContent;
      });

      const resp = await fetch('/api/admin/open-positions', {
        headers: { Authorization: 'Bearer ' + (localStorage.getItem('token') || '') },
      });
      if (!resp.ok) return;
      const positions = await resp.json();

      TOKENS.forEach(t => {
        this.states[t.symbol].state       = 'idle';
        this.states[t.symbol].pnl         = null;
        this.states[t.symbol].screenColor = C.monScrDef;
      });

      (Array.isArray(positions) ? positions : []).forEach(pos => {
        const sym  = pos.symbol;
        if (!this.states[sym]) return;
        const isLong = pos.direction === 'LONG';
        const pnl    = parseFloat(pos.unrealized_pnl || pos.pnl || 0);
        this.states[sym].state       = isLong ? 'bull' : 'bear';
        this.states[sym].pnl         = pnl;
        this.states[sym].screenColor = pnl >= 0
          ? 'rgba(20,83,45,0.88)'
          : (isLong ? 'rgba(120,53,15,0.88)' : 'rgba(100,20,20,0.88)');
      });
    } catch (_) {}
  };

  TradingFloor.prototype._loop = function () {
    if (!this.running) return;
    this.tick++;
    if (this.tick % 10 === 0) this.frame = (this.frame + 1) % 4;
    this._draw();
    this.rafId = requestAnimationFrame(() => this._loop());
  };

  TradingFloor.prototype._draw = function () {
    const ctx = this.ctx;
    const W   = this.canvas.width;
    const H   = this.canvas.height;

    const FLOOR_Y = Math.round(H * 0.30);
    const DESK_Y  = Math.round(H * 0.50);
    const CHAR_Y  = DESK_Y - 26 * SCALE;

    ctx.clearRect(0, 0, W, H);

    drawWall(ctx, W, FLOOR_Y);
    drawFloor(ctx, W, H, FLOOR_Y);

    // Corner plants
    const plantBase = FLOOR_Y + Math.round((DESK_Y - FLOOR_Y) * 0.65);
    drawPlant(ctx, 44, plantBase, 0.85);
    drawPlant(ctx, W - 44, plantBase, 0.85);

    const colW  = W / TOKENS.length;
    const deskW = Math.min(Math.round(colW * 0.70), 186);

    TOKENS.forEach((tok, i) => {
      const cx       = Math.round(colW * i + colW / 2);
      const deskLeft = cx - Math.round(deskW / 2);
      const st       = this.states[tok.symbol];

      // Active glow behind character
      if (st.state !== 'idle') {
        const pnlPos  = (st.pnl ?? 0) >= 0;
        const glowCol = pnlPos ? 'rgba(34,197,94,0.11)' : 'rgba(239,68,68,0.11)';
        const grd     = ctx.createRadialGradient(cx, CHAR_Y + 12 * SCALE, 0, cx, CHAR_Y + 12 * SCALE, deskW * 0.75);
        grd.addColorStop(0, glowCol);
        grd.addColorStop(1, 'transparent');
        ctx.fillStyle = grd;
        ctx.fillRect(cx - deskW, CHAR_Y - 5 * SCALE, deskW * 2, 34 * SCALE);
      }

      drawDesk(ctx, deskLeft, DESK_Y, deskW);

      const dirLine   = st.state === 'bull' ? '▲ LONG'
                      : st.state === 'bear' ? '▼ SHORT'
                      : 'SCANNING...';
      const priceLine = st.pnl !== null
        ? (st.pnl >= 0 ? '+' : '') + st.pnl.toFixed(2) + 'U'
        : st.price;
      drawMonitor(ctx, cx, DESK_Y, st.screenColor, `${tok.label}  ${dirLine}`, priceLine);

      const animFrame = (st.state === 'idle') ? (this.frame % 2)
                      : (st.state === 'win')  ? (this.frame % 2) : 0;
      drawChar(ctx, cx - 6 * SCALE, CHAR_Y, tok, st.state, animFrame);

      drawStateBadge(ctx, cx, DESK_Y + 21 * SCALE, tok, st);
    });

    // HUD strip top-left
    ctx.fillStyle = C.hud;
    ctx.fillRect(6, 5, 170, 20);
    ctx.fillStyle = C.accent;
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('🏢 TRADING FLOOR', 13, 19);

    // Live indicator top-right
    ctx.fillStyle = 'rgba(34,197,94,0.2)';
    ctx.beginPath();
    ctx.arc(W - 14, 15, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(W - 14, 15, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d1fae5';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('LIVE', W - 26, 19);
  };

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    const container = document.getElementById('trading-floor-container');
    if (!container) return null;

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;display:block;';

    const resize = () => {
      const W = container.clientWidth || 900;
      const H = Math.max(500, Math.round(W * 0.5));
      canvas.width  = W;
      canvas.height = H;
    };
    resize();
    container.innerHTML = '';
    container.appendChild(canvas);

    const floor = new TradingFloor(canvas);
    window._tradingFloor = floor;
    window.addEventListener('resize', () => resize());
    return floor;
  }

  global.TradingFloor = { init };

})(window);
