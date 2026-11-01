import test from 'node:test';
import assert from 'node:assert/strict';
import type { Note } from '../src/lib/types';
import { createStableNoteMerger, NOTE_PAGE_SIZE, noteListPage, sortNotes } from '../src/components/note-derivations';

function note(index: number): Note {
  return { id: String(index), title: `Note ${index}`, body: `Body ${index}`, tags: [], notebookId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    deletedAt: null, revision: 1, serverVersion: null, syncState: 'local', role: 'owner', pinned: false };
}

test('list begins at 50 rows and keeps an older selected note visible without expanding', () => {
  const sorted = sortNotes(Array.from({ length: 120 }, (_, index) => note(index)));
  const first = noteListPage(sorted, NOTE_PAGE_SIZE, '0');
  assert.equal(first.visible.length, 50); assert.equal(first.remaining, 70);
  assert.equal(first.selectedOutside?.id, '0');
  const next = noteListPage(sorted, NOTE_PAGE_SIZE * 2, '0');
  assert.equal(next.visible.length, 100); assert.equal(next.remaining, 20);
  const all = noteListPage(sorted, NOTE_PAGE_SIZE * 3, '0');
  assert.equal(all.visible.length, 120); assert.equal(all.remaining, 0); assert.equal(all.selectedOutside, undefined);
});

test('unchanged note identities survive another draft edit and a storage refresh', () => {
  const merge = createStableNoteMerger();
  const originals = [note(1), note(2)];
  const first = merge(originals, {});
  const changed = { ...originals[0], body: 'typing' };
  const second = merge(originals, { '1': { note: changed } });
  assert.notEqual(second[0], first[0]); assert.equal(second[1], first[1]);
  const refreshed = originals.map((item) => ({ ...item }));
  const third = merge(refreshed, { '1': { note: changed } });
  assert.equal(third[0], second[0]); assert.equal(third[1], second[1]);
  const roleChanged = merge([{ ...refreshed[0], role: 'viewer' }, refreshed[1]], { '1': { note: changed } });
  assert.equal(roleChanged[0].role, 'viewer'); assert.equal(roleChanged[0].body, 'typing');
});
