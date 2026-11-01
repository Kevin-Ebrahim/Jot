/**
 * Web Locks serialize sync and conflict decisions across all same-origin tabs.
 * Without this browser primitive, refuse account sync rather than risk a stale
 * attachment request racing a user's explicit discard choice.
 */
export async function withWorkspaceLock<T>(workspace: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    throw new Error('Safe account sync requires browser Web Locks support. Local notes and export still work.');
  }
  const controller = signal ? undefined : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), 25_000) : undefined;
  let acquired = false;
  try {
    return await navigator.locks.request(`jot-sync:${workspace}`, { mode: 'exclusive', signal: signal ?? controller?.signal }, async () => { acquired = true; return operation(); });
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') throw new Error(acquired ? 'Sync timed out; your changes remain local.' : 'Waiting for another tab timed out; your changes remain local.');
    throw cause;
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
}
