import { deleteComment } from '../../../../../../server/handlers';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string; commentId: string }> };
export async function DELETE(req: Request, context: Context): Promise<Response> {
  const { id, commentId } = await context.params;
  return deleteComment(req, id, commentId);
}
