import { getDatabase } from '../../../../server/db';
import { expiredCookie, logout, requireCsrf, requireSession } from '../../../../server/auth';
import { json, requireSameOrigin, route } from '../../../../server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request): Promise<Response> {
  return route(() => {
    requireSameOrigin(req);
    const db = getDatabase();
    const current = requireSession(db, req);
    requireCsrf(req, current);
    logout(db, current);
    return json({ ok: true }, 200, { 'Set-Cookie': expiredCookie(req) });
  });
}
