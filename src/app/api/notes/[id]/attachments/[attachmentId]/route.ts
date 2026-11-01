import { attachmentItem } from '../../../../../../server/attachments';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string; attachmentId: string }> };
async function handle(req: Request, context: Context): Promise<Response> {
  const { id, attachmentId } = await context.params;
  return attachmentItem(req, id, attachmentId);
}
export const GET = handle;
export const PUT = handle;
export const DELETE = handle;
