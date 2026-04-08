// ============================================================
// BaseAgent — Foundation class for all trading agents
//
// Provides: lifecycle management, structured logging, state,
//           inter-agent messaging, and health monitoring.
// ============================================================

const { log: bLog } = require('../bot-logger');
const { think, isAvailable, getSystemPrompt } = require('./ai-brain');

const AGENT_STATES = {
  IDLE:     'idle',
  RUNNING:  'running',
  ERROR:    'error',
  STOPPED:  'stopped',
};

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
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async init() {
    this.log('Initialized');
  }

  async run(context = {}) {
    if (this.state === AGENT_STATES.RUNNING) {
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
      this.state = AGENT_STATES.IDLE;
      this.currentTask = null;
      this.addActivity('success', `Cycle #${this.runCount} complete`);
      return result;
    } catch (err) {
      this.state = AGENT_STATES.ERROR;
      this.lastError = { message: err.message, at: Date.now() };
      this.currentTask = null;
      this.addActivity('error', `Cycle #${this.runCount} failed: ${err.message}`);
      this.logError(`Execute failed: ${err.message}`);
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
      const aiResponse = await think({
        agentName: this.name,
        systemPrompt: getSystemPrompt(this.name),
        userMessage: question,
        context,
      });
      if (aiResponse) return aiResponse;
    }

    // Fallback: hardcoded response
    const profile = this.getProfile();
    const skillList = profile.skills.map(s => `• **${s.name}** ${s.enabled ? '' : '(OFF)'} — ${s.description}`).join('\n');
    return `I'm **${this.name}** (${profile.role}). ${profile.description}\n\n**Skills:**\n${skillList}`;
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

  // ── Health ────────────────────────────────────────────────

  getHealth() {
    return {
      name: this.name,
      state: this.state,
      paused: this.paused,
      runCount: this.runCount,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      currentTask: this.currentTask,
      inboxSize: this._inbox.length,
      recentActivity: this.getActivity(10),
    };
  }

  // ── Internal ──────────────────────────────────────────────

  _ts() {
    return new Date().toLocaleString('en-GB', {
      timeZone: 'Asia/Singapore',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
  }
}

module.exports = { BaseAgent, AGENT_STATES };
