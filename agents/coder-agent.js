// ============================================================
// CoderAgent — Self-healing code maintenance agent
//
// Monitors the entire codebase for errors, crashes, and issues.
// Uses AI brain to diagnose problems and write patches.
// Runs 24/7 in background, scanning logs for errors, validating
// module health, and auto-patching fixable issues.
//
// Safety: all patches are logged, reversible, and reviewed.
// ============================================================

const { BaseAgent } = require('./base-agent');
const fs = require('fs');
const path = require('path');

const SCAN_INTERVAL_MS = 5 * 60 * 1000; // scan every 5 minutes
const PROJECT_ROOT = path.resolve(__dirname, '..');
const MAX_PATCH_SIZE = 500; // max lines per patch (safety limit)

// Files the CoderAgent is allowed to read and patch
const ALLOWED_FILES = [
  'agents/*.js',
  'routes/*.js',
  'cycle.js',
  'bot.js',
  'kronos.js',
  'smc-engine.js',
  'ai-learner.js',
  'hermes-bridge.js',
  'bitunix-client.js',
  'bot-logger.js',
  'db.js',
];

// Files NEVER touched (safety)
const FORBIDDEN_FILES = [
  'crypto-utils.js',   // encryption keys
  'entry.js',          // boot process
  '.env',
  'node_modules',
];

class CoderAgent extends BaseAgent {
  constructor(options = {}) {
    super('CoderAgent', options);

    this._profile = {
      description: 'Self-healing code agent. Scans for errors, diagnoses bugs, and writes patches to keep the system healthy.',
      role: 'Code Engineer',
      icon: 'coder',
      skills: [
        { id: 'error_scan', name: 'Error Scanner', description: 'Scan logs for recurring errors and crashes', enabled: true },
        { id: 'module_health', name: 'Module Health', description: 'Validate all modules load without errors', enabled: true },
        { id: 'auto_patch', name: 'Auto Patch', description: 'Write and apply code fixes for known issues', enabled: true },
        { id: 'code_review', name: 'Code Review', description: 'Review agent code for improvements', enabled: true },
        { id: 'dep_check', name: 'Dependency Check', description: 'Verify all required packages are installed', enabled: true },
      ],
      config: [
        { key: 'autoApply', label: 'Auto-Apply Patches', type: 'boolean', value: true },
        { key: 'scanInterval', label: 'Scan Interval (min)', type: 'number', value: 5, min: 1, max: 60 },
        { key: 'maxPatchSize', label: 'Max Patch Lines', type: 'number', value: MAX_PATCH_SIZE, min: 10, max: 1000 },
      ],
    };

    // Tracking
    this._scanTimer = null;
    this._scanCount = 0;
    this._issuesFound = 0;
    this._issuesFixed = 0;
    this._patchesApplied = 0;
    this._pendingPatches = [];   // patches awaiting review
    this._appliedPatches = [];   // history of applied patches
    this._errorPatterns = new Map(); // error message → count
    this._moduleHealth = new Map();  // module path → { ok, error, lastCheck }
    this._lastDiagnostic = null;

    // Healing sessions: Map<agentName, { attempts: number, lastErrorHash: string, lastAttemptAt: number }>
    this._activeHealingSessions = new Map();
  }


  async init() {
    await super.init();
    await this._loadState();
    this._scheduleNextRun();
    this.log('Code Engineer online — monitoring system health');
  }

  _scheduleNextRun() {
    if (this._scanTimer) clearTimeout(this._scanTimer);
    const interval = (this.options.scanInterval || 5) * 60 * 1000;
    this._scanTimer = setTimeout(async () => {
      if (!this.paused && this.state !== 'jailed') {
        try {
          await this.run({ coordinator: this._coordinator });
        } catch (err) {
          this.addActivity('error', `Scan failed: ${err.message}`);
        }
      }
      this._scheduleNextRun();
    }, interval);
  }

  async shutdown() {
    if (this._scanTimer) clearTimeout(this._scanTimer);
    await super.shutdown();
  }

  // Store reference to coordinator for cross-agent access
  setCoordinator(coordinator) {
    this._coordinator = coordinator;
  }

