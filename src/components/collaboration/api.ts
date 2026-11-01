/** Same-origin collaboration API. Credentials stay in the browser's HttpOnly cookie;
 * the CSRF token is held in memory and supplied only on authenticated writes. */
export interface CollaborationUser {
  id: string;
  email: string;
}

export interface CollaborationSession {
  user: CollaborationUser | null;
  csrfToken: string | null;
}

export type ShareRole = 'viewer' | 'editor';
export interface Share {
  user: CollaborationUser;
  role: ShareRole;
}

export interface NoteComment {
  id: string;
  noteId: string;
  author: CollaborationUser;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export class CollaborationApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CollaborationApiError';
    this.status = status;
  }
}

export async function request<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; csrfToken?: string | null; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method || 'GET';
  const headers = new Headers({ Accept: 'application/json' });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.csrfToken && method !== 'GET') headers.set('X-CSRF-Token', options.csrfToken);
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: options.signal,
  });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    if (!response.ok) throw new CollaborationApiError(response.status, `Request failed (${response.status}).`);
    throw new CollaborationApiError(response.status, 'The server returned an invalid response.');
  }
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error
      : `Request failed (${response.status}).`;
    throw new CollaborationApiError(response.status, message);
  }
  return data as T;
}

export function messageForError(error: unknown): string {
  if (error instanceof CollaborationApiError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return 'The request was canceled.';
  if (error instanceof Error && error.name !== 'TypeError' && error.message) return error.message;
  return 'Could not reach the server. Check your connection and try again.';
}

export function entityPath(kind: 'note' | 'notebook', id: string): string {
  return `/api/${kind === 'note' ? 'notes' : 'notebooks'}/${encodeURIComponent(id)}`;
}
