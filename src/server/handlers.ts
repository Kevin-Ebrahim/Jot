import { getDatabase } from './db';
import { requireCsrf, requireSession } from './auth';
import { json, readJson, requireSameOrigin, route } from './http';
import { Repository } from './repository';
import * as v from './validation';

type Kind = 'note' | 'notebook';
export function list(kind: Kind, req: Request): Promise<Response> {
  return route(() => {
    const db = getDatabase(); const current = requireSession(db, req); const repo = new Repository(db);
    // The client may infer revoked access only from an explicitly complete
    // snapshot, never from an error or a malformed/partial response.
    return kind === 'note' ? json({ notes: repo.listNotes(current.user.id), complete: true }) : json({ notebooks: repo.listNotebooks(current.user.id), complete: true });
  });
}
export function put(kind: Kind, req: Request, rawId: string): Promise<Response> {
  return route(async () => {
    requireSameOrigin(req);
    const db = getDatabase(); const current = requireSession(db, req); requireCsrf(req, current);
    // JSON escaping can expand a valid 1M-character note to ~6 MiB.
    const id = v.id(rawId); const input = v.object(await readJson(req, kind === 'note' ? 8 * 1024 * 1024 : 4096));
    const operationId = v.id(input.operationId, 'operationId'); const base = v.baseVersion(input.baseVersion);
    const repo = new Repository(db);
    return kind === 'note'
      ? json(repo.putNote(current.user.id, operationId, base, v.note(input.note, id)))
      : json(repo.putNotebook(current.user.id, operationId, base, v.notebook(input.notebook, id)));
  });
}
export function shares(kind: Kind, req: Request, rawId: string): Promise<Response> {
  return route(async () => {
    const db = getDatabase(); const current = requireSession(db, req); const id = v.id(rawId); const repo = new Repository(db);
    if (req.method === 'GET') return json({ shares: repo.listShares(kind, current.user.id, id) });
    requireSameOrigin(req); requireCsrf(req, current);
    const input = v.object(await readJson(req, 4096));
    const email = v.email(input.email);
    const role = req.method === 'DELETE' ? null : v.shareRole(input.role);
    return json({ shares: repo.changeShare(kind, current.user.id, id, email, role) });
  });
}
export function comments(req: Request, rawId: string): Promise<Response> {
  return route(async () => {
    const db = getDatabase(); const current = requireSession(db, req); const id = v.id(rawId); const repo = new Repository(db);
    if (req.method === 'GET') return json({ comments: repo.listComments(current.user.id, id) });
    requireSameOrigin(req); requireCsrf(req, current);
    const input = v.object(await readJson(req, 40_000));
    const body = v.text(input.body, 'comment', 10_000, false);
    return json({ comment: repo.addComment(current.user, id, body) }, 201);
  });
}
export function deleteComment(req: Request, rawId: string, rawCommentId: string): Promise<Response> {
  return route(() => {
    requireSameOrigin(req);
    const db = getDatabase(); const current = requireSession(db, req); requireCsrf(req, current);
    const repo = new Repository(db);
    repo.deleteComment(current.user.id, v.id(rawId), v.id(rawCommentId, 'commentId'));
    return json({ ok: true });
  });
}
