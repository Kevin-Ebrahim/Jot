import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/server/db';
import { login, logout, register, requireCsrf, session, trustedClientIp } from '../src/server/auth';
import { HttpError } from '../src/server/errors';
import { requireSameOrigin } from '../src/server/http';
import { Repository } from '../src/server/repository';
import { date } from '../src/server/validation';
import type { ServerNote, ServerNotebook } from '../src/server/validation';

const now = '2026-11-01T12:00:00.000Z';
function user(db: DatabaseSync, email: string): { id: string; email: string } {
  const result = { id: randomUUID(), email };
  db.prepare('INSERT INTO users (id,email,password_salt,password_hash,created_at) VALUES (?,?,?,?,?)')
    .run(result.id, result.email, 'salt', 'hash', now);
  return result;
}
function note(partial: Partial<ServerNote> = {}): ServerNote {
  return { id: randomUUID(), title: 'A note', body: 'Original', tags: ['work'], notebookId: null, createdAt: now, updatedAt: now, deletedAt: null, pinned: false, ...partial };
}
function notebook(partial: Partial<ServerNotebook> = {}): ServerNotebook {
  return { id: randomUUID(), name: 'Notebook', createdAt: now, updatedAt: now, deletedAt: null, ...partial };
}
function errorStatus(status: number) {
  return (error: unknown): boolean => error instanceof HttpError && error.status === status;
}

test('accounts use salted password hashes, expiring sessions and CSRF tokens', async () => {
  const db = openDatabase(':memory:');
  try {
    await assert.rejects(register(db, 'alice@example.test', 'short'), errorStatus(400));
    const registered = await register(db, 'Alice@Example.Test', 'correct horse battery staple');
    assert.equal(registered.user.email, 'alice@example.test');
    assert.notEqual(registered.token, registered.csrfToken);
    const row = db.prepare('SELECT password_salt, password_hash FROM users WHERE id=?').get(registered.user.id) as { password_salt: string; password_hash: string };
    assert.match(row.password_salt, /^[0-9a-f]{32}$/);
    assert.equal(row.password_hash.length, 128);
    assert.ok(!row.password_hash.includes('correct horse'));
    await assert.rejects(login(db, 'alice@example.test', 'incorrect password'), errorStatus(401));
    const loggedIn = await login(db, 'alice@example.test', 'correct horse battery staple');
    const req = new Request('http://localhost:3000/api/auth/session', { headers: { cookie: `jot_session=${loggedIn.token}` } });
    assert.deepEqual(session(db, req)?.user, registered.user);
    assert.throws(() => requireCsrf(req, loggedIn), errorStatus(403));
    requireCsrf(new Request(req.url, { headers: { 'x-csrf-token': loggedIn.csrfToken } }), loggedIn);
    const expired = db.prepare('SELECT token_hash FROM sessions WHERE user_id=? ORDER BY rowid DESC LIMIT 1').get(loggedIn.user.id) as { token_hash: string };
    db.prepare('UPDATE sessions SET expires_at=0 WHERE token_hash=?').run(expired.token_hash);
    assert.equal(session(db, req), null);
    logout(db, registered);
    assert.equal(session(db, new Request(req.url, { headers: { cookie: `jot_session=${registered.token}` } })), null);
  } finally { db.close(); }
});

test('state-changing calls require exact origin', () => {
  const url = 'http://localhost:3000/api/notes';
  assert.throws(() => requireSameOrigin(new Request(url)), errorStatus(403));
  assert.throws(() => requireSameOrigin(new Request(url, { headers: { origin: 'https://evil.example' } })), errorStatus(403));
  requireSameOrigin(new Request(url, { headers: { origin: 'http://localhost:3000' } }));
  // Next can normalize the internal URL to localhost even if the browser is
  // on 127.0.0.1; only the operator-set canonical origin defines trust.
  const custom = new Request('http://localhost:3215/api/notes', { headers: { origin: 'http://127.0.0.1:3215', 'x-forwarded-host': '127.0.0.1:3215' } });
  assert.throws(() => requireSameOrigin(custom), errorStatus(403));
  process.env.JOT_APP_ORIGIN = 'http://127.0.0.1:3215';
  try {
    requireSameOrigin(custom);
    assert.throws(() => requireSameOrigin(new Request(custom.url, { headers: { origin: 'http://localhost:3215', 'x-forwarded-host': '127.0.0.1:3215' } })), errorStatus(403));
    process.env.JOT_APP_ORIGIN = 'http://127.0.0.1:3215/path';
    assert.throws(() => requireSameOrigin(custom), errorStatus(500));
  } finally { delete process.env.JOT_APP_ORIGIN; }
});

