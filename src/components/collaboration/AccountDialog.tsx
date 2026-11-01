'use client';

import { Check, Cloud, CloudOff, LoaderCircle, LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { messageForError } from './api';
import { useCollaboration } from './CollaborationProvider';
import { DialogFrame } from './DialogFrame';
import { ConflictList } from './ConflictList';

export function AccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const account = useCollaboration();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'auth' | 'sync' | 'copy' | 'logout' | 'refresh' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmCopy, setConfirmCopy] = useState(false);

  useEffect(() => {
    if (!open) {
      setPassword('');
      setError(null);
      setNotice(null);
      setConfirmCopy(false);
    }
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy('auth'); setError(null); setNotice(null);
    try {
      if (mode === 'login') await account.signIn(email.trim(), password);
      else await account.register(email.trim(), password);
      setPassword('');
      setNotice(mode === 'login' ? 'Signed in. Guest notes were not copied.' : 'Account created. Guest notes were not copied.');
    } catch (caught) {
      setError(messageForError(caught));
    } finally { setBusy(null); }
  }

  async function checkSession() {
    if (busy) return;
    setBusy('refresh'); setError(null);
    try { await account.refreshSession(); }
    catch { /* The provider supplies the session-specific message. */ }
    finally { setBusy(null); }
  }

  async function synchronize() {
    if (busy) return;
    setBusy('sync'); setError(null); setNotice(null);
    try {
      const result = await account.syncNow();
      if (!result.errors.length && !result.conflicts) setNotice('Sync is up to date.');
    } catch (caught) { setError(messageForError(caught)); }
    finally { setBusy(null); }
  }

  async function copyGuest() {
    if (busy || !confirmCopy) return;
    setBusy('copy'); setError(null); setNotice(null);
    try {
      const count = await account.importGuestNotes();
      setConfirmCopy(false);
      setNotice(count === 0 ? 'There were no guest notes to copy.' : `${count} ${count === 1 ? 'note was' : 'notes were'} copied to this account and will sync when online.`);
    } catch (caught) { setError(messageForError(caught)); }
    finally { setBusy(null); }
  }

  async function logout() {
    if (busy) return;
    setBusy('logout'); setError(null); setNotice(null);
    try { await account.signOut(); }
    catch (caught) { setError(messageForError(caught)); }
    finally { setBusy(null); }
  }

  const signedIn = account.session?.user;
  const syncLabel = account.syncStatus === 'syncing' ? 'Syncing…'
    : account.syncStatus === 'synced' ? 'Synced'
      : account.syncStatus === 'error' ? 'Sync needs attention' : 'Ready to sync';

  return (
    <DialogFrame open={open} onClose={onClose} title="Account & sync">
      {account.sessionStatus === 'checking' && (
        <div className="collab-state" role="status"><LoaderCircle className="collab-spin" size={17} aria-hidden="true" /> Checking your account…</div>
      )}
      {account.sessionStatus === 'error' && (
        <div className="collab-stack">
          <div className="collab-alert" role="alert"><CloudOff size={17} aria-hidden="true" /><span>{account.sessionError || 'Your session could not be checked.'}</span></div>
          <p className="collab-copy">You can keep working in the local workspace already on this device. Sync and sharing are paused until the session is confirmed.</p>
          <button type="button" className="collab-button" onClick={checkSession} disabled={!!busy}>
            <RefreshCw size={15} aria-hidden="true" /> {busy === 'refresh' ? 'Checking…' : 'Check session again'}
          </button>
        </div>
      )}
      {account.sessionStatus === 'ready' && !signedIn && (
        <div className="collab-stack">
          <p className="collab-copy">Your guest notes stay on this device. Sign in to use a separate account workspace and sync between devices.</p>
          <div className="collab-segment" role="group" aria-label="Account action">
            <button type="button" aria-pressed={mode === 'login'} onClick={() => { setMode('login'); setError(null); setPassword(''); }}>Sign in</button>
            <button type="button" aria-pressed={mode === 'register'} onClick={() => { setMode('register'); setError(null); setPassword(''); }}>Create account</button>
          </div>
          <form className="collab-stack" onSubmit={submit}>
            <label className="collab-label">Email
              <input className="collab-field" type="email" autoComplete="username" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
            </label>
            <label className="collab-label">Password
              <input className="collab-field" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 12 : undefined} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} />
              {mode === 'register' && <span className="collab-hint">At least 12 characters.</span>}
            </label>
            {error && <div className="collab-alert" role="alert">{error}</div>}
            <button className="collab-button collab-primary" type="submit" disabled={!!busy}>
              {busy === 'auth' ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>
          <p className="collab-fineprint"><ShieldCheck size={14} aria-hidden="true" /> Signing in never uploads guest notes. You can choose to copy them later.</p>
        </div>
      )}
      {account.sessionStatus === 'ready' && signedIn && (
        <div className="collab-stack">
          <div className="collab-account-row">
            <span className="collab-avatar" aria-hidden="true">{signedIn.email.slice(0, 1).toUpperCase()}</span>
            <div className="collab-grow"><div className="collab-strong">{signedIn.email}</div><div className="collab-hint">Account workspace</div></div>
            <span className="collab-badge"><Check size={12} aria-hidden="true" /> Signed in</span>
          </div>
          {!account.workspaceReady && <div className="collab-state" role="status"><LoaderCircle className="collab-spin" size={16} aria-hidden="true" /> Opening your workspace…</div>}
          <section className="collab-section" aria-labelledby="collab-sync-title">
            <div className="collab-section-heading">
              <div><h3 id="collab-sync-title">Sync</h3><p>Account notes sync automatically while online. Offline changes stay on this device until sync resumes.</p></div>
              <Cloud size={18} aria-hidden="true" />
            </div>
            <div className="collab-status-row"><span className={`collab-status-dot ${account.syncStatus === 'error' ? 'is-error' : ''}`} /> <span>{syncLabel}</span></div>
            {account.syncMessage && <div className="collab-alert" role="status">{account.syncMessage}</div>}
            <button type="button" className="collab-button" onClick={synchronize} disabled={!!busy || !account.workspaceReady || account.syncStatus === 'syncing'}>
              <RefreshCw size={15} className={account.syncStatus === 'syncing' ? 'collab-spin' : ''} aria-hidden="true" /> {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
          </section>
          <ConflictList active={open && account.workspaceReady} />
          <section className="collab-section" aria-labelledby="collab-guest-title">
            <div className="collab-section-heading"><div><h3 id="collab-guest-title">Guest notes on this device</h3><p>Guest and account workspaces are separate.</p></div></div>
            {!confirmCopy ? (
              <button type="button" className="collab-button" onClick={() => { setConfirmCopy(true); setNotice(null); }} disabled={!!busy || !account.workspaceReady}>Copy guest notes…</button>
            ) : (
              <div className="collab-confirm">
                <p>This copies guest notes into this account. The copies will begin syncing automatically and may be uploaded to your server. Guest originals remain on this device; attachments stay local. Repeating this adds only guest notes not copied before; it does not update existing copies or overwrite account edits.</p>
                <div className="collab-actions collab-actions-start">
                  <button type="button" className="collab-button collab-primary" onClick={copyGuest} disabled={!!busy || !account.workspaceReady}>{busy === 'copy' ? 'Copying…' : 'Copy and allow sync'}</button>
                  <button type="button" className="collab-button collab-ghost" onClick={() => setConfirmCopy(false)} disabled={!!busy}>Cancel</button>
                </div>
              </div>
            )}
          </section>
          {notice && <div className="collab-success" role="status"><Check size={15} aria-hidden="true" /> {notice}</div>}
          {error && <div className="collab-alert" role="alert">{error}</div>}
          <div className="collab-signout">
            <p className="collab-hint">Signing out opens the guest workspace. Account data already on this device is not erased.</p>
            <button type="button" className="collab-button collab-ghost" onClick={logout} disabled={!!busy}><LogOut size={15} aria-hidden="true" /> {busy === 'logout' ? 'Signing out…' : 'Sign out'}</button>
          </div>
        </div>
      )}
    </DialogFrame>
  );
}
