import 'fake-indexeddb/auto';
import './web-locks';
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { ConflictError, jotStore, switchWorkspace } from '../src/lib/store';

const unique = () => `test-${crypto.randomUUID()}`;

test('workspace records use atomic optimistic revisions and soft-delete', async () => {
  await switchWorkspace(unique());
  const notebook = await jotStore.createNotebook('Ideas');
  const original = await jotStore.createNote({ title: 'First', body: 'draft', notebookId: notebook.id });
  assert.equal(original.syncState, 'dirty');
  const edited = await jotStore.updateNote(original.id, { body: 'new text' }, original.revision);
  assert.equal(edited.revision, original.revision + 1);
  await assert.rejects(jotStore.updateNote(original.id, { body: 'stale text' }, original.revision), ConflictError);
  assert.equal((await jotStore.getNote(original.id))?.body, 'new text');
  const trashed = await jotStore.trashNote(edited.id, edited.revision);
  assert.equal((await jotStore.listNotes()).length, 0);
  assert.equal((await jotStore.listNotes({ includeDeleted: true })).length, 1);
  const restored = await jotStore.restoreNote(trashed.id, trashed.revision);
  assert.equal(restored.deletedAt, null);
  await jotStore.deleteNotebook(notebook.id);
  assert.equal((await jotStore.getNote(original.id))?.notebookId, null);
  assert.equal((await jotStore.listNotebooks()).length, 0);
});

test('account workspaces do not share data and guest copy is explicit and deduplicated', async () => {
  await switchWorkspace(null);
  const guest = await jotStore.createNote({ title: 'Guest secret', body: 'local only' });
  const accountA = unique();
  await switchWorkspace(accountA);
  assert.equal((await jotStore.listNotes()).length, 0);
  const [first, second] = await Promise.all([jotStore.copyGuestNotesToAccount(accountA), jotStore.copyGuestNotesToAccount(accountA)]);
  assert.ok(first > 0 || second > 0);
  assert.equal(first === 0 || second === 0, true);
  assert.equal((await jotStore.listNotes()).filter(note => note.title === guest.title).length, 1);
  await switchWorkspace(unique());
  assert.equal((await jotStore.listNotes()).length, 0);
  await switchWorkspace(null);
  assert.ok((await jotStore.listNotes()).some(note => note.id === guest.id));
});

test('encrypted backup authenticates data; wrong password writes nothing; attachments round-trip', async () => {
  await switchWorkspace(unique());
  const note = await jotStore.createNote({ title: 'Protected', body: 'private' });
  const attachment = await jotStore.addAttachment(note.id, new Blob(['photo data'], { type: 'text/plain' }), 'photo.txt');
  const linked = await jotStore.updateNote(note.id, { body: `![file](attachment:${attachment.id})` }, note.revision);
  const encrypted = await jotStore.exportBackup('a good password');
  const fileText = await encrypted.text();
  assert.equal(fileText.includes('photo data'), false);
  assert.equal(fileText.includes('Protected'), false);
  const destination = unique();
  await switchWorkspace(destination);
  await assert.rejects(jotStore.importBackup(encrypted, 'incorrect password'), /decrypt/i);
  assert.equal((await jotStore.listNotes()).length, 0);
  await jotStore.importBackup(encrypted, 'a good password');
  const imported = (await jotStore.listNotes())[0];
  assert.equal(imported.title, linked.title);
  assert.notEqual(imported.id, linked.id);
  const importedAttachment = (await jotStore.listAttachments(imported.id))[0];
  assert.equal(await importedAttachment.blob.text(), 'photo data');
  assert.ok(imported.body.includes(`attachment:${importedAttachment.id}`));
  assert.equal(imported.syncState, 'dirty');
  await jotStore.importBackup(encrypted, 'a good password');
  assert.equal((await jotStore.listNotes()).length, 2); // explicit import merges, never overwrites
});

