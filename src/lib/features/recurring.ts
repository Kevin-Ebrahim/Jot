import type { NewNote, Note } from "@/lib/types";
import { nextRecurrenceDate, type RepeatInterval } from "./tasks";

export interface DueRecurringNote { note: Note; dueAt: string; interval: RepeatInterval; }
export interface RecurringOccurrence {
  /** Stable for a given source and scheduled date; useful for sync idempotency. */
  occurrenceKey: string;
  dueAt: string;
  nextDueAt: string;
  nextSourceBody: string;
  newInput: NewNote;
}

const markerPattern = /@repeat-note\((daily|weekly|monthly|yearly)\s*,\s*(\d{4}-\d{2}-\d{2})\)/i;
function findMarker(body: string): { start: number; end: number; dueAt: string; interval: RepeatInterval } | undefined {
  let offset = 0;
  let inFence = false;
  for (const line of body.split(/(?<=\n)/)) {
    if (/^\s*```/.test(line)) { inFence = !inFence; offset += line.length; continue; }
    if (!inFence) {
      const visible = line.replace(/`[^`]*`/g, (code) => " ".repeat(code.length));
      const match = visible.match(markerPattern);
      if (match && match.index !== undefined) {
        const interval = match[1].toLowerCase() as RepeatInterval;
        const dueAt = match[2];
        if (nextRecurrenceDate(dueAt, interval)) return { start: offset + match.index, end: offset + match.index + match[0].length, dueAt, interval };
      }
    }
    offset += line.length;
  }
  return undefined;
}
function localDate(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

/** Read an explicit schedule without considering whether it is due yet. */
export function getRecurringSchedule(note: Note): { interval: RepeatInterval; dueAt: string } | undefined {
  if (note.deletedAt) return undefined;
  const marker = findMarker(note.body);
  return marker ? { interval: marker.interval, dueAt: marker.dueAt } : undefined;
}

function withoutMarker(body: string, marker: { start: number; end: number }): string {
  const lineStart = body.lastIndexOf("\n", marker.start - 1) + 1;
  const newline = body.indexOf("\n", marker.end);
  const lineEnd = newline < 0 ? body.length : newline;
  const remainder = `${body.slice(lineStart, marker.start)}${body.slice(marker.end, lineEnd)}`;
  return /^\s*(?:repeat(?: schedule)?\s*:\s*)?$/i.test(remainder)
    ? `${body.slice(0, lineStart)}${body.slice(newline < 0 ? lineEnd : lineEnd + 1)}`
    : `${body.slice(0, marker.start)}${body.slice(marker.end)}`;
}

/** Remove a visible schedule without altering a marker shown inside code. */
export function removeRecurringSchedule(body: string): string {
  const marker = findMarker(body);
  return marker ? withoutMarker(body, marker) : body;
}

/** Add or replace a visible schedule marker; rejects invalid dates. */
export function setRecurringSchedule(body: string, interval: RepeatInterval, dueAt: string): string {
  if (!nextRecurrenceDate(dueAt, interval)) throw new Error("Enter a valid recurrence date.");
  const value = `@repeat-note(${interval},${dueAt})`;
  const marker = findMarker(body);
  return marker ? `${body.slice(0, marker.start)}${value}${body.slice(marker.end)}` : `${body.trimEnd()}${body.trim() ? "\n\n" : ""}Repeat: ${value}`;
}

/**
 * Find manually due note templates with @repeat-note(weekly,YYYY-MM-DD).
 * This is a local queue, not a background scheduler or notification.
 */
export function getDueRecurringNotes(notes: Note[], now = new Date(), limit = 8): DueRecurringNote[] {
  const today = localDate(now);
  return notes.filter((note) => !note.deletedAt).flatMap((note) => {
    const marker = findMarker(note.body);
    return marker && marker.dueAt <= today ? [{ note, dueAt: marker.dueAt, interval: marker.interval }] : [];
  }).sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.note.title.localeCompare(b.note.title)).slice(0, Math.max(0, limit));
}

/**
 * Prepare one occurrence and advance its source marker. Persist both changes
 * atomically with the source's expected revision; do not save them separately.
 * The copy does not itself carry the schedule. {{date}} expands to the due date.
 */
export function prepareNextRecurringNote(source: Note): RecurringOccurrence | undefined {
  if (source.deletedAt) return undefined;
  const marker = findMarker(source.body);
  if (!marker) return undefined;
  const nextDueAt = nextRecurrenceDate(marker.dueAt, marker.interval);
  if (!nextDueAt) return undefined;
  const nextSourceBody = `${source.body.slice(0, marker.start)}@repeat-note(${marker.interval},${nextDueAt})${source.body.slice(marker.end)}`;
  const body = withoutMarker(source.body, marker).replaceAll("{{date}}", marker.dueAt).trim();
  const rawTitle = source.title.trim() || "Untitled";
  const title = rawTitle.includes("{{date}}") ? rawTitle.replaceAll("{{date}}", marker.dueAt) : `${rawTitle} · ${marker.dueAt}`;
  return {
    occurrenceKey: `${source.id}:${marker.dueAt}`,
    dueAt: marker.dueAt,
    nextDueAt,
    nextSourceBody,
    newInput: { title, body, tags: [...source.tags], notebookId: source.notebookId, pinned: false },
  };
}
