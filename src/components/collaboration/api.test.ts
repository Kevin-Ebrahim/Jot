import assert from 'node:assert/strict';
import test from 'node:test';
import { CollaborationApiError, entityPath, messageForError, request } from './api';

const originalFetch = globalThis.fetch;

test('collaboration requests use same-origin credentials and CSRF only on writes', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), init });
    return Response.json({ ok: true });
  };
  await request('/api/auth/session', { csrfToken: 'token' });
  await request('/api/notes/one/shares', { method: 'POST', csrfToken: 'token', body: { email: 'reader@example.test', role: 'viewer' } });
  assert.equal(calls[0].init?.credentials, 'same-origin');
  assert.equal(calls[0].init?.cache, 'no-store');
  assert.equal(new Headers(calls[0].init?.headers).get('X-CSRF-Token'), null);
  assert.equal(new Headers(calls[1].init?.headers).get('X-CSRF-Token'), 'token');
  assert.equal(new Headers(calls[1].init?.headers).get('Content-Type'), 'application/json');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { email: 'reader@example.test', role: 'viewer' });
  assert.equal(entityPath('note', 'id/part'), '/api/notes/id%2Fpart');
  assert.equal(entityPath('notebook', 'id'), '/api/notebooks/id');
});

test('collaboration errors retain server status without treating an invalid response as success', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ error: 'Account not found' }, { status: 404 });
  await assert.rejects(request('/api/notes/id/shares'), (error: unknown) =>
    error instanceof CollaborationApiError && error.status === 404 && error.message === 'Account not found');
  globalThis.fetch = async () => new Response('not json', { status: 200 });
  await assert.rejects(request('/api/auth/session'), /invalid response/i);
  assert.match(messageForError(new TypeError('Failed to fetch')), /connection/i);
});
