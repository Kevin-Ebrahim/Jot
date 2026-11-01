import 'fake-indexeddb/auto';
import './web-locks';
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
  let loseAttachmentResponse = false;
  let delayedAttachment: { method: string; arrived: () => void; gate: Promise<void> } | undefined;
  const revoked = new Set<string>();
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const serverNoteVersion = (id: string) => notes.get(id)?.version;
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
      return json({ complete: true, [kind === 'note' ? 'notes' : 'notebooks']: [...items.values()].filter(item => !revoked.has(item.data.id)).map(item => ({ [kind]: item.data, version: item.version, role: item.role })) });
    }
    const attachmentMatch = path.match(/^\/api\/notes\/([^/]+)\/attachments(?:\/([^/]+))?$/);
    if (attachmentMatch) {
      const [, noteId, id] = attachmentMatch;
      if (!id) return json({ attachments: [...attachments.values()].map(item => item.metadata).filter(item => item.noteId === noteId) });
      if (delayedAttachment && init?.method === delayedAttachment.method) {
        const pending = delayedAttachment; delayedAttachment = undefined; pending.arrived(); await pending.gate;
      }
      if (init?.method === 'PUT' || init?.method === 'DELETE') {
        const expected = Number(headers.get('X-Jot-Note-Version'));
        if (serverNoteVersion(noteId) !== expected) return json({ error: 'Note version changed; refresh before modifying attachments' }, 409);
      }
      if (init?.method === 'PUT') {
        const blob = init.body as Blob;
        const metadata = { id, noteId, name: decodeURIComponent(headers.get('X-Jot-Filename')!), mimeType: headers.get('Content-Type'),
          size: blob.size, createdAt: headers.get('X-Jot-Created-At'), deletedAt: null };
        attachments.set(id, { metadata, bytes: await blob.arrayBuffer() });
        if (loseAttachmentResponse) { loseAttachmentResponse = false; throw new TypeError('attachment response lost'); }
        return json({ attachment: metadata });
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
    rejectNextWrite() { failNextWrite = true; }, revoke(id: string) { revoked.add(id); }, unrevoke(id: string) { revoked.delete(id); },
    loseNextAttachmentResponse() { loseAttachmentResponse = true; },
    delayAttachment(method: 'PUT' | 'DELETE') {
      let arrive!: () => void, release!: () => void;
      const arrived = new Promise<void>(resolve => { arrive = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      delayedAttachment = { method, arrived: arrive, gate };
      return { arrived, release };
    } };
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
    await assert.rejects(syncWorkspace(), /timed out|abort/i);
    const after = await (await getWorkspaceDb()).getAll('outbox');
    assert.equal(after.length, 1); assert.equal(after[0].operationId, before[0].operationId);
  } finally { globalThis.setTimeout = originalTimeout; }
});

for (const choice of ['server', 'both'] as const) {
  test(`${choice} removes a possibly committed attachment after its PUT response was lost`, async () => {
    const userId = crypto.randomUUID(), server = fakeServer(userId); globalThis.fetch = server.handler;
    await switchWorkspace(userId);
    const note = await jotStore.createNote({ title: 'Shared', body: 'initial' });
    await syncWorkspace();
    const file = await jotStore.addAttachment(note.id, new Blob(['secret file']), 'secret.txt');
    server.loseNextAttachmentResponse();
    const failed = await syncWorkspace();
    assert.ok(failed.errors.length); assert.ok(server.attachments.has(file.id));
    assert.equal((await jotStore.listAttachments(note.id))[0].serverVersion, null);
    const saved = (await jotStore.getNote(note.id))!;
    await jotStore.updateNote(note.id, { body: `local draft attachment:${file.id}` }, saved.revision);
    const remote = server.notes.get(note.id)!; remote.data = { ...remote.data, body: 'remote edit' } as ServerNote; remote.version += 1;
    await syncWorkspace();
    const conflict = (await listConflicts())[0];
    await resolveConflict(conflict.id, choice, conflict.local.revision, conflict.serverVersion);
    const tombstone = await (await getWorkspaceDb()).get('attachments', file.id);
    assert.ok(tombstone?.deletedAt); assert.equal(tombstone.blob.size, 0);
    const result = await syncWorkspace();
    assert.deepEqual(result.errors, []);
    assert.ok(server.attachments.get(file.id)?.metadata.deletedAt);
    if (choice === 'both') {
      const copy = (await jotStore.listNotes()).find(item => item.title.includes('conflict copy'))!;
      assert.equal((await jotStore.listAttachments(copy.id)).length, 1);
      assert.equal([...server.attachments.values()].filter(item => item.metadata.noteId === copy.id && !item.metadata.deletedAt).length, 1);
    }
  });
}

test('unsupported Web Locks blocks sync without changing local data', async () => {
  const original = navigator.locks;
  Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
  try {
    await switchWorkspace(crypto.randomUUID());
    const note = await jotStore.createNote({ title: 'Still local' });
    await assert.rejects(syncWorkspace(), /Web Locks/i);
    assert.equal((await jotStore.getNote(note.id))?.title, 'Still local');
  } finally { Object.defineProperty(navigator, 'locks', { value: original, configurable: true }); }
});

