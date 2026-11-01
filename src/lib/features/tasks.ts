import type { Note } from "@/lib/types";

export type RepeatInterval = "daily" | "weekly" | "monthly" | "yearly";
export interface NoteTask {
  /** Stable while its source line stays in place; always re-read the note before writing. */
  id: string;
  noteId: string;
  noteTitle: string;
  text: string;
  done: boolean;
  lineIndex: number;
  dueAt?: string;
  remindAt?: string;
  repeat?: RepeatInterval;
}

const taskLine = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\]\s+)(.*)$/;
const duePattern = /@due\((\d{4}-\d{2}-\d{2})\)/i;
const remindPattern = /@remind\((\d{4}-\d{2}-\d{2})\)/i;
const repeatPattern = /@repeat\((daily|weekly|monthly|yearly)\)/i;

function validDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function extractTasks(notes: Note[]): NoteTask[] {
  const tasks: NoteTask[] = [];
  for (const note of notes) {
    if (note.deletedAt) continue;
    let inFence = false;
    note.body.split(/\r?\n/).forEach((line, lineIndex) => {
      if (/^\s*```/.test(line)) { inFence = !inFence; return; }
      if (inFence) return;
      const match = line.match(taskLine);
      if (!match) return;
      const source = match[4];
      const due = source.match(duePattern)?.[1];
      const remind = source.match(remindPattern)?.[1];
      const repeat = source.match(repeatPattern)?.[1].toLowerCase() as RepeatInterval | undefined;
      tasks.push({
        id: `${note.id}:${lineIndex}`,
        noteId: note.id,
        noteTitle: note.title,
        text: source.replace(duePattern, "").replace(remindPattern, "").replace(repeatPattern, "").replace(/\s+/g, " ").trim(),
        done: match[2].toLowerCase() === "x",
        lineIndex,
        ...(validDate(due) ? { dueAt: due } : {}),
        ...(validDate(remind) ? { remindAt: remind } : {}),
        ...(repeat ? { repeat } : {}),
      });
    });
  }
  return tasks;
}

/** Returns the next calendar occurrence (UTC date only), clamped to month-end. */
export function nextRecurrenceDate(value: string, repeat: RepeatInterval): string | undefined {
  if (!validDate(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (repeat === "daily" || repeat === "weekly") date.setUTCDate(date.getUTCDate() + (repeat === "daily" ? 1 : 7));
  else {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    if (repeat === "monthly") date.setUTCMonth(date.getUTCMonth() + 1);
    else if (repeat === "yearly") date.setUTCFullYear(date.getUTCFullYear() + 1);
    else return undefined;
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Toggle one Markdown task. Completing a dated recurring task adds its next
 * unchecked occurrence once, keeping all work local and reviewable. An undated
 * recurring task only toggles, because guessing an anchor date would be surprising.
 */
export function toggleTaskInBody(body: string, lineIndex: number): string {
  const separator = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const match = lines[lineIndex]?.match(taskLine);
  if (!match) return body;
  const completing = match[2] === " ";
  lines[lineIndex] = `${match[1]}${completing ? "x" : " "}${match[3]}${match[4]}`;
  if (completing) {
    const due = match[4].match(duePattern)?.[1];
    const repeat = match[4].match(repeatPattern)?.[1]?.toLowerCase() as RepeatInterval | undefined;
    const nextDue = due && repeat ? nextRecurrenceDate(due, repeat) : undefined;
    if (nextDue && repeat) {
      let nextText = match[4].replace(duePattern, `@due(${nextDue})`);
      const remind = match[4].match(remindPattern)?.[1];
      // Keep the reminder's lead/lag relative to the due date, including across short months.
      const nextReminder = remind && validDate(remind) && validDate(due)
        ? new Date(Date.parse(`${nextDue}T00:00:00.000Z`) + Date.parse(`${remind}T00:00:00.000Z`) - Date.parse(`${due}T00:00:00.000Z`)).toISOString().slice(0, 10)
        : undefined;
      if (nextReminder) nextText = nextText.replace(remindPattern, `@remind(${nextReminder})`);
      const nextLine = `${match[1]} ${match[3]}${nextText}`;
      // Rechecking after a mistaken completion should not create an identical duplicate.
      if (!lines.includes(nextLine)) lines.splice(lineIndex + 1, 0, nextLine);
    }
  }
  return lines.join(separator);
}
