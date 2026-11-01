import { getDatabase } from '../../../../server/db';
import { register, sessionCookie } from '../../../../server/auth';
import { json, readJson, requireSameOrigin, route } from '../../../../server/http';
import { object } from '../../../../server/validation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request): Promise<Response> {
  return route(async () => {
    requireSameOrigin(req);
    const input = object(await readJson(req, 4096));
    const current = await register(getDatabase(), input.email, input.password);
    return json({ user: current.user, csrfToken: current.csrfToken }, 201, { 'Set-Cookie': sessionCookie(req, current.token) });
  });
}
