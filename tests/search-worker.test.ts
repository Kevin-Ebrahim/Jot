import assert from "node:assert/strict";
import { test } from "node:test";
import type { Note } from "../src/lib/types";
import { searchNotes } from "../src/lib/features/search";
import { SearchWorkerClient, type SearchWorkerPort } from "../src/lib/features/search-worker-client";
import { SearchNoteTracker, type SearchWorkerRequest, type SearchWorkerResponse } from "../src/lib/features/search-worker-protocol";
import { paginateSearchResults, SEARCH_PAGE_SIZE } from "../src/lib/features/search-pagination";

function note(id: string, title = id, body = ""): Note {
  return { id, title, body, tags: [], notebookId: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null, revision: 1, serverVersion: null, syncState: "local", role: "owner", pinned: false };
}
class FakeWorker implements SearchWorkerPort {
  sent: SearchWorkerRequest[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<SearchWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage(message: SearchWorkerRequest) { this.sent.push(message); }
  terminate() { this.terminated = true; }
  deliver(message: SearchWorkerResponse) { this.onmessage?.({ data: message } as MessageEvent<SearchWorkerResponse>); }
}

test("index planner transfers only changed/deleted notes and preserves order", () => {
  const tracker = new SearchNoteTracker();
  const a = note("a", "Alpha", "first"), b = note("b", "Beta", "second");
  assert.deepEqual(tracker.update([a, b])?.upserts.map((item) => item.id), ["a", "b"]);
  assert.equal(tracker.update([{ ...a }, { ...b }]), null);
  // Draft edits can change body while the stored revision is unchanged.
  const edited = { ...a, body: "new draft" };
  const delta = tracker.update([b, edited]);
  assert.deepEqual(delta?.upserts.map((item) => item.id), ["a"]);
  assert.deepEqual(delta?.order, ["b", "a"]);
  assert.deepEqual(tracker.update([edited])?.removedIds, ["b"]);
  tracker.clear();
  assert.deepEqual(tracker.update([edited])?.upserts.map((item) => item.id), ["a"]);
});

test("rapid queries coalesce, discard stale results, and resync only deltas", () => {
  const worker = new FakeWorker();
  const results: Array<{ ids: string[]; key: string }> = [];
  const failures: string[] = [];
  const client = new SearchWorkerClient(worker, (ids, key) => results.push({ ids, key }), (message) => failures.push(message));
  const a = note("a", "Database indexes"), b = note("b", "Other");
  client.updateNotes([a, b]);
  client.search("d", {}, "d"); client.search("da", {}, "da"); client.search("database", {}, "database");
  assert.equal(worker.sent.filter((message) => message.type === "sync").length, 1);
  const first = worker.sent.find((message) => message.type === "search"); assert.ok(first && first.type === "search");
  assert.equal(worker.sent.filter((message) => message.type === "search").length, 1, "only one query may be in flight");
  worker.deliver({ type: "result", requestId: first.requestId, version: first.version, ids: ["b"] });
  assert.deepEqual(results, [], "stale results must not reach the UI");
  const searches = worker.sent.filter((message) => message.type === "search");
  assert.equal(searches.length, 2); const latest = searches[1]; assert.equal(latest.query, "database");
  worker.deliver({ type: "result", requestId: latest.requestId, version: latest.version, ids: ["a"] });
  assert.deepEqual(results, [{ ids: ["a"], key: "database" }]);
  client.updateNotes([{ ...a, body: "new draft" }]);
  const sync = worker.sent.filter((message) => message.type === "sync").at(-1); assert.ok(sync && sync.type === "sync");
  assert.deepEqual(sync.upserts.map((item) => item.id), ["a"]); assert.deepEqual(sync.removedIds, ["b"]);
  const afterUpdate = worker.sent.filter((message) => message.type === "search").at(-1); assert.ok(afterUpdate && afterUpdate.type === "search");
  assert.equal(afterUpdate.query, "database"); assert.equal(afterUpdate.version, sync.version);
  client.dispose(); assert.equal(worker.terminated, true); assert.equal(worker.onmessage, null); assert.deepEqual(failures, []);
});

test("worker returns every ranked match with the same pure search semantics", async () => {
  const previousMessage = Object.getOwnPropertyDescriptor(globalThis, "onmessage");
  const previousPost = Object.getOwnPropertyDescriptor(globalThis, "postMessage");
  const posted: SearchWorkerResponse[] = [];
  Object.defineProperty(globalThis, "postMessage", { configurable: true, value: (message: SearchWorkerResponse) => posted.push(message) });
  try {
    await import("../src/lib/features/search-worker");
    const receive = (globalThis as unknown as { onmessage: (event: { data: SearchWorkerRequest }) => void }).onmessage;
    const notes = Array.from({ length: 75 }, (_, index) => note(`n${index}`, `Database note ${index}`, "Indexing and query plans"));
    receive({ data: { type: "sync", version: 1, upserts: notes, removedIds: [], order: notes.map((item) => item.id) } });
    receive({ data: { type: "search", requestId: 7, version: 1, query: "database indexes", options: {} } });
    const response = posted.at(-1); assert.ok(response && response.type === "result");
    assert.equal(response.ids.length, 75, "the worker must not truncate matches");
    assert.deepEqual(response.ids, searchNotes(notes, "database indexes").map((item) => item.id));
    const first = paginateSearchResults(response.ids, SEARCH_PAGE_SIZE);
    assert.equal(first.visible.length, 30); assert.equal(first.remaining, 45);
    const second = paginateSearchResults(response.ids, SEARCH_PAGE_SIZE * 2);
    assert.equal(second.visible.length, 60); assert.equal(second.remaining, 15);
    const last = paginateSearchResults(response.ids, SEARCH_PAGE_SIZE * 3);
    assert.equal(last.visible.length, 75); assert.equal(last.remaining, 0);
  } finally {
    if (previousMessage) Object.defineProperty(globalThis, "onmessage", previousMessage); else Reflect.deleteProperty(globalThis, "onmessage");
    if (previousPost) Object.defineProperty(globalThis, "postMessage", previousPost); else Reflect.deleteProperty(globalThis, "postMessage");
  }
});

test("disposing a workspace worker drops pending results and never seeds the next scope", () => {
  const oldWorker = new FakeWorker();
  const oldResults: string[][] = [];
  const oldClient = new SearchWorkerClient(oldWorker, (ids) => oldResults.push(ids), () => undefined);
  oldClient.updateNotes([note("private-a", "Private workspace A")]);
  oldClient.search("private", {}, "private");
  const oldSearch = oldWorker.sent.find((message) => message.type === "search"); assert.ok(oldSearch && oldSearch.type === "search");
  oldClient.dispose();
  oldWorker.deliver({ type: "result", requestId: oldSearch.requestId, version: oldSearch.version, ids: ["private-a"] });
  assert.deepEqual(oldResults, []);
  const newWorker = new FakeWorker();
  const newClient = new SearchWorkerClient(newWorker, () => undefined, () => undefined);
  newClient.updateNotes([note("private-b", "Private workspace B")]);
  const sync = newWorker.sent[0]; assert.equal(sync.type, "sync");
  if (sync.type === "sync") assert.deepEqual(sync.upserts.map((item) => item.id), ["private-b"]);
  newClient.dispose();
});

test("worker startup or message failures trigger a clean fallback signal", () => {
  const worker = new FakeWorker();
  const failures: string[] = [];
  const client = new SearchWorkerClient(worker, () => assert.fail("unexpected result"), (message) => failures.push(message));
  client.updateNotes([note("a")]); client.search("a", {}, "a");
  worker.onerror?.({ message: "worker blocked" } as ErrorEvent);
  assert.deepEqual(failures, ["worker blocked"]);
  assert.equal(worker.terminated, true); assert.equal(worker.onmessage, null);
});

test("an index change during a slow query suppresses its old version", () => {
  const worker = new FakeWorker(); const results: string[][] = [];
  const client = new SearchWorkerClient(worker, (ids) => results.push(ids), () => undefined);
  const old = note("a", "Old title", "before");
  client.updateNotes([old]); client.search("new", {}, "new");
  const first = worker.sent.find((message) => message.type === "search"); assert.ok(first && first.type === "search");
  client.updateNotes([{ ...old, title: "New title", body: "after" }]);
  worker.deliver({ type: "result", requestId: first.requestId, version: first.version, ids: [] });
  assert.deepEqual(results, []);
  const retry = worker.sent.filter((message) => message.type === "search").at(-1); assert.ok(retry && retry.type === "search");
  assert.ok(retry.version > first.version);
  worker.deliver({ type: "result", requestId: retry.requestId, version: retry.version, ids: ["a"] });
  assert.deepEqual(results, [["a"]]);
  client.dispose();
});
