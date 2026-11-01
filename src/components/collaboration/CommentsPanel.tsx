'use client';

import { LoaderCircle, MessageSquare, RefreshCw, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { Note } from '@/lib/types';
import { CollaborationApiError, entityPath, messageForError, type NoteComment } from './api';
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
  const [uncertainPost, setUncertainPost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const generation = useRef(0);
  // Keep interrupted drafts and in-flight mutations scoped to both account and note.
  const drafts = useRef<Record<string, string>>({});
  const uncertain = useRef<Record<string, boolean>>({});
  const mutations = useRef(new Map<string, symbol>());
  const draftKey = `${account.session?.user?.id || 'guest'}:${note?.id || ''}`;
  const currentKey = useRef(draftKey);
  const currentlyOpen = useRef(open);
  currentKey.current = draftKey;
  currentlyOpen.current = open;
  const canRead = !!note && note.serverVersion !== null && account.sessionStatus === 'ready'
    && !!account.session?.user && account.workspaceReady;
  const canPost = canRead && note?.role !== 'viewer';

  const load = useCallback(async (signal?: AbortSignal, initial = false, userRefresh = false) => {
    if (!note || !canRead || mutations.current.has(draftKey)) return;
    const current = ++generation.current;
    if (initial) setLoading(true);
    try {
      const result = await account.authenticatedRequest<{ comments: NoteComment[] }>(`${entityPath('note', note.id)}/comments`, { signal });
      if (current === generation.current) {
        setComments(result.comments);
        if (userRefresh) { uncertain.current[draftKey] = false; setUncertainPost(false); }
        setError(null);
      }
    } catch (caught) {
      if (current === generation.current && !(caught instanceof Error && caught.name === 'AbortError')) setError(messageForError(caught));
    } finally { if (current === generation.current) setLoading(false); }
  }, [note?.id, canRead, account.authenticatedRequest, draftKey]);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    generation.current += 1;
    setComments([]); setBody(drafts.current[draftKey] || ''); setError(null); setDeleteId(null);
    setBusy(mutations.current.has(draftKey)); setUncertainPost(!!uncertain.current[draftKey]); setLoading(false);
    if (!open || !canRead) return;
    const controller = new AbortController();
    void load(controller.signal, true);
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'hidden' && navigator.onLine) void load();
    }, 30_000);
    return () => { controller.abort(); window.clearInterval(interval); generation.current += 1; };
  }, [open, note?.id, canRead, load, draftKey]);

  async function post(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = body;
    if (!note || !text.trim() || !canPost || mutations.current.has(draftKey) || uncertain.current[draftKey]) return;
    const key = draftKey;
    const token = Symbol('comment');
    mutations.current.set(key, token);
    const id = note.id;
    const current = ++generation.current; // An earlier poll must not erase the new comment.
    setBusy(true); setLoading(false); setError(null);
    let posted = false;
    try {
      const result = await account.authenticatedRequest<{ comment: NoteComment }>(`${entityPath('note', id)}/comments`, { method: 'POST', body: { body: text } });
      posted = true;
      drafts.current[key] = '';
      uncertain.current[key] = false;
      if (currentKey.current === key) {
        setBody(''); setUncertainPost(false);
        if (current === generation.current) setComments((items) => [...items, result.comment]);
      }
    } catch (caught) {
      // A lost response or 5xx can leave the server outcome unknown. Require a
      // conversation refresh and human check before allowing another post.
      const definitive = caught instanceof CollaborationApiError && caught.status >= 400 && caught.status < 500;
      uncertain.current[key] = !definitive;
      if (currentKey.current === key) {
        setUncertainPost(!definitive);
        setError(definitive ? messageForError(caught) : 'Could not confirm whether the comment was posted. Refresh the conversation and check it before trying again.');
      }
    } finally {
      if (mutations.current.get(key) === token) mutations.current.delete(key);
      if (currentKey.current === key) setBusy(false);
      if (posted && currentKey.current === key && currentlyOpen.current) void loadRef.current();
    }
  }

  async function remove(commentId: string) {
    if (!note || mutations.current.has(draftKey) || !canRead) return;
    const key = draftKey;
    const token = Symbol('delete');
    mutations.current.set(key, token);
    const current = ++generation.current;
    setBusy(true); setLoading(false); setError(null);
    let removed = false;
    try {
      await account.authenticatedRequest<{ ok: true }>(`${entityPath('note', note.id)}/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
      removed = true;
      if (current === generation.current) { setComments((items) => items.filter((comment) => comment.id !== commentId)); setDeleteId(null); }
    } catch (caught) {
      if (currentKey.current === key) setError(caught instanceof CollaborationApiError && caught.status < 500
        ? messageForError(caught) : 'Could not confirm whether the comment was deleted. Refresh the conversation to check.');
    } finally {
      if (mutations.current.get(key) === token) mutations.current.delete(key);
      if (currentKey.current === key) setBusy(false);
      if (removed && currentKey.current === key && currentlyOpen.current) void loadRef.current();
    }
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
          <div className="collab-comment-toolbar"><span className="collab-list-heading"><MessageSquare size={15} aria-hidden="true" /> Conversation</span><button type="button" className="collab-icon-button" aria-label="Refresh comments" title="Refresh comments" onClick={() => void load(undefined, false, true)} disabled={loading || busy}><RefreshCw size={15} aria-hidden="true" /></button></div>
          {loading ? <div className="collab-state" role="status"><LoaderCircle className="collab-spin" size={15} aria-hidden="true" /> Loading comments…</div>
            : comments.length === 0 ? <div className="collab-comment-empty"><MessageSquare size={20} aria-hidden="true" /><strong>No comments yet</strong><span>Start a conversation about this note.</span></div>
              : <ol className="collab-comments" aria-label="Comments">{comments.map((comment) => <li key={comment.id}>
                <span className="collab-avatar collab-avatar-small" aria-hidden="true">{comment.author.email.slice(0, 1).toUpperCase()}</span>
                <div className="collab-comment-content"><div className="collab-comment-meta"><strong>{comment.author.email}</strong><time dateTime={comment.createdAt}>{displayTime(comment.createdAt)}</time></div><p>{comment.body}</p>
                  {(note.role === 'owner' || (note.role === 'editor' && comment.author.id === account.session?.user?.id)) && (deleteId === comment.id ? <div className="collab-inline-confirm"><button type="button" className="collab-link collab-danger" disabled={busy} onClick={() => void remove(comment.id)}>Confirm delete</button><button type="button" className="collab-link" disabled={busy} onClick={() => setDeleteId(null)}>Cancel</button></div> : <button type="button" className="collab-link" disabled={busy} onClick={() => setDeleteId(comment.id)} aria-label={`Delete comment by ${comment.author.email}`}>Delete</button>)}
                </div>
              </li>)}</ol>}
          {canPost ? <form className="collab-comment-form" onSubmit={post}>
            <label className="collab-label" htmlFor="collab-comment-body">Add a comment</label>
            <textarea id="collab-comment-body" className="collab-field" rows={3} maxLength={10000} disabled={busy} value={body} onChange={(event) => { drafts.current[draftKey] = event.target.value; setBody(event.target.value); }} placeholder="Write a comment…" />
            {uncertainPost && <p className="collab-hint">A previous post has an unknown result. Refresh and check the conversation before posting again.</p>}
            <div className="collab-actions"><button className="collab-button collab-primary" type="submit" disabled={loading || busy || uncertainPost || !body.trim()}><Send size={14} aria-hidden="true" /> {busy ? 'Working…' : 'Post comment'}</button></div>
          </form> : <p className="collab-hint">You have view-only access and can read, but not post, comments.</p>}
        </>}
        {error && <div className="collab-alert" role="alert">{error}</div>}
      </div>}
    </DialogFrame>
  );
}
