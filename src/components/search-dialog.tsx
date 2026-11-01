'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Search, SlidersHorizontal, X } from 'lucide-react';
import type { Note } from '@/lib/types';
import { noteSnippet, searchNotes } from '@/lib/features';

export function SearchDialog({ notes, onClose, onOpenNote }: { notes: Note[]; onClose: () => void; onOpenNote: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const tags = useMemo(() => [...new Set(notes.flatMap((note) => note.tags))].sort((a, b) => a.localeCompare(b)), [notes]);
  const results = useMemo(() => searchNotes(notes, query, { tags: tag ? [tag] : [], from, to }).slice(0, 30), [notes, query, tag, from, to]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);
  useEffect(() => { setActive(0); }, [query, tag, from, to]);
  const open = (id: string) => { onOpenNote(id); onClose(); };
  return <div className="panel-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="dialog search-dialog" role="dialog" aria-modal="true" aria-label="Search notes">
      <div className="search-dialog-top"><Search size={19} /><input ref={input} className="search-dialog-input" value={query} placeholder="Search your notes…" aria-label="Search your notes" aria-controls="search-results" aria-activedescendant={results[active] ? `result-${results[active].id}` : undefined} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(index + 1, results.length - 1)); }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
        if (event.key === 'Enter' && results[active]) { event.preventDefault(); open(results[active].id); }
      }} />
        <button className={`icon-button ${showFilters ? 'is-active' : ''}`} aria-label="Search filters" aria-expanded={showFilters} title="Search filters" onClick={() => setShowFilters((value) => !value)}><SlidersHorizontal size={16} /></button>
        <button className="icon-button search-close" aria-label="Close search" onClick={onClose}><X size={17} /></button>
      </div>
      {showFilters && <div className="search-filters">
        <label>Tag<select className="field" value={tag} onChange={(event) => setTag(event.target.value)}><option value="">All tags</option>{tags.map((item) => <option key={item} value={item}>#{item}</option>)}</select></label>
        <label>Edited from<input className="field" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>Edited to<input className="field" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      </div>}
      <div className="search-dialog-results" id="search-results" role="listbox" aria-label="Search results">
        {results.length ? results.map((note, index) => <button className={`search-result ${index === active ? 'active' : ''}`} id={`result-${note.id}`} key={note.id} role="option" aria-selected={index === active} onMouseEnter={() => setActive(index)} onClick={() => open(note.id)}><FileText size={16} /><span><strong>{note.title.trim() || 'Untitled note'}</strong><span>{noteSnippet(note, query, 125) || 'No additional text'}</span></span></button>) : <div className="empty-list">No matching notes. Try another phrase or remove a filter.</div>}
      </div>
      <div className="search-hint"><span>↑ ↓ Navigate</span><span>↵ Open</span><span>Esc Close</span><span className="search-hint-end">Search stays on this device</span></div>
    </div>
  </div>;
}
