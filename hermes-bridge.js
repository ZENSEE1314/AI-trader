// ============================================================
// Hermes Bridge — Node.js ↔ Hermes Agent integration layer
//
// Provides:
//   - Memory system (read/write MEMORY.md per agent via § delimiter)
//   - TTS generation (edge-tts voice notes for Telegram)
//   - Deep reasoning (ask Hermes for complex analysis via subprocess)
//   - Skill awareness (scan & invoke Hermes skills)
//   - Soul loading (SOUL.md personality injection)
// ============================================================

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { log: bLog } = require('./bot-logger');

// ── Paths ───────────────────────────────────────────────────
const HERMES_HOME = process.env.HERMES_HOME
  || path.join(process.env.LOCALAPPDATA || path.join(require('os').homedir(), '.local', 'share'), 'hermes');
const HERMES_AGENT_DIR = path.join(HERMES_HOME, 'hermes-agent');
const HERMES_MEMORIES_DIR = path.join(HERMES_HOME, 'memories');
const HERMES_SKILLS_DIR = path.join(HERMES_HOME, 'skills');
const HERMES_CONFIG_PATH = path.join(HERMES_HOME, 'config.yaml');
const HERMES_CLI = path.join(HERMES_AGENT_DIR, 'cli.py');

const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';
const ENTRY_DELIMITER = '\n§\n';
const MEMORY_CHAR_LIMIT = 2200;
const USER_CHAR_LIMIT = 1375;
const SUBPROCESS_TIMEOUT_MS = 90_000;

// ── Soul ────────────────────────────────────────────────────

let _soulCache = null;
let _soulLoadedAt = 0;
const SOUL_CACHE_TTL_MS = 5 * 60_000;

/**
 * Load the trading bot's soul from SOUL.md.
 * Checks bot-local SOUL.md first, then Hermes home.
 */
function loadSoul() {
  if (_soulCache && Date.now() - _soulLoadedAt < SOUL_CACHE_TTL_MS) return _soulCache;

  const localSoul = path.join(__dirname, 'SOUL.md');
  const hermesSoul = path.join(HERMES_HOME, 'SOUL.md');

  for (const soulPath of [localSoul, hermesSoul]) {
    try {
      if (fs.existsSync(soulPath)) {
        _soulCache = fs.readFileSync(soulPath, 'utf-8').trim();
        _soulLoadedAt = Date.now();
        return _soulCache;
      }
    } catch {}
  }
  return null;
}

// ── Memory System ───────────────────────────────────────────
// Per-agent memory files using Hermes § delimiter format.
// Each agent gets its own MEMORY.md: memories/ChartAgent.md, etc.

function getAgentMemoryPath(agentName) {
  const safeName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(HERMES_MEMORIES_DIR, `${safeName}.md`);
}

function ensureMemoryDir() {
  try {
    if (!fs.existsSync(HERMES_MEMORIES_DIR)) {
      fs.mkdirSync(HERMES_MEMORIES_DIR, { recursive: true });
    }
  } catch {}
}

/**
 * Read all memory entries for an agent.
 * @returns {string[]} Array of memory entries
 */
