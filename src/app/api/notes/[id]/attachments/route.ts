import { attachmentList } from '../../../../../server/attachments';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
export async function GET(req: Request, context: Context): Promise<Response> { return attachmentList(req, (await context.params).id); }
