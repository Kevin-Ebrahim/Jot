import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors';
import type { ServerNote, ServerNotebook } from './validation';

export type ContentKind = 'note' | 'notebook' | 'comment';
/** Only user content counts as bytes; bounded record counts cover fixed metadata. */
export function contentBytes(kind: 'note', value: ServerNote): number;
export function contentBytes(kind: 'notebook', value: ServerNotebook): number;
export function contentBytes(kind: 'comment', value: string): number;
export function contentBytes(kind: ContentKind, value: ServerNote | ServerNotebook | string): number {
  const encoded = kind === 'note'
    ? JSON.stringify({ title: (value as ServerNote).title, body: (value as ServerNote).body, tags: (value as ServerNote).tags })
    : kind === 'notebook' ? JSON.stringify({ name: (value as ServerNotebook).name }) : value as string;
  return Buffer.byteLength(encoded, 'utf8');
}
function limit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new HttpError(500, `Invalid ${name} configuration`);
  const result = Number(raw);
  if (!Number.isSafeInteger(result)) throw new HttpError(500, `Invalid ${name} configuration`);
  return result;
}
interface Totals { note_count: number; note_bytes: number; notebook_count: number; notebook_bytes: number; comment_count: number; comment_bytes: number }
/** Call inside the same write transaction as the content mutation. */
export function enforceContentQuota(db: DatabaseSync, ownerId: string, kind: ContentKind, previousBytes: number | null, nextBytes: number): void {
  const totals = db.prepare(`SELECT
    (SELECT COUNT(*) FROM notes WHERE owner_id = ?) AS note_count,
    (SELECT COALESCE(SUM(content_bytes), 0) FROM notes WHERE owner_id = ?) AS note_bytes,
    (SELECT COUNT(*) FROM notebooks WHERE owner_id = ?) AS notebook_count,
    (SELECT COALESCE(SUM(content_bytes), 0) FROM notebooks WHERE owner_id = ?) AS notebook_bytes,
    (SELECT COUNT(*) FROM comments c JOIN notes n ON n.id = c.note_id WHERE n.owner_id = ?) AS comment_count,
    (SELECT COALESCE(SUM(c.content_bytes), 0) FROM comments c JOIN notes n ON n.id = c.note_id WHERE n.owner_id = ?) AS comment_bytes`)
    .get(ownerId, ownerId, ownerId, ownerId, ownerId, ownerId) as unknown as Totals;
  const counts: Record<ContentKind, number> = { note: totals.note_count, notebook: totals.notebook_count, comment: totals.comment_count };
  const maxCounts: Record<ContentKind, number> = {
    note: limit('JOT_MAX_USER_NOTES', 10_000),
    notebook: limit('JOT_MAX_USER_NOTEBOOKS', 1_000),
    comment: limit('JOT_MAX_USER_COMMENTS', 50_000),
  };
  if (previousBytes === null && counts[kind] >= maxCounts[kind]) throw new HttpError(413, `${kind === 'note' ? 'Note' : kind === 'notebook' ? 'Notebook' : 'Comment'} record quota exceeded`);
  const total = totals.note_bytes + totals.notebook_bytes + totals.comment_bytes;
  const proposed = total - (previousBytes ?? 0) + nextBytes;
  const maxBytes = limit('JOT_MAX_USER_CONTENT_BYTES', 256 * 1024 * 1024);
  // Existing data above a newly lowered quota is still editable without growth,
  // and may always be reduced; never delete or silently truncate content.
  if (proposed > maxBytes && proposed > total) throw new HttpError(413, 'Content storage quota exceeded');
}