test('CAS preserves the winning write and idempotency survives restart', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'jot-db-'));
  const filename = path.join(directory, 'jot.sqlite');
  let db = openDatabase(filename);
  try {
    const alice = user(db, 'alice@example.test');
    let repo = new Repository(db);
    const original = note();
    const operation = randomUUID();
    const first = repo.putNote(alice.id, operation, 0, original);
    assert.equal(first.version, 1);
    assert.deepEqual(repo.putNote(alice.id, operation, 0, original), first);
    db.close();
    db = openDatabase(filename); repo = new Repository(db);
    assert.deepEqual(repo.putNote(alice.id, operation, 0, original), first);
    assert.throws(() => repo.putNote(alice.id, operation, 0, { ...original, body: 'mismatch' }), errorStatus(409));
    const winner = repo.putNote(alice.id, randomUUID(), 1, { ...original, body: 'Winner' });
    assert.equal(winner.version, 2);
    // A retry after a subsequent writer must not acknowledge the wrong version.
    assert.throws(() => repo.putNote(alice.id, operation, 0, original), errorStatus(409));
    assert.throws(() => repo.putNote(alice.id, randomUUID(), 1, { ...original, body: 'Offline draft' }), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 409);
      assert.equal(error.details?.serverVersion, 2);
      assert.equal((error.details?.serverNote as ServerNote).body, 'Winner');
      return true;
    });
    assert.equal(repo.listNotes(alice.id)[0].note.body, 'Winner');
    const receiptColumns = db.prepare('PRAGMA table_info(operations)').all() as Array<{ name: string }>;
    assert.ok(!receiptColumns.some(column => column.name === 'response_json'));
    assert.ok(!(JSON.stringify(db.prepare('SELECT * FROM operations').all()).includes('Winner')));
    db.prepare('UPDATE operations SET created_at = 0 WHERE operation_id = ?').run(operation);
    assert.throws(() => repo.putNote(alice.id, operation, 0, original), errorStatus(409));
    const tombstone = repo.putNote(alice.id, randomUUID(), 2, { ...winner.note, deletedAt: now });
    assert.equal(tombstone.version, 3);
    assert.equal(repo.listNotes(alice.id)[0].note.deletedAt, now);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('private notes, inherited shares, direct shares, roles and comments enforce access', () => {
  const db = openDatabase(':memory:');
  try {
    const owner = user(db, 'owner@example.test');
    const viewer = user(db, 'viewer@example.test');
    const editor = user(db, 'editor@example.test');
    const stranger = user(db, 'stranger@example.test');
    const repo = new Repository(db);
    const book = notebook();
    repo.putNotebook(owner.id, randomUUID(), 0, book);
    const item = note({ notebookId: book.id });
    repo.putNote(owner.id, randomUUID(), 0, item);
    assert.deepEqual(repo.listNotes(stranger.id), []);
    assert.throws(() => repo.listComments(stranger.id, item.id), errorStatus(404));
    repo.changeShare('notebook', owner.id, book.id, viewer.email, 'viewer');
    assert.equal(repo.listNotes(viewer.id)[0].role, 'viewer');
    assert.throws(() => repo.putNote(viewer.id, randomUUID(), 1, { ...item, body: 'forbidden' }), errorStatus(403));
    assert.throws(() => repo.addComment(viewer, item.id, 'no'), errorStatus(403));
    assert.throws(() => repo.changeShare('notebook', viewer.id, book.id, stranger.email, 'editor'), errorStatus(403));
    // A direct editor grant works even without access to the parent notebook.
    repo.changeShare('note', owner.id, item.id, editor.email, 'editor');
    assert.deepEqual(repo.listNotebooks(editor.id), []);
    assert.equal(repo.listNotes(editor.id)[0].role, 'editor');
    const edit = repo.putNote(editor.id, randomUUID(), 1, { ...item, body: 'Edited' });
    assert.equal(edit.version, 2);
    assert.throws(() => repo.putNote(editor.id, randomUUID(), 2, { ...edit.note, deletedAt: now }), errorStatus(403));
    assert.throws(() => repo.putNote(editor.id, randomUUID(), 2, { ...edit.note, notebookId: null }), errorStatus(403));
    const comment = repo.addComment(editor, item.id, 'A useful comment');
    assert.equal(repo.listComments(viewer.id, item.id)[0].body, 'A useful comment');
    assert.throws(() => repo.deleteComment(viewer.id, item.id, comment.id), errorStatus(403));
    repo.changeShare('note', owner.id, item.id, editor.email, 'viewer');
    assert.throws(() => repo.deleteComment(editor.id, item.id, comment.id), errorStatus(403));
    repo.changeShare('note', owner.id, item.id, editor.email, 'editor');
    repo.deleteComment(owner.id, item.id, comment.id);
    assert.deepEqual(repo.listComments(editor.id, item.id), []);
    repo.changeShare('note', owner.id, item.id, editor.email, null);
    assert.deepEqual(repo.listNotes(editor.id), []);
    assert.throws(() => repo.listComments(editor.id, item.id), errorStatus(404));
  } finally { db.close(); }
});