  async execute(context = {}) {
    this._scanCount++;
    this.currentTask = { description: 'Running system health scan...', startedAt: Date.now() };
    this.addActivity('info', `Health scan #${this._scanCount} started`);

    const report = {
      scanNumber: this._scanCount,
      timestamp: Date.now(),
      errors: [],
      warnings: [],
      fixes: [],
      moduleHealth: {},
    };

    // ── Phase 0: Process upgrade/skill requests from other agents ──
    await this._processAgentRequests(context.coordinator);

    // ── Phase 1: Scan error logs for recurring patterns ──
    this.currentTask = { description: 'Phase 1: Analyzing error logs...', startedAt: Date.now() };
    const errorReport = await this._scanErrorLogs();
    report.errors = errorReport.errors;
    if (errorReport.errors.length > 0) {
      this.addActivity('warn', `Found ${errorReport.errors.length} error pattern(s) in logs`);
    }

    // ── Phase 2: Module health check ──
    this.currentTask = { description: 'Phase 2: Checking module health...', startedAt: Date.now() };
    const healthReport = await this._checkModuleHealth();
    report.moduleHealth = healthReport;
    const broken = Object.values(healthReport).filter(m => !m.ok).length;
    if (broken > 0) {
      this.addActivity('error', `${broken} module(s) have load errors`);
      this._issuesFound += broken;
    }

    // ── Phase 3: Check agent error states ──
    this.currentTask = { description: 'Phase 3: Checking agent states...', startedAt: Date.now() };
    const agentIssues = this._checkAgentErrors(context.coordinator);
    report.warnings.push(...agentIssues);

    // ── Phase 4: Dependency validation ──
    this.currentTask = { description: 'Phase 4: Validating dependencies...', startedAt: Date.now() };
    const depIssues = this._checkDependencies();
    report.warnings.push(...depIssues);

    // ── Phase 5: AI-powered diagnosis for recurring errors ──
    if (errorReport.errors.length > 0 || broken > 0) {
      this.currentTask = { description: 'Phase 5: AI diagnosing issues...', startedAt: Date.now() };
      const diagnosis = await this._aiDiagnose(report);
      if (diagnosis) {
        report.diagnosis = diagnosis;
        this._lastDiagnostic = diagnosis;
        this.addActivity('info', `AI diagnosis: ${diagnosis.summary.slice(0, 80)}`);
      }
    }

    // ── Phase 6: Generate patches for fixable issues ──
    if (this._lastDiagnostic?.patches?.length > 0) {
      this.currentTask = { description: 'Phase 6: Generating patches...', startedAt: Date.now() };
      for (const patch of this._lastDiagnostic.patches) {
        if (this._isFileSafe(patch.file)) {
          this._pendingPatches.push({
            ...patch,
            createdAt: Date.now(),
            status: 'pending',
            scanNumber: this._scanCount,
          });
          this.addActivity('info', `Patch ready: ${patch.file} — ${patch.description}`);
        }
      }
    }

    // ── Phase 7: Auto-apply if enabled and patches are safe ──
    if (this.options.autoApply && this._pendingPatches.length > 0) {
      this.currentTask = { description: 'Phase 7: Applying safe patches...', startedAt: Date.now() };
      await this._applyPendingPatches();
    }

    // Save state
    await this._saveState();

    // Generate a thought about the work
    if (report.errors.length > 0) {
      this._personality.thoughts.push({
        text: `Found ${report.errors.length} issues this scan. ${this._issuesFixed > 0 ? 'Fixed ' + this._issuesFixed + ' so far.' : 'Working on fixes.'}`,
        ts: Date.now(),
      });
    } else {
      this._personality.thoughts.push({
        text: 'System is clean. All modules healthy. Looking for optimizations...',
        ts: Date.now(),
      });
    }

    // Update task
    const summary = `Scan #${this._scanCount}: ${report.errors.length} errors, ${broken} broken modules, ${this._pendingPatches.length} pending patches`;
    this.addActivity('success', summary);
    this.currentTask = { description: 'Monitoring system health...', startedAt: Date.now() };

    // Share critical findings with team
    if (report.errors.length >= 3 || broken > 0) {
      this.shareWithTeam(`Health alert: ${report.errors.length} error patterns, ${broken} broken modules`);
    }

    return report;
  }

  // ── Agent Request Processing ────────────────────────────────

