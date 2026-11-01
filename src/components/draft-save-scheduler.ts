type TimerHandle = ReturnType<typeof setTimeout>;
export interface DraftTimerDriver {
  set(callback: () => void, delay: number): TimerHandle;
  clear(handle: TimerHandle): void;
}
const browserTimers: DraftTimerDriver = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle),
};

/** Debounce brief pauses, but never postpone a dirty draft beyond the maximum wait. */
export function createDraftSaveScheduler(onSave: (id: string) => void, timers: DraftTimerDriver = browserTimers) {
  const debounce = new Map<string, TimerHandle>();
  const maximum = new Map<string, TimerHandle>();
  const clear = (id: string) => {
    const short = debounce.get(id); if (short !== undefined) timers.clear(short);
    const long = maximum.get(id); if (long !== undefined) timers.clear(long);
    debounce.delete(id); maximum.delete(id);
  };
  const schedule = (id: string) => {
    const existing = debounce.get(id); if (existing !== undefined) timers.clear(existing);
    debounce.set(id, timers.set(() => { clear(id); onSave(id); }, 650));
    if (!maximum.has(id)) maximum.set(id, timers.set(() => { clear(id); onSave(id); }, 2_000));
  };
  const clearAll = () => { for (const id of new Set([...debounce.keys(), ...maximum.keys()])) clear(id); };
  return { schedule, clear, clearAll };
}

/** Keep an existing maximum deadline while refreshing only the pause timer. */
export function scheduleDraftEdit(scheduler: ReturnType<typeof createDraftSaveScheduler>, id: string, eligible: boolean): void {
  if (eligible) scheduler.schedule(id);
  else scheduler.clear(id);
}
