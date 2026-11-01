import 'fake-indexeddb/auto';
import './web-locks';
import test from 'node:test';
import assert from 'node:assert/strict';
import { jotStore, switchWorkspace } from '../src/lib/store';
import { isRecurringAutomationEnabled, nextFutureRecurrence, runDueRecurring, setRecurringAutomation } from '../src/lib/auto-recurring';
import { getRecurringSchedule, setRecurringSchedule } from '../src/lib/features/recurring';

const workspace = () => crypto.randomUUID();

test('auto marker is per routine, ignores code examples, and preserves content', () => {
  const example = 'Keep trailing spaces  \n\n```\n@repeat-auto\n```';
  assert.equal(isRecurringAutomationEnabled({ body: example }), false);
  const enabled = setRecurringAutomation(example, true);
  assert.equal(isRecurringAutomationEnabled({ body: enabled }), true);
  assert.ok(enabled.includes('Keep trailing spaces  '));
  assert.equal(isRecurringAutomationEnabled({ body: setRecurringAutomation(enabled, false) }), false);
  assert.ok(setRecurringAutomation(enabled, false).includes('```\n@repeat-auto\n```'));
});

test('overdue auto routine makes one occurrence, then advances beyond today', async () => {
  const id = workspace(); await switchWorkspace(id);
  const body = setRecurringAutomation(setRecurringSchedule('Meeting for {{date}}', 'daily', '2020-01-01'), true);
  const source = await jotStore.createNote({ title: 'Daily {{date}}', body });
  const result = await runDueRecurring({ workspaceId: id, now: new Date(2026, 10, 1, 12) });
  assert.equal(result.created.length, 1); assert.deepEqual(result.errors, []);
  const notes = await jotStore.listNotes(); assert.equal(notes.length, 2);
  const created = notes.find(note => note.id !== source.id)!;
  assert.equal(created.title, 'Daily 2020-01-01');
  assert.ok(created.body.includes('Meeting for 2020-01-01'));
  assert.equal(created.body.includes('@repeat-auto'), false); assert.equal(created.body.includes('@repeat-note'), false);
  const advanced = (await jotStore.getNote(source.id))!;
  assert.equal(getRecurringSchedule(advanced)?.dueAt, '2026-11-02');
  assert.equal(isRecurringAutomationEnabled(advanced), true);
  assert.equal((await runDueRecurring({ workspaceId: id, now: new Date(2026, 10, 1, 12) })).created.length, 0);
});

test('manual, busy, view-only and conflicted routines do not run', async () => {
  const id = workspace(); await switchWorkspace(id);
  const makeBody = (enabled: boolean) => setRecurringAutomation(setRecurringSchedule('Template', 'weekly', '2026-01-01'), enabled);
  await jotStore.createNote({ title: 'Manual', body: makeBody(false) });
  const busy = await jotStore.createNote({ title: 'Busy', body: makeBody(true) });
  const viewer = await jotStore.createNote({ title: 'Viewer', body: makeBody(true) });
  const conflict = await jotStore.createNote({ title: 'Conflict', body: makeBody(true) });
  const db = await (await import('../src/lib/store')).getWorkspaceDb();
  await db.put('notes', { ...viewer, role: 'viewer', syncState: 'synced', serverVersion: 1 });
  await db.put('notes', { ...conflict, syncState: 'conflict', serverVersion: 1 });
  const result = await runDueRecurring({ workspaceId: id, now: new Date(2026, 10, 1, 12), isNoteBusy: noteId => noteId === busy.id });
  assert.equal(result.created.length, 0); assert.equal((await jotStore.listNotes()).length, 4);
  assert.equal(nextFutureRecurrence('2026-01-01', 'weekly', '2026-11-01'), '2026-11-05');
});

test('workspace change during scheduling cannot write into the newly selected account', async () => {
  const first = workspace(), second = workspace(); await switchWorkspace(first);
  await jotStore.createNote({ title: 'Private routine', body: setRecurringAutomation(setRecurringSchedule('private', 'daily', '2020-01-01'), true) });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const original = jotStore.listNotes;
  jotStore.listNotes = async (...args) => { const snapshot = await original(...args); started(); await gate; return snapshot; };
  try {
    const pending = runDueRecurring({ workspaceId: first, now: new Date(2026, 10, 1, 12) });
    await waiting; await switchWorkspace(second); release();
    assert.equal((await pending).created.length, 0);
    assert.equal((await original()).length, 0);
  } finally { jotStore.listNotes = original; }
});