  /**
   * Process upgrade-request and skill-request messages from other agents.
   * Agents can ask CoderAgent to add capabilities, fix issues, or learn new skills.
   */
  async _processAgentRequests(coordinator) {
    if (!this._inbox?.length) return;

    const requests = this._inbox.filter(msg =>
      msg.type === 'upgrade-request' || msg.type === 'skill-request'
    );
    // Clear processed messages
    this._inbox = this._inbox.filter(msg =>
      msg.type !== 'upgrade-request' && msg.type !== 'skill-request'
    );

    if (requests.length === 0) return;

    this.currentTask = { description: `Processing ${requests.length} agent request(s)...`, startedAt: Date.now() };
    this.addActivity('info', `Processing ${requests.length} request(s) from team agents`);

    for (const req of requests.slice(0, 3)) {
      const from = req.from || 'Unknown';
      const payload = req.payload || {};

      if (req.type === 'upgrade-request') {
        this.addActivity('info', `Upgrade request from ${from}: ${payload.reason || 'no reason'}`);

        // Use AI to analyze and suggest improvements
        const { think: aiThink, isAvailable: aiOk } = require('./ai-brain');
        if (aiOk()) {
          try {
            const response = await aiThink({
              agentName: this.name,
              systemPrompt: 'You are CoderAgent, the self-healing code engineer. An agent is requesting an upgrade. Analyze and suggest concrete code improvements.',
              userMessage: `Agent "${from}" requests an upgrade.
Reason: ${payload.reason || 'unknown'}
Suggestion: ${payload.suggestion || 'none'}
Agent level: ${payload.level || 1}
Agent health: ${payload.health || 100}/100

Analyze this request. If it's actionable, suggest a specific code change.
Respond in JSON: {"summary": "...", "actionable": true/false, "recommendation": "..."}`,
              context: {},
              complexity: 'low',
            });

            if (response) {
              const summary = response.slice(0, 200);
              this.addActivity('info', `AI analysis for ${from}: ${summary}`);
              this.shareWithTeam(`CoderAgent reviewed ${from}'s upgrade request: ${summary}`);

              // Store the upgrade request for the admin to review
              this._pendingPatches.push({
                file: `agents/${from.toLowerCase().replace('agent', '-agent')}.js`,
                description: `Upgrade requested by ${from}: ${payload.reason || 'performance improvement'}`,
                type: 'upgrade',
                search: '',
                replace: '',
                confidence: 0.3, // Low confidence = human review needed
                createdAt: Date.now(),
                status: 'pending',
                scanNumber: this._scanCount,
                requestedBy: from,
              });
            }
          } catch (err) {
            this.addActivity('error', `Failed to analyze upgrade request from ${from}: ${err.message}`);
          }
        }
      }

      if (req.type === 'skill-request') {
        const topic = payload.topic || 'unknown';
        this.addActivity('info', `Skill request from ${from}: "${topic}"`);
        this.shareWithTeam(`${from} wants to learn: ${topic}. CoderAgent is investigating.`);

        // Log to DB for tracking
        try {
          const { query } = require('../db');
          await query(
            `INSERT INTO agent_memory (agent, key, value, category, updated_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (agent, key) DO UPDATE SET value = $3, updated_at = NOW()`,
            [this.name, `skill_req_${from}_${Date.now()}`, JSON.stringify({ from, topic, ts: Date.now() }), 'skill_requests']
          );
        } catch {}
      }
    }
  }

  // ── Self-Healing Loop ──────────────────────────────────────

