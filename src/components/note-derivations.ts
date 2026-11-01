import type { Note } from '@/lib/types';
import { extractTasks } from '@/lib/features';

/** Content revisions change for edits; role and sync metadata can change without one. */
export function createStableNoteMerger() {
  const cache = new Map<string, { source: Note; draft?: Note; result: Note }>();
  return (notes: Note[], drafts: Record<string, { note: Note }>): Note[] => {
    const seen = new Set<string>();
    const result = notes.map((note) => {
      seen.add(note.id);
      const draft = drafts[note.id]?.note;
      const previous = cache.get(note.id);
      const old = previous?.source;
      const sameSource = old === note || (!!old && old.revision === note.revision && old.role === note.role && old.syncState === note.syncState && old.serverVersion === note.serverVersion &&
        old.title === note.title && old.body === note.body && old.notebookId === note.notebookId && old.pinned === note.pinned && old.createdAt === note.createdAt && old.updatedAt === note.updatedAt && old.deletedAt === note.deletedAt &&
        old.tags.length === note.tags.length && old.tags.every((tag, index) => tag === note.tags[index]));
      if (previous && sameSource && previous.draft === draft) return previous.result;
      const merged = draft ? { ...draft, role: note.role, syncState: note.syncState, serverVersion: note.serverVersion } : note;
      cache.set(note.id, { source: note, draft, result: merged });
      return merged;
    });
    for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
    return result;
  };
}

const taskCache = new WeakMap<Note, ReturnType<typeof extractTasks>>();
/** Parse each immutable note once; a changed note receives a new identity. */
export function cachedTasks(notes: Note[]): ReturnType<typeof extractTasks> {
  return notes.flatMap((note) => {
    let tasks = taskCache.get(note);
    if (!tasks) { tasks = extractTasks([note]); taskCache.set(note, tasks); }
    return tasks;
  });
}

export const NOTE_PAGE_SIZE = 50;
export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
/** Keep an older open note visible without rendering every intervening row. */
export function noteListPage(sorted: Note[], limit: number, selectedId: string | null) {
  const count = Math.max(0, Math.floor(limit));
  const visible = sorted.slice(0, count);
  const selectedIndex = selectedId ? sorted.findIndex((note) => note.id === selectedId) : -1;
  return {
    visible,
    selectedOutside: selectedIndex >= count ? sorted[selectedIndex] : undefined,
    remaining: Math.max(0, sorted.length - visible.length),
  };
}