function readMemory(agentName) {
  const memPath = getAgentMemoryPath(agentName);
  try {
    if (!fs.existsSync(memPath)) return [];
    const raw = fs.readFileSync(memPath, 'utf-8').trim();
    if (!raw) return [];
    return raw.split(ENTRY_DELIMITER).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Add a memory entry for an agent.
 * Respects char limit — evicts oldest entries if over limit.
 */
function addMemory(agentName, entry) {
  ensureMemoryDir();
  const entries = readMemory(agentName);
  entries.push(entry.trim());

  // Enforce char limit — remove oldest entries until under limit
  let joined = entries.join(ENTRY_DELIMITER);
  while (joined.length > MEMORY_CHAR_LIMIT && entries.length > 1) {
    entries.shift();
    joined = entries.join(ENTRY_DELIMITER);
  }

  const memPath = getAgentMemoryPath(agentName);
  try {
    fs.writeFileSync(memPath, joined, 'utf-8');
    return { success: true, entryCount: entries.length, usage: `${joined.length}/${MEMORY_CHAR_LIMIT} chars` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Remove a memory entry by partial text match.
 */
function removeMemory(agentName, partialText) {
  const entries = readMemory(agentName);
  const idx = entries.findIndex(e => e.includes(partialText));
  if (idx === -1) return { success: false, error: 'Entry not found' };

  entries.splice(idx, 1);
  const joined = entries.join(ENTRY_DELIMITER);
  const memPath = getAgentMemoryPath(agentName);
  try {
    fs.writeFileSync(memPath, joined, 'utf-8');
    return { success: true, removed: true, entryCount: entries.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get formatted memory for injection into system prompt.
 */
function getMemoryPrompt(agentName) {
  const entries = readMemory(agentName);
  if (!entries.length) return null;
  return `<agent_memory>\n${entries.join('\n---\n')}\n</agent_memory>`;
}

// ── Shared Team Memory ──────────────────────────────────────
// All agents share a team MEMORY.md for cross-agent knowledge

const TEAM_MEMORY_PATH = path.join(HERMES_MEMORIES_DIR, 'TEAM.md');

function readTeamMemory() {
  try {
    if (!fs.existsSync(TEAM_MEMORY_PATH)) return [];
    const raw = fs.readFileSync(TEAM_MEMORY_PATH, 'utf-8').trim();
    if (!raw) return [];
    return raw.split(ENTRY_DELIMITER).filter(Boolean);
  } catch { return []; }
}

function addTeamMemory(entry) {
  ensureMemoryDir();
  const entries = readTeamMemory();
  entries.push(entry.trim());

  let joined = entries.join(ENTRY_DELIMITER);
  while (joined.length > MEMORY_CHAR_LIMIT && entries.length > 1) {
    entries.shift();
    joined = entries.join(ENTRY_DELIMITER);
  }

  try {
    fs.writeFileSync(TEAM_MEMORY_PATH, joined, 'utf-8');
    return { success: true, entryCount: entries.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function getTeamMemoryPrompt() {
  const entries = readTeamMemory();
  if (!entries.length) return null;
  return `<team_memory>\n${entries.join('\n---\n')}\n</team_memory>`;
}

// ── TTS (Text-to-Speech) ───────────────────────────────────
// Uses edge-tts (free, no API key) via Python subprocess.

const TTS_OUTPUT_DIR = path.join(__dirname, 'data', 'tts');

function ensureTtsDir() {
  try {
    if (!fs.existsSync(TTS_OUTPUT_DIR)) fs.mkdirSync(TTS_OUTPUT_DIR, { recursive: true });
  } catch {}
}

/**
 * Generate a voice message using edge-tts.
 * @param {string} text - Text to speak
 * @param {object} opts - { voice, format }
 * @returns {Promise<{success: boolean, filePath?: string, error?: string}>}
 */
function generateTTS(text, opts = {}) {
  const voice = opts.voice || 'en-US-AriaNeural';
  const format = opts.format || 'mp3';
  ensureTtsDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `tts_${timestamp}.${format}`;
  const outputPath = path.join(TTS_OUTPUT_DIR, fileName);

  // edge-tts Python one-liner — no Hermes dependency needed
  const script = `
import asyncio, edge_tts, sys
async def main():
    c = edge_tts.Communicate(sys.argv[1], sys.argv[2])
    await c.save(sys.argv[3])
    print(sys.argv[3])
asyncio.run(main())
`.trim();

  return new Promise((resolve) => {
    execFile(PYTHON_CMD, ['-c', script, text.slice(0, 4000), voice, outputPath],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          bLog.error(`[Hermes TTS] Failed: ${err.message}`);
          resolve({ success: false, error: err.message });
          return;
        }
        resolve({ success: true, filePath: outputPath.trim() || stdout.trim() });
      }
    );
  });
}

// ── Deep Reasoning (Hermes subprocess) ──────────────────────
// For complex analysis that benefits from Hermes's full tool suite.

/**
 * Ask Hermes a question via CLI subprocess.
 * Returns the AI response as a string.
 *
 * @param {string} question - The prompt/question
 * @param {object} opts - { toolsets, maxTurns, quiet }
 * @returns {Promise<string|null>}
 */
function askHermes(question, opts = {}) {
  const maxTurns = opts.maxTurns || 3;
  const quiet = opts.quiet !== false;

  // Check if Hermes CLI exists
  if (!fs.existsSync(HERMES_CLI)) {
    return Promise.resolve(null);
  }

  const args = [HERMES_CLI, '-q', question, '--max-turns', String(maxTurns)];
  if (quiet) args.push('--quiet');
  if (opts.toolsets) args.push('--toolsets', opts.toolsets);

  return new Promise((resolve) => {
    execFile(PYTHON_CMD, args,
      {
        timeout: SUBPROCESS_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
        cwd: HERMES_AGENT_DIR,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      },
      (err, stdout, stderr) => {
        if (err) {
          bLog.error(`[Hermes] CLI error: ${err.message}`);
          resolve(null);
          return;
        }
        const response = stdout.trim();
        if (!response) {
          resolve(null);
          return;
        }
        resolve(response);
      }
    );
  });
}

// ── Skills Scanner ──────────────────────────────────────────
// Scans Hermes skills directory for available skill commands.

let _skillsCache = null;
let _skillsLoadedAt = 0;
const SKILLS_CACHE_TTL_MS = 10 * 60_000;

/**
 * Scan Hermes skills and return a map of command → { name, description, path }.
 */
function scanSkills() {
  if (_skillsCache && Date.now() - _skillsLoadedAt < SKILLS_CACHE_TTL_MS) return _skillsCache;

  const skills = new Map();

  try {
    if (!fs.existsSync(HERMES_SKILLS_DIR)) return skills;

    const scanDir = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          scanDir(path.join(dir, entry.name));
        } else if (entry.name === 'SKILL.md') {
          try {
            const raw = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
            const frontmatter = parseFrontmatter(raw);
            if (frontmatter.name) {
              const cmdKey = `/${frontmatter.name.toLowerCase().replace(/[\s_]/g, '-')}`;
              skills.set(cmdKey, {
                name: frontmatter.name,
                description: frontmatter.description || '',
                version: frontmatter.version || '1.0.0',
                path: dir,
              });
            }
          } catch {}
        }
      }
    };

    scanDir(HERMES_SKILLS_DIR);
    _skillsCache = skills;
    _skillsLoadedAt = Date.now();
  } catch {}

  return skills;
}

/**
 * Parse YAML-like frontmatter from SKILL.md (simple key: value pairs).
 */
function parseFrontmatter(raw) {
  const result = {};
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return result;

  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) result[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return result;
}

/**
 * Get skill descriptions formatted for system prompt injection.
 * Only includes trading-relevant skills.
 */
function getSkillsPrompt() {
  const skills = scanSkills();
  if (!skills.size) return null;

  const RELEVANT_TAGS = ['research', 'analysis', 'data', 'web', 'search', 'finance', 'trading', 'notification'];
  const relevant = [];

  for (const [cmd, info] of skills) {
    const desc = (info.description || '').toLowerCase();
    if (RELEVANT_TAGS.some(tag => desc.includes(tag) || cmd.includes(tag))) {
      relevant.push(`• ${cmd} — ${info.description}`);
    }
  }

  if (!relevant.length) return null;
  return `<available_skills>\n${relevant.slice(0, 20).join('\n')}\n</available_skills>`;
}

// ── Workspace Awareness ─────────────────────────────────────
// Reads HERMES.md or .hermes.md from bot directory for context.

function loadWorkspaceContext() {
  const candidates = ['HERMES.md', '.hermes.md', 'CLAUDE.md'];
  for (const name of candidates) {
    const filePath = path.join(__dirname, name);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        return content.slice(0, 2000); // Cap at 2k chars
      }
    } catch {}
  }
  return null;
}

// ── Status & Health ─────────────────────────────────────────

function getHermesStatus() {
  const cliExists = fs.existsSync(HERMES_CLI);
  const skillCount = scanSkills().size;
  const soul = loadSoul();

  return {
    installed: cliExists,
    hermesHome: HERMES_HOME,
    skillCount,
    hasSoul: !!soul,
    memoriesDir: HERMES_MEMORIES_DIR,
    ttsDir: TTS_OUTPUT_DIR,
  };
}

// ── Exports ─────────────────────────────────────────────────
module.exports = {
  // Soul
  loadSoul,

  // Memory
  readMemory,
  addMemory,
  removeMemory,
  getMemoryPrompt,
  readTeamMemory,
  addTeamMemory,
  getTeamMemoryPrompt,

  // TTS
  generateTTS,

  // Deep reasoning
  askHermes,

  // Skills
  scanSkills,
  getSkillsPrompt,

  // Workspace
  loadWorkspaceContext,

  // Status
  getHermesStatus,

  // Constants
  HERMES_HOME,
  HERMES_MEMORIES_DIR,
};
