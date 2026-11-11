// Кеш оболонки застосунку: застосунок відкривається без мережі зі збереженими даними.
const CACHE = 'zas-shell-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'core.js', 'manifest.webmanifest', 'icons/icon-192.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/data/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(e.request, { signal: ctl.signal, cache: 'no-cache' });
      clearTimeout(t);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      const hit = (await cache.match(e.request)) || (e.request.mode === 'navigate' && (await cache.match('index.html')));
      if (hit) return hit;
      throw err;
    }
  })());
});
