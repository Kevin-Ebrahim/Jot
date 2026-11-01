import { getDatabase } from './db';
import { requireCsrf, requireSession } from './auth';
import { HttpError } from './errors';
import { json, readBinary, requireSameOrigin, route } from './http';
import { Repository } from './repository';
import * as v from './validation';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
function filename(req: Request): string {
  const encoded = req.headers.get('x-jot-filename');
  if (!encoded || encoded.length > 3072) throw new HttpError(400, 'Invalid attachment name');
  let decoded: string;
  try { decoded = decodeURIComponent(encoded); }
  catch { throw new HttpError(400, 'Invalid attachment name'); }
  // Do not allow paths, control characters or header delimiters through to a
  // downloadable filename; this normalization is deterministic for retries.
  const cleaned = decoded.replace(/[\\/\x00-\x1f\x7f]/g, '_').trim();
  if (!cleaned || cleaned.length > 255) throw new HttpError(400, 'Invalid attachment name');
  return cleaned;
}
function mime(req: Request): string {
  const candidate = (req.headers.get('content-type') || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(candidate) && candidate.length <= 127 ? candidate : 'application/octet-stream';
}
function disposition(name: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="attachment"; filename*=UTF-8''${encoded}`;
}
export function attachmentList(req: Request, rawNoteId: string): Promise<Response> {
  return route(() => {
    const db = getDatabase(); const current = requireSession(db, req);
    return json({ attachments: new Repository(db).listAttachments(current.user.id, v.id(rawNoteId)) });
  });
}
export function attachmentItem(req: Request, rawNoteId: string, rawAttachmentId: string): Promise<Response> {
  return route(async () => {
    const db = getDatabase(); const current = requireSession(db, req);
    const noteId = v.id(rawNoteId); const attachmentId = v.id(rawAttachmentId, 'attachmentId');
    const repo = new Repository(db);
    if (req.method === 'GET') {
      const { metadata, data } = repo.getAttachment(current.user.id, noteId, attachmentId);
      // Always download, never execute or render potentially active HTML/SVG.
      return new Response(Uint8Array.from(data).buffer, { headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': disposition(metadata.name),
        'Content-Length': String(data.byteLength),
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'no-store',
      } });
    }
    requireSameOrigin(req); requireCsrf(req, current);
    repo.requireAttachmentAccess(current.user.id, noteId, true);
    if (req.method === 'DELETE') return json({ attachment: repo.deleteAttachment(current.user.id, noteId, attachmentId) });
    const name = filename(req);
    const mimeType = mime(req);
    const createdAt = v.date(req.headers.get('x-jot-created-at'), 'createdAt');
    const data = await readBinary(req, MAX_ATTACHMENT_BYTES);
    return json({ attachment: repo.putAttachment(current.user.id, noteId, attachmentId, name, mimeType, createdAt, data) });
  });
}