test('calendar dates must round-trip exactly and proxy IP headers are opt-in', () => {
  assert.equal(date('2026-02-28T12:00:00.000Z', 'date'), '2026-02-28T12:00:00.000Z');
  assert.equal(date('2024-02-29T12:00:00Z', 'date'), '2024-02-29T12:00:00Z');
  assert.throws(() => date('2026-02-30T12:00:00.000Z', 'date'), errorStatus(400));
  assert.throws(() => date('2023-02-29T12:00:00Z', 'date'), errorStatus(400));
  const req = new Request('http://localhost:3000/', { headers: { 'x-real-ip': '203.0.113.42', 'x-forwarded-for': '198.51.100.42' } });
  assert.equal(trustedClientIp(req), undefined);
  process.env.JOT_TRUST_PROXY_IP_HEADER = 'x-real-ip';
  try {
    assert.equal(trustedClientIp(req), '203.0.113.42');
    assert.throws(() => trustedClientIp(new Request(req.url, { headers: { 'x-real-ip': '203.0.113.42, 198.51.100.1' } })), errorStatus(400));
    assert.throws(() => trustedClientIp(new Request(req.url)), errorStatus(400));
  } finally { delete process.env.JOT_TRUST_PROXY_IP_HEADER; }
});

test('account-specific limits do not lock unrelated registrations', async () => {
  const db = openDatabase(':memory:');
  process.env.JOT_ALLOW_REGISTRATION = 'true';
  try {
    // Previously a single global 30-attempt bucket locked every account out.
    for (let i = 0; i < 31; i++) await register(db, `independent-${i}@example.test`, 'a sufficiently long password');
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 31);
  } finally { db.close(); delete process.env.JOT_ALLOW_REGISTRATION; }
});

test('only one initial account can bootstrap unless registration is explicitly opened', async () => {
  const db = openDatabase(':memory:');
  try {
    const attempts = await Promise.allSettled([
      register(db, 'bootstrap-one@example.test', 'a sufficiently long password'),
      register(db, 'bootstrap-two@example.test', 'a sufficiently long password'),
    ]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(result => result.status === 'rejected' && result.reason instanceof HttpError && result.reason.status === 403).length, 1);
  } finally { db.close(); }
});

test('shared notebook editors can create notes; owner-only deletion moves notes safely', () => {
  const db = openDatabase(':memory:');
  try {
    const owner = user(db, 'owner@example.test');
    const editor = user(db, 'editor@example.test');
    const repo = new Repository(db);
    const book = notebook();
    repo.putNotebook(owner.id, randomUUID(), 0, book);
    repo.changeShare('notebook', owner.id, book.id, editor.email, 'editor');
    const item = note({ notebookId: book.id });
    const created = repo.putNote(editor.id, randomUUID(), 0, item);
    assert.equal(created.role, 'editor');
    assert.equal(repo.listNotes(owner.id)[0].role, 'owner');
    assert.throws(() => repo.putNotebook(editor.id, randomUUID(), 1, { ...book, deletedAt: now }), errorStatus(403));
    repo.putNotebook(owner.id, randomUUID(), 1, { ...book, deletedAt: now });
    const detached = repo.listNotes(owner.id)[0];
    assert.equal(detached.note.notebookId, null);
    assert.equal(detached.note.body, item.body);
    assert.equal(detached.version, 2);
    assert.deepEqual(repo.listNotes(editor.id), []);
    assert.throws(() => repo.putNote(owner.id, randomUUID(), 1, { ...item, body: 'stale edit' }), errorStatus(409));
  } finally { db.close(); }
});

