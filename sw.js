/* ============================================================
   study-app sw.js
   app shell（index.html / app.js / styles.css / manifest.json / icons/*）
   をキャッシュするだけの Service Worker。fetch は cache-first。
   問題データ（questions/*.json）はユーザーがアプリ内でインポートして
   IndexedDB/localStorage に保存する運用のため、ここではキャッシュしない。
   更新時は CACHE_VERSION を上げるだけでよい。
   ============================================================ */

const CACHE_VERSION = 'v3';
const CACHE_NAME = `study-app-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // 同一オリジンのみキャッシュ対象にする（外部リクエストはそのままネットワークへ）
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
