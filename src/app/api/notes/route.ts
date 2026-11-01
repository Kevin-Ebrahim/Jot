import { list } from '../../../server/handlers';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request): Promise<Response> { return list('note', req); }