test('markdown ZIP contains readable notes and their actual attachments', async () => {
  await switchWorkspace(unique());
  const note = await jotStore.createNote({ title: 'Portable', body: 'hello' });
  await jotStore.addAttachment(note.id, new Blob(['test bytes'], { type: 'text/plain' }), 'file.txt');
  const zip = await JSZip.loadAsync(await (await jotStore.exportMarkdownZip()).arrayBuffer());
  const paths = Object.keys(zip.files);
  assert.ok(paths.some(path => path.startsWith('notes/Portable-') && path.endsWith('.md')));
  const attachment = paths.find(path => path.startsWith('attachments/') && path.endsWith('-file.txt'));
  assert.ok(attachment);
  assert.equal(await zip.file(attachment)!.async('text'), 'test bytes');
});

test('recurrence advances the source and creates exactly one occurrence under concurrent clicks', async () => {
  await switchWorkspace(unique());
  const source = await jotStore.createNote({ title: 'Weekly', body: 'next: 2026-11-01' });
  const attempts = await Promise.allSettled([
    jotStore.createRecurringOccurrence(source.id, source.revision, 'next: 2026-11-08', { title: 'Weekly 1', body: 'one' }, `${source.id}:2026-11-01`),
    jotStore.createRecurringOccurrence(source.id, source.revision, 'next: 2026-11-08', { title: 'Weekly 1', body: 'one' }, `${source.id}:2026-11-01`),
  ]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(item => item.status === 'rejected').length, 1);
  assert.equal((await jotStore.listNotes()).length, 2);
  assert.equal((await jotStore.getNote(source.id))?.body, 'next: 2026-11-08');
});

test('a delayed backup file cannot import into a workspace selected meanwhile', async () => {
  const source = unique(), destination = unique(), other = unique();
  await switchWorkspace(source); await jotStore.createNote({ title: 'Private export' });
  const original = await jotStore.exportBackup();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  const delayed = new Blob([await original.text()], { type: 'application/json' });
  Object.defineProperty(delayed, 'text', { value: async () => { started(); await gate; return original.text(); } });
  await switchWorkspace(destination);
  const pending = jotStore.importBackup(delayed);
  await reading;
  await switchWorkspace(other);
  release();
  await assert.rejects(pending, /workspace changed/i);
  assert.equal((await jotStore.listNotes()).length, 0);
  await switchWorkspace(destination);
  assert.equal((await jotStore.listNotes()).length, 0);
});

test('a delayed decrypt cannot import into a newly selected account', async () => {
  const source = unique(), destination = unique(), other = unique();
  await switchWorkspace(source); await jotStore.createNote({ title: 'Encrypted private data' });
  const backup = await jotStore.exportBackup('a secure password');
  await switchWorkspace(destination);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const deriving = new Promise<void>(resolve => { started = resolve; });
  const subtle = crypto.subtle;
  const original = subtle.deriveKey.bind(subtle);
  Object.defineProperty(subtle, 'deriveKey', { configurable: true, value: async (...args: Parameters<SubtleCrypto['deriveKey']>) => {
    started(); await gate; return original(...args);
  } });
  try {
    const pending = jotStore.importBackup(backup, 'a secure password');
    await deriving;
    await switchWorkspace(other);
    release();
    await assert.rejects(pending, /workspace changed/i);
    assert.equal((await jotStore.listNotes()).length, 0);
    await switchWorkspace(destination);
    assert.equal((await jotStore.listNotes()).length, 0);
  } finally { delete (subtle as unknown as { deriveKey?: unknown }).deriveKey; }
});