test('HTTP routes enforce session, CSRF, origin and server-side permissions', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'jot-http-'));
  process.env.JOT_DATA_DIR = directory;
  process.env.JOT_ALLOW_REGISTRATION = 'true';
  const origin = 'http://localhost:3000';
  const registerRoute = await import('../src/app/api/auth/register/route');
  const sessionRoute = await import('../src/app/api/auth/session/route');
  const logoutRoute = await import('../src/app/api/auth/logout/route');
  const notesRoute = await import('../src/app/api/notes/route');
  const noteRoute = await import('../src/app/api/notes/[id]/route');
  const shareRoute = await import('../src/app/api/notes/[id]/shares/route');
  function req(route: string, method: string, body?: unknown, cookie?: string, csrf?: string, suppliedOrigin = origin): Request {
    const headers: Record<string, string> = { origin: suppliedOrigin };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-csrf-token'] = csrf;
    return new Request(`${origin}${route}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }
  async function account(email: string) {
    const response = await registerRoute.POST(req('/api/auth/register', 'POST', { email, password: 'a strong password here' }));
    assert.equal(response.status, 201);
    const cookie = response.headers.get('set-cookie');
    assert.ok(cookie?.includes('HttpOnly'));
    assert.ok(cookie?.includes('SameSite=Strict'));
    const result = await response.json() as { user: { id: string; email: string }; csrfToken: string };
    return { ...result, cookie: cookie!.split(';')[0] };
  }
  try {
    assert.equal((await notesRoute.GET(req('/api/notes', 'GET'))).status, 401);
    assert.equal((await registerRoute.POST(req('/api/auth/register', 'POST', { email: 'evil@example.test', password: 'a strong password here' }, undefined, undefined, 'https://evil.example'))).status, 403);
    const alice = await account('http-alice@example.test');
    const bob = await account('http-bob@example.test');
    assert.equal((await notesRoute.GET(new Request(`${origin}/api/notes`, { headers: { cookie: alice.cookie, 'x-jot-workspace': bob.user.id } }))).status, 409);
    assert.equal((await notesRoute.GET(new Request(`${origin}/api/notes`, { headers: { cookie: alice.cookie, 'x-jot-workspace': alice.user.id } }))).status, 200);
    const current = await sessionRoute.GET(req('/api/auth/session', 'GET', undefined, alice.cookie));
    assert.equal((await current.json()).user.email, alice.user.email);
    const item = note();
    const payload = { baseVersion: 0, operationId: randomUUID(), note: item };
    const ctx = { params: Promise.resolve({ id: item.id }) };
    assert.equal((await noteRoute.PUT(req(`/api/notes/${item.id}`, 'PUT', payload, alice.cookie), ctx)).status, 403);
    assert.equal((await noteRoute.PUT(req(`/api/notes/${item.id}`, 'PUT', payload, alice.cookie, alice.csrfToken, 'https://evil.example'), ctx)).status, 403);
    const saved = await noteRoute.PUT(req(`/api/notes/${item.id}`, 'PUT', payload, alice.cookie, alice.csrfToken), ctx);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).version, 1);
    // Valid local text can exceed 1.2 MiB once JSON-escaped on the wire.
    const large = note({ body: '\u0000'.repeat(250_000) });
    const largeCtx = { params: Promise.resolve({ id: large.id }) };
    assert.equal((await noteRoute.PUT(req(`/api/notes/${large.id}`, 'PUT', { baseVersion: 0, operationId: randomUUID(), note: large }, alice.cookie, alice.csrfToken), largeCtx)).status, 200);
    assert.deepEqual((await (await notesRoute.GET(req('/api/notes', 'GET', undefined, bob.cookie))).json()).notes, []);
    const share = await shareRoute.POST(req(`/api/notes/${item.id}/shares`, 'POST', { email: bob.user.email, role: 'viewer' }, alice.cookie, alice.csrfToken), ctx);
    assert.equal(share.status, 200);
    assert.equal((await (await notesRoute.GET(req('/api/notes', 'GET', undefined, bob.cookie))).json()).notes[0].role, 'viewer');
    const badEdit = { baseVersion: 1, operationId: randomUUID(), note: { ...item, body: 'not allowed' } };
    assert.equal((await noteRoute.PUT(req(`/api/notes/${item.id}`, 'PUT', badEdit, bob.cookie, bob.csrfToken), ctx)).status, 403);
    const loggedOut = await logoutRoute.POST(req('/api/auth/logout', 'POST', undefined, alice.cookie, alice.csrfToken));
    assert.equal(loggedOut.status, 200);
    assert.equal((await notesRoute.GET(req('/api/notes', 'GET', undefined, alice.cookie))).status, 401);
  } finally {
    const holder = globalThis as typeof globalThis & { __jotDatabase?: DatabaseSync };
    holder.__jotDatabase?.close();
    delete holder.__jotDatabase;
    delete process.env.JOT_DATA_DIR;
    delete process.env.JOT_ALLOW_REGISTRATION;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('attachment sync is ACL-scoped, immutable, bounded and tombstoned', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'jot-attachments-'));
  process.env.JOT_DATA_DIR = directory;
  process.env.JOT_ALLOW_REGISTRATION = 'true';
  const origin = 'http://localhost:3000';
  const registerRoute = await import('../src/app/api/auth/register/route');
  const noteRoute = await import('../src/app/api/notes/[id]/route');
  const shareRoute = await import('../src/app/api/notes/[id]/shares/route');
  const listRoute = await import('../src/app/api/notes/[id]/attachments/route');
  const itemRoute = await import('../src/app/api/notes/[id]/attachments/[attachmentId]/route');
  function jsonReq(url: string, method: string, body: unknown, cookie?: string, csrf?: string): Request {
    return new Request(origin + url, { method, headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: JSON.stringify(body) });
  }
  async function account(email: string) {
    const res = await registerRoute.POST(jsonReq('/api/auth/register', 'POST', { email, password: 'another strong password' }));
    assert.equal(res.status, 201);
    const { user, csrfToken } = await res.json();
    return { user, csrfToken, cookie: res.headers.get('set-cookie')!.split(';')[0] };
  }
  try {
    const alice = await account('attachments-owner@example.test');
    const bob = await account('attachments-viewer@example.test');
    const stranger = await account('attachments-stranger@example.test');
    const item = note();
    const noteCtx = { params: Promise.resolve({ id: item.id }) };
    await noteRoute.PUT(jsonReq(`/api/notes/${item.id}`, 'PUT', { baseVersion: 0, operationId: randomUUID(), note: item }, alice.cookie, alice.csrfToken), noteCtx);
    await shareRoute.POST(jsonReq(`/api/notes/${item.id}/shares`, 'POST', { email: bob.user.email, role: 'viewer' }, alice.cookie, alice.csrfToken), noteCtx);
    const attachmentId = randomUUID();
    const attachmentCtx = { params: Promise.resolve({ id: item.id, attachmentId }) };
    const endpoint = `${origin}/api/notes/${item.id}/attachments/${attachmentId}`;
    const bytes = new TextEncoder().encode('<script>alert(1)</script>');
    function upload(who: typeof alice, data = bytes, foreignOrigin = origin): Request {
      return new Request(endpoint, { method: 'PUT', headers: { origin: foreignOrigin, cookie: who.cookie, 'x-csrf-token': who.csrfToken,
        'x-jot-filename': encodeURIComponent('../../te\u202est.html'), 'x-jot-created-at': now, 'x-jot-note-version': '1', 'content-type': 'text/html' }, body: Uint8Array.from(data) });
    }
    assert.equal((await itemRoute.PUT(upload(alice, bytes, 'https://evil.example'), attachmentCtx)).status, 403);
    assert.equal((await itemRoute.PUT(upload(bob), attachmentCtx)).status, 403);
    assert.equal((await itemRoute.PUT(upload(stranger), attachmentCtx)).status, 404);
    const uploaded = await itemRoute.PUT(upload(alice), attachmentCtx);
    assert.equal(uploaded.status, 200);
    const metadata = (await uploaded.json()).attachment;
    assert.equal(metadata.name, '.._.._te_st.html');
    assert.equal(metadata.mimeType, 'text/html');
    assert.equal(metadata.size, bytes.length);
    assert.equal((await itemRoute.PUT(upload(alice), attachmentCtx)).status, 200);
    assert.equal((await itemRoute.PUT(upload(alice, new TextEncoder().encode('other')), attachmentCtx)).status, 409);
    const list = await listRoute.GET(new Request(`${origin}/api/notes/${item.id}/attachments`, { headers: { cookie: bob.cookie } }), noteCtx);
    assert.equal((await list.json()).attachments[0].id, attachmentId);
    const download = await itemRoute.GET(new Request(endpoint, { headers: { cookie: bob.cookie } }), attachmentCtx);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.match(download.headers.get('content-disposition')!, /^attachment;/);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.match(download.headers.get('content-security-policy')!, /sandbox/);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
    assert.equal((await itemRoute.GET(new Request(endpoint, { headers: { cookie: stranger.cookie } }), attachmentCtx)).status, 404);
    const remove = () => new Request(endpoint, { method: 'DELETE', headers: { origin, cookie: alice.cookie, 'x-csrf-token': alice.csrfToken, 'x-jot-note-version': '1' } });
    const deleted = (await (await itemRoute.DELETE(remove(), attachmentCtx)).json()).attachment;
    assert.ok(deleted.deletedAt);
    assert.deepEqual((await (await itemRoute.DELETE(remove(), attachmentCtx)).json()).attachment, deleted);
    assert.equal((await itemRoute.GET(new Request(endpoint, { headers: { cookie: bob.cookie } }), attachmentCtx)).status, 404);
    assert.equal((await itemRoute.PUT(upload(alice), attachmentCtx)).status, 409);
    assert.equal((await (await listRoute.GET(new Request(`${origin}/api/notes/${item.id}/attachments`, { headers: { cookie: bob.cookie } }), noteCtx)).json()).attachments[0].deletedAt, deleted.deletedAt);
    const bigCtx = { params: Promise.resolve({ id: item.id, attachmentId: randomUUID() }) };
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    assert.equal((await itemRoute.PUT(upload(alice, big), bigCtx)).status, 413);
    process.env.JOT_MAX_USER_STORAGE_BYTES = '2';
    const quotaCtx = { params: Promise.resolve({ id: item.id, attachmentId: randomUUID() }) };
    assert.equal((await itemRoute.PUT(upload(alice), quotaCtx)).status, 413);
  } finally {
    const holder = globalThis as typeof globalThis & { __jotDatabase?: DatabaseSync };
    holder.__jotDatabase?.close(); delete holder.__jotDatabase;
    delete process.env.JOT_DATA_DIR; delete process.env.JOT_MAX_USER_STORAGE_BYTES; delete process.env.JOT_ALLOW_REGISTRATION;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy receipts are migrated to bounded body-free records', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'jot-receipt-migration-'));
  const filename = path.join(directory, 'jot.sqlite');
  let db = openDatabase(filename);
  try {
    const alice = user(db, 'migration@example.test');
    db.exec(`DROP TABLE operations; CREATE TABLE operations (
      user_id TEXT NOT NULL REFERENCES users(id), operation_id TEXT NOT NULL,
      target TEXT NOT NULL, payload_hash TEXT NOT NULL, response_json TEXT NOT NULL,
      PRIMARY KEY (user_id, operation_id))`);
    db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?, ?)').run(alice.id, randomUUID(), 'note:old', 'abc', JSON.stringify({ version: 7, note: { body: 'private old response' } }));
    db.close();
    db = openDatabase(filename);
    const rows = db.prepare('SELECT * FROM operations').all();
    assert.equal((rows[0] as { result_version: number }).result_version, 7);
    assert.ok(!JSON.stringify(rows).includes('private old response'));
    const repo = new Repository(db);
    db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 10000)
      INSERT INTO operations (user_id, operation_id, target, payload_hash, result_version, created_at)
      SELECT ?, 'fake-' || x, 'note:fake', 'hash', 1, ? FROM n`).run(alice.id, Date.now());
    repo.putNote(alice.id, randomUUID(), 0, note());
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM operations WHERE user_id=?').get(alice.id) as { count: number }).count, 10_000);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('zero-byte and deleted attachment records count toward an owner quota', () => {
  const db = openDatabase(':memory:');
  process.env.JOT_MAX_USER_STORAGE_BYTES = '0';
  process.env.JOT_MAX_USER_ATTACHMENT_RECORDS = '2';
  try {
    const owner = user(db, 'quota@example.test');
    const repo = new Repository(db);
    const item = note();
    repo.putNote(owner.id, randomUUID(), 0, item);
    const a = randomUUID(), b = randomUUID();
    repo.putAttachment(owner.id, item.id, a, 'empty.txt', 'text/plain', now, new Uint8Array(), 1);
    repo.deleteAttachment(owner.id, item.id, a, 1);
    repo.putAttachment(owner.id, item.id, b, 'empty.txt', 'text/plain', now, new Uint8Array(), 1);
    assert.throws(() => repo.putAttachment(owner.id, item.id, randomUUID(), 'empty.txt', 'text/plain', now, new Uint8Array(), 1), errorStatus(413));
    assert.equal(repo.listAttachments(owner.id, item.id).length, 2);
    // A valid retry does not consume another record.
    assert.equal(repo.putAttachment(owner.id, item.id, b, 'empty.txt', 'text/plain', now, new Uint8Array(), 1).id, b);
  } finally { db.close(); delete process.env.JOT_MAX_USER_STORAGE_BYTES; delete process.env.JOT_MAX_USER_ATTACHMENT_RECORDS; }
});

