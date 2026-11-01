'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Notebook } from '@/lib/types';

export type NotebookDialogState = { mode: 'create' } | { mode: 'rename' | 'delete'; notebook: Notebook };

export function NotebookDialog({ state, onClose, onSubmit }: { state: NotebookDialogState; onClose: () => void; onSubmit: (value: string) => Promise<void> }) {
  const [name, setName] = useState(state.mode === 'create' ? '' : state.notebook.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => { window.removeEventListener('keydown', handleKey); previous?.focus(); };
  }, [onClose, busy]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (state.mode !== 'delete' && !name.trim()) { setError('Give your notebook a name.'); return; }
    setBusy(true); setError('');
    try { await onSubmit(name.trim()); onClose(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not update this notebook.'); }
    finally { setBusy(false); }
  };
  const title = state.mode === 'create' ? 'New notebook' : state.mode === 'rename' ? 'Rename notebook' : 'Delete notebook?';
  return <div className="panel-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><form className="dialog" role="dialog" aria-modal="true" aria-labelledby="notebook-dialog-title" onSubmit={(event) => { void submit(event); }}>
    <div className="dialog-header"><h2 id="notebook-dialog-title">{title}</h2><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close"><X size={16} /></button></div>
    <div className="dialog-content">{state.mode === 'delete' ? <p className="dialog-copy">“{state.notebook.name}” will be removed. Its notes will move to your inbox; they won’t be deleted.</p> : <label className="dialog-label">Notebook name<input ref={input} className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Projects" maxLength={100} /></label>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button ghost" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy ? 'Working…' : state.mode === 'delete' ? 'Delete notebook' : state.mode === 'rename' ? 'Save name' : 'Create notebook'}</button></div>
    </div>
  </form></div>;
}
