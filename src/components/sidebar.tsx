'use client';

import { useEffect, useState } from 'react';
import {
  Archive, BookOpen, CheckSquare2, ChevronDown, CircleHelp, FileText, Folder,
  Inbox, LayoutTemplate, MoreHorizontal, Plus, Search, Settings2, Sparkles,
  Star, Trash2, UserRound, Zap,
} from 'lucide-react';
import type { Notebook } from '@/lib/types';
import { useShortcutModifier } from './use-shortcut-modifier';

export type View = { kind: 'all' | 'inbox' | 'starred' | 'tasks' | 'resurface' | 'templates' | 'settings' | 'trash' | 'notebook'; id?: string };
type Props = {
  view: View;
  notebooks: Notebook[];
  counts: { all: number; inbox: number; starred: number; tasks: number; notebooks: Record<string, number> };
  online: boolean;
  open: boolean;
  onClose: () => void;
  onNavigate: (view: View) => void;
  onNew: () => void;
  onCapture: () => void;
  onSearch: () => void;
  onCreateNotebook: () => void;
  onRenameNotebook: (notebook: Notebook) => void;
  onShareNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
  onAccount: () => void;
};

export function Sidebar({ view, notebooks, counts, online, open, onClose, onNavigate, onNew, onCapture, onSearch, onCreateNotebook, onRenameNotebook, onShareNotebook, onDeleteNotebook, onAccount }: Props) {
  const [notebookMenu, setNotebookMenu] = useState<string | null>(null);
  const modifier = useShortcutModifier();
  useEffect(() => {
    if (!notebookMenu) return;
    const outside = (event: MouseEvent) => {
      const row = (event.target as Element | null)?.closest('[data-notebook-id]');
      if (row?.getAttribute('data-notebook-id') !== notebookMenu) setNotebookMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setNotebookMenu(null); };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [notebookMenu]);
  const navigate = (next: View) => { setNotebookMenu(null); onNavigate(next); onClose(); };
  return <>
    {open && <button className="sidebar-scrim mobile-only" aria-label="Close navigation" onClick={onClose} />}
    <aside className={`sidebar ${open ? 'is-open' : ''}`} aria-label="Main navigation">
      <div className="workspace-switcher">
        <div className="brand-mark" aria-hidden="true">j</div>
        <div className="brand-copy"><div className="brand-name">jot</div><div className="brand-sub">Your space to think</div></div>
      </div>
      <div className="sidebar-top-action">
        <button className="new-note-button" onClick={onNew}><Plus size={15} strokeWidth={2} /> New note</button>
        <button className="capture-button" onClick={onCapture} title="Quick capture" aria-label="Quick capture"><Zap size={15} /></button>
      </div>
      <div className="sidebar-scroll">
        <nav className="nav-group" aria-label="Library">
          <button className="nav-item" onClick={onSearch}><Search size={16} /><span className="label">Search</span><span className="shortcut">{modifier} K</span></button>
          <button className={`nav-item ${view.kind === 'all' ? 'active' : ''}`} onClick={() => navigate({ kind: 'all' })}><FileText size={16} /><span className="label">All notes</span><span className="nav-count">{counts.all}</span></button>
          <button className={`nav-item ${view.kind === 'inbox' ? 'active' : ''}`} onClick={() => navigate({ kind: 'inbox' })}><Inbox size={16} /><span className="label">Inbox</span><span className="nav-count">{counts.inbox}</span></button>
          <button className={`nav-item ${view.kind === 'starred' ? 'active' : ''}`} onClick={() => navigate({ kind: 'starred' })}><Star size={16} /><span className="label">Pinned</span>{counts.starred > 0 && <span className="nav-count">{counts.starred}</span>}</button>
          <button className={`nav-item ${view.kind === 'tasks' ? 'active' : ''}`} onClick={() => navigate({ kind: 'tasks' })}><CheckSquare2 size={16} /><span className="label">Tasks</span>{counts.tasks > 0 && <span className="nav-count">{counts.tasks}</span>}</button>
          <button className={`nav-item ${view.kind === 'resurface' ? 'active' : ''}`} onClick={() => navigate({ kind: 'resurface' })}><Sparkles size={16} /><span className="label">Rediscover</span></button>
        </nav>
        <div className="sidebar-heading"><span>Notebooks</span><button onClick={onCreateNotebook} title="New notebook" aria-label="New notebook"><Plus size={14} /></button></div>
        <nav className="nav-group" aria-label="Notebooks">
          {notebooks.map((notebook) => <div className="notebook-row" data-notebook-id={notebook.id} key={notebook.id}>
            <button className={`nav-item ${view.kind === 'notebook' && view.id === notebook.id ? 'active' : ''}`} onClick={() => navigate({ kind: 'notebook', id: notebook.id })}><Folder size={16} /><span className="label">{notebook.name}</span><span className="nav-count">{counts.notebooks[notebook.id] || ''}</span></button>
            <div className="notebook-popover-wrap"><button className="icon-button notebook-menu-button" aria-label={`Actions for ${notebook.name}`} aria-expanded={notebookMenu === notebook.id} onClick={() => setNotebookMenu(notebookMenu === notebook.id ? null : notebook.id)}><MoreHorizontal size={15} /></button>
              {notebookMenu === notebook.id && <div className="small-menu notebook-menu" role="menu">
                <button role="menuitem" disabled={notebook.role !== 'owner'} onClick={() => { setNotebookMenu(null); onRenameNotebook(notebook); }}>Rename</button>
                <button role="menuitem" onClick={() => { setNotebookMenu(null); onShareNotebook(notebook); }}>Sharing</button>
                <button role="menuitem" disabled={notebook.role !== 'owner'} onClick={() => { setNotebookMenu(null); onDeleteNotebook(notebook); }}>Delete notebook</button>
              </div>}
            </div>
          </div>)}
        </nav>
        <div className="sidebar-heading"><span>Workspace</span></div>
        <nav className="nav-group" aria-label="Workspace">
          <button className={`nav-item ${view.kind === 'templates' ? 'active' : ''}`} onClick={() => navigate({ kind: 'templates' })}><LayoutTemplate size={16} /><span className="label">Templates</span></button>
          <button className={`nav-item ${view.kind === 'trash' ? 'active' : ''}`} onClick={() => navigate({ kind: 'trash' })}><Trash2 size={16} /><span className="label">Trash</span></button>
        </nav>
      </div>
      <div className="sidebar-footer">
        <button className="nav-item" onClick={onAccount}><UserRound size={16} /><span className="label">Account &amp; sync</span></button>
        <button className={`nav-item ${view.kind === 'settings' ? 'active' : ''}`} onClick={() => navigate({ kind: 'settings' })}><Settings2 size={16} /><span className="label">Settings</span></button>
        <div className="connection-line"><span className={`status-dot ${online ? '' : 'offline'}`} />{online ? 'Stored on this device' : 'Offline · changes stay here'}</div>
      </div>
    </aside>
  </>;
}