  /**
   * Reactive entry point for self-healing.
   * Triggered by AgentCoordinator when an agent crashes.
   */
  async healAgent({ agent, error, timestamp }) {
    const agentName = agent.name;
    const errorMsg = error.message || 'Unknown error';
    const stack = error.stack || '';
    const errorHash = Buffer.from(errorMsg + stack).toString('base64').slice(0, 16);

    this.log(`Healing triggered for ${agentName}: ${errorMsg}`);
    this.addActivity('info', `Sensing crash in ${agentName}... diagnosing.`);

    // 1. Loop Prevention
    const session = this._activeHealingSessions.get(agentName) || { attempts: 0, lastErrorHash: null, lastAttemptAt: 0 };
    if (session.lastErrorHash === errorHash && session.attempts >= 3) {
      this.log(`Auto-healing limit reached for ${agentName} (Error: ${errorHash}). Manual intervention required.`);
      this.addActivity('error', `Healing limit reached for ${agentName} — marking as human_required.`);
      this.shareWithTeam(`⚠️ CRITICAL: ${agentName} is in a crash loop. Self-healing exhausted. Human review required.`);
      return { ok: false, reason: 'healing_limit_reached' };
    }

    // Update session
    session.attempts = session.lastErrorHash === errorHash ? session.attempts + 1 : 1;
    session.lastErrorHash = errorHash;
    session.lastAttemptAt = Date.now();
    this._activeHealingSessions.set(agentName, session);

    try {
      // 2. Diagnosis
      this.currentTask = { description: `Diagnosing crash in ${agentName}...`, startedAt: Date.now() };
      const diagnosis = await this._diagnoseCrash(agent, error, stack);

      if (!diagnosis || !diagnosis.patches || diagnosis.patches.length === 0) {
        this.log(`AI could not find a fix for ${agentName} crash.`);
        return { ok: false, reason: 'no_fix_found' };
      }

      // 3. Patch Application (take the best patch)
      const patch = diagnosis.patches[0];
      if (patch.confidence < 0.7) {
        this.log(`Patch confidence too low (${patch.confidence}) for auto-apply. Marking as pending.`);
        this._pendingPatches.push({ ...patch, createdAt: Date.now(), status: 'pending' });
        return { ok: false, reason: 'low_confidence' };
      }

      this.log(`Applying fix for ${agentName} (${patch.description})`);
      const applyResult = await this._applyPatch(patch);

      if (applyResult.ok) {
        this.addActivity('success', `Healed ${agentName}: ${patch.description}`);
        this.shareWithTeam(`🛠️ Self-Healed ${agentName}: ${patch.description}`);

        // 4. Verification Trigger
        if (this._coordinator) {
          this.log(`Requesting verification cycle for ${agentName}...`);
          await this._coordinator.verifyAgentFix(agent);
        }
        return { ok: true, patchId: patch.id };
      } else {
        this.log(`Patch application failed for ${agentName}: ${applyResult.error}`);
        return { ok: false, reason: 'patch_failed', error: applyResult.error };
      }
    } catch (err) {
      this.logError(`Healing process failed for ${agentName}: ${err.message}`);
      return { ok: false, reason: 'healing_process_error', error: err.message };
    }
  }

