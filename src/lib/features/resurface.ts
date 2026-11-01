import type { Note } from "@/lib/types";

export interface ResurfacedNote { note: Note; reason: string; }
const DAY = 24 * 60 * 60 * 1000;

/**
 * An intentional local "rediscover" queue: notes untouched for 30 days or more,
 * with anniversary notes first. It does not claim to send notifications.
 */
export function getResurfacedNotes(notes: Note[], now = new Date(), limit = 4): ResurfacedNote[] {
  return notes.filter((note) => !note.deletedAt).flatMap((note) => {
    const updated = new Date(note.updatedAt);
    const created = new Date(note.createdAt);
    if (Number.isNaN(updated.valueOf()) || Number.isNaN(created.valueOf())) return [];
    const days = Math.floor((now.valueOf() - updated.valueOf()) / DAY);
    if (days < 30) return [];
    const years = now.getUTCFullYear() - created.getUTCFullYear();
    const anniversary = years > 0 && now.getUTCMonth() === created.getUTCMonth() && now.getUTCDate() === created.getUTCDate();
    const reason = anniversary ? `Created ${years} ${years === 1 ? "year" : "years"} ago today` : `Last edited ${days} days ago`;
    return [{ note, reason, days, anniversary }];
  }).sort((a, b) => Number(b.anniversary) - Number(a.anniversary) || b.days - a.days)
    .slice(0, Math.max(0, limit)).map(({ note, reason }) => ({ note, reason }));
}

export interface DueReview { note: Note; dueAt: string; }
const reviewPattern = /@review\((\d{4}-\d{2}-\d{2})\)/i;
function dateKey(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}
function isDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function findReview(body: string): { value: string; start: number; end: number } | undefined {
  let offset = 0;
  let inFence = false;
  for (const line of body.split(/(?<=\n)/)) {
    if (/^\s*```/.test(line)) { inFence = !inFence; offset += line.length; continue; }
    if (!inFence) {
      // Preserve offsets while excluding inline code.
      const visible = line.replace(/`[^`]*`/g, (code) => " ".repeat(code.length));
      const match = visible.match(reviewPattern);
      if (match && match.index !== undefined && isDate(match[1])) return { value: match[1], start: offset + match.index, end: offset + match.index + match[0].length };
    }
    offset += line.length;
  }
  return undefined;
}

/** Study reviews use explicit @review(YYYY-MM-DD) markers; no background alarm is implied. */
export function getDueReviews(notes: Note[], now = new Date(), limit = 8): DueReview[] {
  const today = dateKey(now);
  return notes.filter((note) => !note.deletedAt).flatMap((note) => {
    const dueAt = findReview(note.body)?.value;
    return dueAt && dueAt <= today ? [{ note, dueAt }] : [];
  }).sort((a, b) => a.dueAt.localeCompare(b.dueAt) || Date.parse(b.note.updatedAt) - Date.parse(a.note.updatedAt)).slice(0, Math.max(0, limit));
}

/** Explicitly move the first visible review marker; callers save through the normal draft path. */
export function rescheduleReview(body: string, nextDate: string): string {
  if (!isDate(nextDate)) return body;
  const marker = findReview(body);
  return marker ? `${body.slice(0, marker.start)}@review(${nextDate})${body.slice(marker.end)}` : body;
}

/** Prior meeting notes are locally rediscovered after a week, newest first. */
export function getPriorMeetings(notes: Note[], now = new Date(), limit = 4): ResurfacedNote[] {
  return notes.filter((note) => !note.deletedAt && (note.tags.some((tag) => tag.toLocaleLowerCase() === "meeting") || /\bmeeting\b/i.test(note.title)))
    .filter((note) => Number.isFinite(Date.parse(note.createdAt)) && now.valueOf() - Date.parse(note.createdAt) >= 7 * DAY)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, Math.max(0, limit))
    .map((note) => ({ note, reason: `Meeting from ${note.createdAt.slice(0, 10)}` }));
}
