const { BaseAgent } = require('./base-agent');

const PATROL_INTERVAL_MS = 60 * 1000;
const STALE_THRESHOLD_MS = 10 * 60 * 1000;
const WARNING_THRESHOLD = 3;
const RECENT_ACTIVITY_WINDOW = 50;
const CONSECUTIVE_LOSS_LIMIT = 5;
const ERROR_RATE_LIMIT = 0.3;
const CONSECUTIVE_ERROR_STATE_LIMIT = 3;

const EXCLUDED_AGENTS = ['PoliceAgent', 'Coordinator'];

class PoliceAgent extends BaseAgent {
  constructor(options = {}) {
    super('PoliceAgent', options);

    this._profile = {
      description: 'Monitors all agents for rule violations. Issues warnings and jails repeat offenders.',
      role: 'Internal Affairs',
      icon: 'police',
      skills: [
        { id: 'patrol', name: 'Patrol', description: 'Scan all agents for violations on a timer', enabled: true },
        { id: 'investigate', name: 'Investigate', description: 'Deep-check a specific agent for issues', enabled: true },
        { id: 'arrest', name: 'Arrest', description: 'Jail agents that exceed the warning threshold', enabled: true },
        { id: 'release', name: 'Release', description: 'Free jailed agents after user review', enabled: true },
      ],
      config: [
        { key: 'warningThreshold', label: 'Warning Threshold', type: 'number', value: WARNING_THRESHOLD, min: 1, max: 10 },
        { key: 'patrolInterval', label: 'Patrol Interval (s)', type: 'number', value: 60, min: 10, max: 600 },
        { key: 'strictMode', label: 'Strict Mode', type: 'boolean', value: false },
      ],
    };

    this._jailedAgents = new Map();
    this._warningCounts = new Map();
    this._errorStateStreak = new Map();
    this._totalArrests = 0;
    this._totalWarnings = 0;
    this._patrolCount = 0;
    this._runTimer = null;
  }

  async init() {
    await super.init();
    await this._loadJailFromDb();
    this._scheduleNextRun();
    this.log('Internal Affairs patrol started (every 60s)');
  }

  _scheduleNextRun() {
    if (this._runTimer) clearTimeout(this._runTimer);
    const interval = (this.options.patrolInterval || 60) * 1000;
    this._runTimer = setTimeout(async () => {
      if (!this.paused) {
        try {
          await this.run();
        } catch (err) {
          this.addActivity('error', `Patrol failed: ${err.message}`);
        }
      }
      this._scheduleNextRun();
    }, interval);
  }

  async shutdown() {
    if (this._runTimer) clearTimeout(this._runTimer);
    await super.shutdown();
  }

  async execute(context = {}) {
    const { coordinator } = context;
    if (!coordinator) {
      this.addActivity('warn', 'No coordinator provided — cannot patrol');
      return { violations: 0 };
    }

    this._patrolCount++;
    const agents = this._getAllAgents(coordinator);
    let violationsFound = 0;

    for (const [key, agent] of agents) {
      if (EXCLUDED_AGENTS.includes(key) || EXCLUDED_AGENTS.includes(agent.name)) continue;
      if (agent === this) continue;

      const violations = this._checkViolations(key, agent, coordinator);
      for (const violation of violations) {
        violationsFound++;
        this._issueWarning(key, agent, violation);
      }

      if (violations.length === 0) {
        this._trackCleanCheck(key);
      }
    }

    const summary = `Patrol #${this._patrolCount}: ${agents.size} agents checked, ${violationsFound} violations`;
    this.addActivity('info', summary);
    this.log(summary);

    return { patrolCount: this._patrolCount, violations: violationsFound, jailed: this._jailedAgents.size };
  }

  _getAllAgents(coordinator) {
    // Use coordinator's _agents map (the source of truth)
    if (coordinator._agents && coordinator._agents instanceof Map) {
      return coordinator._agents;
    }
    // Fallback: build from named properties
    const agents = new Map();
    const agentProps = [
      ['chart', 'chartAgent'], ['risk', 'riskAgent'], ['trader', 'traderAgent'],
      ['strategy', 'strategyAgent'], ['sentiment', 'sentimentAgent'],
      ['accountant', 'accountantAgent'], ['kronos', 'kronosAgent'],
    ];
    for (const [key, prop] of agentProps) {
      if (coordinator[prop] && coordinator[prop] !== this) {
        agents.set(key, coordinator[prop]);
      }
    }
    return agents;
  }