for (const operation of ['PUT', 'DELETE'] as const) {
  test(`cross-tab ${operation} cannot race conflict resolution or mutate a newer server note`, async () => {
    const userId = crypto.randomUUID(), server = fakeServer(userId); globalThis.fetch = server.handler;
    await switchWorkspace(userId);
    const note = await jotStore.createNote({ title: 'Shared', body: 'initial' });
    await syncWorkspace();
    const file = await jotStore.addAttachment(note.id, new Blob(['shared data']), 'shared.txt');
    if (operation === 'DELETE') { await syncWorkspace(); await jotStore.deleteAttachment(file.id); }
    const delayed = server.delayAttachment(operation);
    const firstSync = syncWorkspace();
    await delayed.arrived;
    const saved = (await jotStore.getNote(note.id))!;
    await jotStore.updateNote(note.id, { body: 'local edit' }, saved.revision);
    const remote = server.notes.get(note.id)!; remote.data = { ...remote.data, body: 'server edit' } as ServerNote; remote.version += 1;
    const modulePath = `../src/lib/sync.ts?second-tab=${crypto.randomUUID()}`;
    const secondTab: typeof import('../src/lib/sync') = await import(modulePath);
    let secondFinished = false;
    const secondSync = secondTab.syncWorkspace().then(result => { secondFinished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(secondFinished, false, 'second tab must wait for the first tab’s workspace lock');
    delayed.release();
    await firstSync;
    const result = await secondSync;
    assert.equal(result.conflicts, 1);
    const conflict = (await secondTab.listConflicts())[0];
    await secondTab.resolveConflict(conflict.id, 'server', conflict.local.revision, conflict.serverVersion);
    await secondTab.syncWorkspace();
    if (operation === 'PUT') assert.equal(server.attachments.has(file.id), false);
    else {
      assert.equal(server.attachments.get(file.id)?.metadata.deletedAt, null);
      assert.equal(await (await jotStore.listAttachments(note.id))[0].blob.text(), 'shared data');
    }
  });
}

test('a confirmed personal recovery acknowledges a revoked original without deleting it', async () => {
  const userId = crypto.randomUUID(), server = fakeServer(userId); globalThis.fetch = server.handler;
  const noteId = crypto.randomUUID(), timestamp = new Date().toISOString();
  server.notes.set(noteId, { data: { id: noteId, title: 'Shared', body: 'server', tags: [], notebookId: null,
    createdAt: timestamp, updatedAt: timestamp, deletedAt: null, pinned: false }, version: 1, role: 'editor' });
  await switchWorkspace(userId); await syncWorkspace();
  const source = (await jotStore.getNote(noteId))!;
  await jotStore.updateNote(source.id, { body: 'preserved local draft' }, source.revision);
  server.rejectNextWrite(); await syncWorkspace(); server.revoke(noteId); await syncWorkspace();
  const unavailable = (await jotStore.getNote(noteId))!;
  const recovered = await jotStore.copyUnavailableNoteToInbox(noteId, unavailable.revision, { body: 'reviewed visible draft' });
  const before = await syncWorkspace();
  assert.ok(before.errors.some(message => /unavailable.*unrecovered/i.test(message)));
  await jotStore.acknowledgeUnavailableNote(noteId, unavailable.revision, recovered.id);
  const after = await syncWorkspace();
  assert.deepEqual(after.errors, []);
  assert.equal((await jotStore.getNote(noteId))?.body, 'preserved local draft');
  assert.equal((await jotStore.getNote(recovered.id))?.body, 'reviewed visible draft');
  const latest = (await jotStore.getNote(recovered.id))!;
  await jotStore.trashNote(latest.id, latest.revision);
  const trashed = await syncWorkspace();
  assert.ok(trashed.errors.some(message => /unavailable.*unrecovered/i.test(message)));
});

test('a clean directly shared note becomes visibly unavailable without a persistent error', async () => {
  const userId = crypto.randomUUID(), server = fakeServer(userId); globalThis.fetch = server.handler;
  const noteId = crypto.randomUUID(), timestamp = new Date().toISOString();
  server.notes.set(noteId, { data: { id: noteId, title: 'Shared', body: 'cached content', tags: [], notebookId: null,
    createdAt: timestamp, updatedAt: timestamp, deletedAt: null, pinned: false }, version: 1, role: 'editor' });
  await switchWorkspace(userId); await syncWorkspace();
  server.revoke(noteId);
  const result = await syncWorkspace();
  assert.deepEqual(result.errors, []);
  const local = (await jotStore.getNote(noteId))!;
  assert.equal(local.unavailable, 'clean'); assert.equal(local.role, 'viewer'); assert.equal(local.syncState, 'local');
  assert.equal(local.body, 'cached content');
  await assert.rejects(jotStore.updateNote(noteId, { body: 'unauthorized' }, local.revision), /view-only/i);
  server.unrevoke(noteId);
  await syncWorkspace();
  const restored = (await jotStore.getNote(noteId))!;
  assert.equal(restored.unavailable, undefined); assert.equal(restored.role, 'editor'); assert.equal(restored.syncState, 'synced');
});

test('notebook-inherited revocation preserves clean notes and explicitly acknowledges unsynced notebook metadata', async () => {
  const userId = crypto.randomUUID(), server = fakeServer(userId); globalThis.fetch = server.handler;
  const notebookId = crypto.randomUUID(), noteId = crypto.randomUUID(), timestamp = new Date().toISOString();
  server.notebooks.set(notebookId, { data: { id: notebookId, name: 'Shared notebook', createdAt: timestamp, updatedAt: timestamp, deletedAt: null }, version: 1, role: 'editor' });
  server.notes.set(noteId, { data: { id: noteId, title: 'Shared note', body: 'cached note', tags: [], notebookId,
    createdAt: timestamp, updatedAt: timestamp, deletedAt: null, pinned: false }, version: 1, role: 'editor' });
  await switchWorkspace(userId); await syncWorkspace();
  await jotStore.renameNotebook(notebookId, 'unsynced local name');
  server.revoke(notebookId); server.revoke(noteId);
  const result = await syncWorkspace();
  assert.ok(result.errors.some(message => /unavailable notebooks.*unrecovered/i.test(message)));
  const book = (await jotStore.listNotebooks())[0], note = (await jotStore.getNote(noteId))!;
  assert.equal(book.name, 'unsynced local name'); assert.equal(book.unavailable, 'unrecovered'); assert.equal(book.role, 'viewer');
  assert.equal(note.body, 'cached note'); assert.equal(note.unavailable, 'clean'); assert.equal(note.role, 'viewer');
  await jotStore.acknowledgeUnavailableNotebook(book.id, book.revision);
  const after = await syncWorkspace();
  assert.deepEqual(after.errors, []);
  assert.equal((await jotStore.listNotebooks())[0].unavailable, 'recovered');
  assert.equal((await jotStore.listNotebooks())[0].name, 'unsynced local name');
});

for (const mode of ['network', 'incomplete', 'invalid'] as const) {
  test(`${mode} snapshot never marks previously synced records unavailable`, async () => {
    const userId = crypto.randomUUID(), server = fakeServer(userId); globalThis.fetch = server.handler;
    const noteId = crypto.randomUUID(), notebookId = crypto.randomUUID(), timestamp = new Date().toISOString();
    server.notebooks.set(notebookId, { data: { id: notebookId, name: 'Book', createdAt: timestamp, updatedAt: timestamp, deletedAt: null }, version: 1, role: 'editor' });
    server.notes.set(noteId, { data: { id: noteId, title: 'Shared', body: 'cached', tags: [], notebookId,
      createdAt: timestamp, updatedAt: timestamp, deletedAt: null, pinned: false }, version: 1, role: 'editor' });
    await switchWorkspace(userId); await syncWorkspace();
    const originalFetch = server.handler;
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/notes') {
        if (mode === 'network') throw new TypeError('connection lost');
        if (mode === 'incomplete') return Response.json({ notes: [] });
        return Response.json({ complete: true, notes: [{ note: { id: 'invalid' }, version: 1, role: 'viewer' }] });
      }
      return originalFetch(input, init);
    };
    server.revoke(notebookId); server.revoke(noteId);
    const result = await syncWorkspace();
    assert.ok(result.errors.length > 0);
    const book = (await jotStore.listNotebooks())[0], note = (await jotStore.getNote(noteId))!;
    assert.equal(book.unavailable, undefined); assert.equal(book.role, 'editor');
    assert.equal(note.unavailable, undefined); assert.equal(note.role, 'editor'); assert.equal(note.body, 'cached');
  });
}

