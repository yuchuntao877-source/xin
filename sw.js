/* ==========================================================
   交易手记 · Service Worker
   策略：联网优先（network-first），断网时回落缓存。
   为什么不用缓存优先：应用还在改，缓存优先会让手机上一直跑旧版，
   出现"代码改了但行为没变"的假象。数据都在 IndexedDB 里，不经过这里。
   ========================================================== */
const CACHE = 'trade-diary-v13';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './zip.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // 绕过 HTTP 缓存，尽量拿最新文件
      const res = await fetch(req, { cache: 'no-store' });
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (e) {
      const hit = await cache.match(req);
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
      }
      return new Response('离线且没有缓存', { status: 503, statusText: 'Offline' });
    }
  })());
});





