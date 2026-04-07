// ============================================================
// BaseAgent — Foundation class for all trading agents
//
// Provides: lifecycle management, structured logging, state,
//           inter-agent messaging, and health monitoring.
// ============================================================

const { log: bLog } = require('../bot-logger');

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

    // Inbox for inter-agent messages
    this._inbox = [];

    // Activity feed — rolling log of recent actions
    this._activity = [];
    this._maxActivity = 50;

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
