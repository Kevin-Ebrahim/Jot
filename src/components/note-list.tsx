'use client';

import { memo, useEffect, useMemo, useState } from 'react';
import { FileText, PanelLeft, Plus, Search } from 'lucide-react';
import type { Note, Notebook } from '@/lib/types';
import { noteSnippet } from '@/lib/features';
import { NOTE_PAGE_SIZE, noteListPage, sortNotes } from './note-derivations';
import { useShortcutModifier } from './use-shortcut-modifier';

type Props = {
  title: string;
  viewKey: string;
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

const NoteRow = memo(function NoteRow({ note, notebookName, selected, onSelect }: { note: Note; notebookName: string; selected: boolean; onSelect: (id: string) => void }) {
  const snippet = useMemo(() => noteSnippet(note, undefined, 115) || 'No additional text', [note.body]);
  return <button className={`note-row ${selected ? 'selected' : ''}`} onClick={() => onSelect(note.id)} aria-current={selected ? 'page' : undefined}>
    <span className="note-row-top"><span className="note-row-title">{note.title.trim() || 'Untitled note'}</span><span className="note-row-date">{noteDate(note.updatedAt)}</span></span>
    <span className="note-row-preview">{snippet}</span>
    <span className="note-row-bottom"><FileText size={11} /><span>{notebookName}</span>{note.tags[0] && <><span className="note-row-dot" /><span className="note-row-tag">#{note.tags[0]}</span></>}{note.pinned && <><span className="note-row-dot" /><span>Pinned</span></>}</span>
  </button>;
});

export function NoteList({ title, viewKey, notes, notebooks, selectedId, onSelect, onNew, onSearch, onOpenSidebar }: Props) {
  const modifier = useShortcutModifier();
  const [page, setPage] = useState({ key: viewKey, count: NOTE_PAGE_SIZE });
  useEffect(() => { setPage({ key: viewKey, count: NOTE_PAGE_SIZE }); }, [viewKey]);
  const limit = page.key === viewKey ? page.count : NOTE_PAGE_SIZE;
  // Body edits do not alter ordering. Re-sort only when IDs, pins or timestamps change.
  const orderKey = notes.map((note) => `${note.id}:${note.pinned ? 1 : 0}:${note.updatedAt}`).join('|');
  const sortedIds = useMemo(() => sortNotes(notes).map((note) => note.id), [orderKey]);
  const byId = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
  const sorted = useMemo(() => sortedIds.flatMap((id) => { const note = byId.get(id); return note ? [note] : []; }), [sortedIds, byId]);
  const notebookNames = useMemo(() => new Map(notebooks.map((notebook) => [notebook.id, notebook.name])), [notebooks]);
  const { visible, selectedOutside, remaining } = noteListPage(sorted, limit, selectedId);
  const row = (note: Note) => <NoteRow key={note.id} note={note} notebookName={(note.notebookId && notebookNames.get(note.notebookId)) || 'Inbox'} selected={selectedId === note.id} onSelect={onSelect} />;
  return <section className="note-list" aria-label={`${title} note list`}>
    <div className="list-header">
      <div className="list-header-top">
        <button className="icon-button mobile-only" onClick={onOpenSidebar} title="Open navigation" aria-label="Open navigation"><PanelLeft size={17} /></button>
        <h1 className="list-title">{title}</h1>
        <button className="icon-button" onClick={onNew} title="New note" aria-label="New note"><Plus size={17} /></button>
      </div>
      <div className="list-meta">{notes.length} {notes.length === 1 ? 'note' : 'notes'}</div>
    </div>
    <div className="list-toolbar"><button className="list-search" onClick={onSearch}><Search size={14} /><span>Find a note</span><span className="shortcut">{modifier} K</span></button></div>
    <div className="note-list-items">
      {sorted.length > 0 ? <>
        {selectedOutside && <><div className="note-list-section">Open note</div>{row(selectedOutside)}</>}
        <div className="note-list-section">Recently edited</div>
        {visible.map(row)}
        {remaining > 0 && <button className="load-more-notes" onClick={() => setPage({ key: viewKey, count: limit + NOTE_PAGE_SIZE })}>Show {Math.min(NOTE_PAGE_SIZE, remaining)} more <span>· {remaining} remaining</span></button>}
      </> : <div className="empty-list">No notes here yet.<br /><button className="text-button" onClick={onNew}>Create one</button> to get started.</div>}
    </div>
  </section>;
}
