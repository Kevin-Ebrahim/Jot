import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('offline worker precaches shell and assets, serves them offline, and ignores API data', async () => {
  const handlers: Record<string, (event: any) => void> = {};
  const contents = new Map<string, Response>();
  let online = true;
  let activated = false;
  const base = 'https://jot.example';
  const key = (input: string | Request) => { const url = new URL(typeof input === 'string' ? input : input.url, base); url.hash = ''; return url.href; };
  const network = async (input: string | Request) => {
    if (!online) throw new TypeError('offline');
    const url = new URL(typeof input === 'string' ? input : input.url, base);
    if (url.pathname === '/') return new Response('<html>Jot shell</html>');
    if (url.pathname === '/offline-assets.json') return Response.json({ assets: ['/_next/static/a.js', '/_next/static/a.css'] });
    if (url.pathname.startsWith('/_next/static/')) return new Response(`asset:${url.pathname}`);
    return new Response('private api response');
  };
  const cache = {
    async addAll(urls: string[]) {
      const staged = await Promise.all(urls.map(async url => [key(url), await network(url)] as const));
      for (const [url, response] of staged) contents.set(url, response.clone());
    },
    async put(url: string | Request, response: Response) { contents.set(key(url), response.clone()); },
    async match(url: string | Request) {
      const response = contents.get(key(url))?.clone();
      if (response) Object.defineProperty(response, 'url', { value: key(url) });
      return response;
    },
  };
  const self = { location: { origin: base }, addEventListener(name: string, handler: (event: any) => void) { handlers[name] = handler; },
    skipWaiting() { activated = true; }, clients: { async claim() {} } };
  runInNewContext(readFileSync('public/sw.js', 'utf8'), { self, caches: { async open() { return cache; } }, fetch: network, URL, Response, Request });
  const installPromises: Promise<unknown>[] = [];
  handlers.install({ waitUntil(promise: Promise<unknown>) { installPromises.push(promise); } });
  await Promise.all(installPromises);
  assert.equal(activated, true);
  assert.equal(await (await cache.match('/'))?.text(), '<html>Jot shell</html>');
  assert.ok(await cache.match('/_next/static/a.js'));
  assert.ok(await cache.match('/_next/static/a.css'));
  online = false;
  let response: Promise<Response> | undefined;
  handlers.fetch({ request: { method: 'GET', url: `${base}/`, mode: 'navigate' }, respondWith(value: Promise<Response>) { response = value; } });
  assert.equal(await (await response!).text(), '<html>Jot shell</html>');
  handlers.fetch({ request: { method: 'GET', url: `${base}/_next/static/a.js`, mode: 'no-cors' }, respondWith(value: Promise<Response>) { response = value; } });
  assert.equal(await (await response!).text(), 'asset:/_next/static/a.js');
  await cache.put('/_next/static/turbopack-worker-test.js', new Response('worker bootstrap', { headers: { 'Content-Type': 'application/javascript' } }));
  handlers.fetch({ request: { method: 'GET', url: `${base}/_next/static/turbopack-worker-test.js#params=abc`, mode: 'same-origin', destination: 'worker' }, respondWith(value: Promise<Response>) { response = value; } });
  const workerResponse = await response!;
  assert.equal(workerResponse.url, ''); // retain the request's fragment, rather than a cached response URL
  assert.equal(workerResponse.headers.get('Content-Type'), 'application/javascript');
  assert.equal(await workerResponse.text(), 'worker bootstrap');
  let intercepted = false;
  handlers.fetch({ request: { method: 'GET', url: `${base}/api/notes`, mode: 'cors' }, respondWith() { intercepted = true; } });
  assert.equal(intercepted, false);
  handlers.fetch({ request: { method: 'PUT', url: `${base}/api/notes/1`, mode: 'cors' }, respondWith() { intercepted = true; } });
  assert.equal(intercepted, false);
});
