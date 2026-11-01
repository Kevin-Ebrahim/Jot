import type { Note } from "@/lib/types";
import type { SearchOptions } from "./search";
import { SearchNoteTracker, type SearchWorkerRequest, type SearchWorkerResponse } from "./search-worker-protocol";

export interface SearchWorkerPort {
  postMessage(message: SearchWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<SearchWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: (() => void) | null;
}
interface Input { query: string; options: SearchOptions; key: string; }
interface Job extends Input { requestId: number; version: number; }

/**
 * One in-flight search and one latest pending query: rapid typing cannot queue
 * dozens of expensive searches. Index deltas are sent only when notes change.
 */
export class SearchWorkerClient {
  private tracker = new SearchNoteTracker();
  private version = 0;
  private sequence = 0;
  private inFlight: Job | null = null;
  private desired: Job | null = null;
  private lastInput: Input | null = null;
  private disposed = false;

  constructor(private worker: SearchWorkerPort, private onResult: (ids: string[], key: string) => void, private onFailure: (message: string) => void) {
    worker.onmessage = (event) => this.receive(event.data);
    worker.onerror = (event) => this.fail(event.message || "Search worker failed.");
    worker.onmessageerror = () => this.fail("Couldn’t read search results.");
  }

  updateNotes(notes: Note[]): boolean {
    if (this.disposed) return false;
    const delta = this.tracker.update(notes);
    if (!delta) return false;
    this.version += 1;
    try { this.worker.postMessage({ type: "sync", version: this.version, ...delta }); }
    catch { this.fail("Couldn’t update the search index."); return false; }
    if (this.lastInput) this.enqueue(this.lastInput);
    return true;
  }

  search(query: string, options: SearchOptions, key: string): void {
    if (this.disposed) return;
    this.lastInput = { query, options: { ...options, tags: options.tags ? [...options.tags] : undefined }, key };
    this.enqueue(this.lastInput);
  }

  private enqueue(input: Input): void {
    this.desired = { ...input, requestId: ++this.sequence, version: this.version };
    this.dispatch();
  }
  private dispatch(): void {
    if (this.disposed || this.inFlight || !this.desired) return;
    const job = this.desired;
    this.inFlight = job;
    try { this.worker.postMessage({ type: "search", requestId: job.requestId, version: job.version, query: job.query, options: job.options }); }
    catch { this.fail("Couldn’t start search."); }
  }
  private receive(message: SearchWorkerResponse): void {
    const job = this.inFlight;
    if (this.disposed || !job || message.requestId !== job.requestId) return;
    this.inFlight = null;
    if (message.type === "error") { this.fail(message.message); return; }
    const current = this.desired;
    if (current?.requestId === job.requestId && current.version === message.version && message.version === this.version) {
      this.desired = null;
      this.onResult(message.ids, job.key);
    }
    this.dispatch();
  }
  private fail(message: string): void {
    if (this.disposed) return;
    this.dispose();
    this.onFailure(message);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
    this.worker.terminate();
    this.tracker.clear();
    this.inFlight = null; this.desired = null; this.lastInput = null;
  }
}
