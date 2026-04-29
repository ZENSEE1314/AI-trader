// ── MCT Trading Floor — Multi-Room Pixel Art ─────────────────────────────
// Characters walk between three rooms: Trading Desk, Meeting Room, Break Room.
// Behavior is driven by live open-position state from the bot.
// Canvas-only, no external assets.

(function (global) {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────
  const SCALE  = 4;    // sprite pixel → canvas pixel
  const SPEED  = 1.8;  // canvas px per frame when walking
  const FPS_ANIM = 8;  // walk-frame changes per second (at 60fps = every 7-8 ticks)

  const TOKENS = [
    { symbol: 'BTCUSDT', label: 'BTC', shirt: '#f7931a', shirtD: '#c87817', hair: '#3d2b1f', hairD: '#291a10' },
    { symbol: 'ETHUSDT', label: 'ETH', shirt: '#627eea', shirtD: '#4a60c4', hair: '#111',    hairD: '#000'    },
    { symbol: 'SOLUSDT', label: 'SOL', shirt: '#14f195', shirtD: '#0db87a', hair: '#1a1a2e', hairD: '#0d0d1f' },
    { symbol: 'BNBUSDT', label: 'BNB', shirt: '#f3ba2f', shirtD: '#d9a520', hair: '#5c3d00', hairD: '#3d2900' },
  ];

  // ── Palette ───────────────────────────────────────────────────────────────
  const C = {
    skin: '#f5cba7', skinD: '#e8b48a',
    eye: '#222', eyeShine: '#fff',
    mouth: '#a04030', mouthSmile: '#c0392b',
    pant: '#1e3a5f', pantL: '#2a4f7c',
    shoe: '#111', shoeL: '#333',

    // Room floors
    floorTradingA: '#c28b54', floorTradingB: '#a8733d',
    floorMeetingA: '#ddd0b8', floorMeetingB: '#cbbfa5',
    floorBreakA:   '#b8d4c8', floorBreakB:   '#a0c0b2',
    floorLine: '#8b7a5a',

    // Walls
    wall: '#2a1f3d', wallTop: '#150d24', wallBase: '#4a3560',
    wallDiv: '#1e1530', doorWay: '#0d0918',
    winFrame: '#3a2d50', winGlass0: '#0d1b3e', winGlass1: '#1a3566',
    winRefl: 'rgba(255,255,255,0.07)',

    // Furniture
    deskTop: '#a0522d', deskHi: '#bf6a38', deskFront: '#6b3515',
    deskDark: '#3d1f08', deskLeg: '#2d1508',
    keyboard: '#334155', kbKey: '#475569',
    monFrame: '#1a1a2e', monScrDef: '#0a192f',

    tableTop: '#8b6914', tableLeg: '#6b4f0a',
    chair: '#4a3560', chairD: '#2d1f40',
    sofaA: '#5b3a8c', sofaD: '#3d2060', sofaArm: '#7a50b0',
    coffeeBody: '#444', coffeeSteam: 'rgba(255,255,255,0.4)',

    potBody: '#cd7f32', potRim: '#b86e28', potSoil: '#3d2510',
    stem: '#4a7a18', leafA: '#3cb44b', leafB: '#2ea43c', leafC: '#56c96b',

    nameTag: 'rgba(0,0,0,0.7)',
    accent: '#d4af37',
    hud: 'rgba(10,6,20,0.75)',
  };

  // ── Pixel helper ──────────────────────────────────────────────────────────
  function r(ctx, gx, gy, w, h, color, ox, oy) {
    if (!color || w <= 0 || h <= 0) return;
    ctx.fillStyle = color;
    ctx.fillRect(ox + gx * SCALE, oy + gy * SCALE, w * SCALE, h * SCALE);
  }

  // ── Character sprite 12×26 grid ───────────────────────────────────────────
  // walkFrame 0=stand, 1=left-fwd, 2=stand, 3=right-fwd
  // facing: 1=right, -1=left
  function drawChar(ctx, ox, oy, tok, tradeState, walkFrame, facing) {
    const { shirt, shirtD, hair, hairD } = tok;

    // Mirror for facing direction
    const W = 12 * SCALE;
    if (facing < 0) {
      ctx.save();
      ctx.translate(ox + W, oy);
      ctx.scale(-1, 1);
      ox = 0; oy = 0;
    }

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect((facing < 0 ? 0 : ox) + 1 * SCALE, (facing < 0 ? 0 : oy) + 25 * SCALE, 10 * SCALE, 2 * SCALE);

    // Hair
    r(ctx,  3,  0,  6, 1, hairD, ox, oy);
    r(ctx,  2,  1,  8, 1, hair,  ox, oy);
    r(ctx,  1,  2, 10, 3, hair,  ox, oy);
    r(ctx,  2,  3,  8, 1, hairD, ox, oy);

    // Face
    r(ctx,  2,  3,  8, 6, C.skin,  ox, oy);
    r(ctx,  1,  4,  1, 4, C.skin,  ox, oy);
    r(ctx, 10,  4,  1, 4, C.skin,  ox, oy);

    // Eyes
    r(ctx,  3,  4,  2, 2, C.eye,      ox, oy);
    r(ctx,  7,  4,  2, 2, C.eye,      ox, oy);
    r(ctx,  4,  4,  1, 1, C.eyeShine, ox, oy);
    r(ctx,  8,  4,  1, 1, C.eyeShine, ox, oy);

    // Mouth
    if (tradeState === 'bull') {
      r(ctx, 3, 7, 6, 1, C.mouthSmile, ox, oy);
      r(ctx, 4, 8, 4, 1, C.mouthSmile, ox, oy);
    } else if (tradeState === 'bear') {
      r(ctx, 4, 8, 4, 1, C.eye,   ox, oy);
    } else {
      r(ctx, 4, 7, 4, 1, C.mouth, ox, oy);
    }

    // Neck
    r(ctx, 4, 9, 4, 2, C.skinD, ox, oy);

    // Torso
    r(ctx, 2, 11, 8, 6, shirt, ox, oy);

    // Arms
    if (tradeState === 'bull') {
      r(ctx,  0,  7, 2, 6, shirtD, ox, oy);
      r(ctx, 10,  7, 2, 6, shirtD, ox, oy);
      r(ctx,  0,  6, 2, 2, C.skin, ox, oy);
      r(ctx, 10,  6, 2, 2, C.skin, ox, oy);
    } else if (tradeState === 'bear') {
      r(ctx,  0, 14, 3, 3, shirtD, ox, oy);
      r(ctx,  9, 14, 3, 3, shirtD, ox, oy);
      r(ctx,  0, 16, 2, 2, C.skin, ox, oy);
      r(ctx, 10, 16, 2, 2, C.skin, ox, oy);
    } else {
      // Walking — arms swing with walk frame
      const armSwing = (walkFrame === 1) ? -1 : (walkFrame === 3) ? 1 : 0;
      r(ctx,  0, 11 + armSwing, 2, 6, shirtD, ox, oy);
      r(ctx, 10, 11 - armSwing, 2, 6, shirtD, ox, oy);
      r(ctx,  0, 16 + armSwing, 2, 2, C.skin, ox, oy);
      r(ctx, 10, 16 - armSwing, 2, 2, C.skin, ox, oy);
    }

    // Legs — animate walk cycle
    if (walkFrame === 1) {
      // Left leg forward, right leg back
      r(ctx, 2, 17, 8, 4, C.pant, ox, oy);
      r(ctx, 2, 21, 3, 2, C.pantL, ox, oy); // left fwd
      r(ctx, 6, 19, 3, 2, C.pant,  ox, oy); // right back
      r(ctx, 2, 23, 4, 2, C.shoe,  ox, oy);
      r(ctx, 5, 21, 4, 2, C.shoe,  ox, oy);
    } else if (walkFrame === 3) {
      // Right leg forward, left leg back
      r(ctx, 2, 17, 8, 4, C.pant, ox, oy);
      r(ctx, 2, 19, 3, 2, C.pantL, ox, oy); // left back
      r(ctx, 6, 21, 3, 2, C.pant,  ox, oy); // right fwd
      r(ctx, 2, 21, 4, 2, C.shoe,  ox, oy);
      r(ctx, 5, 23, 4, 2, C.shoe,  ox, oy);
    } else {
      // Standing
      r(ctx, 2, 17, 8, 5, C.pant,  ox, oy);
      r(ctx, 3, 22, 3, 2, C.pantL, ox, oy);
      r(ctx, 6, 22, 3, 2, C.pant,  ox, oy);
      r(ctx, 2, 24, 4, 2, C.shoe,  ox, oy);
      r(ctx, 2, 24, 4, 1, C.shoeL, ox, oy);
      r(ctx, 6, 24, 4, 2, C.shoe,  ox, oy);
      r(ctx, 6, 24, 4, 1, C.shoeL, ox, oy);
    }

    if (facing < 0) ctx.restore();
  }

  // ── Desk ──────────────────────────────────────────────────────────────────
  function drawDesk(ctx, x, y, deskW) {
    const S = SCALE;
    ctx.fillStyle = C.deskHi;   ctx.fillRect(x, y, deskW, S);
    ctx.fillStyle = C.deskTop;  ctx.fillRect(x, y + S, deskW, 4 * S);
    ctx.fillStyle = C.keyboard; ctx.fillRect(x + 10, y + 2 * S, deskW - 20, 2 * S);
    ctx.fillStyle = C.kbKey;
    for (let kx = x + 14; kx < x + deskW - 14; kx += 7)
      ctx.fillRect(kx, y + 2 * S + 2, 5, S - 2);
    ctx.fillStyle = C.deskFront; ctx.fillRect(x, y + 5 * S, deskW, 7 * S);
    ctx.fillStyle = C.deskDark;
    ctx.fillRect(x + Math.round(deskW * 0.3), y + 7 * S, Math.round(deskW * 0.4), S);
    ctx.fillRect(x, y + 12 * S, deskW, S);
    ctx.fillStyle = C.deskLeg;
    ctx.fillRect(x + 4,             y + 13 * S, 3 * S, 7 * S);
    ctx.fillRect(x + deskW - 4 - 3 * S, y + 13 * S, 3 * S, 7 * S);
  }

  // ── Monitor ───────────────────────────────────────────────────────────────
  function drawMonitor(ctx, cx, deskTopY, screenColor, line1, line2) {
    const S = SCALE;
    const mW = 14 * S, mH = 11 * S;
    const mx = cx - mW / 2, my = deskTopY - mH - 6 * S;
    ctx.fillStyle = '#444'; ctx.fillRect(cx - 3*S, deskTopY, 6*S, S);
    ctx.fillStyle = '#333'; ctx.fillRect(cx - S, deskTopY - 6*S, 2*S, 6*S);
    ctx.fillStyle = C.monFrame; ctx.fillRect(mx - S, my - S, mW + 2*S, mH + 2*S);
    ctx.fillStyle = screenColor || C.monScrDef; ctx.fillRect(mx, my, mW, mH);
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    for (let sy = my; sy < my + mH; sy += 3) ctx.fillRect(mx, sy, mW, 1);
    ctx.save(); ctx.textAlign = 'center';
    if (line1) {
      ctx.fillStyle = '#7dd3fc';
      ctx.font = `bold ${S * 2.1}px "JetBrains Mono",monospace`;
      ctx.fillText(line1, cx, my + Math.round(mH * 0.44));
    }
    if (line2) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = `${S * 1.7}px "JetBrains Mono",monospace`;
      ctx.fillText(line2, cx, my + Math.round(mH * 0.78));
    }
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(mx + S, my + S, Math.round(mW * 0.35), Math.round(mH * 0.25));
    ctx.restore();
  }

  // ── Meeting table ─────────────────────────────────────────────────────────
  function drawMeetingRoom(ctx, room) {
    const { x, y, w, h } = room;
    const cx = x + w / 2, cy = y + h * 0.45;
    const tw = Math.round(w * 0.65), th = Math.round(h * 0.18);
    // Table top
    ctx.fillStyle = '#c4901f'; ctx.fillRect(cx - tw/2, cy, tw, th);
    ctx.fillStyle = C.tableTop; ctx.fillRect(cx - tw/2, cy, tw, th - 4);
    ctx.fillStyle = '#e8b030'; ctx.fillRect(cx - tw/2, cy, tw, 3); // highlight
    // Legs
    ctx.fillStyle = C.tableLeg;
    ctx.fillRect(cx - tw/2 + 6, cy + th, 6, 14);
    ctx.fillRect(cx + tw/2 - 12, cy + th, 6, 14);
    // Chairs around table
    const chairW = 16, chairH = 10;
    [[cx - tw/2 - chairW - 4, cy + th/2 - chairH/2],
     [cx + tw/2 + 4,          cy + th/2 - chairH/2],
     [cx - 20, cy - chairH - 6],
     [cx + 4,  cy - chairH - 6]].forEach(([cx2, cy2]) => {
      ctx.fillStyle = C.chairD; ctx.fillRect(cx2, cy2, chairW, chairH);
      ctx.fillStyle = C.chair;  ctx.fillRect(cx2, cy2, chairW, chairH - 3);
      ctx.fillStyle = C.chairD; ctx.fillRect(cx2 + 2, cy2 - 8, 3, 8);
      ctx.fillRect(cx2 + chairW - 5, cy2 - 8, 3, 8);
    });
    // Label
    ctx.fillStyle = C.accent; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('MEETING', cx, y + h * 0.12);
  }

  // ── Break room ────────────────────────────────────────────────────────────
  function drawBreakRoom(ctx, room) {
    const { x, y, w, h } = room;
    const cx = x + w / 2;

    // Label
    ctx.fillStyle = C.accent; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('BREAK', cx, y + h * 0.12);

    // Sofa
    const sx = x + Math.round(w * 0.1), sy = y + Math.round(h * 0.35);
    const sw = Math.round(w * 0.8), sh = 20;
    ctx.fillStyle = C.sofaD;  ctx.fillRect(sx, sy, sw, sh + 10);
    ctx.fillStyle = C.sofaA;  ctx.fillRect(sx, sy, sw, sh);
    ctx.fillStyle = C.sofaArm;
    ctx.fillRect(sx, sy - 8, 10, sh + 8);
    ctx.fillRect(sx + sw - 10, sy - 8, 10, sh + 8);
    // Cushions
    ctx.fillStyle = '#7a50b0';
    ctx.fillRect(sx + 12, sy + 3, Math.round((sw - 24) / 2) - 2, sh - 6);
    ctx.fillRect(sx + Math.round((sw - 24) / 2) + 14, sy + 3, Math.round((sw - 24) / 2) - 2, sh - 6);

    // Coffee machine
    const kx = x + Math.round(w * 0.2), ky = y + Math.round(h * 0.65);
    ctx.fillStyle = C.coffeeBody; ctx.fillRect(kx, ky, 18, 22);
    ctx.fillStyle = '#333'; ctx.fillRect(kx + 2, ky + 2, 14, 10);
    ctx.fillStyle = '#e00'; ctx.fillRect(kx + 5, ky + 14, 4, 4); // red button
    ctx.fillStyle = '#888'; ctx.fillRect(kx + 6, ky + 20, 6, 6); // cup area
    // Steam
    ctx.fillStyle = C.coffeeSteam;
    ctx.beginPath();
    ctx.arc(kx + 9, ky - 4, 3, 0, Math.PI * 2);
    ctx.fill();

    // Plant
    drawPlant(ctx, x + Math.round(w * 0.75), y + Math.round(h * 0.7), 0.7);
  }

  // ── Potted plant ──────────────────────────────────────────────────────────
  function drawPlant(ctx, cx, baseY, size) {
    const S = SCALE * (size || 1);
    ctx.fillStyle = C.potRim;  ctx.fillRect(cx - 4*S, baseY - 5*S, 8*S, 2*S);
    ctx.fillStyle = C.potBody; ctx.fillRect(cx - 3*S, baseY - 3*S, 6*S, 4*S);
    ctx.fillStyle = C.potSoil; ctx.fillRect(cx - 3*S + 1, baseY - 5*S + 2, 6*S - 2, 2);
    ctx.fillStyle = C.stem;
    ctx.fillRect(cx - S, baseY - 12*S, 2*S, 7*S);
    ctx.fillRect(cx - 4*S, baseY - 10*S, 4*S, S);
    ctx.fillRect(cx + 2*S, baseY -  9*S, 4*S, S);
    ctx.fillStyle = C.leafA;
    ctx.fillRect(cx - 7*S, baseY - 15*S, 5*S, 6*S);
    ctx.fillRect(cx + 2*S, baseY - 14*S, 5*S, 6*S);
    ctx.fillRect(cx - 3*S, baseY - 18*S, 6*S, 7*S);
    ctx.fillStyle = C.leafC;
    ctx.fillRect(cx - 6*S, baseY - 14*S, 2*S, 3*S);
    ctx.fillRect(cx + 3*S, baseY - 13*S, 2*S, 3*S);
  }

  // ── Floor tiles ───────────────────────────────────────────────────────────
  function drawFloor(ctx, x, y, w, h, colorA, colorB) {
    const tW = Math.max(20, Math.round(w / 7));
    const tH = Math.max(16, Math.round(tW * 0.5));
    ctx.save();
    ctx.rect(x, y, w, h);
    ctx.clip();
    for (let ty = y; ty < y + h + tH; ty += tH) {
      for (let tx = x; tx < x + w + tW; tx += tW) {
        const even = (Math.floor((tx - x) / tW) + Math.floor((ty - y) / tH)) % 2 === 0;
        ctx.fillStyle = even ? colorA : colorB;
        ctx.fillRect(tx, ty, tW, tH);
        ctx.fillStyle = C.floorLine;
        ctx.fillRect(tx, ty, tW, 1);
        ctx.fillRect(tx, ty, 1, tH);
      }
    }
    ctx.restore();
  }

  // ── Back wall ─────────────────────────────────────────────────────────────
  function drawWall(ctx, W, floorY) {
    const grad = ctx.createLinearGradient(0, 0, 0, floorY);
    grad.addColorStop(0, C.wallTop);
    grad.addColorStop(1, C.wall);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, floorY);
    ctx.fillStyle = C.wallBase;
    ctx.fillRect(0, floorY - 5, W, 5);

    const winW = Math.round(W * 0.11), winH = Math.round(floorY * 0.55);
    const winY = Math.round(floorY * 0.1);
    [0.18, 0.42, 0.65, 0.88].forEach(fx => {
      const wx = Math.round(W * fx - winW / 2);
      ctx.fillStyle = C.winFrame;
      ctx.fillRect(wx - 3, winY - 3, winW + 6, winH + 6);
      const wg = ctx.createLinearGradient(wx, winY, wx, winY + winH);
      wg.addColorStop(0, C.winGlass0); wg.addColorStop(1, C.winGlass1);
      ctx.fillStyle = wg; ctx.fillRect(wx, winY, winW, winH);
      ctx.fillStyle = C.winFrame;
      ctx.fillRect(wx + winW/2 - 1, winY, 2, winH);
      ctx.fillRect(wx, winY + winH/2 - 1, winW, 2);
      ctx.fillStyle = C.winRefl;
      ctx.fillRect(wx + 2, winY + 2, Math.round(winW * 0.38), Math.round(winH * 0.42));
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      [[0.1,0.1],[0.6,0.08],[0.3,0.4],[0.8,0.55]].forEach(([fx2,fy2]) => {
        ctx.fillRect(wx + fx2*winW, winY + fy2*winH, 2, 2);
      });
    });

    // MCT banner
    const bW = Math.round(W * 0.24);
    ctx.fillStyle = 'rgba(212,175,55,0.1)';
    ctx.strokeStyle = 'rgba(212,175,55,0.3)';
    ctx.lineWidth = 1;
    ctx.fillRect(W/2 - bW/2, 3, bW, 20);
    ctx.strokeRect(W/2 - bW/2, 3, bW, 20);
    ctx.fillStyle = C.accent;
    ctx.font = 'bold 11px "Space Grotesk",monospace';
    ctx.textAlign = 'center';
    ctx.fillText('🏢  MCT TRADING FLOOR', W / 2, 17);
  }

  // ── Room divider wall with doorway ────────────────────────────────────────
  function drawDivider(ctx, x, y, h, doorY, doorH) {
    ctx.fillStyle = C.wallDiv;
    ctx.fillRect(x - 4, y, 8, doorY - y);
    ctx.fillStyle = C.doorWay;
    ctx.fillRect(x - 3, doorY, 6, doorH); // doorway opening (dark)
    ctx.fillStyle = C.wallDiv;
    ctx.fillRect(x - 4, doorY + doorH, 8, (y + h) - (doorY + doorH));
    // Door frame highlight
    ctx.fillStyle = C.wallBase;
    ctx.fillRect(x - 5, doorY - 2, 10, 2);
    ctx.fillRect(x - 5, doorY + doorH, 10, 2);
  }

  // ── Character behavior & movement ─────────────────────────────────────────
  function Character(tok, deskX, deskY) {
    this.tok      = tok;
    this.x        = deskX;
    this.y        = deskY;
    this.tx       = deskX;
    this.ty       = deskY;
    this.deskX    = deskX;
    this.deskY    = deskY;
    this.walkFrame  = 0;
    this.walkTick   = 0;
    this.facing     = 1;
    this.room       = 'trading';
    this.behavior   = 'at_desk';
    this.idleTimer  = Math.round(180 + Math.random() * 360);
    this.tradeState = { state: 'idle', pnl: null, price: '--', screenColor: C.monScrDef };
  }

  Character.prototype.setTarget = function (tx, ty, newBehavior) {
    this.tx = tx; this.ty = ty;
    this.behavior = newBehavior;
  };

  Character.prototype.wander = function (rooms) {
    const roll = Math.random();
    const br = rooms.breakroom, mr = rooms.meeting;
    if (this.tradeState.state !== 'idle') {
      // Always go back to desk when trading
      this.setTarget(this.deskX, this.deskY, 'walking_to_desk');
      return;
    }
    if (roll < 0.45) {
      this.setTarget(this.deskX, this.deskY, 'walking_to_desk');
    } else if (roll < 0.75) {
      const tx = br.x + Math.round(br.w * (0.25 + Math.random() * 0.5));
      const ty = br.y + Math.round(br.h * (0.5  + Math.random() * 0.2));
      this.setTarget(tx, ty, 'walking_to_break');
    } else {
      const tx = mr.x + Math.round(mr.w * (0.2 + Math.random() * 0.6));
      const ty = mr.y + Math.round(mr.h * (0.4 + Math.random() * 0.2));
      this.setTarget(tx, ty, 'walking_to_meeting');
    }
  };

  Character.prototype.update = function (rooms) {
    const dx = this.tx - this.x;
    const dy = this.ty - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > SPEED + 0.5) {
      // Walking
      this.x += (dx / dist) * SPEED;
      this.y += (dy / dist) * SPEED;
      if (Math.abs(dx) > 1) this.facing = dx > 0 ? 1 : -1;

      this.walkTick++;
      if (this.walkTick % Math.round(60 / FPS_ANIM / 2) === 0) {
        this.walkFrame = (this.walkFrame + 1) % 4;
      }
    } else {
      // Arrived
      this.x = this.tx; this.y = this.ty;
      this.walkFrame = 0;

      const prev = this.behavior;
      if (prev === 'walking_to_desk')    { this.behavior = 'at_desk';    this.idleTimer = 300 + Math.round(Math.random() * 400); }
      else if (prev === 'walking_to_break')   { this.behavior = 'at_break';   this.idleTimer = 180 + Math.round(Math.random() * 240); }
      else if (prev === 'walking_to_meeting') { this.behavior = 'at_meeting'; this.idleTimer = 150 + Math.round(Math.random() * 180); }
    }

    // Active trade: keep at desk
    if (this.tradeState.state !== 'idle' &&
        this.behavior !== 'at_desk' && this.behavior !== 'walking_to_desk') {
      this.setTarget(this.deskX, this.deskY, 'walking_to_desk');
    }

    // Idle timer
    if (this.tradeState.state === 'idle') {
      if (this.behavior === 'at_desk' || this.behavior === 'at_break' || this.behavior === 'at_meeting') {
        this.idleTimer--;
        if (this.idleTimer <= 0) this.wander(rooms);
      }
    }
  };

  // ── TradingFloor class ────────────────────────────────────────────────────
  function TradingFloor(canvas) {
    this.canvas     = canvas;
    this.ctx        = canvas.getContext('2d');
    this.running    = false;
    this.rafId      = null;
    this._pollTimer = null;
    this.tick       = 0;
    this.chars      = [];
    this._initChars();
  }

  TradingFloor.prototype._initChars = function () {
    const W = this.canvas.width, H = this.canvas.height;
    const rooms = this._rooms(W, H);
    const room  = rooms.trading;
    this.chars  = TOKENS.map((tok, i) => {
      const cx = room.x + Math.round(room.w * (i + 0.5) / TOKENS.length);
      const cy = room.y + Math.round(room.h * 0.42);
      const ch = new Character(tok, cx, cy);
      ch.idleTimer += i * 80; // stagger departures
      return ch;
    });
  };

  TradingFloor.prototype._rooms = function (W, H) {
    const wallH = Math.round(H * 0.29);
    const fy    = wallH; // floor starts here
    const fh    = H - fy;
    return {
      trading:   { x: 0,               y: fy, w: Math.round(W * 0.54), h: fh },
      meeting:   { x: Math.round(W * 0.54), y: fy, w: Math.round(W * 0.22), h: fh },
      breakroom: { x: Math.round(W * 0.76), y: fy, w: Math.round(W * 0.24), h: fh },
      wallH,
    };
  };

  TradingFloor.prototype.start = function () {
    if (this.running) return;
    this.running    = true;
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
      TOKENS.forEach((t, i) => {
        const el = document.getElementById(priceIds[t.symbol]);
        if (el && el.textContent && el.textContent !== '--')
          this.chars[i].tradeState.price = el.textContent;
      });

      const resp = await fetch('/api/admin/open-positions', {
        headers: { Authorization: 'Bearer ' + (localStorage.getItem('token') || '') },
      });
      if (!resp.ok) return;
      const positions = await resp.json();

      // Reset all to idle
      this.chars.forEach(ch => {
        ch.tradeState.state       = 'idle';
        ch.tradeState.pnl         = null;
        ch.tradeState.screenColor = C.monScrDef;
      });

      (Array.isArray(positions) ? positions : []).forEach(pos => {
        const idx = TOKENS.findIndex(t => t.symbol === pos.symbol);
        if (idx < 0) return;
        const ch     = this.chars[idx];
        const isLong = pos.direction === 'LONG';
        const pnl    = parseFloat(pos.unrealized_pnl || pos.pnl || 0);
        ch.tradeState.state       = isLong ? 'bull' : 'bear';
        ch.tradeState.pnl         = pnl;
        ch.tradeState.screenColor = pnl >= 0 ? 'rgba(20,83,45,0.88)' : (isLong ? 'rgba(120,53,15,0.88)' : 'rgba(100,20,20,0.88)');
      });
    } catch (_) {}
  };

  TradingFloor.prototype._loop = function () {
    if (!this.running) return;
    this.tick++;
    const W     = this.canvas.width, H = this.canvas.height;
    const rooms = this._rooms(W, H);
    this.chars.forEach(ch => ch.update(rooms));
    this._draw(rooms, W, H);
    this.rafId = requestAnimationFrame(() => this._loop());
  };

  TradingFloor.prototype._draw = function (rooms, W, H) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);

    const { trading, meeting, breakroom, wallH } = rooms;

    // ── Scene ──
    drawWall(ctx, W, wallH);

    // Room floors
    drawFloor(ctx, trading.x,   trading.y,   trading.w,   trading.h,   C.floorTradingA, C.floorTradingB);
    drawFloor(ctx, meeting.x,   meeting.y,   meeting.w,   meeting.h,   C.floorMeetingA, C.floorMeetingB);
    drawFloor(ctx, breakroom.x, breakroom.y, breakroom.w, breakroom.h, C.floorBreakA,   C.floorBreakB);

    // Room dividers with doorways
    const doorH = Math.round(trading.h * 0.38);
    const doorY = trading.y + Math.round(trading.h * 0.35);
    drawDivider(ctx, trading.x + trading.w,   trading.y, trading.h, doorY, doorH);
    drawDivider(ctx, meeting.x + meeting.w,   meeting.y, meeting.h, doorY, doorH);

    // Corner plants in trading room
    const plantBase = trading.y + Math.round(trading.h * 0.72);
    drawPlant(ctx, trading.x + 36, plantBase, 0.8);
    drawPlant(ctx, trading.x + trading.w - 36, plantBase, 0.8);

    // Trading desks + monitors
    const deskW = Math.min(Math.round(trading.w * 0.17), 170);
    const deskY = trading.y + Math.round(trading.h * 0.52);

    TOKENS.forEach((tok, i) => {
      const cx = trading.x + Math.round(trading.w * (i + 0.5) / TOKENS.length);
      const ch = this.chars[i];
      const st = ch.tradeState;

      drawDesk(ctx, cx - Math.round(deskW / 2), deskY, deskW);

      // Only draw monitor when character is at/near desk
      const atDesk = ch.behavior === 'at_desk' || ch.behavior === 'walking_to_desk';
      const dirLine   = st.state === 'bull' ? '▲ LONG' : st.state === 'bear' ? '▼ SHORT' : 'SCANNING…';
      const priceLine = st.pnl !== null ? (st.pnl >= 0 ? '+' : '') + st.pnl.toFixed(2) + 'U' : st.price;
      drawMonitor(ctx, cx, deskY, atDesk ? st.screenColor : C.monScrDef, `${tok.label}  ${dirLine}`, priceLine);
    });

    // Meeting & Break room furniture
    drawMeetingRoom(ctx, meeting);
    drawBreakRoom(ctx, breakroom);

    // ── Characters (drawn sorted by Y so "depth" looks right) ──
    const sorted = [...this.chars].sort((a, b) => a.y - b.y);
    sorted.forEach(ch => {
      const cx = Math.round(ch.x) - 6 * SCALE;
      const cy = Math.round(ch.y) - 26 * SCALE;

      // Active glow
      if (ch.tradeState.state !== 'idle' && ch.behavior === 'at_desk') {
        const winning = (ch.tradeState.pnl ?? 0) >= 0;
        const grd = ctx.createRadialGradient(ch.x, ch.y, 0, ch.x, ch.y, 55);
        grd.addColorStop(0, winning ? 'rgba(34,197,94,0.13)' : 'rgba(239,68,68,0.13)');
        grd.addColorStop(1, 'transparent');
        ctx.fillStyle = grd;
        ctx.fillRect(ch.x - 60, ch.y - 60, 120, 120);
      }

      drawChar(ctx, cx, cy, ch.tok, ch.tradeState.state, ch.walkFrame, ch.facing);

      // Name tag above head
      const label = ch.tok.label;
      const tagW = 32, tagH = 12;
      ctx.fillStyle = C.nameTag;
      ctx.fillRect(Math.round(ch.x) - tagW/2, cy - tagH - 2, tagW, tagH);
      ctx.fillStyle = ch.tok.shirt;
      ctx.font = 'bold 9px "JetBrains Mono",monospace';
      ctx.textAlign = 'center';
      ctx.fillText(label, Math.round(ch.x), cy + tagH - 14);

      // State dot
      const dotCol = ch.tradeState.state === 'bull' ? '#22c55e'
                   : ch.tradeState.state === 'bear' ? '#ef4444'
                   : '#475569';
      ctx.fillStyle = dotCol;
      ctx.beginPath();
      ctx.arc(Math.round(ch.x) + 14, cy - 5, 4, 0, Math.PI * 2);
      ctx.fill();
    });

    // ── HUD ──
    ctx.fillStyle = C.hud;
    ctx.fillRect(6, 5, 168, 20);
    ctx.fillStyle = C.accent;
    ctx.font = 'bold 11px "JetBrains Mono",monospace';
    ctx.textAlign = 'left';
    ctx.fillText('🏢 TRADING FLOOR', 12, 19);

    ctx.fillStyle = 'rgba(34,197,94,0.2)';
    ctx.beginPath(); ctx.arc(W - 14, 15, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#22c55e';
    ctx.beginPath(); ctx.arc(W - 14, 15, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#d1fae5';
    ctx.font = '10px monospace'; ctx.textAlign = 'right';
    ctx.fillText('LIVE', W - 26, 19);
  };

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    const container = document.getElementById('trading-floor-container');
    if (!container) return null;

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;display:block;';

    const resize = () => {
      const W = container.clientWidth || 960;
      const H = Math.max(480, Math.round(W * 0.52));
      canvas.width  = W;
      canvas.height = H;
    };
    resize();
    container.innerHTML = '';
    container.appendChild(canvas);

    const floor = new TradingFloor(canvas);
    window._tradingFloor = floor;
    window.addEventListener('resize', () => { resize(); floor._initChars(); });
    return floor;
  }

  global.TradingFloor = { init };

})(window);
