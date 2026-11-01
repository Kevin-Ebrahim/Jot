import { put } from '../../../../server/handlers';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function PUT(req: Request, context: Context): Promise<Response> { return put('notebook', req, (await context.params).id); }
