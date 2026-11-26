/* ==========================================================
   交易手记 · Service Worker
   只缓存应用外壳（HTML/CSS/JS/图标），数据在 IndexedDB 里，不经过这里。
   策略：缓存优先 + 后台更新（stale-while-revalidate），
        离线可用；发新版后第二次打开即更新。
   ========================================================== */
const CACHE = 'trade-diary-v1';
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
    const hit = await cache.match(req);

    const network = fetch(req)
      .then(res => {
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      })
      .catch(() => null);

    if (hit) return hit;

    const res = await network;
    if (res) return res;

    if (req.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    return new Response('离线且未缓存', { status: 503, statusText: 'Offline' });
  })());
});
