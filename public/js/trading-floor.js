/**
 * Trading Floor — pixel-agents engine adapted for vanilla browser JS
 * Based on: https://github.com/pablodelucca/pixel-agents
 *
 * Characters: BTC / ETH / SOL / BNB agents with full walking/typing/idle
 * state machine, BFS pathfinding, and z-sorted rendering.
 * Active = open position (isActive=true → sit at desk typing).
 * Inactive = no position (isActive=false → wander the office).
 */
(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════
  // Constants  (pixel-agents/src/constants.ts)
  // ════════════════════════════════════════════════════════════
  const TILE_SIZE              = 16;
  const WALK_SPEED             = 48;    // px / sec
  const WALK_FRAME_DUR         = 0.15;  // sec per walk frame
  const TYPE_FRAME_DUR         = 0.30;  // sec per typing frame
  const WANDER_PAUSE_MIN       = 2.0;
  const WANDER_PAUSE_MAX       = 20.0;
  const WANDER_MOVES_MIN       = 3;
  const WANDER_MOVES_MAX       = 6;
  const SEAT_REST_MIN          = 25.0;
  const SEAT_REST_MAX          = 70.0;
  const CHAR_SIT_OFFSET        = 6;     // px down when seated
  const CHAR_Z_OFFSET          = 0.5;
  const MAX_DT                 = 0.10;

  // Character state enum  (pixel-agents types.ts)
  const CS  = { IDLE: 'idle', WALK: 'walk', TYPE: 'type' };
  // Direction enum — matches pixel-agents exactly
  const Dir = { DOWN: 0, LEFT: 1, RIGHT: 2, UP: 3 };

  // PNG sprite-sheet layout for each char_N.png  (112 × 96 px)
  // Frame row by direction:  down=0 (y=0), up=1 (y=32), right=2 (y=64)
  // Frames per row (7 × 16 px wide):
  //   0,1,2 = walk   3,4 = typing   5,6 = reading
  // LEFT direction = horizontal flip of RIGHT frames
  const WALK_FRAME_IDX = [0, 1, 2, 1]; // 4-step walk cycle

  // ════════════════════════════════════════════════════════════
  // Office tile map  (20 cols × 11 rows)
  // ════════════════════════════════════════════════════════════
  const COLS = 20, ROWS = 22;
  const W = 0, F = 1; // TileType: WALL=0, FLOOR=1

  /*
    Layout diagram (. = floor, # = wall, | = internal wall, D = doorway)
    Two floors connected by a doorway in the dividing wall (row 10, cols 9-10).
    Upper: existing trading wing (cols 1-8) + lounge (cols 10-18)
    Lower: AI Lab — single open room (cols 1-18) with 14 desks for backend agents

    Col:  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19
    r 0:  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #
    r 1:  #  .  .  .  .  .  .  .  .  |  .  .  .  .  .  .  .  .  .  #
    r 2:  #  .  .  .  .  .  .  .  .  |  .  .  .  .  .  .  .  .  .  #
    r 3:  #  .  .  .  .  .  .  .  .  |  .  .  .  .  .  .  .  .  .  #
    r 4:  #  .  .  .  .  .  .  .  .  D  .  .  .  .  .  .  .  .  .  #   doorway L↔R
    r 5:  #  .  .  .  .  .  .  .  .  D  .  .  .  .  .  .  .  .  .  #   doorway L↔R
    r 6:  #  .  .  .  .  .  .  .  .  |  .  .  .  .  .  .  .  .  .  #
    r 7:  #  .  .  .  .  .  .  .  .  |  .  .  .  .  .  .  .  .  .  #
    r 8:  #  .  .  .  .  .  .  .  .  |  .  .  .  .  .  .  .  .  .  #
    r 9:  #  .  .  .  .  .  .  .  .  |  .  .  .  .  .  .  .  .  .  #
    r10:  #  #  #  #  #  #  #  #  #  D  D  #  #  #  #  #  #  #  #  #   stair/door upper↔lower
    r11:  #  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  #
    r12:  #  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  #   chair row (front)
    r13:  #  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  #
    r14:  #  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  #
    r15:  #  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  #
    r16:  #  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  #   chair row (back)
    r17:  #  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  #
    r18:  #  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  #
    r19:  #  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  #
    r20:  #  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  .  #
    r21:  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #  #
  */
  // prettier-ignore
  const TILE_FLAT = [
    W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,  // row 0
    W,F,F,F,F,F,F,F,F,W,F,F,F,F,F,F,F,F,F,W,  // row 1
    W,F,F,F,F,F,F,F,F,W,F,F,F,F,F,F,F,F,F,W,  // row 2
    W,F,F,F,F,F,F,F,F,W,F,F,F,F,F,F,F,F,F,W,  // row 3
    W,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,W,  // row 4  doorway L↔R
    W,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,W,  // row 5  doorway L↔R
    W,F,F,F,F,F,F,F,F,W,F,F,F,F,F,F,F,F,F,W,  // row 6
    W,F,F,F,F,F,F,F,F,W,F,F,F,F,F,F,F,F,F,W,  // row 7
    W,F,F,F,F,F,F,F,F,W,F,F,F,F,F,F,F,F,F,W,  // row 8
    W,F,F,F,F,F,F,F,F,W,F,F,F,F,F,F,F,F,F,W,  // row 9
    W,W,W,W,W,W,W,W,W,F,F,W,W,W,W,W,W,W,W,W,  // row 10  stair/door upper↔lower
    W,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,W,  // row 11
    W,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,W,  // row 12  chair row (front)
    W,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,W,  // row 13
    W,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,W,  // row 14
    W,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,W,  // row 15
    W,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,W,  // row 16  chair row (back)
    W,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,W,  // row 17
    W,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,W,  // row 18
    W,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,W,  // row 19
    W,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,F,W,  // row 20
    W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,W,  // row 21
  ];

  function buildTileMap() {
    const m = [];
    for (let r = 0; r < ROWS; r++) m.push(TILE_FLAT.slice(r * COLS, (r + 1) * COLS));
    return m;
  }

  // ════════════════════════════════════════════════════════════
  // Seats  (col/row/facingDir for each agent's chair)
  // ════════════════════════════════════════════════════════════
  const SEATS = new Map([
    ['seat-btc',   { seatCol: 2,  seatRow: 3, facingDir: Dir.UP, assigned: false }],
    ['seat-eth',   { seatCol: 6,  seatRow: 3, facingDir: Dir.UP, assigned: false }],
    ['seat-sol',   { seatCol: 2,  seatRow: 8, facingDir: Dir.UP, assigned: false }],
    ['seat-bnb',   { seatCol: 6,  seatRow: 8, facingDir: Dir.UP, assigned: false }],
    ['seat-xrp',   { seatCol: 10, seatRow: 3, facingDir: Dir.UP, assigned: false }],
    // Lounge — non-trader agents
    ['seat-coord', { seatCol: 16, seatRow: 3, facingDir: Dir.UP, assigned: false }], // at whiteboard
    ['seat-coder', { seatCol: 11, seatRow: 5, facingDir: Dir.UP, assigned: false }], // by bookshelf/coffee
    // ── AI Lab (lower floor) — backend agents ──────────────────
    // Front row — control agents
    ['seat-chart',   { seatCol: 2,  seatRow: 12, facingDir: Dir.UP, assigned: false }],
    ['seat-risk',    { seatCol: 4,  seatRow: 12, facingDir: Dir.UP, assigned: false }],
    ['seat-trader',  { seatCol: 6,  seatRow: 12, facingDir: Dir.UP, assigned: false }],
    ['seat-police',  { seatCol: 8,  seatRow: 12, facingDir: Dir.UP, assigned: false }],
    ['seat-kronos',  { seatCol: 10, seatRow: 12, facingDir: Dir.UP, assigned: false }],
    ['seat-acct',    { seatCol: 12, seatRow: 12, facingDir: Dir.UP, assigned: false }],
    ['seat-watch',   { seatCol: 14, seatRow: 12, facingDir: Dir.UP, assigned: false }],
    // Back row — strategy / AI agents
    ['seat-strat',   { seatCol: 2,  seatRow: 16, facingDir: Dir.UP, assigned: false }],
    ['seat-sent',    { seatCol: 4,  seatRow: 16, facingDir: Dir.UP, assigned: false }],
    ['seat-opt',     { seatCol: 6,  seatRow: 16, facingDir: Dir.UP, assigned: false }],
    ['seat-brain',   { seatCol: 8,  seatRow: 16, facingDir: Dir.UP, assigned: false }],
    ['seat-swarm',   { seatCol: 10, seatRow: 16, facingDir: Dir.UP, assigned: false }],
    ['seat-gov',     { seatCol: 12, seatRow: 16, facingDir: Dir.UP, assigned: false }],
    ['seat-lab',     { seatCol: 14, seatRow: 16, facingDir: Dir.UP, assigned: false }],
  ]);

  // ════════════════════════════════════════════════════════════
  // Static blocked tiles from furniture
  // (Background rows are walkable; only solid footprint rows are blocked)
  // ════════════════════════════════════════════════════════════
  const STATIC_BLOCKED = [
    // DESK_FRONT (48×32, bg=1): front row blocked (row+1 of placement)
    // BTC desk at (1,1): solid at row 2
    '1,2','2,2','3,2',
    // ETH desk at (5,1): solid at row 2
    '5,2','6,2','7,2',
    // SOL desk at (1,6): solid at row 7
    '1,7','2,7','3,7',
    // BNB desk at (5,6): solid at row 7
    '5,7','6,7','7,7',

    // CUSHIONED_CHAIR_BACK (16×16, bg=0, 1×1 footprint):
    // These are the seat tiles — unblocked per-character during pathfinding
    '2,3','6,3',   // top row chairs
    '2,8','6,8',   // bottom row chairs

    // PLANT (16×32, bg=1, 1×2): bottom half blocked
    '8,2', '8,7',

    // Right room ─────────────────────────────────────
    // DOUBLE_BOOKSHELF (32×32, bg=0, 2×2): full footprint
    '10,1','11,1','10,2','11,2',
    // WHITEBOARD (32×32, bg=0, 2×2) at (15,1)
    '15,1','16,1','15,2','16,2',
    // SOFA_BACK (32×16, bg=0, 2×1) at (13,2)
    '13,2','14,2',
    // COFFEE_TABLE (32×32, bg=0, 2×2) at (13,3)
    '13,3','14,3','13,4','14,4',
    // SOFA_FRONT (32×16, bg=0, 2×1) at (13,6)
    '13,6','14,6',
    // LARGE_PLANT (32×48, bg=2, 2×3) at (17,7): bottom 1 row blocked
    '17,9','18,9',
    // PLANT right side at (18,1)
    '18,2',

    // ── AI Lab (lower floor) chair tiles — front row (row 12) ──
    '2,12','4,12','6,12','8,12','10,12','12,12','14,12',
    // ── AI Lab back row (row 16) ──
    '2,16','4,16','6,16','8,16','10,16','12,16','14,16',
  ];

  // ════════════════════════════════════════════════════════════
  // Agent definitions
  // ════════════════════════════════════════════════════════════
  const AGENTS = [
    { id: 0,  symbol: 'BTCUSDT', label: 'BTC',    palette: 0, seatId: 'seat-btc',    role: 'trader' },
    { id: 1,  symbol: 'ETHUSDT', label: 'ETH',    palette: 1, seatId: 'seat-eth',    role: 'trader' },
    { id: 2,  symbol: 'SOLUSDT', label: 'SOL',    palette: 2, seatId: 'seat-sol',    role: 'trader' },
    { id: 3,  symbol: 'BNBUSDT', label: 'BNB',    palette: 3, seatId: 'seat-bnb',    role: 'trader' },
    { id: 6,  symbol: 'XRPUSDT', label: 'XRP',    palette: 0, seatId: 'seat-xrp',    role: 'trader' },
    { id: 4,  symbol: null,      label: 'COORD',  palette: 4, seatId: 'seat-coord',  role: 'coordinator' },
    { id: 5,  symbol: null,      label: 'CODER',  palette: 5, seatId: 'seat-coder',  role: 'coder' },
    // ── AI Lab — backend agents ──────────────────────────────
    { id: 7,  symbol: null,      label: 'CHART',  palette: 0, seatId: 'seat-chart',  role: 'chart' },
    { id: 8,  symbol: null,      label: 'RISK',   palette: 1, seatId: 'seat-risk',   role: 'risk' },
    { id: 9,  symbol: null,      label: 'TRADER', palette: 2, seatId: 'seat-trader', role: 'executor' },
    { id: 10, symbol: null,      label: 'POLICE', palette: 3, seatId: 'seat-police', role: 'police' },
    { id: 11, symbol: null,      label: 'KRONOS', palette: 4, seatId: 'seat-kronos', role: 'kronos' },
    { id: 12, symbol: null,      label: 'ACCT',   palette: 5, seatId: 'seat-acct',   role: 'accountant' },
    { id: 13, symbol: null,      label: 'WATCH',  palette: 0, seatId: 'seat-watch',  role: 'watcher' },
    { id: 14, symbol: null,      label: 'STRAT',  palette: 1, seatId: 'seat-strat',  role: 'strategy' },
    { id: 15, symbol: null,      label: 'SENT',   palette: 2, seatId: 'seat-sent',   role: 'sentiment' },
    { id: 16, symbol: null,      label: 'OPT',    palette: 3, seatId: 'seat-opt',    role: 'optimizer' },
    { id: 17, symbol: null,      label: 'BRAIN',  palette: 4, seatId: 'seat-brain',  role: 'ai_brain' },
    { id: 18, symbol: null,      label: 'SWARM',  palette: 5, seatId: 'seat-swarm',  role: 'swarm' },
    { id: 19, symbol: null,      label: 'GOV',    palette: 0, seatId: 'seat-gov',    role: 'governance' },
    { id: 20, symbol: null,      label: 'LAB',    palette: 1, seatId: 'seat-lab',    role: 'strategy_lab' },
  ];

  // Friendly display titles + role colours for the sidebar agent list
  const ROLE_META = {
    trader:        { title: 'Trader',       color: '#7dd3fc' },
    coordinator:   { title: 'Coordinator',  color: '#fbbf24' },
    coder:         { title: 'Coder',        color: '#a78bfa' },
    // AI Lab roles
    chart:         { title: 'Chart',        color: '#60a5fa' },
    risk:          { title: 'Risk',         color: '#f87171' },
    executor:      { title: 'Trade Exec',   color: '#34d399' },
    police:        { title: 'Police',       color: '#94a3b8' },
    kronos:        { title: 'Kronos',       color: '#c084fc' },
    accountant:    { title: 'Accountant',   color: '#facc15' },
    watcher:       { title: 'Watcher',      color: '#22d3ee' },
    strategy:      { title: 'Strategy',     color: '#fb923c' },
    sentiment:     { title: 'Sentiment',    color: '#f472b6' },
    optimizer:     { title: 'Optimizer',    color: '#a3e635' },
    ai_brain:      { title: 'AI Brain',     color: '#e879f9' },
    swarm:         { title: 'Swarm',        color: '#f59e0b' },
    governance:    { title: 'Governance',   color: '#cbd5e1' },
    strategy_lab:  { title: 'Strategy Lab', color: '#67e8f9' },
  };

  // Sidebar status label per non-trader role
  const ROLE_LABEL = {
    coordinator:  'planning',
    coder:        'coding',
    chart:        'scanning',
    risk:         'gating',
    executor:     'executing',
    police:       'patrolling',
    kronos:       'predicting',
    accountant:   'tallying',
    watcher:      'watching',
    strategy:     'strategising',
    sentiment:    'reading',
    optimizer:    'tuning',
    ai_brain:     'thinking',
    swarm:        'voting',
    governance:   'enforcing',
    strategy_lab: 'experimenting',
  };

  // Map role → backend agent class name for /api/admin/agents/health lookup
  const ROLE_TO_NAME = {
    coordinator:  'Coordinator',
    coder:        'CoderAgent',
    chart:        'ChartAgent',
    risk:         'RiskAgent',
    executor:     'TraderAgent',
    police:       'PoliceAgent',
    kronos:       'KronosAgent',
    accountant:   'AccountantAgent',
    watcher:      'WatcherAgent',
    strategy:     'StrategyAgent',
    sentiment:    'SentimentAgent',
    optimizer:    'OptimizerAgent',
    ai_brain:     'AIBrain',
    swarm:        'SwarmEngine',
    governance:   'GovernanceEngine',
    strategy_lab: 'StrategyLab',
  };


  // PC positions mapped to character IDs (for ON/OFF animation)
  const PC_ITEMS = [
    { charId: 0, col: 2, row: 1 },
    { charId: 1, col: 6, row: 1 },
    { charId: 2, col: 2, row: 6 },
    { charId: 3, col: 6, row: 6 },
  ];

  // ════════════════════════════════════════════════════════════
  // BFS Pathfinding  (pixel-agents/src/office/layout/tileMap.ts)
  // ════════════════════════════════════════════════════════════

  function isWalkable(col, row, tileMap, blocked) {
    if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return false;
    if (tileMap[row][col] === W) return false;
    if (blocked.has(`${col},${row}`)) return false;
    return true;
  }

  function getWalkableTiles(tileMap, blocked) {
    const tiles = [];
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (isWalkable(c, r, tileMap, blocked)) tiles.push({ col: c, row: r });
    return tiles;
  }

  function findPath(sc, sr, ec, er, tileMap, blocked) {
    if (sc === ec && sr === er) return [];
    const key = (c, r) => `${c},${r}`;
    const sk = key(sc, sr), ek = key(ec, er);
    if (!isWalkable(ec, er, tileMap, blocked)) return [];
    const visited = new Set([sk]);
    const parent = new Map();
    const queue = [{ col: sc, row: sr }];
    const dirs = [{ dc: 0, dr: -1 }, { dc: 0, dr: 1 }, { dc: -1, dr: 0 }, { dc: 1, dr: 0 }];
    while (queue.length) {
      const cur = queue.shift();
      const ck = key(cur.col, cur.row);
      if (ck === ek) {
        const path = [];
        let k = ek;
        while (k !== sk) {
          const [c, r] = k.split(',').map(Number);
          path.unshift({ col: c, row: r });
          k = parent.get(k);
        }
        return path;
      }
      for (const d of dirs) {
        const nc = cur.col + d.dc, nr = cur.row + d.dr, nk = key(nc, nr);
        if (visited.has(nk) || !isWalkable(nc, nr, tileMap, blocked)) continue;
        visited.add(nk);
        parent.set(nk, ck);
        queue.push({ col: nc, row: nr });
      }
    }
    return [];
  }

  // ════════════════════════════════════════════════════════════
  // Character factory + FSM  (pixel-agents/src/office/engine/characters.ts)
  // ════════════════════════════════════════════════════════════

  function tileCenter(col, row) {
    return { x: col * TILE_SIZE + TILE_SIZE / 2, y: row * TILE_SIZE + TILE_SIZE / 2 };
  }

  function dirBetween(fc, fr, tc, tr) {
    const dc = tc - fc, dr = tr - fr;
    if (dc > 0) return Dir.RIGHT;
    if (dc < 0) return Dir.LEFT;
    if (dr > 0) return Dir.DOWN;
    return Dir.UP;
  }

  function rndRange(min, max) { return min + Math.random() * (max - min); }
  function rndInt(min, max)   { return min + Math.floor(Math.random() * (max - min + 1)); }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function createCharacter(id, palette, seatId, seat) {
    const col = seat ? seat.seatCol : 1;
    const row = seat ? seat.seatRow : 1;
    const c = tileCenter(col, row);
    return {
      id, state: CS.TYPE,
      dir: seat ? seat.facingDir : Dir.DOWN,
      x: c.x, y: c.y,
      tileCol: col, tileRow: row,
      path: [], moveProgress: 0,
      palette,
      frame: 0, frameTimer: 0,
      wanderTimer: 0, wanderCount: 0,
      wanderLimit: rndInt(WANDER_MOVES_MIN, WANDER_MOVES_MAX),
      isActive: true,
      seatId,
      seatTimer: 0,
      currentSide: null,
    };
  }

  /**
   * Update one character for `dt` seconds.
   * The caller must temporarily unblock the character's own seat before calling.
   * Ported directly from pixel-agents characters.ts updateCharacter().
   */
  function updateCharacter(ch, dt, walkableTiles, tileMap, blocked) {
    ch.frameTimer += dt;

    switch (ch.state) {
      // ── TYPE ──────────────────────────────────────────────
      case CS.TYPE: {
        if (ch.frameTimer >= TYPE_FRAME_DUR) {
          ch.frameTimer -= TYPE_FRAME_DUR;
          ch.frame = (ch.frame + 1) % 2;
        }
        if (!ch.isActive) {
          if (ch.seatTimer > 0) { ch.seatTimer -= dt; break; }
          ch.seatTimer = 0;
          ch.state = CS.IDLE;
          ch.frame = 0; ch.frameTimer = 0;
          ch.wanderTimer = rndRange(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX);
          ch.wanderCount = 0;
          ch.wanderLimit = rndInt(WANDER_MOVES_MIN, WANDER_MOVES_MAX);
        }
        break;
      }

      // ── IDLE ──────────────────────────────────────────────
      case CS.IDLE: {
        ch.frame = 0;
        if (ch.seatTimer < 0) ch.seatTimer = 0;

        if (ch.isActive) {
          if (!ch.seatId) {
            ch.state = CS.TYPE; ch.frame = 0; ch.frameTimer = 0;
            break;
          }
          const seat = SEATS.get(ch.seatId);
          if (seat) {
            const path = findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blocked);
            if (path.length > 0) {
              ch.path = path; ch.moveProgress = 0;
              ch.state = CS.WALK; ch.frame = 0; ch.frameTimer = 0;
            } else {
              ch.state = CS.TYPE; ch.dir = seat.facingDir;
              ch.frame = 0; ch.frameTimer = 0;
            }
          }
          break;
        }

        ch.wanderTimer -= dt;
        if (ch.wanderTimer <= 0) {
          if (ch.wanderCount >= ch.wanderLimit && ch.seatId) {
            const seat = SEATS.get(ch.seatId);
            if (seat) {
              const path = findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blocked);
              if (path.length > 0) {
                ch.path = path; ch.moveProgress = 0;
                ch.state = CS.WALK; ch.frame = 0; ch.frameTimer = 0;
                break;
              }
            }
          }
          if (walkableTiles.length > 0) {
            const target = walkableTiles[Math.floor(Math.random() * walkableTiles.length)];
            const path = findPath(ch.tileCol, ch.tileRow, target.col, target.row, tileMap, blocked);
            if (path.length > 0) {
              ch.path = path; ch.moveProgress = 0;
              ch.state = CS.WALK; ch.frame = 0; ch.frameTimer = 0;
              ch.wanderCount++;
            }
          }
          ch.wanderTimer = rndRange(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX);
        }
        break;
      }

      // ── WALK ──────────────────────────────────────────────
      case CS.WALK: {
        if (ch.frameTimer >= WALK_FRAME_DUR) {
          ch.frameTimer -= WALK_FRAME_DUR;
          ch.frame = (ch.frame + 1) % 4;
        }

        if (ch.path.length === 0) {
          const c = tileCenter(ch.tileCol, ch.tileRow);
          ch.x = c.x; ch.y = c.y;

          if (ch.isActive) {
            const seat = SEATS.get(ch.seatId);
            if (!ch.seatId) {
              ch.state = CS.TYPE;
            } else if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
              ch.state = CS.TYPE; ch.dir = seat.facingDir;
            } else {
              ch.state = CS.IDLE;
            }
          } else {
            const seat = SEATS.get(ch.seatId);
            if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
              ch.state = CS.TYPE; ch.dir = seat.facingDir;
              ch.seatTimer = ch.seatTimer < 0 ? 0 : rndRange(SEAT_REST_MIN, SEAT_REST_MAX);
              ch.wanderCount = 0;
              ch.wanderLimit = rndInt(WANDER_MOVES_MIN, WANDER_MOVES_MAX);
              ch.frame = 0; ch.frameTimer = 0;
              break;
            }
            ch.state = CS.IDLE;
            ch.wanderTimer = rndRange(WANDER_PAUSE_MIN, WANDER_PAUSE_MAX);
          }
          ch.frame = 0; ch.frameTimer = 0;
          break;
        }

        const next = ch.path[0];
        ch.dir = dirBetween(ch.tileCol, ch.tileRow, next.col, next.row);
        ch.moveProgress += (WALK_SPEED / TILE_SIZE) * dt;

        const from = tileCenter(ch.tileCol, ch.tileRow);
        const to   = tileCenter(next.col, next.row);
        const t = Math.min(ch.moveProgress, 1);
        ch.x = from.x + (to.x - from.x) * t;
        ch.y = from.y + (to.y - from.y) * t;

        if (ch.moveProgress >= 1) {
          ch.tileCol = next.col; ch.tileRow = next.row;
          ch.x = to.x; ch.y = to.y;
          ch.path.shift(); ch.moveProgress = 0;
        }

        // Re-path to seat if character became active mid-wander
        if (ch.isActive && ch.seatId) {
          const seat = SEATS.get(ch.seatId);
          if (seat) {
            const last = ch.path[ch.path.length - 1];
            if (!last || last.col !== seat.seatCol || last.row !== seat.seatRow) {
              const np = findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blocked);
              if (np.length > 0) { ch.path = np; ch.moveProgress = 0; }
            }
          }
        }
        break;
      }
    }
  }

  /**
   * Temporarily unblock a character's own seat tile, run the FSM, then re-block.
   * Mirrors OfficeState.withOwnSeatUnblocked() in pixel-agents.
   */
  function updateWithSeatUnblocked(ch, dt, walkable, tileMap, blocked) {
    const seat = ch.seatId ? SEATS.get(ch.seatId) : null;
    const sk = seat ? `${seat.seatCol},${seat.seatRow}` : null;
    if (sk) blocked.delete(sk);
    updateCharacter(ch, dt, walkable, tileMap, blocked);
    if (sk) blocked.add(sk);
  }

  // ════════════════════════════════════════════════════════════
  // Asset loading
  // ════════════════════════════════════════════════════════════

  function loadImg(src) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function loadAllAssets() {
    const base = '/img/pixel-agents';

    const [charImgs, ...furnList] = await Promise.all([
      // 6 character sprite sheets
      Promise.all(Array.from({ length: 6 }, (_, i) => loadImg(`${base}/characters/char_${i}.png`))),
      // Furniture PNGs
      loadImg(`${base}/furniture/DESK_FRONT.png`),
      loadImg(`${base}/furniture/PC_FRONT_OFF.png`),
      loadImg(`${base}/furniture/PC_FRONT_ON_1.png`),
      loadImg(`${base}/furniture/PC_FRONT_ON_2.png`),
      loadImg(`${base}/furniture/PC_FRONT_ON_3.png`),
      loadImg(`${base}/furniture/CUSHIONED_CHAIR_BACK.png`),
      loadImg(`${base}/furniture/PLANT.png`),
      loadImg(`${base}/furniture/DOUBLE_BOOKSHELF.png`),
      loadImg(`${base}/furniture/SOFA_BACK.png`),
      loadImg(`${base}/furniture/COFFEE_TABLE.png`),
      loadImg(`${base}/furniture/SOFA_FRONT.png`),
      loadImg(`${base}/furniture/LARGE_PLANT.png`),
      loadImg(`${base}/furniture/WHITEBOARD.png`),
      loadImg(`${base}/furniture/CLOCK.png`),
    ]);

    const furnImgs = {
      DESK_FRONT:           furnList[0],
      PC_FRONT_OFF:         furnList[1],
      PC_FRONT_ON_1:        furnList[2],
      PC_FRONT_ON_2:        furnList[3],
      PC_FRONT_ON_3:        furnList[4],
      CUSHIONED_CHAIR_BACK: furnList[5],
      PLANT:                furnList[6],
      DOUBLE_BOOKSHELF:     furnList[7],
      SOFA_BACK:            furnList[8],
      COFFEE_TABLE:         furnList[9],
      SOFA_FRONT:           furnList[10],
      LARGE_PLANT:          furnList[11],
      WHITEBOARD:           furnList[12],
      CLOCK:                furnList[13],
    };

    return { charImgs, furnImgs };
  }

  // ════════════════════════════════════════════════════════════
  // Build static furniture list (z-sorted, pixel-agents layout)
  // Each entry: { name, col, row, zYoverride, mirror }
  //   zYoverride — world-px depth for special sorting; null = auto (row*16 + imgH)
  // ════════════════════════════════════════════════════════════
  function buildFurnitureList() {
    const items = [];
    const add = (name, col, row, zYoverride, mirror) =>
      items.push({ name, col, row, zYoverride: zYoverride !== undefined ? zYoverride : null, mirror: !!mirror });

    // ── Trading floor (left room, cols 1–8) ──────────────────
    // BTC workstation — desk at (1,1): 3×2 tiles (48×32 px), bg=1
    add('DESK_FRONT', 1, 1);
    add('PC_FRONT_OFF', 2, 1, 1 * TILE_SIZE + 32 + 0.5); // on desktop, in front of desk
    add('CUSHIONED_CHAIR_BACK', 2, 3, (3 + 1) * TILE_SIZE + 1); // back chair in FRONT of character

    // ETH workstation — desk at (5,1)
    add('DESK_FRONT', 5, 1);
    add('PC_FRONT_OFF', 6, 1, 1 * TILE_SIZE + 32 + 0.5);
    add('CUSHIONED_CHAIR_BACK', 6, 3, (3 + 1) * TILE_SIZE + 1);

    // SOL workstation — desk at (1,6)
    add('DESK_FRONT', 1, 6);
    add('PC_FRONT_OFF', 2, 6, 6 * TILE_SIZE + 32 + 0.5);
    add('CUSHIONED_CHAIR_BACK', 2, 8, (8 + 1) * TILE_SIZE + 1);

    // BNB workstation — desk at (5,6)
    add('DESK_FRONT', 5, 6);
    add('PC_FRONT_OFF', 6, 6, 6 * TILE_SIZE + 32 + 0.5);
    add('CUSHIONED_CHAIR_BACK', 6, 8, (8 + 1) * TILE_SIZE + 1);

    // Decorative plants near the divider wall
    add('PLANT', 8, 1);
    add('PLANT', 8, 6);

    // ── Lounge (right room, cols 10–18) ──────────────────────
    add('DOUBLE_BOOKSHELF', 10, 1);
    add('WHITEBOARD',       15, 1);
    add('CLOCK',            17, 1, 1 * TILE_SIZE + 16);
    add('SOFA_BACK',        13, 2);
    add('COFFEE_TABLE',     13, 3);
    add('SOFA_FRONT',       13, 6);
    add('LARGE_PLANT',      17, 7);
    add('PLANT',            18, 1);

    // ── AI Lab (lower floor) — chairs only, no desks ─────────
    // Front row at row 12, back row at row 16, chairs at even cols 2–14
    const labChairCols = [2, 4, 6, 8, 10, 12, 14];
    for (const c of labChairCols) {
      add('CUSHIONED_CHAIR_BACK', c, 12, (12 + 1) * TILE_SIZE + 1);
      add('CUSHIONED_CHAIR_BACK', c, 16, (16 + 1) * TILE_SIZE + 1);
    }

    return items;
  }

  // ════════════════════════════════════════════════════════════
  // Rendering  (pixel-agents/src/office/engine/renderer.ts)
  // ════════════════════════════════════════════════════════════

  const WALL_COLOR          = '#3A3A5C';
  const FLOOR_TRADING_COLOR = '#3a2e1e'; // warm wood — upper-left room
  const FLOOR_LOUNGE_COLOR  = '#242f30'; // cool slate — upper-right room
  const FLOOR_LAB_COLOR     = '#1e293a'; // deep navy  — AI Lab (lower)

  function isLounge(col) { return col >= 10; }
  function isLab(row) { return row >= 11; }

  /**
   * Full frame render with z-sorting.
   * Ported from renderFrame() + renderScene() + renderTileGrid() in renderer.ts.
   */
  function renderFrame(ctx, cW, cH, tileMap, furnitureList, characters, assets, zoom, pcOnName, activeIds) {
    const s  = TILE_SIZE * zoom;
    const mW = COLS * s;
    const mH = ROWS * s;
    const ox = Math.floor((cW - mW) / 2);
    const oy = Math.floor((cH - mH) / 2);

    // Clear
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, cW, cH);

    // Floor + wall tiles
    ctx.imageSmoothingEnabled = false;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const t = tileMap[r][c];
        ctx.fillStyle = t === W ? WALL_COLOR
          : (isLab(r) ? FLOOR_LAB_COLOR
            : (isLounge(c) ? FLOOR_LOUNGE_COLOR : FLOOR_TRADING_COLOR));
        ctx.fillRect(ox + c * s, oy + r * s, s, s);
      }
    }

    // ── Build z-sorted drawable list ─────────────────────────
    const drawables = [];

    // Furniture
    for (const item of furnitureList) {
      // PCs: swap to ON frame when the owner agent is active
      let imgName = item.name;
      if (item.name === 'PC_FRONT_OFF') {
        const pc = PC_ITEMS.find(p => p.col === item.col && p.row === item.row);
        if (pc && activeIds.has(pc.charId)) imgName = pcOnName;
      }

      const img = assets.furnImgs[imgName];
      if (!img) continue;

      const fw = img.naturalWidth  * zoom;
      const fh = img.naturalHeight * zoom;
      const fx = ox + item.col * s;
      const fy = oy + item.row * s;

      // zY: override wins; default = bottom of sprite in world px
      const zY = item.zYoverride !== null
        ? item.zYoverride
        : item.row * TILE_SIZE + img.naturalHeight;

      const im = img, x = fx, y = fy, w = fw, h = fh;
      if (item.mirror) {
        drawables.push({ zY, draw(c) {
          c.save(); c.translate(x + w, y); c.scale(-1, 1);
          c.drawImage(im, 0, 0, w, h); c.restore();
        }});
      } else {
        drawables.push({ zY, draw(c) { c.drawImage(im, x, y, w, h); } });
      }
    }

    // Characters  (pixel-agents getCharacterSprite + character anchor logic)
    for (const ch of characters) {
      const img = assets.charImgs[ch.palette];
      if (!img) continue;

      // Sprite frame index in sheet  (0–6)
      let spriteFrame;
      if (ch.state === CS.TYPE) {
        spriteFrame = 3 + (ch.frame % 2);      // typing: 3 or 4
      } else if (ch.state === CS.WALK) {
        spriteFrame = WALK_FRAME_IDX[ch.frame % 4]; // walk: 0,1,2,1
      } else {
        spriteFrame = 1;                         // idle: walk frame 1
      }

      // Direction row in sprite sheet + horizontal flip flag
      const flipH = ch.dir === Dir.LEFT;
      const dirRow = ch.dir === Dir.DOWN ? 0 : ch.dir === Dir.UP ? 1 : 2;

      const srcX = spriteFrame * 16;
      const srcY = dirRow * 32;

      // Bottom-center anchor; shift down by sit offset when seated
      const sitOff = ch.state === CS.TYPE ? CHAR_SIT_OFFSET : 0;
      const drawX  = Math.round(ox + ch.x * zoom - 8 * zoom);
      const drawY  = Math.round(oy + (ch.y + sitOff) * zoom - 32 * zoom);

      // Z depth key  (matches pixel-agents charZY)
      const charZY = ch.y + TILE_SIZE / 2 + CHAR_Z_OFFSET;

      const im = img, sx = srcX, sy = srcY, dx = drawX, dy = drawY, z = zoom;
      if (flipH) {
        drawables.push({ zY: charZY, draw(c) {
          c.save(); c.translate(dx + 16 * z, dy); c.scale(-1, 1);
          c.drawImage(im, sx, sy, 16, 32, 0, 0, 16 * z, 32 * z); c.restore();
        }});
      } else {
        drawables.push({ zY: charZY, draw(c) {
          c.drawImage(im, sx, sy, 16, 32, dx, dy, 16 * z, 32 * z);
        }});
      }
    }

    // Sort by depth (lower zY = drawn first = further back)
    drawables.sort((a, b) => a.zY - b.zY);
    ctx.imageSmoothingEnabled = false;
    for (const d of drawables) d.draw(ctx);

    // ── Labels + status badges (always on top) ───────────────
    ctx.imageSmoothingEnabled = true;
    const fontSize = Math.max(9, zoom * 4);
    ctx.font = `bold ${fontSize}px "Courier New", monospace`;
    ctx.textAlign = 'center';

    for (const ch of characters) {
      const def = AGENTS.find(a => a.id === ch.id);
      if (!def) continue;

      const sitOff = ch.state === CS.TYPE ? CHAR_SIT_OFFSET : 0;
      const lx = Math.round(ox + ch.x * zoom);
      const ly = Math.round(oy + (ch.y + sitOff) * zoom - 32 * zoom - zoom);

      const label = def.label;
      const tw    = ctx.measureText(label).width + zoom * 4;
      const th    = fontSize + zoom * 2;

      let bgColor, textColor;
      if (ch.isActive) {
        bgColor   = ch.currentSide === 'SHORT' ? 'rgba(220,60,60,0.88)' : 'rgba(34,160,70,0.88)';
        textColor = '#fff';
      } else {
        bgColor   = 'rgba(30,30,50,0.75)';
        textColor = '#999';
      }

      // Badge
      ctx.fillStyle = bgColor;
      const bx = lx - tw / 2, by = ly - th;
      fillRoundRect(ctx, bx, by, tw, th, Math.max(2, zoom));

      ctx.fillStyle = textColor;
      ctx.fillText(label, lx, by + th - zoom);

      // LONG / SHORT indicator above badge
      if (ch.isActive && ch.currentSide) {
        ctx.font = `bold ${Math.max(7, zoom * 3)}px "Courier New", monospace`;
        ctx.fillStyle = ch.currentSide === 'SHORT' ? '#ff9999' : '#88ffaa';
        ctx.fillText(ch.currentSide, lx, by - zoom);
        ctx.font = `bold ${fontSize}px "Courier New", monospace`;
      }
    }
  }

  /** Cross-browser rounded rectangle fill helper */
  function fillRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, r);
    } else {
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }
    ctx.fill();
  }

  // ════════════════════════════════════════════════════════════
  // TradingFloor controller
  // ════════════════════════════════════════════════════════════

  class TradingFloor {
    constructor(container) {
      this.container     = container;
      // Canvas mounts inside #trading-floor-canvas-wrap if present, else container
      this.canvasMount   = container.querySelector('#trading-floor-canvas-wrap') || container;
      this.listEl        = document.getElementById('trading-floor-agent-list');
      this.logEl         = document.getElementById('trading-floor-log');
      this.canvas        = null;
      this.running       = false;
      this.rafId         = null;
      this.lastTime      = 0;
      this.apiTimer      = 0;
      this.agentStatsTimer = 0;
      this._agentStats   = {};
      this.pcAnimTimer   = 0;
      this.pcFrame       = 0;       // 0–2 → PC_FRONT_ON_1/2/3
      this.coordTimer    = 8;   // first scan ~8s after init
      this.listTimer     = 0;
      this.tileMap       = buildTileMap();
      this.blocked       = new Set(STATIC_BLOCKED);
      this.walkable      = [];
      this.characters    = [];
      this.furnitureList = buildFurnitureList();
      this.assets        = null;
      this.zoom          = 3;
      this.logLimit      = 80;

      const clearBtn = document.getElementById('trading-floor-log-clear');
      if (clearBtn) clearBtn.addEventListener('click', () => {
        if (this.logEl) this.logEl.innerHTML = '';
      });

      const cmdForm = document.getElementById('trading-floor-cmd-form');
      const cmdInput = document.getElementById('trading-floor-cmd');
      if (cmdForm && cmdInput) {
        cmdForm.addEventListener('submit', (e) => {
          e.preventDefault();
          const text = cmdInput.value.trim();
          if (!text) return;
          this._handleCommand(text);
          cmdInput.value = '';
        });
      }
    }

    // ── User commands ──────────────────────────────────────────
    _handleCommand(text) {
      this._log('user', 'YOU', text);

      // Slash-commands run an action instead of dispatching to agents
      const trimmed = text.trim();
      if (/^\/sweep\b/i.test(trimmed)) { this._runSweep(); return; }
      if (/^\/board\b/i.test(trimmed)) { this._reportStrategyBoard(); return; }
      if (/^\/scan\b/i.test(trimmed))  { this._runCoordScan();        return; }
      if (/^\/help\b/i.test(trimmed)) {
        this._log('coord', 'COORD',
          'commands: /scan (audit live bot), /board (strategy WR), /sweep (run backtest). Or address an agent: BTC … / COORD … / ALL …');
        return;
      }

      // Parse: first token is target agent (BTC/ETH/SOL/BNB/COORD/CODER/ALL)
      const parts = text.split(/\s+/);
      const head = parts[0].toUpperCase();
      const rest = parts.slice(1).join(' ').trim();

      // Aliases → agent label
      const aliasMap = {
        BTC: 'BTC', BTCUSDT: 'BTC',
        ETH: 'ETH', ETHUSDT: 'ETH',
        SOL: 'SOL', SOLUSDT: 'SOL',
        BNB: 'BNB', BNBUSDT: 'BNB',
        COORD: 'COORD', COORDINATOR: 'COORD',
        CODER: 'CODER', DEV: 'CODER',
        ALL: 'ALL', TEAM: 'ALL', EVERYONE: 'ALL',
      };

      const target = aliasMap[head];
      const directive = target ? rest : text;

      if (!target) {
        // No prefix: COORD broadcasts to traders
        this._dispatchTo('COORD', `relayed: "${directive}"`);
        for (const t of ['BTC', 'ETH', 'SOL', 'BNB']) {
          setTimeout(() => this._dispatchTo(t, `acknowledged — ${this._shortAck(directive)}`), 400 + Math.random() * 800);
        }
        return;
      }

      if (target === 'ALL') {
        for (const t of ['BTC', 'ETH', 'SOL', 'BNB', 'COORD', 'CODER']) {
          setTimeout(() => this._dispatchTo(t, `roger — ${this._shortAck(directive || text)}`), 200 + Math.random() * 1000);
        }
        return;
      }

      const ack = directive
        ? `${this._shortAck(directive)}`
        : 'standing by';
      setTimeout(() => this._dispatchTo(target, ack), 250 + Math.random() * 600);
    }

    _shortAck(s) {
      if (!s) return 'standing by';
      const trimmed = s.length > 80 ? s.slice(0, 77) + '…' : s;
      return trimmed;
    }

    _dispatchTo(label, msg) {
      const def = AGENTS.find(a => a.label === label);
      if (!def) return;
      const kind = def.role === 'coordinator' ? 'coord'
        : def.role === 'coder' ? 'coder'
        : 'trade';
      this._log(kind, label, msg);
    }

    // ── COORD: real SMC scan via /api/admin/coord/scan ──────────
    async _runCoordScan() {
      try {
        const res = await fetch('/api/admin/coord/scan', { credentials: 'include' });
        if (!res.ok) {
          let detail = '';
          try { const body = await res.json(); detail = body.error ? ` — ${body.error}` : ''; } catch (_) {}
          this._log('coord', 'COORD', `scan failed (HTTP ${res.status})${detail}`);
          return;
        }
        const data = await res.json();
        if (!data || !Array.isArray(data.results)) return;

        if (data.botAlive === false) {
          this._log('coord', 'COORD', 'live bot is silent — no scan logs in the last 15m. Cycle may be paused.');
          return;
        }

        for (const r of data.results) {
          const sym = r.symbol.replace('USDT', '');
          const tradeNote = r.inOpenTrade ? ' — in open trade'
            : r.trades > 0 ? ' — closed earlier this hour'
            : '';
          if (r.missed) {
            const sample = r.recentSignalSample ? ` ("${r.recentSignalSample}")` : '';
            this._log('coord', 'COORD',
              `MISSED ${sym}: ${r.recentSignals} signal(s) in last 15m, no trade${tradeNote}.${sample}`);
            continue;
          }
          if (r.lastLog) {
            const t = new Date(r.lastLog.ts);
            const ago = Math.max(0, Math.round((Date.now() - t.getTime()) / 1000));
            this._log('coord', 'COORD',
              `${sym}: [${r.lastLog.category}] ${r.lastLog.message} (${ago}s ago)${tradeNote}.`);
          } else {
            this._log('coord', 'COORD', `${sym}: bot has not logged in 15m${tradeNote}.`);
          }
        }

        // Every 4th scan (~2 min), surface a strategy board snapshot
        this._scanCount = (this._scanCount || 0) + 1;
        if (this._scanCount % 4 === 1) {
          await this._reportStrategyBoard();
        }
      } catch (e) {
        this._log('coord', 'COORD', `scan exception: ${e.message}`);
      }
    }

    // ── COORD: live WR per combo + optimizer status ─────────────
    async _reportStrategyBoard() {
      try {
        const res = await fetch('/api/admin/coord/strategy-board', { credentials: 'include' });
        if (!res.ok) return;
        const d = await res.json();
        if (!d.ok) return;
        if (d.active) {
          const wr = (d.active.emaWr || d.active.wr || 0) * 100;
          this._log('coord', 'COORD',
            `active strategy: ${d.active.name} — ${wr.toFixed(1)}% WR over ${d.active.trades} trades, avg ${(d.active.avgPnl * 100).toFixed(2)}%/trade.`);
        } else {
          this._log('coord', 'COORD', 'no active strategy combo recorded yet.');
        }
        const top = d.topByLiveWR && d.topByLiveWR[0];
        if (top && d.active && top.id !== d.active.id && top.trades >= 10) {
          const wrPct = (top.wr * 100).toFixed(1);
          const fastTrackHit = top.wr >= 0.80 && top.trades >= 20 && (top.wr - (d.active.emaWr || d.active.wr || 0)) >= 0.05;
          const note = fastTrackHit
            ? ' — FAST-TRACK eligible, will auto-activate on next eval cycle.'
            : top.wr >= 0.75
              ? ' — closing in on the 80% auto-activate threshold.'
              : ' Run /sweep to backtest fresh params.';
          this._log('coord', 'COORD', `contender: ${top.name} — ${wrPct}% WR over ${top.trades} trades.${note}`);
        }
        if (d.explorationProgress) {
          const ep = d.explorationProgress;
          this._log('coord', 'COORD', `phase=${d.currentPhase} | ${ep.explored}/${ep.total} combos explored.`);
        }
        if (d.optimizer && d.optimizer.isRunning) {
          this._log('coder', 'CODER', `backtest running — ${d.optimizer.lastTask?.description || 'in progress'}.`);
        }
      } catch (_) { /* silent */ }
    }

    // ── CODER: run a backtest sweep on demand ───────────────────
    async _runSweep() {
      this._log('coder', 'CODER', 'launching backtest sweep…');
      try {
        const res = await fetch('/api/admin/coord/run-sweep', { method: 'POST', credentials: 'include' });
        const out = await res.json().catch(() => ({}));
        if (res.ok && out.started) {
          this._log('coder', 'CODER', `sweep #${out.runIdx} started — results will appear in 1-3 min.`);
        } else if (out.error === 'already_running') {
          this._log('coder', 'CODER', `sweep already running — ${out.task?.description || 'standby'}.`);
        } else {
          this._log('coder', 'CODER', `sweep failed: ${out.error || res.status}`);
        }
      } catch (e) {
        this._log('coder', 'CODER', `sweep exception: ${e.message}`);
      }
    }

    async init() {
      // Create canvas
      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText =
        'display:block;image-rendering:pixelated;image-rendering:crisp-edges;';
      this.canvasMount.innerHTML = '';
      this.canvasMount.appendChild(this.canvas);

      // Load all PNG assets
      this.assets = await loadAllAssets();

      // Fit zoom to container
      this._calcZoom();

      // Compute walkable tiles (after furniture blocks applied)
      this.walkable = getWalkableTiles(this.tileMap, this.blocked);

      // Spawn one character per agent
      for (const def of AGENTS) {
        const seat = SEATS.get(def.seatId);
        if (seat) seat.assigned = true;
        const ch = createCharacter(def.id, def.palette, def.seatId, seat || null);
        this.characters.push(ch);
      }

      // Initial position fetch (fire-and-forget — rendering starts immediately)
      this._fetchPositions();

      // Seed sidebar
      this._renderAgentList();
      this._log('coord', 'COORD', 'Trading floor online — auditing live bot decisions…');
      this._log('coder', 'CODER', 'standing by — manual tunes only, no auto-adjustment.');
      this._runCoordScan();

      return this;
    }

    _calcZoom() {
      const cw = this.canvasMount.clientWidth  || 800;
      const ch = this.canvasMount.clientHeight || 480;
      const maxW = Math.floor(cw / (COLS * TILE_SIZE));
      const maxH = Math.floor(ch / (ROWS * TILE_SIZE));
      this.zoom = Math.max(2, Math.min(4, Math.min(maxW, maxH)));
      this.canvas.width  = Math.max(COLS * TILE_SIZE * this.zoom, cw);
      this.canvas.height = Math.max(ROWS * TILE_SIZE * this.zoom, ch);
    }

    async _fetchAgentStats() {
      // Pull RPG (level, totalEarned) + Survival (totalLosses-pnl) for each agent.
      // /api/admin/agents/health returns { agents: [{ key, name, health: {rpg:{...}, survival:{...}} }] }
      try {
        const res = await fetch('/api/admin/agents/health', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        const agentsArr = Array.isArray(data?.agents) ? data.agents : (data?.health?.agents || []);
        if (!agentsArr.length) return;

        // Index by both lower-case key (system agents) and symbol (token agents)
        this._agentStats = {};
        for (const a of agentsArr) {
          const rpg  = a.health?.rpg  || a.rpg  || {};
          const surv = a.health?.survival || a.survival || {};
          const stats = {
            level:    rpg.level    || 1,
            earned:   Number(rpg.totalEarned || 0),
            // "lost" = absolute USD lost on losing trades (sum of negative PnL)
            // Survival doesn't break this out, so use grossLossesPnl from agent_trade_history
            // when available, falling back to a derived |totalRevenue - totalEarned| only if both
            // are present.  For the floor, show the simple totalLossesPnl from the per-agent
            // trade-history endpoint (fetched separately below).
            totalTrades: surv.totalTrades || 0,
            wins:     surv.totalWins   || 0,
            losses:   surv.totalLosses || 0,
            capital:  surv.capital     || 0,
          };
          if (a.key)  this._agentStats[a.key] = stats;
          if (a.name) this._agentStats[a.name] = stats;
        }

        // Fetch per-agent revenue summary for accurate "lost" $ figure
        try {
          const rev = await fetch('/api/admin/agents/revenue-summary', { credentials: 'include' });
          if (rev.ok) {
            const rdata = await rev.json();
            const rrows = Array.isArray(rdata?.agents) ? rdata.agents : [];
            for (const r of rrows) {
              const key = r.agent;
              if (!this._agentStats[key]) this._agentStats[key] = { level: 1, earned: 0, totalTrades: 0, wins: 0, losses: 0, capital: 0 };
              this._agentStats[key].lossDollars = Math.abs(Number(r.total_losses_pnl || 0));
              this._agentStats[key].winDollars  = Number(r.total_wins_pnl || 0);
            }
          }
        } catch (_) { /* revenue summary is optional */ }
      } catch (_) { /* keep last-known stats on error */ }
    }

    async _fetchPositions() {
      try {
        const res = await fetch('/api/admin/open-positions', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();

        const posMap = {};
        if (Array.isArray(data)) {
          for (const p of data) posMap[p.symbol] = p;
        }

        for (const ch of this.characters) {
          const def = AGENTS.find(a => a.id === ch.id);
          if (!def || def.role !== 'trader') continue; // coord/coder are always active
          const pos = def.symbol ? posMap[def.symbol] : null;
          const wasActive = ch.isActive;
          const wasSide   = ch.currentSide;
          ch.isActive    = !!pos;
          ch.currentSide = pos ? (pos.side || pos.positionSide || null) : null;

          // Sentinel -1: "just became inactive" — skip the long seat rest
          if (wasActive && !ch.isActive) {
            ch.seatTimer    = -1;
            ch.path         = [];
            ch.moveProgress = 0;
            this._log('trade', def.label, `closed ${wasSide || 'position'}`);
          } else if (!wasActive && ch.isActive) {
            this._log('trade', def.label, `opened ${ch.currentSide || 'position'}`);
          } else if (wasActive && ch.isActive && wasSide !== ch.currentSide && ch.currentSide) {
            this._log('trade', def.label, `flipped to ${ch.currentSide}`);
          }
        }
      } catch (_) { /* keep current state on network error */ }
    }

    start() {
      if (this.running) return this;
      this.running  = true;
      this.lastTime = 0;
      this._tick();
      return this;
    }

    stop() {
      this.running = false;
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    _tick() {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(ts => {
        const dt = this.lastTime === 0 ? 0
          : Math.min((ts - this.lastTime) / 1000, MAX_DT);
        this.lastTime = ts;
        this._update(dt);
        this._draw();
        this._tick();
      });
    }

    _update(dt) {
      // API poll every 5 s
      this.apiTimer -= dt;
      if (this.apiTimer <= 0) {
        this.apiTimer = 5;
        this._fetchPositions();
      }

      // Agent stats poll every 15 s (level / earned / lost)
      this.agentStatsTimer -= dt;
      if (this.agentStatsTimer <= 0) {
        this.agentStatsTimer = 15;
        this._fetchAgentStats();
      }

      // PC animation: cycle 3 ON frames at ~5 fps
      this.pcAnimTimer += dt;
      if (this.pcAnimTimer >= 0.2) {
        this.pcAnimTimer -= 0.2;
        this.pcFrame = (this.pcFrame + 1) % 3;
      }

      // COORD: real SMC scan every ~30s (CODER reacts inside the scan handler)
      this.coordTimer -= dt;
      if (this.coordTimer <= 0) {
        this.coordTimer = 30;
        this._runCoordScan();
      }

      // Refresh sidebar status ~2 Hz
      this.listTimer -= dt;
      if (this.listTimer <= 0) {
        this.listTimer = 0.5;
        this._renderAgentList();
      }

      // Character FSM updates
      for (const ch of this.characters) {
        updateWithSeatUnblocked(ch, dt, this.walkable, this.tileMap, this.blocked);
      }
    }

    // ── Sidebar: agent list ─────────────────────────────────────
    _renderAgentList() {
      if (!this.listEl) return;
      // Build only once; afterwards just patch dynamic nodes
      if (this.listEl.children.length !== AGENTS.length) {
        this.listEl.innerHTML = '';
        for (const def of AGENTS) {
          const meta = ROLE_META[def.role] || ROLE_META.trader;
          const li = document.createElement('li');
          li.dataset.aid = def.id;
          li.style.cssText = 'display:grid;grid-template-columns:auto auto 1fr auto;align-items:center;gap:6px 8px;padding:6px 8px;border:1px solid var(--color-border-muted);border-radius:6px;background:var(--color-bg);';
          li.innerHTML =
            '<span class="tf-dot" style="width:8px;height:8px;border-radius:50%;background:#555;flex-shrink:0;"></span>' +
            '<span style="font-weight:700;color:' + meta.color + ';min-width:54px;">' + def.label + '</span>' +
            '<span style="color:var(--color-text-muted);font-size:0.7rem;">' + meta.title + '</span>' +
            '<span class="tf-state" style="font-size:0.65rem;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.05em;justify-self:end;">--</span>' +
            '<span class="tf-stats" style="grid-column:1 / -1;display:flex;gap:10px;font-size:0.65rem;color:var(--color-text-muted);padding-left:14px;">' +
              '<span class="tf-lvl">Lv.--</span>' +
              '<span class="tf-earned" style="color:#4ade80;">+$0</span>' +
              '<span class="tf-lost" style="color:#f87171;">-$0</span>' +
              '<span class="tf-wl">0W/0L</span>' +
            '</span>';
          this.listEl.appendChild(li);
        }
      }
      for (const ch of this.characters) {
        const def = AGENTS.find(a => a.id === ch.id);
        if (!def) continue;
        const li = this.listEl.querySelector('li[data-aid="' + def.id + '"]');
        if (!li) continue;
        const dot = li.querySelector('.tf-dot');
        const stateEl = li.querySelector('.tf-state');
        let label, color;
        if (def.role !== 'trader') {
          label = ROLE_LABEL[def.role] || 'idle';
          color = ROLE_META[def.role].color;
        } else if (ch.isActive) {
          label = ch.currentSide || 'active';
          color = ch.currentSide === 'SHORT' ? '#f87171' : '#4ade80';
        } else {
          label = ch.state === CS.WALK ? 'walking' : (ch.state === CS.TYPE ? 'idle' : 'idle');
          color = '#6b7280';
        }
        if (dot) dot.style.background = color;
        if (stateEl) stateEl.textContent = label;

        // Patch stats line — agent stats keyed by name (BTCAgent / ChartAgent / etc)
        // Token agents name-format from coordinator: '<sym lower no usdt>' e.g. 'btc'
        // The /api/admin/agents/health response uses both `key` (lowercased sym) and `name`.
        const statsKey = def.symbol
          ? def.label.toLowerCase()                 // e.g. 'btc'
          : (ROLE_TO_NAME[def.role] || def.label);
        const stats = this._agentStats[statsKey]
                   || this._agentStats[def.label + 'Agent']
                   || this._agentStats[def.label];
        const lvlEl    = li.querySelector('.tf-lvl');
        const earnedEl = li.querySelector('.tf-earned');
        const lostEl   = li.querySelector('.tf-lost');
        const wlEl     = li.querySelector('.tf-wl');
        if (stats) {
          if (lvlEl)    lvlEl.textContent    = 'Lv.' + stats.level;
          if (earnedEl) earnedEl.textContent = '+$' + (stats.winDollars ?? stats.earned ?? 0).toFixed(2);
          if (lostEl)   lostEl.textContent   = '-$' + (stats.lossDollars ?? 0).toFixed(2);
          if (wlEl)     wlEl.textContent     = (stats.wins || 0) + 'W/' + (stats.losses || 0) + 'L';
        }
      }
    }

    // ── Sidebar: activity log ───────────────────────────────────
    _log(kind, who, msg) {
      if (!this.logEl) return;
      const colorByKind = {
        coord: '#fbbf24',
        coder: '#a78bfa',
        trade: '#4ade80',
        user:  '#38bdf8',
      };
      const c = colorByKind[kind] || 'var(--color-text)';
      const t = new Date();
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      const ss = String(t.getSeconds()).padStart(2, '0');
      const row = document.createElement('div');
      row.style.cssText = 'padding:2px 0;border-bottom:1px dashed rgba(255,255,255,0.04);';
      row.innerHTML =
        '<span style="color:var(--color-text-muted);">[' + hh + ':' + mm + ':' + ss + ']</span> ' +
        '<span style="color:' + c + ';font-weight:700;">' + escapeHtml(who) + '</span> ' +
        '<span>' + escapeHtml(msg) + '</span>';
      // Most recent at top
      this.logEl.insertBefore(row, this.logEl.firstChild);
      while (this.logEl.children.length > this.logLimit) {
        this.logEl.removeChild(this.logEl.lastChild);
      }
      this.logEl.scrollTop = 0;
    }

    _draw() {
      if (!this.assets) return;
      const ctx      = this.canvas.getContext('2d');
      const pcNames  = ['PC_FRONT_ON_1', 'PC_FRONT_ON_2', 'PC_FRONT_ON_3'];
      const pcOnName = pcNames[this.pcFrame];
      const activeIds = new Set(this.characters.filter(c => c.isActive).map(c => c.id));

      renderFrame(
        ctx,
        this.canvas.width, this.canvas.height,
        this.tileMap,
        this.furnitureList,
        this.characters,
        this.assets,
        this.zoom,
        pcOnName,
        activeIds,
      );
    }
  }

  // ════════════════════════════════════════════════════════════
  // Public API  (called from app.js switchTab handler)
  // ════════════════════════════════════════════════════════════

  window.TradingFloor = {
    init() {
      const container = document.getElementById('trading-floor-container');
      if (!container) return null;
      // Reuse existing instance if already created
      if (window._tradingFloor) {
        window._tradingFloor.start();
        return window._tradingFloor;
      }
      const floor = new TradingFloor(container);
      floor.init().then(() => {
        floor.start();
        window._tradingFloor = floor;
      });
      return floor;
    },
  };

})();
