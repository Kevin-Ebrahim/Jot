import { comments } from '../../../../../server/handlers';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
async function handle(req: Request, context: Context): Promise<Response> { return comments(req, (await context.params).id); }
export const GET = handle;
export const POST = handle;
