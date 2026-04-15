// ============================================================
// WatcherAgent — Custom user-created agent
//
// Monitors specific coins or conditions. Created from the
// Mission Control UI. Lightweight — just watches and alerts.
// ============================================================

const { BaseAgent } = require('./base-agent');

class WatcherAgent extends BaseAgent {
  constructor(name, options = {}) {
    super(name, options);
    this.watchSymbols = options.symbols || [];
    this.alertThreshold = options.alertThreshold || 3;
    this.alerts = [];

    this._profile = {
      description: options.description || `Custom watcher monitoring ${this.watchSymbols.join(', ') || 'configured coins'}.`,
      role: 'Custom Watcher',
      icon: 'watcher',
      skills: [
        { id: 'price_watch', name: 'Price Watch', description: 'Monitor price moves above threshold', enabled: true },
        { id: 'alert', name: 'Alert', description: 'Log alerts to activity feed', enabled: true },
      ],
      config: [
        { key: 'watchSymbols', label: 'Watch Symbols (comma-separated)', type: 'text', value: (options.symbols || []).join(',') },
        { key: 'alertThreshold', label: 'Alert Threshold %', type: 'number', value: options.alertThreshold || 3, min: 0.5, max: 20 },
      ],
    };
  }

  async execute(context = {}) {
    if (!this.watchSymbols.length) {
      this.addActivity('skip', 'No symbols to watch');
      return { alerts: [] };
    }

    this.currentTask = { description: `Watching ${this.watchSymbols.length} coins`, startedAt: Date.now() };

    const newAlerts = [];
    for (const sym of this.watchSymbols) {
      try {
        const fetch = require('node-fetch');
        const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${sym}`, { timeout: 5000 });
        if (!res.ok) continue;
        const data = await res.json();
        const pct = parseFloat(data.priceChangePercent || 0);
        if (Math.abs(pct) >= this.alertThreshold) {
          const alert = { symbol: sym, change: pct, price: parseFloat(data.lastPrice), ts: Date.now() };
          newAlerts.push(alert);
          this.addActivity(pct > 0 ? 'success' : 'warning', `${sym} ${pct > 0 ? '+' : ''}${pct.toFixed(2)}% @ $${alert.price}`);
        }
      } catch (_) {}
    }

    this.alerts = newAlerts;
    this.currentTask = null;
    return { alerts: newAlerts };
  }

  updateConfig(changes) {
    super.updateConfig(changes);
    if (changes.watchSymbols !== undefined) {
      const val = changes.watchSymbols;
      this.watchSymbols = typeof val === 'string' ? val.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : val;
      this._profile.config.find(c => c.key === 'watchSymbols').value = this.watchSymbols.join(',');
    }
    if (changes.alertThreshold !== undefined) {
      this.alertThreshold = parseFloat(changes.alertThreshold);
    }
  }

  getHealth() {
    return {
      ...super.getHealth(),
      watchSymbols: this.watchSymbols,
      alertCount: this.alerts.length,
      custom: true,
    };
  }
}

module.exports = { WatcherAgent };
