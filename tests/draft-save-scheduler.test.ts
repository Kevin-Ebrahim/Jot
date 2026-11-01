import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftSaveScheduler, scheduleDraftEdit, type DraftTimerDriver } from '../src/components/draft-save-scheduler';

function fakeClock() {
  let now = 0, next = 0;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  const driver: DraftTimerDriver = {
    set(callback, delay) { const id = ++next; tasks.set(id, { at: now + delay, callback }); return id as unknown as ReturnType<typeof setTimeout>; },
    clear(handle) { tasks.delete(handle as unknown as number); },
  };
  const advance = (milliseconds: number) => {
    const target = now + milliseconds;
    while (true) {
      const due = [...tasks.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      now = due[1].at; tasks.delete(due[0]); due[1].callback();
    }
    now = target;
  };
  return { driver, advance };
}

test('continuous typing saves no later than two seconds after the first dirty edit', () => {
  const clock = fakeClock(); const saves: string[] = [];
  const scheduler = createDraftSaveScheduler((id) => saves.push(id), clock.driver);
  scheduleDraftEdit(scheduler, 'note', true);
  for (let elapsed = 100; elapsed < 2_000; elapsed += 100) { clock.advance(100); scheduleDraftEdit(scheduler, 'note', true); }
  assert.deepEqual(saves, []);
  clock.advance(100); assert.deepEqual(saves, ['note']);
  scheduler.schedule('note'); clock.advance(650); assert.deepEqual(saves, ['note', 'note']);
});

test('clearing a draft cancels both pause and maximum timers independently', () => {
  const clock = fakeClock(); const saves: string[] = [];
  const scheduler = createDraftSaveScheduler((id) => saves.push(id), clock.driver);
  scheduler.schedule('a'); scheduler.schedule('b'); scheduler.clear('a'); clock.advance(2_100);
  assert.deepEqual(saves, ['b']);
  scheduler.schedule('c'); scheduler.clearAll(); clock.advance(2_100); assert.deepEqual(saves, ['b']);
});
