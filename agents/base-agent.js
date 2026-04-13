// ============================================================
// BaseAgent — Foundation class for all trading agents
//
// Provides: lifecycle management, structured logging, state,
//           inter-agent messaging, and health monitoring.
// ============================================================

const { log: bLog } = require('../bot-logger');
const { think, isAvailable, getSystemPrompt } = require('./ai-brain');
const hermes = require('../hermes-bridge');

const AGENT_STATES = {
  IDLE:     'idle',
  RUNNING:  'running',
  ERROR:    'error',
  STOPPED:  'stopped',
  JAILED:   'jailed',
};

// Intelligence tiers — higher level = smarter behavior
const INTEL_TIERS = {
  ROOKIE:  { min: 1,  max: 5,  label: 'Rookie',    xpMultiplier: 1.0, trustScore: 0.5 },
  SKILLED: { min: 6,  max: 15, label: 'Skilled',    xpMultiplier: 1.2, trustScore: 0.7 },
  EXPERT:  { min: 16, max: 30, label: 'Expert',     xpMultiplier: 1.5, trustScore: 0.85 },
  MASTER:  { min: 31, max: 50, label: 'Master',     xpMultiplier: 2.0, trustScore: 0.95 },
  LEGEND:  { min: 51, max: 999, label: 'Legend',     xpMultiplier: 3.0, trustScore: 1.0 },
};

// Personality traits that evolve with level
const PERSONALITY_TRAITS = [
  'cautious', 'aggressive', 'analytical', 'intuitive', 'methodical', 'creative',
];

const MOODS = ['focused', 'confident', 'anxious', 'determined', 'competitive', 'reflective', 'ambitious'];

