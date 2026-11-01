import type { Note } from "@/lib/types";
import type { SearchOptions } from "./search";

export type SearchWorkerRequest =
  | { type: "sync"; version: number; upserts: Note[]; removedIds: string[]; order: string[] }
  | { type: "search"; requestId: number; version: number; query: string; options: SearchOptions };
export type SearchWorkerResponse =
  | { type: "result"; requestId: number; version: number; ids: string[] }
  | { type: "error"; requestId: number; version: number; message: string };

interface Fingerprint { revision: number; title: string; body: string; tags: string; updatedAt: string; deletedAt: string | null; }
function fingerprint(note: Note): Fingerprint {
  return { revision: note.revision, title: note.title, body: note.body, tags: JSON.stringify(note.tags), updatedAt: note.updatedAt, deletedAt: note.deletedAt };
}
function same(a: Fingerprint | undefined, b: Fingerprint): boolean {
  return !!a && a.revision === b.revision && a.title === b.title && a.body === b.body && a.tags === b.tags && a.updatedAt === b.updatedAt && a.deletedAt === b.deletedAt;
}

/** Incremental transfer planner. No note text is retained after clear/worker disposal. */
export class SearchNoteTracker {
  private notes = new Map<string, Fingerprint>();
  private order: string[] = [];
  update(notes: Note[]): { upserts: Note[]; removedIds: string[]; order: string[] } | null {
    const next = new Map<string, Fingerprint>();
    const upserts: Note[] = [];
    for (const note of notes) {
      const value = fingerprint(note);
      next.set(note.id, value);
      if (!same(this.notes.get(note.id), value)) upserts.push(note);
    }
    const removedIds = [...this.notes.keys()].filter((id) => !next.has(id));
    const order = notes.map((note) => note.id);
    const orderChanged = order.length !== this.order.length || order.some((id, index) => this.order[index] !== id);
    this.notes = next; this.order = order;
    return upserts.length || removedIds.length || orderChanged ? { upserts, removedIds, order } : null;
  }
  clear(): void { this.notes.clear(); this.order = []; }
}
