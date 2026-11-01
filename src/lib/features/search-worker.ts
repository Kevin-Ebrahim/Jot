import type { Note } from "@/lib/types";
import { searchNotes } from "./search";
import type { SearchWorkerRequest, SearchWorkerResponse } from "./search-worker-protocol";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<SearchWorkerRequest>) => void) | null;
  postMessage(message: SearchWorkerResponse): void;
};
const notes = new Map<string, Note>();
let order: string[] = [];
let version = 0;

scope.onmessage = ({ data }) => {
  if (data.type === "sync") {
    for (const id of data.removedIds) notes.delete(id);
    for (const note of data.upserts) notes.set(note.id, note);
    order = data.order;
    version = data.version;
    return;
  }
  try {
    const ordered = order.flatMap((id) => { const note = notes.get(id); return note ? [note] : []; });
    const ids = searchNotes(ordered, data.query, data.options).map((note) => note.id);
    scope.postMessage({ type: "result", requestId: data.requestId, version, ids });
  } catch (cause) {
    scope.postMessage({ type: "error", requestId: data.requestId, version, message: cause instanceof Error ? cause.message : "Search failed." });
  }
};
