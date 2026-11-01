/* Cache the public application shell and hashed build assets only, never API data. */
const CACHE = 'jot-offline-shell-v1';

async function cacheShell() {
  const cache = await caches.open(CACHE);
  const [shell, manifestResponse] = await Promise.all([
    fetch('/', { cache: 'reload' }),
    fetch('/offline-assets.json', { cache: 'no-store' }),
  ]);
  if (!shell.ok || !manifestResponse.ok) throw new Error('Offline shell is not available.');
  const manifest = await manifestResponse.json();
  if (!Array.isArray(manifest.assets)) throw new Error('Invalid offline manifest.');
  const assets = manifest.assets.filter((item) => typeof item === 'string' && item.startsWith('/_next/static/'));
  // Prepare all assets first; only replace the cached HTML when they succeeded.
  // This avoids a shell referring to chunks that were never cached.
  await cache.addAll(assets);
  await cache.put('/', shell);
}
self.addEventListener('install', (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'refresh-offline-shell') event.waitUntil(cacheShell().catch(() => {}));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith((async () => {
      try { return await fetch(request); }
      catch { return (await (await caches.open(CACHE)).match('/')) || Response.error(); }
    })());
  } else if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })());
  }
});
