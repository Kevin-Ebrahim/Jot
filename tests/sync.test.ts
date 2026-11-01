import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorkspaceDb, jotStore, switchWorkspace } from '../src/lib/store';
import { listConflicts, resolveConflict, syncWorkspace } from '../src/lib/sync';
import type { ServerNote, ServerNotebook } from '../src/lib/types';

type Remote = { data: ServerNote | ServerNotebook; version: number; role: 'owner' | 'editor' | 'viewer' };
function fakeServer(userId: string) {
  const notes = new Map<string, Remote>(), notebooks = new Map<string, Remote>();
  const receipts = new Map<string, { response: object; payload: string }>();
  const attachments = new Map<string, { metadata: Record<string, unknown>; bytes: ArrayBuffer }>();
  let sessionUser = userId;
  let offlineAfterWrite = false;
  let offline = false;
  let calls = 0;
  let failNextWrite = false;
  const revoked = new Set<string>();
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const handler: typeof fetch = async (input, init) => {
    if (offline) throw new TypeError('offline');
    calls += 1;
    const path = String(input);
    if (path === '/api/auth/session') return json({ user: { id: sessionUser, email: 'a@example.test' }, csrfToken: 'csrf' });
    const headers = new Headers(init?.headers);
    if (headers.get('X-Jot-Workspace') !== sessionUser) return json({ error: 'Workspace mismatch' }, 409);
    if (path === '/api/notes' || path === '/api/notebooks') {
      const kind = path === '/api/notes' ? 'note' : 'notebook';
      const items = kind === 'note' ? notes : notebooks;
      return json({ [kind === 'note' ? 'notes' : 'notebooks']: [...items.values()].filter(item => !revoked.has(item.data.id)).map(item => ({ [kind]: item.data, version: item.version, role: item.role })) });
    }
    const attachmentMatch = path.match(/^\/api\/notes\/([^/]+)\/attachments(?:\/([^/]+))?$/);
    if (attachmentMatch) {
      const [, noteId, id] = attachmentMatch;
      if (!id) return json({ attachments: [...attachments.values()].map(item => item.metadata).filter(item => item.noteId === noteId) });
      if (init?.method === 'PUT') {
        const blob = init.body as Blob;
        const metadata = { id, noteId, name: decodeURIComponent(headers.get('X-Jot-Filename')!), mimeType: headers.get('Content-Type'),
          size: blob.size, createdAt: headers.get('X-Jot-Created-At'), deletedAt: null };
        attachments.set(id, { metadata, bytes: await blob.arrayBuffer() }); return json({ attachment: metadata });
      }
      const item = attachments.get(id);
      if (!item) return json({ error: 'Not found' }, 404);
      if (init?.method === 'DELETE') { item.metadata.deletedAt = new Date().toISOString(); return json({ attachment: item.metadata }); }
      return new Response(item.bytes, { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    const match = path.match(/^\/api\/(notes|notebooks)\/([^/]+)$/);
    if (match && init?.method === 'PUT') {
      const kind = match[1] === 'notes' ? 'note' : 'notebook';
      const items = kind === 'note' ? notes : notebooks;
      if (failNextWrite) { failNextWrite = false; return json({ error: 'Temporary failure' }, 503); }
      if (revoked.has(match[2])) return json({ error: 'Note not found' }, 404);
      if (items.get(match[2])?.role === 'viewer') return json({ error: 'This note is read-only' }, 403);
      const body = JSON.parse(String(init.body));
      if (kind === 'note' && body.note.notebookId && revoked.has(body.note.notebookId)) return json({ error: 'Notebook not found' }, 404);
      const oldReceipt = receipts.get(body.operationId);
      if (oldReceipt) {
        if (oldReceipt.payload !== String(init.body)) return json({ error: 'Operation mismatch' }, 409);
        return json(oldReceipt.response);
      }
      const current = items.get(match[2]);
      if ((current?.version ?? 0) !== body.baseVersion) return json({ error: 'conflict', serverVersion: current?.version,
        [kind === 'note' ? 'serverNote' : 'serverNotebook']: current?.data }, 409);
      const item: Remote = { data: body[kind], version: (current?.version ?? 0) + 1, role: 'owner' };
      items.set(match[2], item);
      const response = { [kind]: item.data, version: item.version, role: item.role };
      receipts.set(body.operationId, { response, payload: String(init.body) });
      if (offlineAfterWrite) { offlineAfterWrite = false; offline = true; throw new TypeError('connection dropped'); }
      return json(response);
    }
    return json({ error: `Unexpected request ${path}` }, 404);
  };
  return { notes, notebooks, attachments, handler, setSession(id: string) { sessionUser = id; },
    loseNextResponse() { offlineAfterWrite = true; }, reconnect() { offline = false; }, callCount() { return calls; },
    rejectNextWrite() { failNextWrite = true; }, revoke(id: string) { revoked.add(id); } };
}

test('syncs account notes, notebooks and attachment bytes; conflicts preserve both drafts', async () => {
  const userId = crypto.randomUUID(); const server = fakeServer(userId); globalThis.fetch = server.handler;
  await switchWorkspace(userId);
  const notebook = await jotStore.createNotebook('Projects');
  const note = await jotStore.createNote({ title: 'Plan', body: 'start', notebookId: notebook.id });
  const attachment = await jotStore.addAttachment(note.id, new Blob(['audio bytes'], { type: 'audio/webm' }), 'meeting.webm');
  await jotStore.updateNote(note.id, { body: `![audio](attachment:${attachment.id})` }, note.revision);
  const first = await syncWorkspace();
  assert.deepEqual(first.errors, []);
  assert.equal(server.notes.size, 1); assert.equal(server.notebooks.size, 1); assert.equal(server.attachments.size, 1);
  assert.equal((await jotStore.getNote(note.id))?.syncState, 'synced');
  assert.equal((await jotStore.listAttachments(note.id))[0].syncState, 'synced');

  const saved = (await jotStore.getNote(note.id))!;
  await jotStore.updateNote(note.id, { body: `local draft attachment:${attachment.id}` }, saved.revision);
  const remote = server.notes.get(note.id)!;
  remote.data = { ...remote.data, body: 'remote draft' } as ServerNote; remote.version += 1;
  const second = await syncWorkspace();
  assert.equal(second.conflicts, 1);
  assert.equal((await jotStore.getNote(note.id))?.body, `local draft attachment:${attachment.id}`);
  const conflict = (await listConflicts())[0];
  assert.equal((conflict.server as ServerNote).body, 'remote draft');
  await assert.rejects(resolveConflict(conflict.id, 'server', conflict.local.revision - 1, conflict.serverVersion), /changed since review/i);
  await resolveConflict(conflict.id, 'both', conflict.local.revision, conflict.serverVersion);
  assert.equal((await jotStore.getNote(note.id))?.body, 'remote draft');
  const copy = (await jotStore.listNotes()).find(item => item.title.includes('conflict copy'))!;
  assert.ok(copy.body.includes('local draft'));
  const copiedAttachment = (await jotStore.listAttachments(copy.id))[0];
  assert.equal(await copiedAttachment.blob.text(), 'audio bytes');
  assert.ok(copy.body.includes(`attachment:${copiedAttachment.id}`));
  const third = await syncWorkspace();
  assert.deepEqual(third.errors, []); assert.equal(third.conflicts, 0); assert.equal(server.notes.size, 2);
});

test('durable outbox retries a lost response without duplicating a server write', async () => {
  const userId = crypto.randomUUID(); const server = fakeServer(userId); globalThis.fetch = server.handler;
  await switchWorkspace(userId);
  const note = await jotStore.createNote({ title: 'Retry', body: 'preserve me' });
  server.loseNextResponse();
  const failed = await syncWorkspace();
  assert.ok(failed.errors.length > 0);
  assert.equal((await (await getWorkspaceDb()).getAll('outbox')).length, 1);
  server.reconnect();
  const recovered = await syncWorkspace();
  assert.deepEqual(recovered.errors, []);
  assert.equal(server.notes.get(note.id)?.version, 1);
  assert.equal((await jotStore.getNote(note.id))?.syncState, 'synced');
  assert.equal((await (await getWorkspaceDb()).getAll('outbox')).length, 0);
});

test('a changed session cannot upload a different workspace', async () => {
  const userId = crypto.randomUUID(); const server = fakeServer(userId); globalThis.fetch = server.handler;
  await switchWorkspace(userId); await jotStore.createNote({ title: 'Do not leak' });
  server.setSession(crypto.randomUUID());
  await assert.rejects(syncWorkspace(), /matching account/i);
  assert.equal(server.notes.size, 0); assert.equal(server.callCount(), 1);
});

test('permission downgrade retires a denied outbox operation and preserves the draft as a conflict', async () => {
  const userId = crypto.randomUUID(), server = fakeServer(userId); globalThis.fetch = server.handler;
  const noteId = crypto.randomUUID(), timestamp = new Date().toISOString();
  server.notes.set(noteId, { data: { id: noteId, title: 'Shared', body: 'server original', tags: [], notebookId: null,
    createdAt: timestamp, updatedAt: timestamp, deletedAt: null, pinned: false }, version: 1, role: 'editor' });
  await switchWorkspace(userId);
  await syncWorkspace();
  const note = (await jotStore.getNote(noteId))!;
  await jotStore.updateNote(note.id, { body: 'unsynced local edit' }, note.revision);
  server.rejectNextWrite();
  assert.ok((await syncWorkspace()).errors.length);
  assert.equal((await (await getWorkspaceDb()).getAll('outbox')).length, 1);
  server.notes.get(noteId)!.role = 'viewer';
  const result = await syncWorkspace();
  assert.equal(result.conflicts, 1);
  assert.equal((await (await getWorkspaceDb()).getAll('outbox')).length, 0);
  assert.equal((await jotStore.getNote(noteId))?.body, 'unsynced local edit');
  assert.equal((await jotStore.getNote(noteId))?.role, 'viewer');
  const conflict = (await listConflicts())[0];
  assert.equal((conflict.server as ServerNote).body, 'server original');
  await assert.rejects(resolveConflict(conflict.id, 'local', conflict.local.revision, conflict.serverVersion), /view-only/i);
});

test('revoked access preserves a local copy without retrying or re-uploading it', async () => {
  const userId = crypto.randomUUID(), server = fakeServer(userId); globalThis.fetch = server.handler;
  const noteId = crypto.randomUUID(), timestamp = new Date().toISOString();
  server.notes.set(noteId, { data: { id: noteId, title: 'Shared', body: 'server', tags: [], notebookId: null,
    createdAt: timestamp, updatedAt: timestamp, deletedAt: null, pinned: false }, version: 1, role: 'editor' });
  await switchWorkspace(userId); await syncWorkspace();
  const note = (await jotStore.getNote(noteId))!;
  await jotStore.updateNote(note.id, { body: 'keep my offline draft' }, note.revision);
  server.rejectNextWrite(); await syncWorkspace();
  server.revoke(noteId);
  const result = await syncWorkspace();
  assert.ok(result.errors.some(message => /access.*removed/i.test(message)));
  assert.equal((await (await getWorkspaceDb()).getAll('outbox')).length, 0);
  const local = (await jotStore.getNote(noteId))!;
  assert.equal(local.body, 'keep my offline draft'); assert.equal(local.syncState, 'local'); assert.equal(local.role, 'viewer');
  await syncWorkspace();
  assert.equal(server.notes.get(noteId)?.version, 1);
  assert.equal((await (await getWorkspaceDb()).getAll('outbox')).length, 0);
});

for (const choice of ['server', 'both'] as const) {
  test(`resolving with ${choice} never uploads discarded local-only attachments to the server original`, async () => {
    const userId = crypto.randomUUID(), server = fakeServer(userId); globalThis.fetch = server.handler;
    await switchWorkspace(userId);
    const note = await jotStore.createNote({ title: 'Shared original', body: 'initial' });
    await syncWorkspace();
    const saved = (await jotStore.getNote(note.id))!;
    const localAttachment = await jotStore.addAttachment(note.id, new Blob(['private draft'], { type: 'text/plain' }), 'private.txt');
    await jotStore.updateNote(note.id, { body: `local attachment:${localAttachment.id}` }, saved.revision);
    const remote = server.notes.get(note.id)!; remote.data = { ...remote.data, body: 'server edit' } as ServerNote; remote.version += 1;
    await syncWorkspace();
    const conflict = (await listConflicts())[0];
    await resolveConflict(conflict.id, choice, conflict.local.revision, conflict.serverVersion);
    assert.equal((await jotStore.listAttachments(note.id)).length, 0);
    const result = await syncWorkspace();
    assert.deepEqual(result.errors, []);
    const originalFiles = [...server.attachments.values()].filter(item => item.metadata.noteId === note.id);
    assert.equal(originalFiles.length, 0);
    if (choice === 'both') {
      const copy = (await jotStore.listNotes()).find(item => item.title.includes('conflict copy'))!;
      assert.ok(copy);
      assert.equal((await jotStore.listAttachments(copy.id)).length, 1);
      assert.equal([...server.attachments.values()].filter(item => item.metadata.noteId === copy.id).length, 1);
    } else assert.equal(server.attachments.size, 0);
  });
}

for (const choice of ['server', 'both'] as const) {
  test(`${choice} cancels a local attachment deletion and restores the server file`, async () => {
    const userId = crypto.randomUUID(), server = fakeServer(userId); globalThis.fetch = server.handler;
    await switchWorkspace(userId);
    const note = await jotStore.createNote({ title: 'With shared file', body: 'initial' });
    const attachment = await jotStore.addAttachment(note.id, new Blob(['server file'], { type: 'text/plain' }), 'shared.txt');
    await syncWorkspace();
    const saved = (await jotStore.getNote(note.id))!;
    await jotStore.deleteAttachment(attachment.id);
    await jotStore.updateNote(note.id, { body: 'local deletion draft' }, saved.revision);
    const remote = server.notes.get(note.id)!; remote.data = { ...remote.data, body: 'server edit' } as ServerNote; remote.version += 1;
    await syncWorkspace();
    const conflict = (await listConflicts())[0];
    await resolveConflict(conflict.id, choice, conflict.local.revision, conflict.serverVersion);
    const result = await syncWorkspace();
    assert.deepEqual(result.errors, []);
    assert.equal(server.attachments.get(attachment.id)?.metadata.deletedAt, null);
    const restored = (await jotStore.listAttachments(note.id)).find(item => item.id === attachment.id);
    assert.ok(restored); assert.equal(await restored.blob.text(), 'server file');
  });
}

test('a new offline note in a revoked shared notebook stays local until explicit personal recovery', async () => {
  const userId = crypto.randomUUID(), server = fakeServer(userId); globalThis.fetch = server.handler;
  const notebookId = crypto.randomUUID(), timestamp = new Date().toISOString();
  server.notebooks.set(notebookId, { data: { id: notebookId, name: 'Shared notebook', createdAt: timestamp, updatedAt: timestamp, deletedAt: null }, version: 1, role: 'editor' });
  await switchWorkspace(userId); await syncWorkspace();
  const note = await jotStore.createNote({ title: 'Offline draft', body: 'do not lose', notebookId });
  const file = await jotStore.addAttachment(note.id, new Blob(['draft file']), 'draft.txt');
  const withLink = await jotStore.updateNote(note.id, { body: `draft attachment:${file.id}` }, note.revision);
  server.revoke(notebookId);
  const failed = await syncWorkspace();
  assert.ok(failed.errors.some(message => /destination was removed/i.test(message)));
  const local = (await jotStore.getNote(note.id))!;
  assert.equal(local.role, 'viewer'); assert.equal(local.syncState, 'local');
  assert.equal((await (await getWorkspaceDb()).getAll('outbox')).length, 0);
  assert.equal(server.notes.size, 0);
  const recovered = await jotStore.copyUnavailableNoteToInbox(local.id, local.revision, { body: `unsaved visible draft attachment:${file.id}` });
  assert.equal(recovered.notebookId, null); assert.equal(recovered.role, 'owner');
  assert.equal(recovered.syncState, 'dirty');
  const recoveredFile = (await jotStore.listAttachments(recovered.id))[0];
  assert.equal(await recoveredFile.blob.text(), 'draft file');
  assert.ok(recovered.body.includes(`attachment:${recoveredFile.id}`));
  assert.ok(recovered.body.includes('unsaved visible draft'));
  const again = await jotStore.copyUnavailableNoteToInbox(local.id, local.revision, { body: `unsaved visible draft attachment:${file.id}` });
  assert.equal(again.id, recovered.id);
  await syncWorkspace();
  assert.equal(server.notes.has(recovered.id), true); assert.equal(server.notes.has(withLink.id), false);
});

test('a hung network is aborted while the durable outbox stays available for retry', async () => {
  const userId = crypto.randomUUID(), server = fakeServer(userId); globalThis.fetch = server.handler;
  await switchWorkspace(userId);
  await jotStore.createNote({ title: 'Pending' });
  server.rejectNextWrite(); await syncWorkspace();
  const before = await (await getWorkspaceDb()).getAll('outbox');
  assert.equal(before.length, 1);
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    originalTimeout(callback, delay === 20_000 ? 10 : delay, ...args)) as typeof setTimeout;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  try {
    await assert.rejects(syncWorkspace(), /abort/i);
    const after = await (await getWorkspaceDb()).getAll('outbox');
    assert.equal(after.length, 1); assert.equal(after[0].operationId, before[0].operationId);
  } finally { globalThis.setTimeout = originalTimeout; }
});
