'use client';

import { AlertTriangle, ChevronDown, ChevronUp, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SyncConflict } from '@/lib/types';
import { messageForError } from './api';
import { useCollaboration } from './CollaborationProvider';

type Choice = 'local' | 'server' | 'both';

function titleOf(item: SyncConflict['local'] | SyncConflict['server']): string {
  return ('title' in item ? item.title : item.name) || 'Untitled';
}
function bodyOf(item: SyncConflict['local'] | SyncConflict['server']): string | null {
  return 'body' in item ? item.body : null;
}
function choiceText(conflict: SyncConflict, choice: Choice): string {
  if (choice === 'local') return 'Your current local version will be rebased on the server version and sent on the next sync. The server version will be replaced if that sync succeeds.';
  if (choice === 'server') return 'Your local version will be replaced by the server version. Its unsynced changes will be discarded.';
  return conflict.entity === 'note'
    ? 'The server version stays on the original note. Your local version becomes a new, editable account-owned note in Inbox and will upload on the next sync.'
    : 'The server notebook stays. A separate empty notebook copy is created from your local version; its notes are not duplicated.';
}

/** Conflict resolution is deliberate: show both versions and confirm each choice. */
export function ConflictList({ active }: { active: boolean }) {
  const account = useCollaboration();
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async (initial = false) => {
    const current = ++generation.current;
    if (initial) setLoading(true);
    try {
      const result = await account.listConflicts();
      if (current === generation.current) { setConflicts(result); setError(null); }
    } catch (caught) { if (current === generation.current) setError(messageForError(caught)); }
    finally { if (current === generation.current) setLoading(false); }
  }, [account.listConflicts]);

  useEffect(() => {
    if (!active) { generation.current += 1; setConflicts([]); setExpanded(null); setChoice(null); setError(null); setNotice(null); return; }
    void load(true);
    return () => { generation.current += 1; };
  }, [active, load]);

  useEffect(() => {
    if (active && account.lastSync) void load();
  }, [active, account.lastSync, load]);

  async function confirm(conflict: SyncConflict) {
    if (!choice || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await account.resolveConflict(conflict.id, choice, conflict.local.revision);
      setExpanded(null); setChoice(null);
      setNotice('Choice saved. Any remaining changes will sync automatically when online.');
      await load();
    } catch (caught) {
      const message = messageForError(caught);
      await load();
      setChoice(null);
      setError(`${message} Review the current versions and try again.`);
    } finally { setBusy(false); }
  }

  if (!active) return null;
  if (!loading && conflicts.length === 0 && !error && !notice) return null;
  return (
    <section className="collab-section collab-conflicts" aria-labelledby="collab-conflicts-title">
      <div className="collab-section-heading"><div><h3 id="collab-conflicts-title">Sync conflicts</h3><p>Both versions are kept until you choose what to do.</p></div><AlertTriangle size={18} aria-hidden="true" /></div>
      {loading && <div className="collab-state" role="status"><LoaderCircle className="collab-spin" size={15} aria-hidden="true" /> Checking for conflicts…</div>}
      {conflicts.map((conflict) => <div className="collab-conflict" key={conflict.id}>
        <div className="collab-conflict-heading"><div className="collab-grow"><div className="collab-strong">{titleOf(conflict.local)}</div><div className="collab-hint">{conflict.entity === 'note' ? 'Note' : 'Notebook'} · server version {conflict.serverVersion}</div></div>
          <button type="button" className="collab-button collab-ghost" onClick={() => { setExpanded(expanded === conflict.id ? null : conflict.id); setChoice(null); }} aria-expanded={expanded === conflict.id} disabled={busy}>{expanded === conflict.id ? <>Close <ChevronUp size={14} aria-hidden="true" /></> : <>Review <ChevronDown size={14} aria-hidden="true" /></>}</button>
        </div>
        {expanded === conflict.id && <div className="collab-conflict-detail">
          <div className="collab-compare">
            <div><div className="collab-list-heading">Your local version</div><strong>{titleOf(conflict.local)}</strong>{conflict.local.deletedAt && <span className="collab-hint">Marked deleted</span>}{bodyOf(conflict.local) !== null && <pre>{bodyOf(conflict.local) || '(empty)'}</pre>}</div>
            <div><div className="collab-list-heading">Server version</div><strong>{titleOf(conflict.server)}</strong>{conflict.server.deletedAt && <span className="collab-hint">Marked deleted</span>}{bodyOf(conflict.server) !== null && <pre>{bodyOf(conflict.server) || '(empty)'}</pre>}</div>
          </div>
          {!choice ? <div className="collab-actions collab-actions-start">
            <button type="button" className="collab-button" disabled={busy || conflict.role === 'viewer'} onClick={() => setChoice('local')}>Keep mine</button>
            <button type="button" className="collab-button" disabled={busy} onClick={() => setChoice('server')}>Use server</button>
            <button type="button" className="collab-button" disabled={busy} onClick={() => setChoice('both')}>Keep both</button>
          </div> : <div className="collab-confirm"><p>{choiceText(conflict, choice)}</p><div className="collab-actions collab-actions-start"><button type="button" className="collab-button collab-primary" disabled={busy} onClick={() => void confirm(conflict)}>{busy ? 'Saving…' : 'Confirm choice'}</button><button type="button" className="collab-button collab-ghost" disabled={busy} onClick={() => setChoice(null)}>Cancel</button></div></div>}
          {conflict.role === 'viewer' && <p className="collab-hint">View-only access cannot replace the server version. You can keep a separate copy instead.</p>}
        </div>}
      </div>)}
      {notice && <div className="collab-success" role="status">{notice}</div>}
      {error && <div className="collab-alert" role="alert">{error}</div>}
    </section>
  );
}