  _checkViolations(agentKey, agent, coordinator) {
    const violations = [];

    if (this._jailedAgents.has(agentKey)) return violations;

    const activity = agent.getActivity(RECENT_ACTIVITY_WINDOW);
    const health = agent.getHealth();

    if (this._hasExcessiveConsecutiveLosses(activity)) {
      violations.push({
        type: 'excessive_losses',
        severity: 'high',
        message: `${CONSECUTIVE_LOSS_LIMIT}+ consecutive error/loss entries detected`,
      });
    }

    if (this._hasHighErrorRate(activity)) {
      const errorCount = activity.filter(a => a.type === 'error').length;
      violations.push({
        type: 'high_error_rate',
        severity: 'high',
        message: `Error rate ${((errorCount / activity.length) * 100).toFixed(0)}% exceeds ${ERROR_RATE_LIMIT * 100}% threshold`,
      });
    }

    if (this._isIgnoringRisk(agent, coordinator)) {
      violations.push({
        type: 'ignoring_risk',
        severity: 'critical',
        message: 'Executed trade that RiskAgent rejected',
      });
    }

    if (this._isStale(health)) {
      violations.push({
        type: 'stale_agent',
        severity: 'medium',
        message: `Agent has not run in ${Math.round((Date.now() - health.lastRunAt) / 60000)}+ minutes and is not paused`,
      });
    }

    if (this._hasRepeatedErrorState(agentKey, health)) {
      violations.push({
        type: 'repeated_failures',
        severity: 'high',
        message: `Agent stuck in error state for ${CONSECUTIVE_ERROR_STATE_LIMIT}+ consecutive checks`,
      });
    }

    return violations;
  }

  _hasExcessiveConsecutiveLosses(activity) {
    if (activity.length === 0) return false;
    let streak = 0;
    for (let i = activity.length - 1; i >= 0; i--) {
      const entry = activity[i];
      if (entry.type === 'error' || entry.message.toLowerCase().includes('loss') || entry.message.toLowerCase().includes('failed')) {
        streak++;
        if (streak >= CONSECUTIVE_LOSS_LIMIT) return true;
      } else if (entry.type === 'success') {
        streak = 0;
      }
    }
    return false;
  }

  _hasHighErrorRate(activity) {
    if (activity.length < 10) return false;
    const errorCount = activity.filter(a => a.type === 'error').length;
    return (errorCount / activity.length) > ERROR_RATE_LIMIT;
  }

  _isIgnoringRisk(agent, coordinator) {
    if (agent.name !== 'TraderAgent') return false;
    const riskAgent = coordinator.riskAgent;
    if (!riskAgent) return false;

    const riskActivity = riskAgent.getActivity(RECENT_ACTIVITY_WINDOW);
    const traderActivity = agent.getActivity(RECENT_ACTIVITY_WINDOW);

    const recentRejections = riskActivity.filter(a =>
      a.message.toLowerCase().includes('reject') || a.message.toLowerCase().includes('denied')
    );
    if (recentRejections.length === 0) return false;

    const recentTrades = traderActivity.filter(a =>
      a.type === 'success' && (a.message.toLowerCase().includes('trade') || a.message.toLowerCase().includes('order'))
    );

    for (const rejection of recentRejections) {
      for (const trade of recentTrades) {
        if (trade.ts > rejection.ts && trade.ts - rejection.ts < 5 * 60 * 1000) {
          return true;
        }
      }
    }

    return false;
  }

  _isStale(health) {
    if (health.paused || health.state === 'stopped' || health.state === 'jailed') return false;
    if (!health.lastRunAt) return false;
    return (Date.now() - health.lastRunAt) > STALE_THRESHOLD_MS;
  }

  _hasRepeatedErrorState(agentKey, health) {
    if (health.state === 'error') {
      const current = this._errorStateStreak.get(agentKey) || 0;
      this._errorStateStreak.set(agentKey, current + 1);
      return (current + 1) >= CONSECUTIVE_ERROR_STATE_LIMIT;
    }
    this._errorStateStreak.set(agentKey, 0);
    return false;
  }

  _trackCleanCheck(agentKey) {
    this._errorStateStreak.set(agentKey, 0);
  }

  _issueWarning(agentKey, agent, violation) {
    const currentWarnings = this._warningCounts.get(agentKey) || 0;
    const newCount = currentWarnings + 1;
    this._warningCounts.set(agentKey, newCount);
    this._totalWarnings++;

    const threshold = this.options.warningThreshold || WARNING_THRESHOLD;

    agent.addActivity('warn', `WARNING from PoliceAgent: ${violation.message}`);
    this.addActivity('warn', `WARNING → ${agent.name}: ${violation.message} (${newCount}/${threshold})`);
    this.log(`WARNING #${newCount} → ${agent.name}: [${violation.type}] ${violation.message}`);

    this.remember(`warning:${agentKey}:${Date.now()}`, {
      agentKey,
      agentName: agent.name,
      violation,
      warningNumber: newCount,
      ts: Date.now(),
    }, 'violations').catch(() => {});

    if (newCount >= threshold) {
      this._jailAgent(agentKey, agent, violation);
    }
  }

