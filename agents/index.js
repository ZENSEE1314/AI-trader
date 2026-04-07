// ============================================================
// Agent Framework — Public API
// ============================================================

const { BaseAgent, AGENT_STATES } = require('./base-agent');
const { ChartAgent } = require('./chart-agent');
const { TraderAgent } = require('./trader-agent');
const { AgentCoordinator, getCoordinator } = require('./agent-coordinator');

module.exports = {
  BaseAgent,
  AGENT_STATES,
  ChartAgent,
  TraderAgent,
  AgentCoordinator,
  getCoordinator,
};
