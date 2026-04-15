// ============================================================
// Trophy & Governance Engine — Monthly Champions & User Prefs
// ============================================================

const { query } = require('../db');

/**
 * Crowns the monthly champion based on the best Profit-to-Risk Ratio.
 * Triggered once every 30 days.
 */
async function crownMonthlyChampion() {
  try {
    const currentMonth = new Date().toLocaleString('en-GB', { month: 'short', year: 'numeric' });

    // 1. Gather performance data for all agents
    const agents = await query('SELECT agent FROM agent_profiles');
    const candidates = [];

    for (const row of agents) {
      const agent = row.agent;
      const profile = await query('SELECT monthly_pnl, monthly_risk FROM agent_profiles WHERE agent = $1', [agent]);
      if (!profile.length) continue;

      const pnl = parseFloat(profile[0].monthly_pnl) || 0;
      const risk = Math.abs(parseFloat(profile[0].monthly_risk)) || 1;

      // Profit-to-Risk Ratio (The Golden Metric)
      const ratio = pnl / risk;
      candidates.push({ agent, ratio, pnl });
    }

    if (candidates.length === 0) return null;

    // 2. Sort by ratio descending
    candidates.sort((a, b) => b.ratio - a.ratio);
    const champion = candidates[0];

    if (champion.ratio <= 0) return null; // No champion if no one made profit

    // 3. Award the trophy
    await query(
      `INSERT INTO agent_trophies (agent, month, trophy_type, buff_multiplier)
       VALUES ($1, $2, 'Monthly Champion', 0.2)
       ON CONFLICT (agent, month) DO UPDATE SET buff_multiplier = 0.2`,
      [champion.agent, currentMonth]
    );

    return {
      champion: champion.agent,
      ratio: champion.ratio,
      month: currentMonth
    };
  } catch (err) {
    console.error('[TrophyEngine] Error crowning champion:', err.message);
    return null;
  }
}

/**
 * Retrieves the preferred agent for a specific API key.
 * @param {number} apiKeyId
 */
async function getPreferredAgent(apiKeyId) {
  try {
    const rows = await query(
      'SELECT preferred_agent FROM user_agent_preferences WHERE api_key_id = $1',
      [apiKeyId]
    );
    return rows.length > 0 ? rows[0].preferred_agent : null;
  } catch (err) {
    return null;
  }
}

/**
 * Sets the preferred agent for a user's API key.
 */
async function setPreferredAgent(apiKeyId, agentName) {
  try {
    await query(
      `INSERT INTO user_agent_preferences (api_key_id, preferred_agent)
       VALUES ($1, $2)
       ON CONFLICT (api_key_id) DO UPDATE SET preferred_agent = $2`,
      [apiKeyId, agentName]
    );
    return true;
  } catch (err) {
    console.error('[TrophyEngine] Error setting preference:', err.message);
    return false;
  }
}

module.exports = {
  crownMonthlyChampion,
  getPreferredAgent,
  setPreferredAgent
};
