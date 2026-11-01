import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceLease } from '../src/components/workspace-lease';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function ready(flushDrafts: () => Promise<void> = async () => {}) {
  const lease = createWorkspaceLease({ flushDrafts, onChange: () => {} });
  const release = await lease.beginTransition(); release();
  return lease;
}

test('delayed workspace switch gates typing and operations until an idempotent release', async () => {
  const lease = await ready();
  const release = await lease.beginTransition();
  const delayedSwitch = deferred<void>();
  let draft = 'saved before switch';
  const switchPromise = (async () => { await delayedSwitch.promise; draft = ''; })();
  // The editor uses this synchronous gate before applying an input event.
  if (!lease.isLocked()) draft += ' typed during switch';
  assert.equal(draft, 'saved before switch');
  await assert.rejects(lease.runOperation(async () => {}), /Wait/);
  delayedSwitch.resolve(); await switchPromise;
  release(); release();
  assert.equal(lease.isLocked(), false);
  await lease.runOperation(async () => { draft = 'new workspace'; });
  assert.equal(draft, 'new workspace');
});

test('backup flushes visible drafts before snapshot; failure never runs export', async () => {
  let visible = 'initial'; let persisted = 'initial'; let shouldFail = false;
  const lease = await ready(async () => { if (shouldFail) throw new Error('Resolve conflict'); persisted = visible; });
  visible = 'new visible edits';
  const exported = await lease.runTransfer(async () => persisted);
  assert.equal(exported, 'new visible edits');
  shouldFail = true; let exportedAfterFailure = false;
  await assert.rejects(lease.runTransfer(async () => { exportedAfterFailure = true; }), /Resolve conflict/);
  assert.equal(exportedAfterFailure, false);
  assert.equal(lease.isLocked(), false);
});

test('transitions and transfers reject while another local operation is pending', async () => {
  const lease = await ready();
  const pending = deferred<void>();
  const operation = lease.runOperation(() => pending.promise);
  await assert.rejects(lease.beginTransition(), /Wait/);
  await assert.rejects(lease.runTransfer(async () => {}), /Wait/);
  pending.resolve(); await operation;
  const release = await lease.beginTransition();
  await assert.rejects(lease.runTransfer(async () => {}), /Wait/);
  release();
});

test('an active transfer blocks account changes and a stale release cannot unlock a newer lease', async () => {
  const lease = await ready();
  const transferGate = deferred<void>();
  const transfer = lease.runTransfer(() => transferGate.promise);
  assert.equal(lease.isLocked(), true);
  await assert.rejects(lease.beginTransition(), /Wait/);
  transferGate.resolve(); await transfer;
  const first = await lease.beginTransition(); first();
  const second = await lease.beginTransition();
  first();
  assert.equal(lease.isLocked(), true);
  second();
  assert.equal(lease.isLocked(), false);
});

test('failed transition flush unlocks without running a switch', async () => {
  let fail = false; let switched = false;
  const lease = await ready(async () => { if (fail) throw new Error('Unsaved conflict'); });
  fail = true;
  await assert.rejects((async () => { const release = await lease.beginTransition(); switched = true; release(); })(), /Unsaved conflict/);
  assert.equal(switched, false);
  assert.equal(lease.isLocked(), false);
});
