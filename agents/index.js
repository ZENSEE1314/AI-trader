// ============================================================
// Agent Framework — Public API
// ============================================================

const { BaseAgent, AGENT_STATES } = require('./base-agent');
const { ChartAgent } = require('./chart-agent');
const { TraderAgent } = require('./trader-agent');
const { RiskAgent } = require('./risk-agent');
const { SentimentAgent } = require('./sentiment-agent');
const { AccountantAgent } = require('./accountant-agent');
const { WatcherAgent } = require('./watcher-agent');
const { AgentCoordinator, getCoordinator } = require('./agent-coordinator');

module.exports = {
  BaseAgent,
  AGENT_STATES,
  ChartAgent,
  TraderAgent,
  RiskAgent,
  SentimentAgent,
  AccountantAgent,
  WatcherAgent,
  AgentCoordinator,
  getCoordinator,
};