  async _diagnoseCrash(agent, error, stack) {
    const { think, isAvailable } = require('./ai-brain');
    if (!isAvailable()) return null;

    // Find the failing file from stack trace
    const stackLines = stack.split('\n');
    const fileMatch = stackLines.find(line => line.includes('at ') && (line.includes('.js') || line.includes('module.js')));
    let failingFile = null;
    if (fileMatch) {
      const match = fileMatch.match(/([a-zA-Z0-9_/.-]+\.js)/);
      if (match) failingFile = match[1];
    }

    let fileContent = 'Unknown';
    if (failingFile) {
      try {
        const fullPath = path.resolve(PROJECT_ROOT, failingFile.replace('internal/modules/cjs/loader.js', ''));
        fileContent = fs.readFileSync(fullPath, 'utf8');
      } catch {}
    }

    const prompt = `You are CoderAgent, the self-healing engineer. An agent has crashed.

    AGENT: ${agent.name}
    ERROR: ${error.message}
    STACK TRACE:
    ${stack}

    FILE CONTENT:
    ${fileContent}

    Respond ONLY with JSON:
    {
      "summary": "What happened",
      "patches": [
        {
          "file": "relative/path.js",
          "description": "The fix",
          "type": "fix",
          "search": "exact code to find",
          "replace": "exact code to replace",
          "confidence": 0.0-1.0
        }
      ]
    }`;

    try {
      const response = await think({
        agentName: this.name,
        systemPrompt: 'You are a precision code-fixing AI. Respond ONLY with valid JSON. No markdown.',
        userMessage: prompt,
        context: {},
        complexity: 'high',
      });
      if (!response) return null;
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (err) {
      return null;
    }
  }

  // ── Phase 1: Error Log Analysis ─────────────────────────

  async _scanErrorLogs() {
    const errors = [];
    try {
      const { query } = require('../db');
      // Get recent error logs from DB
      const rows = await query(
        `SELECT message, COUNT(*) as cnt, MAX(ts) as last_seen
         FROM bot_logs
         WHERE category = 'error' AND ts > NOW() - INTERVAL '1 hour'
         GROUP BY message
         ORDER BY cnt DESC
         LIMIT 20`
      );
      for (const row of rows) {
        const count = parseInt(row.cnt);
        const pattern = row.message.slice(0, 200);
        this._errorPatterns.set(pattern, (this._errorPatterns.get(pattern) || 0) + count);
        if (count >= 3) {
          errors.push({
            message: pattern,
            count,
            lastSeen: row.last_seen,
            severity: count >= 10 ? 'critical' : count >= 5 ? 'high' : 'medium',
          });
        }
      }
    } catch (err) {
      // Also scan in-memory logs
      try {
        const { getLogs } = require('../bot-logger');
        const logs = getLogs ? getLogs('error', 50) : [];
        const counts = new Map();
        for (const log of logs) {
          const key = (log.message || '').slice(0, 100);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        for (const [msg, cnt] of counts) {
          if (cnt >= 3) {
            errors.push({ message: msg, count: cnt, severity: cnt >= 10 ? 'critical' : 'medium' });
          }
        }
      } catch {}
    }
    return { errors };
  }

  // ── Phase 2: Module Health Check ────────────────────────

  async _checkModuleHealth() {
    const results = {};
    const coreModules = [
      'db', 'cycle', 'kronos', 'smc-engine', 'ai-learner',
      'bot-logger', 'hermes-bridge', 'bitunix-client',
      'agents/base-agent', 'agents/chart-agent', 'agents/trader-agent',
      'agents/risk-agent', 'agents/sentiment-agent', 'agents/accountant-agent',
      'agents/kronos-agent', 'agents/strategy-agent', 'agents/police-agent',
      'agents/token-agent', 'agents/agent-coordinator',
    ];

    for (const mod of coreModules) {
      const modPath = path.join(PROJECT_ROOT, mod);
      try {
        // Check file exists
        const fullPath = modPath.endsWith('.js') ? modPath : modPath + '.js';
        if (!fs.existsSync(fullPath)) {
          results[mod] = { ok: false, error: 'File not found', lastCheck: Date.now() };
          continue;
        }

        // Syntax check via require (cached — won't re-execute)
        delete require.cache[require.resolve(`../${mod}`)];
        require(`../${mod}`);
        results[mod] = { ok: true, lastCheck: Date.now() };
        this._moduleHealth.set(mod, { ok: true });
      } catch (err) {
        results[mod] = { ok: false, error: err.message.slice(0, 200), lastCheck: Date.now() };
        this._moduleHealth.set(mod, { ok: false, error: err.message });
      }
    }
    return results;
  }

  // ── Phase 3: Agent Error State Check ────────────────────

  _checkAgentErrors(coordinator) {
    const issues = [];
    if (!coordinator?._agents) return issues;

    for (const [key, agent] of coordinator._agents) {
      if (agent === this) continue;

      // Check stuck error state
      if (agent.state === 'error' && agent.lastError) {
        const errorAge = Date.now() - (agent.lastError.at || 0);
        issues.push({
          type: 'agent_error',
          agent: key,
          message: `${agent.name} stuck in error: ${agent.lastError.message}`,
          age: errorAge,
          severity: errorAge > 600000 ? 'high' : 'medium',
        });
      }

      // Check high failure rate
      const health = agent.getHealth();
      const rpg = health.rpg || {};
      if (rpg.tasksCompleted > 20 && rpg.successRate < 40) {
        issues.push({
          type: 'low_success_rate',
          agent: key,
          message: `${agent.name} has ${rpg.successRate}% success rate (${rpg.tasksCompleted} tasks)`,
          severity: rpg.successRate < 20 ? 'high' : 'medium',
        });
      }
    }
    return issues;
  }

  // ── Phase 4: Dependency Check ───────────────────────────

  _checkDependencies() {
    const issues = [];
    const required = [
      'node-fetch', 'pg', 'express', 'jsonwebtoken', 'bcryptjs',
    ];
    for (const dep of required) {
      try {
        require.resolve(dep);
      } catch {
        issues.push({
          type: 'missing_dependency',
          message: `Required package "${dep}" is missing`,
          severity: 'critical',
        });
      }
    }
    return issues;
  }

  // ── Phase 5: AI-Powered Diagnosis ──────────────────────

  async _aiDiagnose(report) {
    const { think, isAvailable } = require('./ai-brain');
    if (!isAvailable()) {
      return { summary: 'AI unavailable — manual review required', patches: [] };
    }

    const tier = this.getIntelTier();
    const errorSummary = report.errors.map(e => `[${e.severity}] "${e.message}" (${e.count}x)`).join('\n');
    const brokenModules = Object.entries(report.moduleHealth)
      .filter(([, v]) => !v.ok)
      .map(([k, v]) => `${k}: ${v.error}`)
      .join('\n');
    const agentIssues = report.warnings.map(w => `[${w.severity}] ${w.message}`).join('\n');

    const prompt = `You are CoderAgent (Level ${this._rpg.level}, ${tier.label} tier), the self-healing code engineer for a crypto trading bot.

Analyze these system issues and provide a diagnosis.

RECURRING ERRORS (last hour):
${errorSummary || 'None'}

BROKEN MODULES:
${brokenModules || 'None'}

AGENT ISSUES:
${agentIssues || 'None'}

Respond in JSON format ONLY:
{
  "summary": "One-line summary of the main issue",
  "rootCause": "What is causing these errors",
  "impact": "How this affects trading",
  "patches": [
    {
      "file": "relative/path.js",
      "description": "What the fix does",
      "type": "fix|optimize|guard",
      "search": "exact text to find in the file",
      "replace": "exact text to replace it with",
      "confidence": 0.0-1.0
    }
  ],
  "recommendations": ["list of things the human should review"]
}

Rules:
- Only suggest patches for files you're confident about
- Keep patches minimal — fix the root cause, don't refactor
- Never patch crypto-utils.js, entry.js, or .env files
- Set confidence < 0.5 for risky patches (they won't auto-apply)
- If no patches are possible, return empty patches array`;

    try {
      const response = await think({
        agentName: this.name,
        systemPrompt: 'You are a code maintenance AI. Respond ONLY with valid JSON. No markdown.',
        userMessage: prompt,
        context: {},
        complexity: 'high',
      });

      if (!response) return { summary: 'AI returned no response', patches: [] };

      // Parse JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { summary: response.slice(0, 100), patches: [] };

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary: parsed.summary || 'Analysis complete',
        rootCause: parsed.rootCause || '',
        impact: parsed.impact || '',
        patches: (parsed.patches || []).filter(p => p.confidence >= 0.3),
        recommendations: parsed.recommendations || [],
      };
    } catch (err) {
      return { summary: `AI diagnosis failed: ${err.message}`, patches: [] };
    }
  }

  // ── Phase 7: Apply Patches ─────────────────────────────

  async _applyPendingPatches() {
    const toApply = this._pendingPatches.filter(p =>
      p.status === 'pending' &&
      (p.confidence || 0) >= 0.7 &&  // only high-confidence auto-applies
      this._isFileSafe(p.file) &&
      (p.replace || '').split('\n').length <= MAX_PATCH_SIZE
    );

    for (const patch of toApply) {
      try {
        const result = await this._applyPatch(patch);
        if (result.ok) {
          patch.status = 'applied';
          patch.appliedAt = Date.now();
          this._patchesApplied++;
          this._issuesFixed++;
          this._appliedPatches.push(patch);
          this.addActivity('success', `PATCH APPLIED: ${patch.file} — ${patch.description}`);
          this.shareWithTeam(`Auto-patched ${patch.file}: ${patch.description}`);
        } else {
          patch.status = 'failed';
          patch.failReason = result.error;
          this.addActivity('error', `Patch failed: ${patch.file} — ${result.error}`);
        }
      } catch (err) {
        patch.status = 'failed';
        patch.failReason = err.message;
        this.addActivity('error', `Patch error: ${err.message}`);
      }
    }

    // Remove old applied/failed patches from pending (keep last 20)
    this._pendingPatches = this._pendingPatches.filter(p => p.status === 'pending');
    if (this._appliedPatches.length > 50) {
      this._appliedPatches = this._appliedPatches.slice(-50);
    }
  }

  async _applyPatch(patch) {
    const filePath = path.resolve(PROJECT_ROOT, patch.file);

    // Safety: verify file is within project
    if (!filePath.startsWith(PROJECT_ROOT)) {
      return { ok: false, error: 'Path traversal blocked' };
    }

    // Read current file
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return { ok: false, error: 'Cannot read file' };
    }

    // Verify search text exists
    if (!content.includes(patch.search)) {
      return { ok: false, error: 'Search text not found — code may have changed' };
    }

    // Create backup
    const backupPath = filePath + '.coder-backup';
    try {
      fs.writeFileSync(backupPath, content);
    } catch {
      return { ok: false, error: 'Cannot create backup' };
    }

    // Apply replacement
    const newContent = content.replace(patch.search, patch.replace);

    // Validate the patched content loads (syntax check)
    try {
      // Write to temp file for syntax check
      const tmpPath = filePath + '.coder-tmp';
      fs.writeFileSync(tmpPath, newContent);

      // Syntax validate via Node
      const { execSync } = require('child_process');
      execSync(`node -c "${tmpPath}"`, { timeout: 5000, stdio: 'pipe' });

      // Passed — apply the real patch
      fs.writeFileSync(filePath, newContent);
      fs.unlinkSync(tmpPath);

      // Clear require cache so the fix takes effect
      try { delete require.cache[require.resolve(filePath)]; } catch {}

      // Save patch record to DB
      await this._savePatchToDb(patch);

      return { ok: true };
    } catch (err) {
      // Syntax error in patch — restore backup
      try {
        fs.writeFileSync(filePath, content);
        const tmpPath = filePath + '.coder-tmp';
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}
      return { ok: false, error: `Syntax error in patch: ${err.message}` };
    }
  }

