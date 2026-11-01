import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionRecovery, sessionMatchesWorkspace } from './session-recovery';

const guest = { user: null, csrfToken: null };
const account = { user: { id: 'account-a', email: 'a@example.test' }, csrfToken: 'token' };

test('a verified session must match the preserved workspace before automatic activation', () => {
  assert.equal(sessionMatchesWorkspace('account-a', account), true);
  assert.equal(sessionMatchesWorkspace(null, guest), true);
  assert.equal(sessionMatchesWorkspace('account-a', guest), false);
  assert.equal(sessionMatchesWorkspace('account-b', account), false);
  assert.equal(sessionMatchesWorkspace(null, account), false);
});

test('offline recovery wakes on reconnect, backs off, and pauses for a mismatch', async () => {
  let online = false, visible = true, canRetry = true, calls = 0, next = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const recovery = createSessionRecovery({
    canRetry: () => canRetry, isOnline: () => online, isVisible: () => visible,
    refresh: async () => { calls += 1; throw new Error('unavailable'); },
    setTimer: (callback, delay) => { const id = ++next; timers.set(id, { callback, delay }); return id; },
    clearTimer: (id) => { timers.delete(id); }, initialDelay: 10, maxDelay: 40,
  });
  recovery.schedule(); recovery.wake();
  assert.equal(calls, 0); assert.equal(timers.size, 0);
  online = true; recovery.wake();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  let timer = [...timers.entries()][0]; assert.equal(timer[1].delay, 10);
  timers.delete(timer[0]); timer[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2); timer = [...timers.entries()][0]; assert.equal(timer[1].delay, 20);
  timers.delete(timer[0]); timer[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  timer = [...timers.entries()][0]; assert.equal(timer[1].delay, 40);
  canRetry = false; recovery.wake(); timers.delete(timer[0]); timer[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3); assert.equal(timers.size, 0);
  canRetry = true; visible = false; recovery.wake(); assert.equal(calls, 3);
  visible = true; recovery.wake(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 4);
  recovery.stop(); assert.equal(timers.size, 0);
});
