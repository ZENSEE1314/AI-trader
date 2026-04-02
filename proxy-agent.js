// ============================================================
// Shared proxy agent for static IP routing
// Set PROXY_URL env var to route all API calls through a proxy
// Supports HTTP/HTTPS/SOCKS proxies
// Example: PROXY_URL=http://user:pass@proxy.example.com:9293
// ============================================================

const PROXY_URL = process.env.PROXY_URL || '';

let proxyAgent = null;

if (PROXY_URL) {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  proxyAgent = new HttpsProxyAgent(PROXY_URL);
  console.log('[PROXY] Routing API calls through static IP proxy');
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