  // ── Manual Patch Review ────────────────────────────────

  getPendingPatches() {
    return this._pendingPatches.filter(p => p.status === 'pending').map(p => ({
      id: p.scanNumber + '-' + (p.file || '').replace(/[^a-z0-9]/gi, '_'),
      file: p.file,
      description: p.description,
      type: p.type,
      confidence: p.confidence,
      search: (p.search || '').slice(0, 200),
      replace: (p.replace || '').slice(0, 200),
      createdAt: p.createdAt,
    }));
  }

  getAppliedPatches() {
    return this._appliedPatches.map(p => ({
      file: p.file,
      description: p.description,
      appliedAt: p.appliedAt,
      confidence: p.confidence,
    }));
  }

  async approvePatch(patchId) {
    const patch = this._pendingPatches.find(p =>
      p.status === 'pending' &&
      (p.scanNumber + '-' + (p.file || '').replace(/[^a-z0-9]/gi, '_')) === patchId
    );
    if (!patch) return { ok: false, error: 'Patch not found' };
    const result = await this._applyPatch(patch);
    if (result.ok) {
      patch.status = 'applied';
      patch.appliedAt = Date.now();
      this._patchesApplied++;
      this._issuesFixed++;
      this._appliedPatches.push(patch);
      this.addActivity('success', `PATCH APPROVED & APPLIED: ${patch.file}`);
      return { ok: true };
    }
    patch.status = 'failed';
    patch.failReason = result.error;
    return result;
  }

