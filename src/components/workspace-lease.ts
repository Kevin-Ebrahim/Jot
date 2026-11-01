/**
 * Coordinates session transitions, backups, and local writes. The lock is set
 * synchronously before awaiting a flush so no new edit can enter the gap.
 */
export interface WorkspaceLeaseState {
  locked: boolean;
  transitioning: boolean;
  transferring: boolean;
}

export function createWorkspaceLease(options: {
  flushDrafts: () => Promise<void>;
  onChange: (state: WorkspaceLeaseState) => void;
}) {
  let state: WorkspaceLeaseState = { locked: true, transitioning: false, transferring: false };
  let activeOperations = 0;
  let generation = 0;
  const publish = (next: WorkspaceLeaseState) => { state = next; options.onChange(state); };
  const busy = () => state.transitioning || state.transferring || activeOperations > 0;

  async function beginTransition(): Promise<() => void> {
    if (state.transitioning) throw new Error('A workspace change is already in progress.');
    if (state.transferring || activeOperations) throw new Error('Wait for the current note or backup operation to finish before changing accounts.');
    const token = ++generation;
    publish({ locked: true, transitioning: true, transferring: false });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (token !== generation) return;
      publish({ locked: false, transitioning: false, transferring: false });
    };
    try { await options.flushDrafts(); return release; }
    catch (error) { release(); throw error; }
  }

  async function runOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (state.locked) throw new Error('Wait for the workspace operation to finish.');
    activeOperations += 1;
    try { return await operation(); } finally { activeOperations -= 1; }
  }

  async function runTransfer<T>(operation: () => Promise<T>): Promise<T> {
    if (state.locked || busy()) throw new Error('Wait for the current note or workspace operation to finish.');
    const token = ++generation;
    publish({ locked: true, transitioning: false, transferring: true });
    try {
      await options.flushDrafts();
      return await operation();
    } finally {
      if (token === generation) publish({ locked: false, transitioning: false, transferring: false });
    }
  }

  return {
    beginTransition, runOperation, runTransfer,
    isLocked: () => state.locked,
    isTransitioning: () => state.transitioning,
  };
}