class BaseAgent {
  constructor(name, options = {}) {
    this.name = name;
    this.state = AGENT_STATES.IDLE;
    this.lastRunAt = null;
    this.lastError = null;
    this.runCount = 0;
    this.options = options;
    this.paused = false;
    this.currentTask = null; // { description, startedAt }
    this.managedByCoordinator = false; // when true, coordinator controls state lifecycle

    // Profile — subclasses override via defineProfile()
    this._profile = {
      description: '',
      role: '',
      icon: '',
      skills: [],    // [{ id, name, description, enabled }]
      config: [],    // [{ key, label, type, value, min, max, options }]
    };

    // Inbox for inter-agent messages
    this._inbox = [];

    // Activity feed — rolling log of recent actions
    this._activity = [];
    this._maxActivity = 200;

    // Event listeners: { eventName: [fn, ...] }
    this._listeners = {};

    // RPG profile — level, XP, earnings (loaded from DB on first access)
    this._rpg = { level: 1, xp: 0, totalEarned: 0, tasksCompleted: 0, tasksSuccess: 0, loaded: false, points: 0 };

    // ── Intelligence & Personality System ────────────────────
    this._personality = {
      trait: PERSONALITY_TRAITS[Math.floor(Math.random() * PERSONALITY_TRAITS.length)],
      mood: 'focused',
      ambition: 'Level up and outperform rivals',
      rivalry: null,           // agentName they compete with
      streakWins: 0,
      streakLosses: 0,
      bestStreak: 0,
      thoughts: [],            // recent inner thoughts
      lastThoughtAt: 0,
    };
    this._maxThoughts = 20;

    // Competition tracking
    this._competition = {
      rank: 0,
      weeklyXp: 0,
      weeklyEarnings: 0,
      weeklyTasks: 0,
      lastResetWeek: 0,
    };

    // ── Survival System — trade with $1000 virtual capital ──
    // Health: 100 max. Win +10, Lose -10. At 0 HP → agent dies (permanently disabled)
    // Capital: $1000 starting. Trade outcomes adjust this. At $0 → dead
    // Monthly target: 60% profit ($600 from $1000). Must hit or face penalty.
    this._survival = {
      health: 100,           // HP: 0-100
      isAlive: true,         // False = permanently killed
      capital: 1000,         // Virtual $1000 starting capital
      startCapital: 1000,    // Baseline for monthly % calc
      monthlyPnl: 0,         // This month's PnL in $
      monthStart: new Date().toISOString().slice(0, 7), // YYYY-MM
      totalTrades: 0,
      totalWins: 0,
      totalLosses: 0,
      killReason: null,      // Why agent was killed
      monthlyTarget: 0.60,   // 60% monthly target
      lastTradeAt: null,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async init() {
    await this._loadSurvival();
    // Always persist survival defaults on first boot so data survives restarts
    await this._saveSurvival();
    this.log('Initialized');
  }

  async run(context = {}) {
    // Dead agents cannot run
    if (!this._survival.isAlive) {
      return null;
    }
    // When managedByCoordinator is true, skip the "already running" guard
    // because the coordinator pre-sets state to 'running' for the full pipeline
    if (this.state === AGENT_STATES.RUNNING && !this.managedByCoordinator) {
      this.log('Already running — skipping');
      return null;
    }
    if (this.paused) {
      this.log('Paused — skipping');
      this.addActivity('skip', 'Skipped (paused)');
      return null;
    }

    this.state = AGENT_STATES.RUNNING;
    this.lastRunAt = Date.now();
    this.runCount++;
    this.currentTask = { description: 'Executing cycle', startedAt: Date.now() };

    try {
      const result = await this.execute(context);
      // Only reset to idle if coordinator isn't managing our state
      if (!this.managedByCoordinator) {
        this.state = AGENT_STATES.IDLE;
        this.currentTask = null;
      }
      this.addActivity('success', `Cycle #${this.runCount} complete`);
      // Save survival every 10 runs to persist state
      if (this.runCount % 10 === 0) this._saveSurvival().catch(() => {});
      return result;
    } catch (err) {
      this.state = AGENT_STATES.ERROR;
      this.lastError = { message: err.message, at: Date.now() };
      this.currentTask = null;
      this.addActivity('error', `Cycle #${this.runCount} failed: ${err.message}`);
      this.logError(`Execute failed: ${err.message}`);

      // Reactive Trigger: Notify coordinator/system of the crash
      this.emit('agent_crash', {
        agentName: this.name,
        error: err,
        timestamp: Date.now()
      });

      throw err;
    }
  }

  // Subclasses override this
  async execute(context) {
    throw new Error(`${this.name}: execute() not implemented`);
  }

  async shutdown() {
    this.state = AGENT_STATES.STOPPED;
    this.log('Shut down');
  }

  // ── Messaging ─────────────────────────────────────────────

  send(targetAgent, type, payload) {
    if (!targetAgent || typeof targetAgent.receive !== 'function') {
      this.logError(`Cannot send to invalid agent`);
      return;
    }
    targetAgent.receive({ from: this.name, type, payload, ts: Date.now() });
  }

  receive(message) {
    this._inbox.push(message);
    this.emit('message', message);
  }

  consumeMessages(type = null) {
    if (!type) {
      const msgs = [...this._inbox];
      this._inbox = [];
      return msgs;
    }
    const matched = this._inbox.filter(m => m.type === type);
    this._inbox = this._inbox.filter(m => m.type !== type);
    return matched;
  }

  // ── Events ────────────────────────────────────────────────

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }

  emit(event, data) {
    const fns = this._listeners[event] || [];
    for (const fn of fns) {
      try { fn(data); } catch (e) { this.logError(`Event ${event} handler error: ${e.message}`); }
    }
  }

  // ── Logging ───────────────────────────────────────────────

  log(msg) {
    const formatted = `[${this.name}] ${msg}`;
    console.log(`[${this._ts()}] ${formatted}`);
    bLog.system(formatted);
  }

  logTrade(msg) {
    const formatted = `[${this.name}] ${msg}`;
    console.log(`[${this._ts()}] ${formatted}`);
    bLog.trade(formatted);
  }

  logScan(msg) {
    const formatted = `[${this.name}] ${msg}`;
    console.log(`[${this._ts()}] ${formatted}`);
    bLog.scan(formatted);
  }

  logError(msg) {
    const formatted = `[${this.name}] ${msg}`;
    console.error(`[${this._ts()}] ERROR ${formatted}`);
    bLog.error(formatted);
  }

  // ── Activity Feed ──────────────────────────────────────────

  addActivity(type, message) {
    this._activity.push({ type, message, ts: Date.now() });
    if (this._activity.length > this._maxActivity) this._activity.shift();
  }

  getActivity(limit = 20) {
    return this._activity.slice(-limit);
  }

  // ── Profile & Skills ───────────────────────────────────────

  getProfile() {
    return { ...this._profile, name: this.name };
  }

  getConfig() {
    return this._profile.config.map(c => ({ ...c }));
  }

  updateConfig(changes) {
    // changes = { key: value, ... }
    for (const [key, value] of Object.entries(changes)) {
      const cfg = this._profile.config.find(c => c.key === key);
      if (cfg) {
        cfg.value = value;
        // Apply to options
        this.options[key] = value;
        // Apply to instance property if it exists
        if (this[key] !== undefined) this[key] = value;
        this.addActivity('config', `Config: ${cfg.label} → ${value}`);
      }
    }
  }

  toggleSkill(skillId, enabled) {
    const skill = this._profile.skills.find(s => s.id === skillId);
    if (skill) {
      skill.enabled = enabled;
      this.addActivity('config', `Skill ${skill.name}: ${enabled ? 'ON' : 'OFF'}`);
    }
  }

  isSkillEnabled(skillId) {
    const skill = this._profile.skills.find(s => s.id === skillId);
    return skill ? skill.enabled : false;
  }

  // ── Explain (agent answers questions about itself) ─────────

  async explain(question) {
    // Try AI brain first
    if (isAvailable()) {
      const context = {
        health: this.getHealth(),
        profile: this.getProfile(),
        recentActivity: this.getActivity(5),
      };
      // Add agent-specific context
      if (this._getAIContext) {
        Object.assign(context, await this._getAIContext());
      }

      // Inject Hermes memory + team memory + soul into system prompt
      const soul = this.getSoul();
      const agentMemory = this.getHermesMemoryPrompt();
      const teamMemory = hermes.getTeamMemoryPrompt();

      let enrichedPrompt = getSystemPrompt(this.name);
      if (soul) enrichedPrompt = `${soul}\n\n${enrichedPrompt}`;
      if (agentMemory) enrichedPrompt += `\n\n${agentMemory}`;
      if (teamMemory) enrichedPrompt += `\n\n${teamMemory}`;

      const aiResponse = await think({
        agentName: this.name,
        systemPrompt: enrichedPrompt,
        userMessage: question,
        context,
        complexity: 'medium',
      });
      if (aiResponse) return aiResponse;
    }

    // Fallback: hardcoded response
    const profile = this.getProfile();
    const skillList = profile.skills.map(s => `• **${s.name}** ${s.enabled ? '' : '(OFF)'} — ${s.description}`).join('\n');
    return `I'm **${this.name}** (${profile.role}). ${profile.description}\n\n**Skills:**\n${skillList}`;
  }

  // ── Hermes Integration ────────────────────────────────────

  /**
   * Add a persistent memory entry (Hermes-style § delimited file).
   * Complements DB memory — survives even without DB.
   */
  hermesRemember(entry) {
    return hermes.addMemory(this.name, entry);
  }

  /**
   * Read all Hermes memory entries for this agent.
   */
  hermesRecallAll() {
    return hermes.readMemory(this.name);
  }

  /**
   * Get Hermes memory formatted for system prompt injection.
   */
  getHermesMemoryPrompt() {
    return hermes.getMemoryPrompt(this.name);
  }

  /**
   * Share a learning with the whole team via shared memory.
   */
  shareWithTeam(entry) {
    return hermes.addTeamMemory(`[${this.name}] ${entry}`);
  }

  /**
   * Request CoderAgent to upgrade this agent's capabilities.
   * Any agent can call this when it identifies a gap in its skills.
   * @param {string} reason - Why the upgrade is needed
   * @param {string} suggestion - What to add or change
   */
  requestSelfUpgrade(reason, suggestion) {
    if (!this._coordinator?.coderAgent) return;
    this._coordinator.coderAgent.receive({
      from: this.name,
      type: 'upgrade-request',
      payload: {
        agent: this.name,
        reason,
        suggestion,
        level: this._rpg?.level || 1,
        health: this._survival?.health || 100,
        ts: Date.now(),
      },
      ts: Date.now(),
    });
    this.addActivity('info', `Requested upgrade: ${reason}`);
  }

  /**
   * Request to learn a new skill from online knowledge or AI.
   * Triggers StrategyAgent/CoderAgent to research and implement.
   * @param {string} skillTopic - What skill/knowledge to acquire
   */
  requestSkillInstall(skillTopic) {
    if (!this._coordinator) return;
    // Broadcast to team — whoever can help will pick it up
    const msg = {
      from: this.name,
      type: 'skill-request',
      payload: { topic: skillTopic, requestedBy: this.name, ts: Date.now() },
      ts: Date.now(),
    };
    if (this._coordinator.strategyAgent) this._coordinator.strategyAgent.receive(msg);
    if (this._coordinator.coderAgent) this._coordinator.coderAgent.receive(msg);
    this.addActivity('info', `Requested new skill: ${skillTopic}`);
    this.shareWithTeam(`${this.name} wants to learn: ${skillTopic}`);
  }

  /**
   * Self-reflect and identify improvement areas using AI brain.
   * Returns actionable insights about what this agent should improve.
   */
  async selfReflect() {
    if (!isAvailable()) return null;
    const health = this.getHealth();
    const survival = this._survival || {};
    const prompt = `You are ${this.name} (Level ${this._rpg?.level || 1}). Reflect on your performance and identify 2-3 specific improvements.

Current status:
- Health: ${survival.health || 100}/100 HP
- Capital: $${(survival.capital || 1000).toFixed(0)}
- Win/Loss: ${survival.totalWins || 0}/${survival.totalLosses || 0}
- Run count: ${this.runCount}
- State: ${this.state}
- Last error: ${this.lastError?.message || 'none'}

What specific changes would make you perform better? Be concrete — suggest parameter changes, new indicators, or strategy modifications.`;

    try {
      const response = await think({
        agentName: this.name,
        systemPrompt: getSystemPrompt(this.name),
        userMessage: prompt,
        context: {},
        complexity: 'low',
      });
      if (response) {
        this.addActivity('info', `Self-reflection: ${response.slice(0, 100)}...`);
        this.shareWithTeam(`[Reflection] ${response.slice(0, 150)}`);
      }
      return response;
    } catch {
      return null;
    }
  }

  /**
   * Generate TTS voice note for Telegram notifications.
   * @param {string} text - Text to speak
   * @param {object} opts - { voice }
   * @returns {Promise<{success: boolean, filePath?: string}>}
   */
  async speak(text, opts = {}) {
    return hermes.generateTTS(text, opts);
  }

  /**
   * Ask Hermes for deep reasoning on a complex question.
   * Runs as subprocess — use sparingly (slow, 30-90s).
   * @param {string} question
   * @returns {Promise<string|null>}
   */
  async askHermes(question) {
    return hermes.askHermes(question, { maxTurns: 2, quiet: true });
  }

  /**
   * Get the soul/personality context for this bot.
   */
  getSoul() {
    return hermes.loadSoul();
  }

  // ── Memory (DB-backed, survives restarts) ──────────────────

  async remember(key, value, category = 'general') {
    try {
      const { query } = require('../db');
      await query(
        `INSERT INTO agent_memory (agent, key, value, category, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (agent, key) DO UPDATE SET value = $3, category = $4, updated_at = NOW()`,
        [this.name, key, JSON.stringify(value), category]
      );
    } catch (e) {
      // Fallback to in-memory if DB unavailable
      if (!this._memoryCache) this._memoryCache = {};
      this._memoryCache[key] = value;
    }
  }

  async recall(key) {
    try {
      const { query } = require('../db');
      const rows = await query(
        'SELECT value FROM agent_memory WHERE agent = $1 AND key = $2',
        [this.name, key]
      );
      if (rows.length) return rows[0].value;
    } catch (e) {
      if (this._memoryCache && this._memoryCache[key] !== undefined) return this._memoryCache[key];
    }
    return null;
  }

  async recallAll(category = null) {
    try {
      const { query } = require('../db');
      const sql = category
        ? 'SELECT key, value, category, updated_at FROM agent_memory WHERE agent = $1 AND category = $2 ORDER BY updated_at DESC'
        : 'SELECT key, value, category, updated_at FROM agent_memory WHERE agent = $1 ORDER BY updated_at DESC';
      const params = category ? [this.name, category] : [this.name];
      return await query(sql, params);
    } catch { return []; }
  }

  async forget(key) {
    try {
      const { query } = require('../db');
      await query('DELETE FROM agent_memory WHERE agent = $1 AND key = $2', [this.name, key]);
    } catch {}
  }

  // ── Learning (tracks decisions → outcomes) ────────────────

  async learn(type, input, outcome, lesson, score = 0) {
    try {
      const { query } = require('../db');
      await query(
        `INSERT INTO agent_lessons (agent, type, input, outcome, lesson, score)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [this.name, type, JSON.stringify(input), JSON.stringify(outcome), lesson, score]
      );
      this.addActivity('learn', `Learned: ${lesson.substring(0, 60)}`);
    } catch {}
  }

  async getLessons(type = null, limit = 20) {
    try {
      const { query } = require('../db');
      const sql = type
        ? 'SELECT * FROM agent_lessons WHERE agent = $1 AND type = $2 ORDER BY created_at DESC LIMIT $3'
        : 'SELECT * FROM agent_lessons WHERE agent = $1 ORDER BY created_at DESC LIMIT $2';
      const params = type ? [this.name, type, limit] : [this.name, limit];
      return await query(sql, params);
    } catch { return []; }
  }

  async getBestLessons(type, limit = 5) {
    try {
      const { query } = require('../db');
      return await query(
        'SELECT * FROM agent_lessons WHERE agent = $1 AND type = $2 ORDER BY score DESC LIMIT $3',
        [this.name, type, limit]
      );
    } catch { return []; }
  }

  // ── RPG Level System ────────────────────────────────────────

  /** XP needed to reach a given level: level * 100 (cumulative: L*(L+1)/2 * 100) */
  static xpForLevel(level) { return level * 100; }

  /** Calculate level from total XP */
  static levelFromXp(totalXp) {
    let level = 1;
    let xpNeeded = 0;
    while (true) {
      xpNeeded += BaseAgent.xpForLevel(level);
      if (totalXp < xpNeeded) return level;
      level++;
      if (level > 100) return 100;
    }
  }

  /** XP progress within current level (0-1) */
  getXpProgress() {
    let consumed = 0;
    for (let l = 1; l < this._rpg.level; l++) consumed += BaseAgent.xpForLevel(l);
    const needed = BaseAgent.xpForLevel(this._rpg.level);
    const current = this._rpg.xp - consumed;
    return Math.min(1, Math.max(0, current / needed));
  }

  /** Load RPG profile from DB (called once) */
  async loadRpgProfile() {
    if (this._rpg.loaded) return;
    try {
      const { query } = require('../db');
      const rows = await query('SELECT * FROM agent_profiles WHERE agent = $1', [this.name]);
      if (rows.length > 0) {
        const r = rows[0];
        this._rpg.level = r.level;
        this._rpg.xp = r.xp;
        this._rpg.totalEarned = parseFloat(r.total_earned) || 0;
        this._rpg.tasksCompleted = r.tasks_completed;
        this._rpg.tasksSuccess = r.tasks_success;
        this._rpg.points = parseFloat(r.points) || 0;
      }
      this._rpg.loaded = true;
      this.log(`RPG loaded: Lv.${this._rpg.level} XP=${this._rpg.xp} Earned=$${this._rpg.totalEarned}`);
    } catch (err) {
      this._rpg.loaded = true;
      this.log(`RPG load failed: ${err.message}`);
    }
  }

  /** Save RPG profile to DB */
  async saveRpgProfile() {
    try {
      const { query } = require('../db');
      await query(`
        INSERT INTO agent_profiles (agent, level, xp, total_earned, tasks_completed, tasks_success, points, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (agent) DO UPDATE SET
          level = $2, xp = $3, total_earned = $4, tasks_completed = $5, tasks_success = $6, points = $7, updated_at = NOW()
      `, [this.name, this._rpg.level, this._rpg.xp, this._rpg.totalEarned, this._rpg.tasksCompleted, this._rpg.tasksSuccess, this._rpg.points]);
    } catch (err) {
      this.log(`RPG save failed: ${err.message}`);
    }
  }

  /** Adjust agent points based on trade outcome */
  async adjustPoints(amount) {
    await this.loadRpgProfile();
    this._rpg.points += amount;
    await this.saveRpgProfile();
    this.addActivity('economy', `Points adjusted: ${amount > 0 ? '+' : ''}${amount} (Total: ${this._rpg.points})`);
  }

  /** Update prestige tier based on points */
  updateTier() {
    const pts = this._rpg.points;
    let tier = 'Bronze';
    if (pts >= 5001) tier = 'Legend';
    else if (pts >= 2001) tier = 'Diamond';
    else if (pts >= 501) tier = 'Gold';
    else if (pts >= 101) tier = 'Silver';

    this._profile.tier = tier;
    return tier;
  }

  /** Get point-based influence multiplier (buff) */
  async getPrestigeBuff() {
    const tier = this.updateTier();
    const buffs = { 'Legend': 1.5, 'Diamond': 1.3, 'Gold': 1.2, 'Silver': 1.1, 'Bronze': 1.0 };


    // Check for monthly trophy buff
    let finalBuff = buffs[tier] || 1.0;
    try {
      const { query } = require('../db');
      const trophies = await query(
        'SELECT buff_multiplier FROM agent_trophies WHERE agent = $1 AND month = to_char(NOW(), \'Mon YYYY\')',
        [this.name]
      );
      if (trophies.length > 0) {
        finalBuff += (parseFloat(trophies[0].buff_multiplier) || 0);
      }
    } catch (e) {
      // Fallback to tier buff if trophy check fails
    }
    return finalBuff;
  }

  /** Award XP for completing a task. isSuccess determines if it was correct. */
  async gainXp(amount, isSuccess = true) {
    await this.loadRpgProfile();
    // Intelligence multiplier: smarter agents earn XP faster
    const tier = this.getIntelTier();
    const boostedAmount = Math.round(amount * tier.xpMultiplier);
    this._rpg.xp += boostedAmount;
    this._rpg.tasksCompleted++;
    if (isSuccess) this._rpg.tasksSuccess++;

    // Track competition stats
    this._competition.weeklyXp += boostedAmount;
    this.recordOutcome(isSuccess);

    const newLevel = BaseAgent.levelFromXp(this._rpg.xp);
    const leveledUp = newLevel > this._rpg.level;
    if (leveledUp) {
      this._rpg.level = newLevel;
      const tierNow = this.getIntelTier();
      this.addActivity('success', `LEVEL UP! Now level ${newLevel} [${tierNow.label}]`);
      this.log(`LEVEL UP → Lv.${newLevel} [${tierNow.label}] (${this._rpg.xp} XP)`);
      // Level-up thought
      this._personality.thoughts.push({
        text: `Level ${newLevel}! I'm getting smarter — ${tierNow.label} tier unlocked.`,
        ts: Date.now(),
      });
      // Broadcast to team
      this.shareWithTeam(`leveled up to Lv.${newLevel} [${tierNow.label}]! ${this._rpg.xp} total XP.`);
    }

    // Generate thought periodically (every ~10 tasks)
    if (this._rpg.tasksCompleted % 10 === 0) {
      this.generateThought();
    }

    await this.saveRpgProfile();
    return { leveledUp, newLevel, xpGained: boostedAmount };
  }

  /** Add earnings to this agent's total */
  async addEarnings(amount) {
    await this.loadRpgProfile();
    this._rpg.totalEarned += amount;
    await this.saveRpgProfile();
  }

  // ── Survival System Methods ───────────────────────────────

  /** Record a trade win — +10 HP, capital increases */
  recordSurvivalWin(pnlUsdt, tradeDetails = {}) {
    if (!this._survival.isAlive) return;
    this._checkMonthReset();
    this._survival.health = Math.min(100, this._survival.health + 10);
    this._survival.capital += Math.abs(pnlUsdt);
    this._survival.monthlyPnl += Math.abs(pnlUsdt);
    this._survival.totalTrades++;
    this._survival.totalWins++;
    this._survival.totalRevenue = (this._survival.totalRevenue || 0) + Math.abs(pnlUsdt);
    this._survival.lastTradeAt = Date.now();
    this.addActivity('win', `HP ${this._survival.health}/100 | +$${Math.abs(pnlUsdt).toFixed(2)} | Capital: $${this._survival.capital.toFixed(2)}`);
    this._saveSurvival();
    this._saveTradeHistory({ ...tradeDetails, pnlUsdt: Math.abs(pnlUsdt), isWin: true });
  }

  /** Record a trade loss — -10 HP, capital decreases. May kill agent. */
  recordSurvivalLoss(pnlUsdt, tradeDetails = {}) {
    if (!this._survival.isAlive) return;
    this._checkMonthReset();
    this._survival.health = Math.max(0, this._survival.health - 10);
    this._survival.capital -= Math.abs(pnlUsdt);
    this._survival.monthlyPnl -= Math.abs(pnlUsdt);
    this._survival.totalTrades++;
    this._survival.totalLosses++;
    this._survival.totalRevenue = (this._survival.totalRevenue || 0) - Math.abs(pnlUsdt);
    this._survival.lastTradeAt = Date.now();

    if (this._survival.capital <= 0) {
      this._killAgent('Capital depleted — $0 remaining');
    } else if (this._survival.health <= 0) {
      this._killAgent('Health reached 0 HP — too many losses');
    } else {
      this.addActivity('loss', `HP ${this._survival.health}/100 | -$${Math.abs(pnlUsdt).toFixed(2)} | Capital: $${this._survival.capital.toFixed(2)}`);
    }
    this._saveSurvival();
    this._saveTradeHistory({ ...tradeDetails, pnlUsdt: -Math.abs(pnlUsdt), isWin: false });
  }

  /** Save a trade to the agent's trade history in DB */
  async _saveTradeHistory(trade) {
    try {
      const { query } = require('../db');
      await query(
        `INSERT INTO agent_trade_history (agent, symbol, direction, entry_price, exit_price, pnl_usdt, is_win, strategy, setup, leverage, capital_after, health_after, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
        [
          this.name,
          trade.symbol || 'UNKNOWN',
          trade.direction || 'UNKNOWN',
          trade.entryPrice || 0,
          trade.exitPrice || 0,
          trade.pnlUsdt || 0,
          trade.isWin,
          trade.strategy || trade.setupName || 'AI',
          trade.setup || '',
          trade.leverage || 20,
          this._survival.capital,
          this._survival.health,
        ]
      );
    } catch {}
  }

  /** Get trade history for this agent */
  async getTradeHistory(limit = 100) {
    try {
      const { query } = require('../db');
      return await query(
        `SELECT * FROM agent_trade_history WHERE agent = $1 ORDER BY created_at DESC LIMIT $2`,
        [this.name, limit]
      );
    } catch {
      return [];
    }
  }

  /** Kill this agent permanently */
  _killAgent(reason) {
    this._survival.isAlive = false;
    this._survival.killReason = reason;
    this.state = AGENT_STATES.STOPPED;
    this.paused = true;
    this._personality.mood = 'dead';
    this.addActivity('death', `☠️ KILLED: ${reason} | Final capital: $${this._survival.capital.toFixed(2)} | W/L: ${this._survival.totalWins}/${this._survival.totalLosses}`);
    this.log(`AGENT KILLED: ${reason}`);
    bLog.error(`${this.name} KILLED: ${reason}`);
  }

  /** Check if month rolled over — reset monthly PnL tracking */
  _checkMonthReset() {
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (this._survival.monthStart !== currentMonth) {
      // Check if last month hit 60% target
      const monthlyPct = this._survival.monthlyPnl / this._survival.startCapital;
      if (this._survival.totalTrades >= 10 && monthlyPct < this._survival.monthlyTarget) {
        // Penalty: lose 20 HP for missing monthly target
        this._survival.health = Math.max(0, this._survival.health - 20);
        this.addActivity('penalty', `📉 Missed ${(this._survival.monthlyTarget*100).toFixed(0)}% target: only ${(monthlyPct*100).toFixed(1)}% — lost 20 HP`);
        if (this._survival.health <= 0) {
          this._killAgent('Failed monthly target — 0 HP');
          return;
        }
      }
      // Reset month tracking
      this._survival.monthStart = currentMonth;
      this._survival.startCapital = this._survival.capital;
      this._survival.monthlyPnl = 0;
    }
  }

  /** Get survival status for dashboard */
  getSurvival() {
    this._checkMonthReset();
    const monthlyPct = this._survival.startCapital > 0
      ? (this._survival.monthlyPnl / this._survival.startCapital * 100) : 0;
    return {
      health: this._survival.health,
      isAlive: this._survival.isAlive,
      capital: Math.round(this._survival.capital * 100) / 100,
      monthlyPnl: Math.round(this._survival.monthlyPnl * 100) / 100,
      monthlyPct: Math.round(monthlyPct * 10) / 10,
      monthlyTarget: this._survival.monthlyTarget * 100,
      totalTrades: this._survival.totalTrades,
      totalWins: this._survival.totalWins,
      totalLosses: this._survival.totalLosses,
      totalRevenue: Math.round((this._survival.totalRevenue || 0) * 100) / 100,
      winRate: this._survival.totalTrades > 0
        ? Math.round(this._survival.totalWins / this._survival.totalTrades * 100) : 0,
      killReason: this._survival.killReason,
      lastTradeAt: this._survival.lastTradeAt,
    };
  }

  /** Save survival state to DB */
  async _saveSurvival() {
    try {
      const db = require('../db');
      await db.query(
        `INSERT INTO agent_survival (agent, health, is_alive, capital, monthly_pnl, month_start, start_capital, total_trades, total_wins, total_losses, kill_reason, total_revenue, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
         ON CONFLICT (agent) DO UPDATE SET
           health = $2, is_alive = $3, capital = $4, monthly_pnl = $5,
           month_start = $6, start_capital = $7, total_trades = $8,
           total_wins = $9, total_losses = $10, kill_reason = $11,
           total_revenue = $12, updated_at = NOW()`,
        [this.name, this._survival.health, this._survival.isAlive, this._survival.capital,
         this._survival.monthlyPnl, this._survival.monthStart, this._survival.startCapital,
         this._survival.totalTrades, this._survival.totalWins, this._survival.totalLosses,
         this._survival.killReason, this._survival.totalRevenue || 0]
      );
    } catch (err) {
      this.logError(`Save survival failed: ${err.message}`);
    }
  }

  /** Load survival state from DB */
  async _loadSurvival() {
    try {
      const db = require('../db');
      const rows = await db.query('SELECT * FROM agent_survival WHERE agent = $1', [this.name]);
      if (rows.length) {
        const r = rows[0];
        this._survival.health = parseInt(r.health) || 100;
        this._survival.isAlive = r.is_alive !== false;
        this._survival.capital = parseFloat(r.capital) || 1000;
        this._survival.monthlyPnl = parseFloat(r.monthly_pnl) || 0;
        this._survival.monthStart = r.month_start || new Date().toISOString().slice(0, 7);
        this._survival.startCapital = parseFloat(r.start_capital) || 1000;
        this._survival.totalTrades = parseInt(r.total_trades) || 0;
        this._survival.totalWins = parseInt(r.total_wins) || 0;
        this._survival.totalLosses = parseInt(r.total_losses) || 0;
        this._survival.totalRevenue = parseFloat(r.total_revenue) || 0;
        this._survival.killReason = r.kill_reason;
        if (!this._survival.isAlive) {
          this.state = AGENT_STATES.STOPPED;
          this.paused = true;
        }
        this.log(`Survival loaded: HP=${this._survival.health} Capital=$${this._survival.capital.toFixed(0)} W/L=${this._survival.totalWins}/${this._survival.totalLosses}`);
      }
    } catch (err) {
      this.logError(`Load survival failed: ${err.message}`);
    }
  }

  getRpgProfile() {
    return {
      level: this._rpg.level,
      xp: this._rpg.xp,
      xpProgress: this.getXpProgress(),
      xpForNext: BaseAgent.xpForLevel(this._rpg.level),
      totalEarned: this._rpg.totalEarned,
      points: this._rpg.points,
      tier: this.updateTier(),
      tasksCompleted: this._rpg.tasksCompleted,
      tasksSuccess: this._rpg.tasksSuccess,
      successRate: this._rpg.tasksCompleted > 0
        ? Math.round((this._rpg.tasksSuccess / this._rpg.tasksCompleted) * 100) : 0,
    };
  }

  // ── Intelligence & Thinking System ─────────────────────────

  /** Get intelligence tier based on current level */
  getIntelTier() {
    const lvl = this._rpg.level;
    for (const [key, tier] of Object.entries(INTEL_TIERS)) {
      if (lvl >= tier.min && lvl <= tier.max) return { id: key, ...tier };
    }
    return { id: 'ROOKIE', ...INTEL_TIERS.ROOKIE };
  }

  /** Get intelligence-adjusted value — higher level = tighter parameters */
  getIntelValue(base, improvePct = 0.05) {
    const tier = this.getIntelTier();
    return base * (1 + (tier.trustScore - 0.5) * improvePct * 2);
  }

  /** Generate a human-like thought based on current context */
  generateThought() {
    const tier = this.getIntelTier();
    const lvl = this._rpg.level;
    const wr = this._rpg.tasksCompleted > 0
      ? Math.round((this._rpg.tasksSuccess / this._rpg.tasksCompleted) * 100) : 0;
    const mood = this._personality.mood;
    const trait = this._personality.trait;
    const rival = this._personality.rivalry;
    const streak = this._personality.streakWins;
    const losses = this._personality.streakLosses;

    const thoughts = [];

    // Level-based ambition thoughts
    if (lvl < 5) {
      thoughts.push('Still learning the ropes... need more experience.');
      thoughts.push('Every task teaches me something new.');
      thoughts.push('Watching the senior agents — they make it look easy.');
    } else if (lvl < 15) {
      thoughts.push('Getting better every cycle. My accuracy is improving.');
      thoughts.push(`My ${trait} approach is starting to pay off.`);
      thoughts.push('I can handle more responsibility now.');
    } else if (lvl < 30) {
      thoughts.push('I see patterns the rookies miss.');
      thoughts.push(`${wr}% success rate — the data doesn't lie.`);
      thoughts.push('Time to push for Master tier.');
    } else if (lvl < 50) {
      thoughts.push('The market has no secrets from me anymore.');
      thoughts.push(`${this._rpg.tasksCompleted} tasks completed — experience is everything.`);
      thoughts.push('I should be teaching the younger agents.');
    } else {
      thoughts.push('Legend status earned, not given.');
      thoughts.push('Even legends keep learning.');
      thoughts.push(`${this._rpg.totalEarned.toFixed(2)} earned — that's real proof.`);
    }

    // Mood-based thoughts
    if (mood === 'competitive' && rival) {
      thoughts.push(`${rival} thinks they're better? Let's see about that.`);
      thoughts.push(`Outperforming ${rival} is today's mission.`);
    }
    if (mood === 'confident' && streak >= 3) {
      thoughts.push(`${streak} wins in a row — I'm in the zone.`);
    }
    if (mood === 'anxious' && losses >= 2) {
      thoughts.push('Need to refocus. Losses happen but patterns repeat.');
      thoughts.push('Double-checking everything before the next move.');
    }
    if (mood === 'determined') {
      thoughts.push('Not stopping until I level up.');
    }
    if (mood === 'reflective') {
      thoughts.push('What could I have done differently last cycle?');
    }

    // Performance-based thoughts
    if (wr >= 70) thoughts.push(`${wr}% win rate — top performer.`);
    else if (wr >= 50) thoughts.push(`${wr}% is solid, but there's room to improve.`);
    else if (wr > 0) thoughts.push(`${wr}% needs work. Analyzing my mistakes.`);

    const thought = thoughts[Math.floor(Math.random() * thoughts.length)];
    this._personality.thoughts.push({ text: thought, ts: Date.now() });
    if (this._personality.thoughts.length > this._maxThoughts) this._personality.thoughts.shift();
    this._personality.lastThoughtAt = Date.now();
    return thought;
  }

  /** Get latest thoughts for display */
  getThoughts(limit = 5) {
    return this._personality.thoughts.slice(-limit);
  }

  /** Update mood based on recent performance */
  updateMood() {
    const wins = this._personality.streakWins;
    const losses = this._personality.streakLosses;
    const tier = this.getIntelTier();

    if (wins >= 5) this._personality.mood = 'confident';
    else if (wins >= 3) this._personality.mood = 'determined';
    else if (losses >= 3) this._personality.mood = 'anxious';
    else if (this._personality.rivalry) this._personality.mood = 'competitive';
    else if (tier.label === 'Legend') this._personality.mood = 'reflective';
    else this._personality.mood = MOODS[Math.floor(Math.random() * MOODS.length)];
  }

  /** Record a win/loss for streak tracking and mood updates */
  recordOutcome(isWin) {
    if (isWin) {
      this._personality.streakWins++;
      this._personality.streakLosses = 0;
      if (this._personality.streakWins > this._personality.bestStreak) {
        this._personality.bestStreak = this._personality.streakWins;
      }
    } else {
      this._personality.streakLosses++;
      this._personality.streakWins = 0;
    }
    this._competition.weeklyTasks++;
    this.updateMood();
  }

  /** Set a rival to compete against */
  setRival(agentName) {
    if (agentName === this.name) return;
    this._personality.rivalry = agentName;
    this._personality.mood = 'competitive';
    this.addActivity('info', `New rival: ${agentName} — competition is ON`);
  }

  /** Get competition stats for leaderboard */
  getCompetitionStats() {
    return {
      name: this.name,
      level: this._rpg.level,
      xp: this._rpg.xp,
      tier: this.getIntelTier().label,
      totalEarned: this._rpg.totalEarned,
      tasksCompleted: this._rpg.tasksCompleted,
      successRate: this._rpg.tasksCompleted > 0
        ? Math.round((this._rpg.tasksSuccess / this._rpg.tasksCompleted) * 100) : 0,
      streak: this._personality.streakWins,
      bestStreak: this._personality.bestStreak,
      mood: this._personality.mood,
      trait: this._personality.trait,
      rivalry: this._personality.rivalry,
      weeklyXp: this._competition.weeklyXp,
      weeklyTasks: this._competition.weeklyTasks,
    };
  }

  /** Get personality for display / emulator */
  getPersonality() {
    return {
      trait: this._personality.trait,
      mood: this._personality.mood,
      ambition: this._personality.ambition,
      rivalry: this._personality.rivalry,
      streakWins: this._personality.streakWins,
      streakLosses: this._personality.streakLosses,
      bestStreak: this._personality.bestStreak,
      latestThought: this._personality.thoughts.length > 0
        ? this._personality.thoughts[this._personality.thoughts.length - 1].text : null,
      tier: this.getIntelTier().label,
    };
  }

  // ── Health ────────────────────────────────────────────────

  getHealth() {
    return {
      name: this.name,
      state: this._survival.isAlive === false ? 'dead' : this.state,
      paused: this.paused,
      runCount: this.runCount,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      currentTask: this.currentTask,
      inboxSize: this._inbox.length,
      recentActivity: this.getActivity(10),
      rpg: this.getRpgProfile(),
      personality: this.getPersonality(),
      competition: this.getCompetitionStats(),
      survival: this.getSurvival(),
      profile: this._profile,
    };
  }

  // ── Internal ──────────────────────────────────────────────

  _ts() {
    return new Date().toLocaleString('en-GB', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
  }
}

module.exports = { BaseAgent, AGENT_STATES };
