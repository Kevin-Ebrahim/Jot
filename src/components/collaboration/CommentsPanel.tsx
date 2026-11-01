'use client';

import { LoaderCircle, MessageSquare, RefreshCw, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Note } from '@/lib/types';
import { entityPath, messageForError, type NoteComment } from './api';
import { useCollaboration } from './CollaborationProvider';
import { DialogFrame } from './DialogFrame';

function displayTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function CommentsPanel({ open, onClose, note }: { open: boolean; onClose: () => void; note: Note | null }) {
  const account = useCollaboration();
  const [comments, setComments] = useState<NoteComment[]>([]);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const generation = useRef(0);
  const mutation = useRef<symbol | null>(null);
  const canRead = !!note && note.serverVersion !== null && account.sessionStatus === 'ready'
    && !!account.session?.user && account.workspaceReady;
  const canPost = canRead && note?.role !== 'viewer';

  const load = useCallback(async (signal?: AbortSignal, initial = false) => {
    if (!note || !canRead || mutation.current) return;
    const current = ++generation.current;
    if (initial) setLoading(true);
    try {
      const result = await account.authenticatedRequest<{ comments: NoteComment[] }>(`${entityPath('note', note.id)}/comments`, { signal });
      if (current === generation.current) { setComments(result.comments); setError(null); }
    } catch (caught) {
      if (current === generation.current && !(caught instanceof Error && caught.name === 'AbortError')) setError(messageForError(caught));
    } finally { if (current === generation.current) setLoading(false); }
  }, [note?.id, canRead, account.authenticatedRequest]);

  useEffect(() => {
    generation.current += 1;
    mutation.current = null;
    setComments([]); setBody(''); setError(null); setDeleteId(null); setBusy(false);
    if (!open || !canRead) { setLoading(false); return; }
    const controller = new AbortController();
    void load(controller.signal, true);
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'hidden' && navigator.onLine) void load();
    }, 30_000);
    return () => { controller.abort(); window.clearInterval(interval); generation.current += 1; };
  }, [open, note?.id, canRead, load]);

  async function post(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = body;
    if (!note || !text.trim() || !canPost || mutation.current) return;
    const token = Symbol('comment');
    mutation.current = token;
    const id = note.id;
    const current = ++generation.current; // An earlier poll must not erase the new comment.
    setBusy(true); setLoading(false); setError(null);
    try {
      const result = await account.authenticatedRequest<{ comment: NoteComment }>(`${entityPath('note', id)}/comments`, { method: 'POST', body: { body: text } });
      if (current === generation.current) { setComments((items) => [...items, result.comment]); setBody(''); }
    } catch (caught) { if (current === generation.current) setError(messageForError(caught)); }
    finally { if (mutation.current === token) { mutation.current = null; setBusy(false); } }
  }

  async function remove(commentId: string) {
    if (!note || mutation.current || !canRead) return;
    const token = Symbol('delete');
    mutation.current = token;
    const current = ++generation.current;
    setBusy(true); setError(null);
    try {
      await account.authenticatedRequest<{ ok: true }>(`${entityPath('note', note.id)}/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
      if (current === generation.current) { setComments((items) => items.filter((comment) => comment.id !== commentId)); setDeleteId(null); }
    } catch (caught) { if (current === generation.current) setError(messageForError(caught)); }
    finally { if (mutation.current === token) { mutation.current = null; setBusy(false); } }
  }

  return (
    <DialogFrame open={open} onClose={onClose} title="Comments" className="collab-comments-dialog">
      {!note && <p className="collab-copy">Choose a note to see its comments.</p>}
      {note && <div className="collab-stack">
        <p className="collab-subtitle collab-truncate">On {note.title || 'Untitled note'}</p>
        {account.sessionStatus !== 'ready' && <div className="collab-alert" role="status">Your account session must be checked before comments can load. Open Account &amp; sync to retry.</div>}
        {account.sessionStatus === 'ready' && !account.session?.user && <p className="collab-copy">Sign in from Account &amp; sync to view and leave comments.</p>}
        {account.sessionStatus === 'ready' && account.session?.user && !account.workspaceReady && <div className="collab-state" role="status"><LoaderCircle className="collab-spin" size={16} aria-hidden="true" /> Opening your account workspace…</div>}
        {account.sessionStatus === 'ready' && account.session?.user && account.workspaceReady && note.serverVersion === null && <p className="collab-copy">Sync this note to your account before using comments.</p>}
        {canRead && <>
          <div className="collab-comment-toolbar"><span className="collab-list-heading"><MessageSquare size={15} aria-hidden="true" /> Conversation</span><button type="button" className="collab-icon-button" aria-label="Refresh comments" title="Refresh comments" onClick={() => void load()} disabled={loading || busy}><RefreshCw size={15} aria-hidden="true" /></button></div>
          {loading ? <div className="collab-state" role="status"><LoaderCircle className="collab-spin" size={15} aria-hidden="true" /> Loading comments…</div>
            : comments.length === 0 ? <div className="collab-comment-empty"><MessageSquare size={20} aria-hidden="true" /><strong>No comments yet</strong><span>Start a conversation about this note.</span></div>
              : <ol className="collab-comments" aria-label="Comments">{comments.map((comment) => <li key={comment.id}>
                <span className="collab-avatar collab-avatar-small" aria-hidden="true">{comment.author.email.slice(0, 1).toUpperCase()}</span>
                <div className="collab-comment-content"><div className="collab-comment-meta"><strong>{comment.author.email}</strong><time dateTime={comment.createdAt}>{displayTime(comment.createdAt)}</time></div><p>{comment.body}</p>
                  {(comment.author.id === account.session?.user?.id || note.role === 'owner') && (deleteId === comment.id ? <div className="collab-inline-confirm"><button type="button" className="collab-link collab-danger" disabled={busy} onClick={() => void remove(comment.id)}>Confirm delete</button><button type="button" className="collab-link" disabled={busy} onClick={() => setDeleteId(null)}>Cancel</button></div> : <button type="button" className="collab-link" disabled={busy} onClick={() => setDeleteId(comment.id)} aria-label={`Delete comment by ${comment.author.email}`}>Delete</button>)}
                </div>
              </li>)}</ol>}
          {canPost ? <form className="collab-comment-form" onSubmit={post}>
            <label className="collab-label" htmlFor="collab-comment-body">Add a comment</label>
            <textarea id="collab-comment-body" className="collab-field" rows={3} maxLength={10000} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Write a comment…" />
            <div className="collab-actions"><button className="collab-button collab-primary" type="submit" disabled={loading || busy || !body.trim()}><Send size={14} aria-hidden="true" /> {busy ? 'Sending…' : 'Post comment'}</button></div>
          </form> : <p className="collab-hint">You have view-only access and can read, but not post, comments.</p>}
        </>}
        {error && <div className="collab-alert" role="alert">{error}</div>}
      </div>}
    </DialogFrame>
  );
}
