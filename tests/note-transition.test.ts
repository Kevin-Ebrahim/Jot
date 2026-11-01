import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoteTransitionGuard } from '../src/components/note-transition';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('delayed creation cannot route typing to the previously selected note', async () => {
  for (let trial = 0; trial < 4; trial += 1) {
    const guard = createNoteTransitionGuard();
    const oldId = `shared-old-${trial}`, newId = `new-${trial}`;
    let oldTitle = 'Shared original', newTitle = '';
    guard.select(oldId);
    const token = guard.begin(); assert.notEqual(token, null);
    const creation = deferred<string>();
    const pending = creation.promise.then((id) => guard.complete(token!, id));
    // A stale old-editor input event during the delayed create must be ignored.
    if (guard.accepts(oldId)) oldTitle = 'Accidental rename';
    assert.equal(guard.select(oldId), false, 'selection is gated while creating');
    creation.resolve(newId); assert.equal(await pending, true);
    if (guard.accepts(oldId)) oldTitle = 'Late accidental rename';
    if (guard.accepts(newId)) newTitle = 'New title';
    assert.equal(oldTitle, 'Shared original'); assert.equal(newTitle, 'New title');
  }
});

test('failed creation restores the prior identity; stale completions cannot replace it', () => {
  const guard = createNoteTransitionGuard(); guard.select('old');
  const token = guard.begin()!; assert.equal(guard.begin(), null);
  assert.equal(guard.cancel(token), 'old'); assert.equal(guard.accepts('old'), true);
  assert.equal(guard.complete(token, 'late'), false); assert.equal(guard.accepts('old'), true);
});
