import 'fake-indexeddb/auto';
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
