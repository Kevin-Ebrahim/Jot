/**
 * Exercises the real client sync adapter and real production HTTP backend with
 * fake-indexeddb (not a browser). Run after a build:
 *   node --import tsx tests/backend-client-live.mts
 * The server uses a disposable database and synthetic test accounts.
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getWorkspaceDb, jotStore, switchWorkspace } from '../src/lib/store';
import { listConflicts, resolveConflict, syncWorkspace } from '../src/lib/sync';

const directory = mkdtempSync(path.join(tmpdir(), 'jot-live-client-'));
const probe = net.createServer();
await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
const address = probe.address();
assert.ok(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>(resolve => probe.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const env: NodeJS.ProcessEnv = { ...process.env, JOT_DATA_DIR: directory, JOT_ALLOW_REGISTRATION: 'true',
  JOT_APP_ORIGIN: origin, JOT_SECURE_COOKIES: 'false', JOT_ENCRYPTION_KEY: '66'.repeat(32) };
delete env.JOT_TRUST_PROXY_IP_HEADER;
const child: ChildProcess = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)],
  { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout?.on('data', chunk => { output += chunk; });
child.stderr?.on('data', chunk => { output += chunk; });
const nativeFetch = globalThis.fetch;
interface Account { user: { id: string; email: string }; csrfToken: string; cookie: string }
async function ready() {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
    try { if ((await nativeFetch(`${origin}/api/auth/session`)).ok) return; } catch { /* starting */ }
    await delay(100);
  }
  throw new Error(`Server did not start: ${output}`);
}
async function account(label: string): Promise<Account> {
  const response = await nativeFetch(`${origin}/api/auth/register`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${label}-${randomUUID()}@example.test`, password: 'synthetic test password' }) });
  assert.equal(response.status, 201);
  const body = await response.json() as Omit<Account, 'cookie'>;
  return { ...body, cookie: response.headers.get('set-cookie')!.split(';')[0] };
}
async function share(owner: Account, notebookId: string, email: string) {
  const response = await nativeFetch(`${origin}/api/notebooks/${notebookId}/shares`, { method: 'POST', headers: { Origin: origin, Cookie: owner.cookie,
    'Content-Type': 'application/json', 'X-CSRF-Token': owner.csrfToken }, body: JSON.stringify({ email, role: 'editor' }) });
  assert.equal(response.status, 200, await response.text());
}
let current: Account;
let dropNextWrite = false;
let offline = false;
globalThis.fetch = async (input, init) => {
  if (offline) throw new TypeError('simulated offline');
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, origin);
  const headers = new Headers(init?.headers);
  headers.set('Cookie', current.cookie);
  if ((init?.method || 'GET') !== 'GET') headers.set('Origin', origin);
  const response = await nativeFetch(url, { ...init, headers });
  if (dropNextWrite && init?.method === 'PUT' && /^\/api\/notes\/[^/]+$/.test(url.pathname)) {
    dropNextWrite = false; offline = true;
    throw new TypeError('simulated lost response');
  }
  return response;
};
try {
  await ready();
  const owner = await account('sync-owner');
  const editor = await account('sync-editor');
  current = owner; await switchWorkspace(owner.user.id);
  const book = await jotStore.createNotebook('Live shared notebook');
  const original = await jotStore.createNote({ title: 'Live sync note', body: 'original', notebookId: book.id });
  const attachment = await jotStore.addAttachment(original.id, new Blob(['live sync bytes'], { type: 'text/plain' }), 'file.txt');
  const linked = await jotStore.updateNote(original.id, { body: `original attachment:${attachment.id}` }, original.revision);
  const initial = await syncWorkspace();
  assert.deepEqual(initial.errors, []);
  assert.equal((await jotStore.getNote(original.id))?.syncState, 'synced');
  await share(owner, book.id, editor.user.email);
  current = editor; await switchWorkspace(editor.user.id);
  const pull = await syncWorkspace();
  assert.deepEqual(pull.errors, []);
  const editorCopy = (await jotStore.getNote(original.id))!;
  assert.equal(editorCopy.role, 'editor');
  assert.equal(await (await jotStore.listAttachments(original.id))[0].blob.text(), 'live sync bytes');
  await jotStore.updateNote(original.id, { body: 'editor server change' }, editorCopy.revision);
  assert.deepEqual((await syncWorkspace()).errors, []);
  current = owner; await switchWorkspace(owner.user.id);
  const ownerCopy = (await jotStore.getNote(original.id))!;
  assert.equal(ownerCopy.revision, linked.revision);
  await jotStore.updateNote(original.id, { body: `owner offline draft attachment:${attachment.id}` }, ownerCopy.revision);
  const conflictResult = await syncWorkspace();
  assert.equal(conflictResult.conflicts, 1);
  const conflict = (await listConflicts())[0];
  assert.equal((conflict.server as { body: string }).body, 'editor server change');
  assert.match((conflict.local as { body: string }).body, /owner offline draft/);
  await resolveConflict(conflict.id, 'both', conflict.local.revision, conflict.serverVersion);
  assert.deepEqual((await syncWorkspace()).errors, []);
  const copy = (await jotStore.listNotes()).find(note => note.title.includes('conflict copy'))!;
  assert.ok(copy);
  assert.equal(await (await jotStore.listAttachments(copy.id))[0].blob.text(), 'live sync bytes');
  const retry = await jotStore.createNote({ title: 'Lost response', body: 'saved exactly once' });
  dropNextWrite = true;
  const interrupted = await syncWorkspace();
  assert.ok(interrupted.errors.length > 0);
  assert.equal((await (await getWorkspaceDb()).getAll('outbox')).length, 1);
  offline = false;
  const recovered = await syncWorkspace();
  assert.deepEqual(recovered.errors, []);
  assert.equal((await jotStore.getNote(retry.id))?.serverVersion, 1);
  assert.equal((await (await getWorkspaceDb()).getAll('outbox')).length, 0);
  console.log('Real client-to-production-server sync passed with fake-indexeddb: shared notebook/attachment pull, conflict preservation, both-copy resolution, and lost-response retry.');
} finally {
  globalThis.fetch = nativeFetch;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
  rmSync(directory, { recursive: true, force: true });
}
