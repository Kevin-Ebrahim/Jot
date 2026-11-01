import type { CollaborationSession } from './api';

/** A verified identity is not permission to silently change the local scope. */
export function sessionMatchesWorkspace(workspaceId: string | null, session: CollaborationSession): boolean {
  return workspaceId === (session.user?.id ?? null);
}

/** Event-driven retry with capped exponential backoff. The caller supplies the
 * live session state so an identity mismatch can pause retries for a decision. */
export function createSessionRecovery(options: {
  canRetry: () => boolean;
  isOnline: () => boolean;
  isVisible: () => boolean;
  refresh: () => Promise<void>;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (id: number) => void;
  initialDelay?: number;
  maxDelay?: number;
}) {
  const initialDelay = options.initialDelay ?? 5_000;
  const maxDelay = options.maxDelay ?? 60_000;
  let delay = initialDelay;
  let timer: number | null = null;
  let running = false;
  let stopped = false;
  const allowed = () => !stopped && options.canRetry() && options.isOnline() && options.isVisible();
  const cancelTimer = () => { if (timer !== null) options.clearTimer(timer); timer = null; };

  function schedule(): void {
    if (!allowed() || running || timer !== null) return;
    const wait = delay;
    delay = Math.min(delay * 2, maxDelay);
    timer = options.setTimer(() => { timer = null; attempt(); }, wait);
  }
  function attempt(): void {
    if (!allowed() || running) return;
    running = true;
    void options.refresh().catch(() => undefined).finally(() => { running = false; schedule(); });
  }
  function wake(): void {
    if (!allowed()) return;
    cancelTimer();
    attempt();
  }
  function pause(): void { cancelTimer(); }
  function reset(): void { cancelTimer(); delay = initialDelay; }
  function stop(): void { stopped = true; cancelTimer(); }
  return { schedule, wake, pause, reset, stop };
}