test('deleted attachment bytes never appear in plaintext, encrypted, or Markdown ZIP exports', async () => {
  await switchWorkspace(unique());
  const note = await jotStore.createNote({ title: 'Sensitive' });
  const attachment = await jotStore.addAttachment(note.id, new Blob(['secret-attachment-bytes']), 'secret.txt');
  const db = await (await import('../src/lib/store')).getWorkspaceDb();
  await db.put('attachments', { ...attachment, serverVersion: 1, syncState: 'synced' });
  await jotStore.deleteAttachment(attachment.id);
  assert.equal((await jotStore.listAttachments(note.id)).length, 0);
  const tombstone = await db.get('attachments', attachment.id);
  assert.ok(tombstone?.deletedAt);
  assert.equal(tombstone.blob.size, 0);
  const plain = JSON.parse(await (await jotStore.exportBackup()).text());
  assert.equal(plain.attachments.length, 0);
  assert.equal(JSON.stringify(plain).includes('secret-attachment-bytes'), false);
  const encrypted = await jotStore.exportBackup('strong secret password');
  await switchWorkspace(unique());
  await jotStore.importBackup(encrypted, 'strong secret password');
  const restored = (await jotStore.listNotes())[0];
  assert.equal((await jotStore.listAttachments(restored.id)).length, 0);
  await switchWorkspace(unique());
  const zipNote = await jotStore.createNote({ title: 'ZIP sensitive' });
  const zipAttachment = await jotStore.addAttachment(zipNote.id, new Blob(['zip-secret-bytes']), 'deleted.txt');
  const zipDb = await (await import('../src/lib/store')).getWorkspaceDb();
  await zipDb.put('attachments', { ...zipAttachment, serverVersion: 1, syncState: 'synced' });
  await jotStore.deleteAttachment(zipAttachment.id);
  const zip = await JSZip.loadAsync(await (await jotStore.exportMarkdownZip()).arrayBuffer());
  assert.equal(Object.keys(zip.files).some(path => path.includes('deleted.txt')), false);
  for (const file of Object.values(zip.files)) if (!file.dir) assert.equal((await file.async('text')).includes('zip-secret-bytes'), false);
});

test('backup size checks UTF-8 bytes rather than JavaScript character count', async () => {
  const { assertBackupSize } = await import('../src/lib/store');
  const unicode = new Blob(['漢字']);
  assert.equal(unicode.size, 6);
  assert.throws(() => assertBackupSize(unicode, 5), /exceeds/i);
  assert.doesNotThrow(() => assertBackupSize(unicode, 6));
});

test('backup import rejects noncanonical dates and blank tags atomically', async () => {
  await switchWorkspace(unique());
  await jotStore.createNote({ title: 'Source', tags: ['valid'] });
  const baseline = JSON.parse(await (await jotStore.exportBackup()).text());
  await switchWorkspace(unique());
  const badDate = structuredClone(baseline); badDate.notes[0].updatedAt = '2020-01-01';
  await assert.rejects(jotStore.importBackup(new Blob([JSON.stringify(badDate)])), /invalid note/i);
  const invalidCalendar = structuredClone(baseline); invalidCalendar.notes[0].updatedAt = '2020-02-30T00:00:00.000Z';
  await assert.rejects(jotStore.importBackup(new Blob([JSON.stringify(invalidCalendar)])), /invalid note/i);
  const badTag = structuredClone(baseline); badTag.notes[0].tags = ['   '];
  await assert.rejects(jotStore.importBackup(new Blob([JSON.stringify(badTag)])), /invalid note/i);
  assert.equal((await jotStore.listNotes()).length, 0);
});

test('a view-only note can recover an unsaved visible draft without modifying its original', async () => {
  await switchWorkspace(unique());
  const source = await jotStore.createNote({ title: 'Shared', body: 'stored original' });
  const db = await (await import('../src/lib/store')).getWorkspaceDb();
  await db.put('notes', { ...source, role: 'viewer', syncState: 'synced', serverVersion: 1 });
  const recovered = await jotStore.copyUnavailableNoteToInbox(source.id, source.revision, { body: 'unsaved visible edit', title: 'Shared draft' });
  assert.equal(recovered.body, 'unsaved visible edit'); assert.equal(recovered.role, 'owner');
  assert.equal((await jotStore.getNote(source.id))?.body, 'stored original');
  await db.put('notes', { ...source, role: 'viewer', syncState: 'conflict', serverVersion: 1 });
  const conflictedCopy = await jotStore.copyUnavailableNoteToInbox(source.id, source.revision, { body: 'different visible edit' });
  assert.equal(conflictedCopy.body, 'different visible edit'); assert.notEqual(conflictedCopy.id, recovered.id);
});
