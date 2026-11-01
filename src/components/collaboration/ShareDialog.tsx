'use client';

import { BookOpen, FileText, LoaderCircle, RefreshCw, UserPlus, Users } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Note, Notebook } from '@/lib/types';
import { entityPath, messageForError, type Share, type ShareRole } from './api';
import { useCollaboration } from './CollaborationProvider';
import { DialogFrame } from './DialogFrame';

/** Manages direct grants only. A recipient must already have an account on this server. */
export function ShareDialog({ open, onClose, note, notebook }: {
  open: boolean;
  onClose: () => void;
  note: Note | null;
  notebook: Notebook | null;
}) {
  const account = useCollaboration();
  const [kind, setKind] = useState<'note' | 'notebook'>(note ? 'note' : 'notebook');
  const [shares, setShares] = useState<Share[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ShareRole>('viewer');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revokeEmail, setRevokeEmail] = useState<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    if (open) setKind(note ? 'note' : 'notebook');
  }, [open, note?.id, notebook?.id]);

  const target = kind === 'note' ? note : notebook;
  const targetName = kind === 'note' ? note?.title || 'Untitled note' : notebook?.name || 'Untitled notebook';
  const targetKey = target ? `${kind}:${target.id}` : '';
  const canManage = !!target && target.role === 'owner' && target.serverVersion !== null
    && account.sessionStatus === 'ready' && !!account.session?.user && account.workspaceReady;

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setShares([]); setError(null); setNotice(null); setRevokeEmail(null); setEmail(''); setRole('viewer'); setBusy(false);
    if (!open || !target || !canManage) { setLoading(false); return () => controller.abort(); }
    setLoading(true);
    void account.authenticatedRequest<{ shares: Share[] }>(`${entityPath(kind, target.id)}/shares`, { signal: controller.signal })
      .then((result) => { if (sequence.current === current) setShares(result.shares); })
      .catch((caught) => {
        if (sequence.current === current && !(caught instanceof Error && caught.name === 'AbortError')) setError(messageForError(caught));
      })
      .finally(() => { if (sequence.current === current) setLoading(false); });
    return () => { controller.abort(); sequence.current += 1; };
  }, [open, targetKey, canManage, account.authenticatedRequest]);

  async function changeShare(method: 'POST' | 'PATCH' | 'DELETE', shareEmail: string, nextRole?: ShareRole) {
    if (!target || busy || !canManage) return;
    const current = sequence.current;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await account.authenticatedRequest<{ shares: Share[] }>(`${entityPath(kind, target.id)}/shares`, {
        method, body: method === 'DELETE' ? { email: shareEmail } : { email: shareEmail, role: nextRole },
      });
      if (current !== sequence.current) return;
      setShares(result.shares);
      setRevokeEmail(null);
      if (method === 'POST') { setEmail(''); setNotice('Access added. No invitation email was sent.'); }
      if (method === 'PATCH') setNotice('Access updated.');
      if (method === 'DELETE') setNotice('Direct access removed.');
    } catch (caught) {
      if (current === sequence.current) setError(messageForError(caught));
    } finally { if (current === sequence.current) setBusy(false); }
  }

  async function addShare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await changeShare('POST', email.trim(), role);
  }

  async function syncFirst() {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await account.syncNow();
      if (result.errors.length) setError(result.errors.join(' '));
      else if (result.conflicts) setError('Resolve sync conflicts before sharing this item.');
      else setNotice('Sync finished. This item can be shared once it appears in your account.');
    } catch (caught) { setError(messageForError(caught)); }
    finally { setBusy(false); }
  }

  return (
    <DialogFrame open={open} onClose={onClose} title="Share">
      {!target && <p className="collab-copy">Choose a note or notebook to share.</p>}
      {target && <div className="collab-stack">
        {note && notebook && (
          <div className="collab-segment" role="group" aria-label="What to share">
            <button type="button" aria-pressed={kind === 'note'} onClick={() => setKind('note')}><FileText size={14} aria-hidden="true" /> Note</button>
            <button type="button" aria-pressed={kind === 'notebook'} onClick={() => setKind('notebook')}><BookOpen size={14} aria-hidden="true" /> Notebook</button>
          </div>
        )}
        <div className="collab-target"><span className="collab-target-icon">{kind === 'note' ? <FileText size={17} aria-hidden="true" /> : <BookOpen size={17} aria-hidden="true" />}</span><div className="collab-grow"><div className="collab-strong collab-truncate">{targetName}</div><div className="collab-hint">{kind === 'note' ? 'Individual note' : 'Notebook'}</div></div></div>
        {account.sessionStatus !== 'ready' && <div className="collab-alert" role="status">Your account session must be checked before sharing. Open Account &amp; sync to retry.</div>}
        {account.sessionStatus === 'ready' && !account.session?.user && <p className="collab-copy">Sign in from Account &amp; sync to share. Guest notes remain on this device until you explicitly copy them to your account.</p>}
        {account.sessionStatus === 'ready' && account.session?.user && !account.workspaceReady && <div className="collab-state" role="status"><LoaderCircle className="collab-spin" size={16} aria-hidden="true" /> Opening your account workspace…</div>}
        {account.sessionStatus === 'ready' && account.session?.user && account.workspaceReady && target.serverVersion === null && (
          <div className="collab-stack">
            <p className="collab-copy">This {kind} is only on this device so far. Sync it to your account before sharing.</p>
            <button type="button" className="collab-button" onClick={syncFirst} disabled={busy}><RefreshCw size={15} aria-hidden="true" /> {busy ? 'Syncing…' : 'Sync now'}</button>
          </div>
        )}
        {account.sessionStatus === 'ready' && account.session?.user && account.workspaceReady && target.serverVersion !== null && target.role !== 'owner' && (
          <p className="collab-copy">You have {target.role === 'editor' ? 'editing' : 'viewing'} access. Only the owner can manage sharing for this {kind}.</p>
        )}
        {canManage && <>
          <p className="collab-copy">Add someone with an existing account on this Jot server. No email invitation is sent.</p>
          <form className="collab-share-form" onSubmit={addShare}>
            <label className="collab-sr-only" htmlFor="collab-share-email">Account email</label>
            <input id="collab-share-email" className="collab-field" type="email" autoComplete="off" placeholder="Account email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy || loading} />
            <label className="collab-sr-only" htmlFor="collab-share-role">Access level</label>
            <select id="collab-share-role" className="collab-field collab-select" value={role} onChange={(event) => setRole(event.target.value as ShareRole)} disabled={busy || loading}><option value="viewer">Can view</option><option value="editor">Can edit</option></select>
            <button className="collab-button collab-primary" type="submit" disabled={busy || loading}><UserPlus size={15} aria-hidden="true" /> Add</button>
          </form>
          <div className="collab-list-heading"><Users size={15} aria-hidden="true" /> People with direct access</div>
          {loading ? <div className="collab-state" role="status"><LoaderCircle className="collab-spin" size={15} aria-hidden="true" /> Loading access…</div>
            : shares.length === 0 ? <p className="collab-hint">No one has been added directly.</p>
              : <ul className="collab-share-list">{shares.map((share) => <li key={share.user.id}>
                <span className="collab-avatar collab-avatar-small" aria-hidden="true">{share.user.email.slice(0, 1).toUpperCase()}</span>
                <span className="collab-share-email">{share.user.email}</span>
                {revokeEmail === share.user.email ? <span className="collab-inline-confirm"><button type="button" className="collab-link collab-danger" disabled={busy} onClick={() => void changeShare('DELETE', share.user.email)}>Confirm remove</button><button type="button" className="collab-link" disabled={busy} onClick={() => setRevokeEmail(null)}>Cancel</button></span> : <>
                  <select className="collab-inline-select" aria-label={`Access for ${share.user.email}`} value={share.role} disabled={busy} onChange={(event) => void changeShare('PATCH', share.user.email, event.target.value as ShareRole)}><option value="viewer">Can view</option><option value="editor">Can edit</option></select>
                  <button type="button" className="collab-link" disabled={busy} onClick={() => setRevokeEmail(share.user.email)} aria-label={`Remove ${share.user.email}`}>Remove</button>
                </>}
              </li>)}</ul>}
          <p className="collab-fineprint">{kind === 'note' ? 'This list shows direct note access. Access through a shared notebook is managed separately.' : 'Notebook access applies to its notes. Separate direct note access remains if notebook access is removed.'}</p>
        </>}
        {notice && <div className="collab-success" role="status">{notice}</div>}
        {error && <div className="collab-alert" role="alert">{error}</div>}
      </div>}
    </DialogFrame>
  );
}
