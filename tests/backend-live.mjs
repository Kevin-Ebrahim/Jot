/**
 * Production HTTP smoke test against an isolated temporary server/database.
 * Run `npm run build && node tests/backend-live.mjs`. This never uses the
 * operator's configured database or accounts.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const directory = mkdtempSync(path.join(tmpdir(), 'jot-live-http-'));
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: process.cwd(), env: { ...process.env, JOT_DATA_DIR: directory, JOT_ALLOW_REGISTRATION: 'true', JOT_ENCRYPTION_KEY: '44'.repeat(32), JOT_APP_ORIGIN: origin, JOT_SECURE_COOKIES: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
async function ready() {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${output}`);
    try { if ((await fetch(`${origin}/api/auth/session`)).ok) return; } catch { /* still starting */ }
    await delay(100);
  }
  throw new Error(`Server did not start: ${output}`);
}
function call(url, { method = 'GET', body, account, headers = {} } = {}) {
  return fetch(origin + url, { method, headers: { ...(method === 'GET' ? {} : { Origin: origin }), ...(account ? { Cookie: account.cookie, 'X-CSRF-Token': account.csrfToken, 'X-Jot-Workspace': account.user.id } : {}), ...headers }, body });
}
async function json(url, options = {}) {
  const res = await call(url, { ...options, headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
  const value = await res.json();
  return { res, value };
}
async function account(label) {
  const { res, value } = await json('/api/auth/register', { method: 'POST', body: { email: `${label}-${randomUUID()}@example.test`, password: 'synthetic test password' } });
  assert.equal(res.status, 201, JSON.stringify(value));
  return { ...value, cookie: res.headers.get('set-cookie').split(';')[0] };
}
let stopped = false;
try {
  await ready();
  const owner = await account('owner');
  const editor = await account('editor');
  const outsider = await account('outsider');
  const timestamp = new Date().toISOString();
  const book = { id: randomUUID(), name: 'private notebook smoke', createdAt: timestamp, updatedAt: timestamp, deletedAt: null };
  let response = await json(`/api/notebooks/${book.id}`, { method: 'PUT', account: owner, body: { operationId: randomUUID(), baseVersion: 0, notebook: book } });
  assert.equal(response.res.status, 200, JSON.stringify(response.value));
  response = await json(`/api/notebooks/${book.id}/shares`, { method: 'POST', account: owner, body: { email: editor.user.email, role: 'editor' } });
  assert.equal(response.res.status, 200, JSON.stringify(response.value));
  const note = { id: randomUUID(), title: 'private title smoke', body: 'uniquely private live smoke body', tags: [], notebookId: book.id, createdAt: timestamp, updatedAt: timestamp, deletedAt: null, pinned: false };
  const operationId = randomUUID();
  const payload = { operationId, baseVersion: 0, note };
  response = await json(`/api/notes/${note.id}`, { method: 'PUT', account: owner, body: payload });
  assert.equal(response.res.status, 200, JSON.stringify(response.value));
  assert.equal(response.value.version, 1);
  response = await json(`/api/notes/${note.id}`, { method: 'PUT', account: owner, body: payload });
  assert.equal(response.value.version, 1);
  response = await json('/api/notes', { account: editor });
  assert.equal(response.value.notes[0].role, 'editor');
  assert.deepEqual((await json('/api/notes', { account: outsider })).value.notes, []);
  const edited = { ...note, body: 'editor saved body' };
  response = await json(`/api/notes/${note.id}`, { method: 'PUT', account: editor, body: { operationId: randomUUID(), baseVersion: 1, note: edited } });
  assert.equal(response.value.version, 2);
  response = await json(`/api/notes/${note.id}`, { method: 'PUT', account: owner, body: { operationId: randomUUID(), baseVersion: 1, note: { ...note, body: 'offline draft' } } });
  assert.equal(response.res.status, 409);
  assert.equal(response.value.serverNote.body, 'editor saved body');
  response = await json(`/api/notes/${note.id}`, { method: 'PUT', account: editor, body: { operationId: randomUUID(), baseVersion: 2, note: { ...edited, deletedAt: timestamp } } });
  assert.equal(response.res.status, 403);
  response = await json(`/api/notes/${note.id}/comments`, { method: 'POST', account: editor, body: { body: 'private live comment' } });
  assert.equal(response.res.status, 201);
  const attachmentId = randomUUID();
  const attachmentPath = `/api/notes/${note.id}/attachments/${attachmentId}`;
  response = await json(`/api/notes/${note.id}/attachments`, { account: editor });
  assert.equal(response.value.attachments.length, 0);
  const uploaded = await call(attachmentPath, { method: 'PUT', account: editor, headers: { 'Content-Type': 'text/plain', 'X-Jot-Filename': encodeURIComponent('private filename.txt'), 'X-Jot-Created-At': timestamp }, body: 'private attachment bytes' });
  assert.equal(uploaded.status, 200, await uploaded.text());
  const downloaded = await call(attachmentPath, { account: owner });
  assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
  assert.equal(await downloaded.text(), 'private attachment bytes');
  assert.equal((await call(attachmentPath, { account: outsider })).status, 404);
  assert.equal((await call('/api/notes', { account: owner, headers: { 'X-Jot-Workspace': editor.user.id } })).status, 409);
  const badOrigin = await call(`/api/notes/${note.id}`, { method: 'PUT', account: owner, headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify(payload) });
  assert.equal(badOrigin.status, 403);
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve)); stopped = true;
  const disk = readFileSync(path.join(directory, 'jot.sqlite'));
  for (const secret of ['uniquely private live smoke body', 'editor saved body', 'private notebook smoke', 'private title smoke', 'private live comment', 'private filename.txt', 'private attachment bytes']) {
    assert.ok(!disk.includes(Buffer.from(secret)), `${secret} leaked to the database file`);
  }
  console.log('Production HTTP smoke passed: accounts, notebook ACL, CAS/idempotency, comments, attachments, origin/workspace guards and encrypted disk content.');
} finally {
  if (!stopped && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  rmSync(directory, { recursive: true, force: true });
}
