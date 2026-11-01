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
      return json({ [kind === 'note' ? 'notes' : 'notebooks']: [...items.values()].map(item => ({ [kind]: item.data, version: item.version, role: item.role })) });
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
      const body = JSON.parse(String(init.body));
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
    loseNextResponse() { offlineAfterWrite = true; }, reconnect() { offline = false; }, callCount() { return calls; } };
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
  await assert.rejects(resolveConflict(conflict.id, 'server', conflict.local.revision - 1), /changed since review/i);
  await resolveConflict(conflict.id, 'both', conflict.local.revision);
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
