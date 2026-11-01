'use client';

import { FileText, PanelLeft, Plus, Search } from 'lucide-react';
import type { Note, Notebook } from '@/lib/types';
import { noteSnippet } from '@/lib/features';

type Props = {
  title: string;
  notes: Note[];
  notebooks: Notebook[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSearch: () => void;
  onOpenSidebar: () => void;
};

function noteDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).valueOf();
  if (day === today) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (today - day < 6 * 86400000 && day < today) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: '2-digit' as const } : {}) });
}

export function NoteList({ title, notes, notebooks, selectedId, onSelect, onNew, onSearch, onOpenSidebar }: Props) {
  const sorted = [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return <section className="note-list" aria-label={`${title} note list`}>
    <div className="list-header">
      <div className="list-header-top">
        <button className="icon-button mobile-only" onClick={onOpenSidebar} title="Open navigation" aria-label="Open navigation"><PanelLeft size={17} /></button>
        <h1 className="list-title">{title}</h1>
        <button className="icon-button" onClick={onNew} title="New note" aria-label="New note"><Plus size={17} /></button>
      </div>
      <div className="list-meta">{notes.length} {notes.length === 1 ? 'note' : 'notes'}</div>
    </div>
    <div className="list-toolbar"><button className="list-search" onClick={onSearch}><Search size={14} /><span>Find a note</span><span className="shortcut">⌘ K</span></button></div>
    <div className="note-list-items">
      {sorted.length > 0 ? <>
        <div className="note-list-section">Recently edited</div>
        {sorted.map((note) => {
          const notebook = notebooks.find((item) => item.id === note.notebookId);
          return <button className={`note-row ${selectedId === note.id ? 'selected' : ''}`} key={note.id} onClick={() => onSelect(note.id)} aria-current={selectedId === note.id ? 'page' : undefined}>
            <span className="note-row-top"><span className="note-row-title">{note.title.trim() || 'Untitled note'}</span><span className="note-row-date">{noteDate(note.updatedAt)}</span></span>
            <span className="note-row-preview">{noteSnippet(note, undefined, 115) || 'No additional text'}</span>
            <span className="note-row-bottom"><FileText size={11} /><span>{notebook?.name || 'Inbox'}</span>{note.tags[0] && <><span className="note-row-dot" /><span className="note-row-tag">#{note.tags[0]}</span></>}{note.pinned && <><span className="note-row-dot" /><span>Pinned</span></>}</span>
          </button>;
        })}
      </> : <div className="empty-list">No notes here yet.<br /><button className="text-button" onClick={onNew}>Create one</button> to get started.</div>}
    </div>
  </section>;
}