test('optional content-at-rest encryption authenticates key and encrypts all content fields', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'jot-encrypted-'));
  const filename = path.join(directory, 'jot.sqlite');
  const key = '11'.repeat(32); // Fixed test fixture, not a deployment key.
  process.env.JOT_ENCRYPTION_KEY = key;
  let db: DatabaseSync | undefined;
  try {
    db = openDatabase(filename);
    const owner = user(db, 'encrypted@example.test');
    let repo = new Repository(db);
    const book = notebook({ name: 'secret notebook name' });
    repo.putNotebook(owner.id, randomUUID(), 0, book);
    const item = note({ notebookId: book.id, title: 'secret title', body: 'uniquely secret note body' });
    const op = randomUUID();
    repo.putNote(owner.id, op, 0, item);
    const comment = repo.addComment(owner, item.id, 'uniquely secret comment');
    const attachmentId = randomUUID();
    const payload = new TextEncoder().encode('uniquely secret attachment bytes');
    repo.putAttachment(owner.id, item.id, attachmentId, 'secret filename.txt', 'text/plain', now, payload, 1);
    const rawNote = db.prepare('SELECT data_json FROM notes WHERE id=?').get(item.id) as { data_json: string };
    const rawBook = db.prepare('SELECT data_json FROM notebooks WHERE id=?').get(book.id) as { data_json: string };
    const rawComment = db.prepare('SELECT body FROM comments WHERE id=?').get(comment.id) as { body: string };
    const rawAttachment = db.prepare('SELECT name, data FROM attachments WHERE id=?').get(attachmentId) as { name: string; data: Uint8Array };
    for (const text of [rawNote.data_json, rawBook.data_json, rawComment.body, rawAttachment.name]) assert.match(text, /^jotenc1:/);
    assert.ok(!Buffer.from(rawAttachment.data).includes(Buffer.from('uniquely secret attachment bytes')));
    assert.equal(repo.listNotes(owner.id)[0].note.body, item.body);
    assert.equal(repo.listNotebooks(owner.id)[0].notebook.name, book.name);
    assert.equal(repo.listComments(owner.id, item.id)[0].body, 'uniquely secret comment');
    assert.deepEqual(Uint8Array.from(repo.getAttachment(owner.id, item.id, attachmentId).data), payload);
    assert.equal(repo.putNote(owner.id, op, 0, item).version, 1);
    db.close(); db = undefined;
    const disk = readFileSync(filename);
    for (const secret of ['uniquely secret note body', 'secret notebook name', 'uniquely secret comment', 'secret filename.txt', 'uniquely secret attachment bytes']) {
      assert.ok(!disk.includes(Buffer.from(secret)), `${secret} leaked to the SQLite file`);
    }
    delete process.env.JOT_ENCRYPTION_KEY;
    assert.throws(() => openDatabase(filename), /JOT_ENCRYPTION_KEY is required/);
    process.env.JOT_ENCRYPTION_KEY = '22'.repeat(32);
    assert.throws(() => openDatabase(filename), /does not match/);
    process.env.JOT_ENCRYPTION_KEY = 'invalid';
    assert.throws(() => openDatabase(filename), /64 hexadecimal/);
    process.env.JOT_ENCRYPTION_KEY = key;
    db = openDatabase(filename); repo = new Repository(db);
    assert.equal(repo.listNotes(owner.id)[0].note.body, item.body);
    assert.deepEqual(Uint8Array.from(repo.getAttachment(owner.id, item.id, attachmentId).data), payload);
    // Notebook removal rewrites encrypted notes without losing content.
    repo.putNotebook(owner.id, randomUUID(), 1, { ...book, deletedAt: now });
    assert.equal(repo.listNotes(owner.id)[0].note.body, item.body);
    assert.equal(repo.listNotes(owner.id)[0].note.notebookId, null);
    const other = note({ body: 'another encrypted note' });
    repo.putNote(owner.id, randomUUID(), 0, other);
    const ciphertext = (db.prepare('SELECT data_json FROM notes WHERE id=?').get(item.id) as { data_json: string }).data_json;
    db.prepare('UPDATE notes SET data_json=? WHERE id=?').run(ciphertext, other.id);
    assert.throws(() => repo.listNotes(owner.id), /cannot be authenticated/);
  } finally { db?.close(); delete process.env.JOT_ENCRYPTION_KEY; rmSync(directory, { recursive: true, force: true }); }
});

