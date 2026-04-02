// ============================================================
// Shared proxy agent for static IP routing
// Set PROXY_URL env var to route all API calls through a proxy
// Supports HTTP/HTTPS and SOCKS5 proxies
// HTTP:   PROXY_URL=http://user:pass@host:9293
// SOCKS5: PROXY_URL=socks5://user:pass@host:1080
// ============================================================

const PROXY_URL = process.env.PROXY_URL || '';

let proxyAgent = null;

if (PROXY_URL) {
  try {
    const isSocks = PROXY_URL.startsWith('socks5://') || PROXY_URL.startsWith('socks4://') || PROXY_URL.startsWith('socks://');
    if (isSocks) {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      proxyAgent = new SocksProxyAgent(PROXY_URL);
      console.log('[PROXY] SOCKS5 proxy active →', PROXY_URL.replace(/:[^:@]+@/, ':***@'));
    } else {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      proxyAgent = new HttpsProxyAgent(PROXY_URL);
      console.log('[PROXY] HTTP proxy active →', PROXY_URL.replace(/:[^:@]+@/, ':***@'));
    }
  } catch (err) {
    console.error('[PROXY] Failed to initialize proxy agent:', err.message);
    console.error('[PROXY] Bot will run WITHOUT proxy — IP will NOT be static!');
  }
} else {
  console.warn('[PROXY] PROXY_URL not set — running without proxy (dynamic IP)');
}

function getFetchOptions() {
  if (!proxyAgent) return {};
  return { agent: proxyAgent };
}

function getBinanceRequestOptions() {
  if (!proxyAgent) return {};
  return { httpsAgent: proxyAgent };
}

function isProxyEnabled() {
  return !!proxyAgent;
}

module.exports = { getFetchOptions, getBinanceRequestOptions, isProxyEnabled };