  async _jailAgent(agentKey, agent, violation) {
    agent.paused = true;
    agent.state = 'jailed';

    const jailRecord = {
      reason: violation.message,
      violationType: violation.type,
      severity: violation.severity,
      jailedAt: Date.now(),
      warnings: this._warningCounts.get(agentKey) || 0,
      violations: [],
    };

    this._jailedAgents.set(agentKey, jailRecord);
    this._totalArrests++;

    const arrestMessage = `ARRESTED: ${agent.name} — ${violation.message}`;
    this.addActivity('error', arrestMessage);
    agent.addActivity('error', `JAILED by PoliceAgent: ${violation.message}`);
    this.log(arrestMessage);

    this.shareWithTeam(arrestMessage);

    await this._saveJailToDb(agentKey, agent.name, jailRecord);
  }

  async _saveJailToDb(agentKey, agentName, record) {
    try {
      const { query } = require('../db');
      await query(
        `INSERT INTO agent_jail (agent_key, agent_name, reason, violation_type, severity, jailed_at, warnings)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), $7)`,
        [agentKey, agentName, record.reason, record.violationType, record.severity, record.jailedAt, record.warnings]
      );
    } catch (err) {
      this.logError(`Failed to save jail record: ${err.message}`);
    }
  }

  async _loadJailFromDb() {
    try {
      const { query } = require('../db');
      const rows = await query('SELECT * FROM agent_jail WHERE released_at IS NULL');
      for (const row of rows) {
        this._jailedAgents.set(row.agent_key, {
          reason: row.reason,
          violationType: row.violation_type,
          severity: row.severity,
          jailedAt: new Date(row.jailed_at).getTime(),
          warnings: row.warnings,
          violations: [],
        });
      }
      if (this._jailedAgents.size > 0) {
        this.log(`Loaded ${this._jailedAgents.size} jailed agent(s) from DB`);
      }
    } catch {
      // DB may not have the table yet — not critical
    }
  }

  getJailedAgents() {
    const result = [];
    for (const [agentKey, record] of this._jailedAgents) {
      result.push({
        agentKey,
        reason: record.reason,
        violationType: record.violationType,
        severity: record.severity,
        jailedAt: record.jailedAt,
        duration: Date.now() - record.jailedAt,
        warnings: record.warnings,
      });
    }
    return result;
  }

  async releaseAgent(agentKey, coordinator) {
    const record = this._jailedAgents.get(agentKey);
    if (!record) {
      this.log(`Cannot release ${agentKey}: not jailed`);
      return false;
    }

    const agents = this._getAllAgents(coordinator);
    const agent = agents.get(agentKey);

    if (agent) {
      agent.paused = false;
      agent.state = 'idle';

      const releaseMessage = `RELEASED: ${agent.name} — back on duty`;
      this.addActivity('success', releaseMessage);
      agent.addActivity('success', 'Released from jail by PoliceAgent');
      this.log(releaseMessage);
      this.shareWithTeam(releaseMessage);
    }

    this._jailedAgents.delete(agentKey);
    this._warningCounts.set(agentKey, 0);
    this._errorStateStreak.set(agentKey, 0);

    try {
      const { query } = require('../db');
      await query(
        'UPDATE agent_jail SET released_at = NOW() WHERE agent_key = $1 AND released_at IS NULL',
        [agentKey]
      );
    } catch (err) {
      this.logError(`Failed to update jail release in DB: ${err.message}`);
    }

    return true;
  }

  async getViolationReport(agentKey) {
    const warnings = [];
    try {
      const allMemory = await this.recallAll('violations');
      for (const entry of allMemory) {
        const data = typeof entry.value === 'string' ? JSON.parse(entry.value) : entry.value;
        if (data.agentKey === agentKey) {
          warnings.push(data);
        }
      }
    } catch {
      // Fallback: no DB data available
    }

    const jailRecord = this._jailedAgents.get(agentKey) || null;
    const currentWarnings = this._warningCounts.get(agentKey) || 0;

    return {
      agentKey,
      currentWarnings,
      isJailed: this._jailedAgents.has(agentKey),
      jailRecord,
      warningHistory: warnings.sort((a, b) => b.ts - a.ts),
    };
  }

  getHealth() {
    return {
      ...super.getHealth(),
      jailedCount: this._jailedAgents.size,
      totalArrests: this._totalArrests,
      totalWarnings: this._totalWarnings,
      patrolCount: this._patrolCount,
    };
  }
}

module.exports = { PoliceAgent };