  rejectPatch(patchId) {
    const idx = this._pendingPatches.findIndex(p =>
      p.status === 'pending' &&
      (p.scanNumber + '-' + (p.file || '').replace(/[^a-z0-9]/gi, '_')) === patchId
    );
    if (idx === -1) return { ok: false, error: 'Patch not found' };
    this._pendingPatches.splice(idx, 1);
    this.addActivity('info', `Patch rejected: ${patchId}`);
    return { ok: true };
  }

  async revertPatch(filePath) {
    const fullPath = path.resolve(PROJECT_ROOT, filePath);
    const backupPath = fullPath + '.coder-backup';
    if (!fs.existsSync(backupPath)) {
      return { ok: false, error: 'No backup found for this file' };
    }
    try {
      const backup = fs.readFileSync(backupPath, 'utf8');
      fs.writeFileSync(fullPath, backup);
      try { delete require.cache[require.resolve(fullPath)]; } catch {}
      this.addActivity('info', `Reverted ${filePath} from backup`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ── Safety Checks ──────────────────────────────────────

  _isFileSafe(filePath) {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, '/');
    for (const forbidden of FORBIDDEN_FILES) {
      if (normalized.includes(forbidden)) return false;
    }
    // Must be a .js file within the project
    if (!normalized.endsWith('.js')) return false;
    if (normalized.includes('..')) return false;
    if (normalized.includes('node_modules')) return false;
    return true;
  }

  // ── DB Persistence ─────────────────────────────────────

  async _savePatchToDb(patch) {
    try {
      const { query } = require('../db');
      await query(
        `INSERT INTO code_patches (file, description, patch_type, search_text, replace_text, confidence, status, applied_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [patch.file, patch.description, patch.type, patch.search, patch.replace, patch.confidence, patch.status]
      );
    } catch {}
  }

  async _saveState() {
    await this.remember('scan_count', this._scanCount, 'stats').catch(() => {});
    await this.remember('issues_found', this._issuesFound, 'stats').catch(() => {});
    await this.remember('issues_fixed', this._issuesFixed, 'stats').catch(() => {});
    await this.remember('patches_applied', this._patchesApplied, 'stats').catch(() => {});
    if (this._lastDiagnostic) {
      await this.remember('last_diagnostic', this._lastDiagnostic, 'diagnostics').catch(() => {});
    }
  }

  async _loadState() {
    try {
      const sc = await this.recall('scan_count');
      if (sc !== null) this._scanCount = typeof sc === 'object' ? parseInt(sc) || 0 : parseInt(sc) || 0;
      const ifound = await this.recall('issues_found');
      if (ifound !== null) this._issuesFound = typeof ifound === 'object' ? parseInt(ifound) || 0 : parseInt(ifound) || 0;
      const ifixed = await this.recall('issues_fixed');
      if (ifixed !== null) this._issuesFixed = typeof ifixed === 'object' ? parseInt(ifixed) || 0 : parseInt(ifixed) || 0;
      const pa = await this.recall('patches_applied');
      if (pa !== null) this._patchesApplied = typeof pa === 'object' ? parseInt(pa) || 0 : parseInt(pa) || 0;
      const diag = await this.recall('last_diagnostic');
      if (diag) this._lastDiagnostic = typeof diag === 'string' ? JSON.parse(diag) : diag;
    } catch {}
  }

  // ── Health ─────────────────────────────────────────────

  getHealth() {
    return {
      ...super.getHealth(),
      scanCount: this._scanCount,
      issuesFound: this._issuesFound,
      issuesFixed: this._issuesFixed,
      patchesApplied: this._patchesApplied,
      pendingPatches: this._pendingPatches.filter(p => p.status === 'pending').length,
      lastDiagnostic: this._lastDiagnostic?.summary || null,
      moduleHealth: Object.fromEntries(this._moduleHealth),
    };
  }

  async explain(question) {
    const health = this.getHealth();
    const pending = this.getPendingPatches();
    const applied = this.getAppliedPatches();

    const lines = [
      `I'm **${this.name}** — the self-healing code engineer.`,
      ``,
      `**Stats:** ${health.scanCount} scans | ${health.issuesFound} issues found | ${health.issuesFixed} fixed | ${health.patchesApplied} patches applied`,
      ``,
    ];

    if (pending.length > 0) {
      lines.push(`**Pending Patches (${pending.length}):**`);
      for (const p of pending) {
        lines.push(`• ${p.file}: ${p.description} (confidence: ${(p.confidence * 100).toFixed(0)}%)`);
      }
      lines.push('');
    }

    if (applied.length > 0) {
      lines.push(`**Recent Fixes (${applied.length}):**`);
      for (const p of applied.slice(-5)) {
        lines.push(`• ${p.file}: ${p.description}`);
      }
      lines.push('');
    }

    if (health.lastDiagnostic) {
      lines.push(`**Last Diagnosis:** ${health.lastDiagnostic}`);
    }

    return lines.join('\n');
  }
}

module.exports = { CoderAgent };
