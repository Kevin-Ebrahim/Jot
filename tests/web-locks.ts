/** A process-local Web Locks stand-in shared by independently imported sync modules. */
const tails = new Map<string, Promise<void>>();
const manager = {
  async request<T>(name: string, options: { signal?: AbortSignal }, callback: (lock: { name: string; mode: string }) => Promise<T>): Promise<T> {
    const prior = tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    tails.set(name, prior.catch(() => {}).then(() => current));
    await prior.catch(() => {});
    try {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return await callback({ name, mode: 'exclusive' });
    } finally { release(); }
  },
};
Object.defineProperty(globalThis.navigator, 'locks', { value: manager, configurable: true });
