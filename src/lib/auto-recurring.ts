import { getWorkspaceId, jotStore } from './store';
import { getDueRecurringNotes, getRecurringSchedule, prepareNextRecurringNote, setRecurringSchedule } from './features/recurring';
import { nextRecurrenceDate, type RepeatInterval } from './features/tasks';
import type { Note } from './types';

const AUTO_MARKER = '@repeat-auto';
/** The standalone marker is portable Markdown metadata; fenced examples are ignored. */
function markerLines(body: string): number[] {
  const lines = body.split(/\r?\n/);
  const indices: number[] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return; }
    if (!fenced && /^\s*@repeat-auto\s*$/i.test(line)) indices.push(index);
  });
  return indices;
}
export function isRecurringAutomationEnabled(note: Pick<Note, 'body'>): boolean { return markerLines(note.body).length > 0; }
export function setRecurringAutomation(body: string, enabled: boolean): string {
  const remove = new Set(markerLines(body));
  const separator = body.includes('\r\n') ? '\r\n' : '\n';
  if (enabled && remove.size === 1) return body;
  const result = body.split(/\r?\n/).filter((_line, index) => !remove.has(index)).join(separator);
  if (!enabled) return result;
  return `${result}${result ? (result.endsWith(separator) ? separator : `${separator}${separator}`) : ''}${AUTO_MARKER}`;
}
function dateString(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
/** Advance past today while creating only one catch-up occurrence, never an unbounded backlog. */
export function nextFutureRecurrence(dueAt: string, interval: RepeatInterval, today: string): string {
  if (interval === 'daily' || interval === 'weekly') {
    const due = Date.parse(`${dueAt}T00:00:00.000Z`), end = Date.parse(`${today}T00:00:00.000Z`);
    if (!Number.isFinite(due) || !Number.isFinite(end)) throw new Error('Invalid recurrence date.');
    const step = interval === 'daily' ? 1 : 7;
    const periods = Math.max(1, Math.floor((end - due) / (step * 86_400_000)) + 1);
    return new Date(due + periods * step * 86_400_000).toISOString().slice(0, 10);
  }
  let next = nextRecurrenceDate(dueAt, interval);
  for (let iterations = 0; next && next <= today && iterations < 10_000; iterations++) next = nextRecurrenceDate(next, interval);
  if (!next || next <= today) throw new Error('This routine is too far behind; update its schedule manually.');
  return next;
}
export interface AutoRecurringResult { created: string[]; errors: string[]; }
/** Runs only on the open device. One due occurrence per routine is created atomically. */
export async function runDueRecurring(options: {
  workspaceId: string | null; now?: Date; isNoteBusy?: (id: string) => boolean; limit?: number;
}): Promise<AutoRecurringResult> {
  const { workspaceId, isNoteBusy = () => false } = options;
  const result: AutoRecurringResult = { created: [], errors: [] };
  if (getWorkspaceId() !== workspaceId) return result;
  const now = options.now ?? new Date();
  const notes = await jotStore.listNotes();
  if (getWorkspaceId() !== workspaceId) return result;
  const candidates = getDueRecurringNotes(notes.filter(note => note.role !== 'viewer' && note.syncState !== 'conflict' &&
    isRecurringAutomationEnabled(note) && !isNoteBusy(note.id)), now, options.limit ?? 20);
  for (const candidate of candidates) {
    if (getWorkspaceId() !== workspaceId) break;
    if (isNoteBusy(candidate.note.id)) continue;
    try {
      const source = await jotStore.getNote(candidate.note.id);
      if (!source || source.revision !== candidate.note.revision || source.role === 'viewer' || source.syncState === 'conflict' ||
          !isRecurringAutomationEnabled(source) || isNoteBusy(source.id)) continue;
      const schedule = getRecurringSchedule(source);
      const occurrence = prepareNextRecurringNote(source);
      if (!schedule || !occurrence || schedule.dueAt > dateString(now)) continue;
      const nextDue = nextFutureRecurrence(schedule.dueAt, schedule.interval, dateString(now));
      const nextBody = setRecurringSchedule(occurrence.nextSourceBody, schedule.interval, nextDue);
      const newInput = { ...occurrence.newInput, body: setRecurringAutomation(occurrence.newInput.body ?? '', false) };
      const created = await jotStore.createRecurringOccurrence(source.id, source.revision, nextBody, newInput, occurrence.occurrenceKey);
      result.created.push(created.id);
    } catch (cause) {
      // Another tab can advance the same routine; CAS makes this a safe no-op.
      if (cause instanceof Error && cause.name === 'ConflictError') continue;
      result.errors.push(`Could not create a recurring note: ${cause instanceof Error ? cause.message : 'unknown error'}`);
    }
  }
  return result;
}
