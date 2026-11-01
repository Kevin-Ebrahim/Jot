import { HttpError } from './errors';

export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const result = new Headers(headers);
  result.set('Content-Type', 'application/json; charset=utf-8');
  result.set('Cache-Control', 'no-store');
  result.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(value), { status, headers: result });
}
export async function route(handler: () => Promise<Response> | Response): Promise<Response> {
  try { return await handler(); }
  catch (error) {
    if (error instanceof HttpError) return json({ error: error.message, ...(error.details || {}) }, error.status);
    console.error('Jot API error', error instanceof Error ? error.message : 'unknown error');
    return json({ error: 'Internal server error' }, 500);
  }
}
export function requireSameOrigin(req: Request): void {
  const supplied = req.headers.get('origin');
  let expected: string;
  try { expected = new URL(process.env.JOT_APP_ORIGIN || req.url).origin; }
  catch { throw new HttpError(500, 'Invalid server origin configuration'); }
  if (!supplied || supplied !== expected) throw new HttpError(403, 'Origin not allowed');
}
export async function readJson(req: Request, limit = 1_200_000): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') || '')) throw new HttpError(415, 'Expected application/json');
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'Request too large');
  if (!req.body) throw new HttpError(400, 'Expected a JSON body');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new HttpError(413, 'Request too large'); }
      chunks.push(value);
    }
    const all = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid JSON');
  } finally { reader.releaseLock(); }
}

/** Read a bounded upload without trusting Content-Length. */
export async function readBinary(req: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'Attachment is too large');
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new HttpError(413, 'Attachment is too large'); }
      chunks.push(value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } finally { reader.releaseLock(); }
}
