// MCT Service Worker — required for PWA installability.
// Network-first strategy: always fetch fresh data (trading app must be real-time).
'use strict';

const CACHE = 'mct-shell-v2';
const SHELL = ['/css/tokens.css', '/css/style.css', '/img/logo.jpeg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // API calls and non-GET requests always go to network.
  if (e.request.method !== 'GET' || e.request.url.includes('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }
  // Navigations must bypass the HTTP cache: a stale cached index.html once
  // pinned a months-old app.js for every user (hid live positions).
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // For everything else: network first, fall back to cache.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
