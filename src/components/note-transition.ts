/** Synchronous identity guard for create/select transitions. */
export function createNoteTransitionGuard() {
  let currentId: string | null = null;
  let active: { token: number; previous: string | null } | null = null;
  let generation = 0;
  return {
    select(id: string | null): boolean {
      if (active) return false;
      currentId = id;
      return true;
    },
    begin(): number | null {
      if (active) return null;
      active = { token: ++generation, previous: currentId };
      currentId = null;
      return active.token;
    },
    complete(token: number, id: string): boolean {
      if (!active || active.token !== token) return false;
      currentId = id; active = null; return true;
    },
    cancel(token: number): string | null {
      if (!active || active.token !== token) return currentId;
      currentId = active.previous; active = null; return currentId;
    },
    accepts(id: string): boolean { return !active && currentId === id; },
    isActive(): boolean { return !!active; },
  };
}
