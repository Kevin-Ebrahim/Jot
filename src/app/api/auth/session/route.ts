import { getDatabase } from '../../../../server/db';
import { session } from '../../../../server/auth';
import { json, route } from '../../../../server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request): Promise<Response> {
  return route(() => {
    const current = session(getDatabase(), req);
    return json({ user: current?.user || null, csrfToken: current?.csrfToken || null });
  });
}