test('a plaintext database cannot silently switch to encrypted mode', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'jot-plaintext-'));
  const filename = path.join(directory, 'jot.sqlite');
  let db: DatabaseSync | undefined;
  try {
    db = openDatabase(filename);
    const owner = user(db, 'plaintext@example.test');
    const item = note({ body: 'still available' });
    new Repository(db).putNote(owner.id, randomUUID(), 0, item);
    db.close(); db = undefined;
    process.env.JOT_ENCRYPTION_KEY = '33'.repeat(32);
    assert.throws(() => openDatabase(filename), /existing plaintext/);
    delete process.env.JOT_ENCRYPTION_KEY;
    db = openDatabase(filename);
    assert.equal(new Repository(db).listNotes(owner.id)[0].note.body, 'still available');
  } finally { db?.close(); delete process.env.JOT_ENCRYPTION_KEY; rmSync(directory, { recursive: true, force: true }); }
});

test('attachment mutations reject stale note versions even when an upload finishes late', { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'jot-attachment-version-'));
  process.env.JOT_DATA_DIR = directory;
  const origin = 'http://localhost:3000';
  const registerRoute = await import('../src/app/api/auth/register/route');
  const noteRoute = await import('../src/app/api/notes/[id]/route');
  const listRoute = await import('../src/app/api/notes/[id]/attachments/route');
  const itemRoute = await import('../src/app/api/notes/[id]/attachments/[attachmentId]/route');
  const jsonReq = (url: string, body: unknown, cookie?: string, csrf?: string) => new Request(origin + url, {
    method: 'PUT', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: JSON.stringify(body),
  });
  try {
    const registered = await registerRoute.POST(new Request(`${origin}/api/auth/register`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'version-race@example.test', password: 'a sufficiently long password' }) }));
    assert.equal(registered.status, 201);
    const { csrfToken } = await registered.json();
    const cookie = registered.headers.get('set-cookie')!.split(';')[0];
    const item = note();
    const noteCtx = { params: Promise.resolve({ id: item.id }) };
    assert.equal((await noteRoute.PUT(jsonReq(`/api/notes/${item.id}`, { baseVersion: 0, operationId: randomUUID(), note: item }, cookie, csrfToken), noteCtx)).status, 200);
    const attachmentId = randomUUID();
    const endpoint = `${origin}/api/notes/${item.id}/attachments/${attachmentId}`;
    const attachmentCtx = { params: Promise.resolve({ id: item.id, attachmentId }) };
    const headers = { origin, cookie, 'x-csrf-token': csrfToken, 'x-jot-filename': 'one.txt', 'x-jot-created-at': now,
      'x-jot-note-version': '1', 'content-type': 'text/plain' };
    assert.equal((await itemRoute.PUT(new Request(endpoint, { method: 'PUT', headers, body: 'keep this' }), attachmentCtx)).status, 200);
    assert.equal((await itemRoute.DELETE(new Request(endpoint, { method: 'DELETE', headers: { origin, cookie, 'x-csrf-token': csrfToken } }), attachmentCtx)).status, 400);
    assert.equal((await itemRoute.DELETE(new Request(endpoint, { method: 'DELETE', headers: { ...headers, 'x-jot-note-version': '0' } }), attachmentCtx)).status, 400);

    const lateId = randomUUID();
    const lateCtx = { params: Promise.resolve({ id: item.id, attachmentId: lateId }) };
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let signalRead!: () => void;
    const reading = new Promise<void>(resolve => { signalRead = resolve; });
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { signalRead(); } }, { highWaterMark: 0 });
    // No bytes are available until after the competing note write. Pull means
    // the route has already passed its initial ACL check and begun reading.
    const pending = itemRoute.PUT(new Request(`${origin}/api/notes/${item.id}/attachments/${lateId}`, {
      method: 'PUT', headers, body: stream, duplex: 'half',
    } as RequestInit & { duplex: 'half' }), lateCtx);
    await reading;
    const changed = { ...item, body: 'server note changed while upload was in flight' };
    assert.equal((await noteRoute.PUT(jsonReq(`/api/notes/${item.id}`, { baseVersion: 1, operationId: randomUUID(), note: changed }, cookie, csrfToken), noteCtx)).status, 200);
    controller.enqueue(new TextEncoder().encode('stale bytes')); controller.close();
    const lateResponse = await pending;
    assert.equal(lateResponse.status, 409);
    assert.equal((await lateResponse.json()).serverVersion, 2);
    const listed = await listRoute.GET(new Request(`${origin}/api/notes/${item.id}/attachments`, { headers: { cookie } }), noteCtx);
    assert.deepEqual((await listed.json()).attachments.map((entry: { id: string }) => entry.id), [attachmentId]);
    const staleDelete = await itemRoute.DELETE(new Request(endpoint, { method: 'DELETE', headers }), attachmentCtx);
    assert.equal(staleDelete.status, 409);
    assert.equal((await itemRoute.GET(new Request(endpoint, { headers: { cookie } }), attachmentCtx)).status, 200);
    const currentDelete = await itemRoute.DELETE(new Request(endpoint, { method: 'DELETE', headers: { ...headers, 'x-jot-note-version': '2' } }), attachmentCtx);
    assert.equal(currentDelete.status, 200);
  } finally {
    const holder = globalThis as typeof globalThis & { __jotDatabase?: DatabaseSync };
    holder.__jotDatabase?.close(); delete holder.__jotDatabase; delete process.env.JOT_DATA_DIR;
    rmSync(directory, { recursive: true, force: true });
  }
});
