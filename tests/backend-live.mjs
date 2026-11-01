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
const testKey = '44'.repeat(32);
let child;
let output = '';
function start(key) {
  const env = { ...process.env, JOT_DATA_DIR: directory, JOT_ALLOW_REGISTRATION: 'true', JOT_APP_ORIGIN: origin, JOT_SECURE_COOKIES: 'false' };
  delete env.JOT_TRUST_PROXY_IP_HEADER;
  if (key === undefined) delete env.JOT_ENCRYPTION_KEY; else env.JOT_ENCRYPTION_KEY = key;
  child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
}
async function ready(expectedStatus = 200) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${output}`);
    try { if ((await fetch(`${origin}/api/auth/session`)).status === expectedStatus) return; } catch { /* still starting */ }
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
try {
  start(testKey);
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
  assert.equal(response.value.complete, true);
  assert.equal(response.value.notes[0].role, 'editor');
  assert.equal((await json('/api/notebooks', { account: editor })).value.complete, true);
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
  const uploaded = await call(attachmentPath, { method: 'PUT', account: editor, headers: { 'Content-Type': 'text/plain', 'X-Jot-Filename': encodeURIComponent('private filename.txt'), 'X-Jot-Created-At': timestamp, 'X-Jot-Note-Version': '2' }, body: 'private attachment bytes' });
  assert.equal(uploaded.status, 200, await uploaded.text());
  const downloaded = await call(attachmentPath, { account: owner });
  assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
  assert.equal(await downloaded.text(), 'private attachment bytes');
  response = await json(`/api/notes/${note.id}`, { method: 'PUT', account: owner, body: { operationId: randomUUID(), baseVersion: 2, note: edited } });
  assert.equal(response.value.version, 3);
  const staleDelete = await call(attachmentPath, { method: 'DELETE', account: editor, headers: { 'X-Jot-Note-Version': '2' } });
  assert.equal(staleDelete.status, 409);
  assert.equal((await staleDelete.json()).serverVersion, 3);
  assert.equal(await (await call(attachmentPath, { account: owner })).text(), 'private attachment bytes');
  const staleUpload = await call(`/api/notes/${note.id}/attachments/${randomUUID()}`, { method: 'PUT', account: editor,
    headers: { 'Content-Type': 'text/plain', 'X-Jot-Filename': 'stale.txt', 'X-Jot-Created-At': timestamp, 'X-Jot-Note-Version': '2' }, body: 'stale' });
  assert.equal(staleUpload.status, 409);
  assert.equal((await call(attachmentPath, { account: outsider })).status, 404);
  assert.equal((await call('/api/notes', { account: owner, headers: { 'X-Jot-Workspace': editor.user.id } })).status, 409);
  const badOrigin = await call(`/api/notes/${note.id}`, { method: 'PUT', account: owner, headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify(payload) });
  assert.equal(badOrigin.status, 403);
  await stop();
  const disk = readFileSync(path.join(directory, 'jot.sqlite'));
  for (const secret of ['uniquely private live smoke body', 'editor saved body', 'private notebook smoke', 'private title smoke', 'private live comment', 'private filename.txt', 'private attachment bytes']) {
    assert.ok(!disk.includes(Buffer.from(secret)), `${secret} leaked to the database file`);
  }
  // Sessions, login and inherited permissions survive a real process restart.
  start(testKey); await ready();
  response = await json('/api/auth/session', { account: owner });
  assert.equal(response.value.user.id, owner.user.id);
  response = await json('/api/auth/login', { method: 'POST', body: { email: editor.user.email, password: 'synthetic test password' } });
  assert.equal(response.res.status, 200);
  const signedInAgain = { ...response.value, cookie: response.res.headers.get('set-cookie').split(';')[0] };
  assert.equal((await json('/api/notes', { account: signedInAgain })).value.notes[0].note.body, 'editor saved body');
  assert.equal((await json(`/api/notes/${note.id}/comments`, { account: signedInAgain })).value.comments[0].body, 'private live comment');
  assert.equal(await (await call(attachmentPath, { account: signedInAgain })).text(), 'private attachment bytes');
  response = await json(`/api/notebooks/${book.id}/shares`, { method: 'DELETE', account: owner, body: { email: editor.user.email } });
  assert.equal(response.res.status, 200);
  assert.deepEqual((await json('/api/notes', { account: signedInAgain })).value.notes, []);
  assert.equal((await call(attachmentPath, { account: signedInAgain })).status, 404);
  await stop();
  // A missing or wrong key never falls back to plaintext or modifies data.
  for (const wrongKey of [undefined, '55'.repeat(32)]) {
    start(wrongKey); await ready(500);
    response = await json('/api/auth/session', { account: owner });
    assert.equal(response.res.status, 500);
    assert.deepEqual(response.value, { error: 'Internal server error' });
    await stop();
  }
  start(testKey); await ready();
  assert.equal((await json('/api/notes', { account: owner })).value.notes[0].note.body, 'editor saved body');
  await stop();
  console.log('Production HTTP smoke passed: encrypted restart/key failures, account login, ACL/revocation, CAS/idempotency, comments, attachments, origin/workspace guards and encrypted disk content.');
} finally {
  await stop();
  rmSync(directory, { recursive: true, force: true });
}