test('revoked access with an unsynced attachment requires recovery even when note text was synced', async () => {
  const userId = crypto.randomUUID(), server = fakeServer(userId); globalThis.fetch = server.handler;
  const noteId = crypto.randomUUID(), timestamp = new Date().toISOString();
  server.notes.set(noteId, { data: { id: noteId, title: 'Shared', body: 'synced text', tags: [], notebookId: null,
    createdAt: timestamp, updatedAt: timestamp, deletedAt: null, pinned: false }, version: 1, role: 'editor' });
  await switchWorkspace(userId); await syncWorkspace();
  const file = await jotStore.addAttachment(noteId, new Blob(['unsynced private file']), 'draft.txt');
  server.revoke(noteId);
  const result = await syncWorkspace();
  assert.ok(result.errors.some(message => /unavailable notes.*unrecovered/i.test(message)));
  const unavailable = (await jotStore.getNote(noteId))!;
  assert.equal(unavailable.unavailable, 'unrecovered');
  assert.equal(await (await jotStore.listAttachments(noteId))[0].blob.text(), 'unsynced private file');
  const recovered = await jotStore.copyUnavailableNoteToInbox(noteId, unavailable.revision);
  assert.equal(await (await jotStore.listAttachments(recovered.id))[0].blob.text(), 'unsynced private file');
  await jotStore.acknowledgeUnavailableNote(noteId, unavailable.revision, recovered.id);
  assert.deepEqual((await syncWorkspace()).errors, []);
  assert.equal(server.attachments.has(file.id), false);
});
