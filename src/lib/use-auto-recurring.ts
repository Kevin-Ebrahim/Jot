'use client';
import { useEffect, useRef } from 'react';
import { runDueRecurring } from './auto-recurring';
import { subscribeStore } from './store';

/** Run on open, foregrounding and periodically; never implies a closed-app scheduler. */
export function useAutoRecurring(options: {
  workspaceId: string | null; isLoading: boolean; locked: boolean; isNoteBusy: (id: string) => boolean;
  runOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  onError?: (message: string) => void;
}): void {
  const busy = useRef(options.isNoteBusy); busy.current = options.isNoteBusy;
  const onError = useRef(options.onError); onError.current = options.onError;
  const runOperation = useRef(options.runOperation); runOperation.current = options.runOperation;
  useEffect(() => {
    if (options.isLoading || options.locked) return;
    let stopped = false, running = false;
    let debounce: number | undefined;
    const run = async () => {
      if (stopped || running || document.visibilityState === 'hidden') return;
      running = true;
      try {
        const result = await runOperation.current(() => runDueRecurring({ workspaceId: options.workspaceId, isNoteBusy: id => busy.current(id) }));
        if (!stopped && result.errors.length) onError.current?.(result.errors[0]);
      } catch (cause) {
        // A lease may lock after render but before this pass starts. That is a
        // normal transition; the next visible/unlocked pass will retry.
        if (!stopped && !(cause instanceof Error && cause.message === 'Wait for the workspace operation to finish.'))
          onError.current?.(cause instanceof Error ? cause.message : 'Could not run recurring notes.');
      } finally { running = false; }
    };
    void run();
    const timer = window.setInterval(() => void run(), 15 * 60 * 1000);
    const schedule = () => { window.clearTimeout(debounce); debounce = window.setTimeout(() => void run(), 2_000); };
    const unsubscribe = subscribeStore(schedule);
    const visibility = () => { if (document.visibilityState === 'visible') void run(); };
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('focusout', schedule);
    return () => { stopped = true; window.clearInterval(timer); window.clearTimeout(debounce); unsubscribe();
      document.removeEventListener('visibilitychange', visibility); document.removeEventListener('focusout', schedule); };
  }, [options.workspaceId, options.isLoading, options.locked]);
}
