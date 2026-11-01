'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Search, SlidersHorizontal, X } from 'lucide-react';
import type { Note } from '@/lib/types';
import { noteSnippet } from '@/lib/features';
import { useLocalSearch } from '@/lib/features/use-local-search';
import { paginateSearchResults, SEARCH_PAGE_SIZE } from '@/lib/features/search-pagination';
import { useDialogFocus } from './use-dialog-focus';

export function SearchDialog({ notes, workspaceId, onClose, onOpenNote }: { notes: Note[]; workspaceId: string | null; onClose: () => void; onOpenNote: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [active, setActive] = useState(0);
  const [visibleCount, setVisibleCount] = useState(SEARCH_PAGE_SIZE);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, { onEscape: onClose, initialFocus: input });
  const tags = useMemo(() => [...new Set(notes.flatMap((note) => note.tags))].sort((a, b) => a.localeCompare(b)), [notes]);
  const { results, searching, error } = useLocalSearch(notes, query, { tags: tag ? [tag] : [], from, to }, workspaceId);
  const { visible: visibleResults, remaining } = paginateSearchResults(results, visibleCount);
  useEffect(() => { if (visibleResults[active]) document.getElementById(`result-${visibleResults[active].id}`)?.scrollIntoView({ block: 'nearest' }); }, [active, results]);
  useEffect(() => { setActive(0); setVisibleCount(SEARCH_PAGE_SIZE); }, [query, tag, from, to]);
  useEffect(() => { if (active >= visibleResults.length) setActive(Math.max(0, visibleResults.length - 1)); }, [active, visibleResults.length]);
  const open = (id: string) => { onOpenNote(id); onClose(); };
  return <div className="panel-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="dialog search-dialog" role="dialog" aria-modal="true" aria-label="Search notes">
      <div className="search-dialog-top"><Search size={19} /><input ref={input} className="search-dialog-input" value={query} placeholder="Search or describe what you remember…" aria-label="Search titles, note text, and tags" aria-controls="search-results" aria-activedescendant={!searching && visibleResults[active] ? `result-${visibleResults[active].id}` : undefined} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' && visibleResults.length) { event.preventDefault(); setActive((index) => Math.min(index + 1, visibleResults.length - 1)); }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
        if (event.key === 'Enter' && !searching && visibleResults[active]) { event.preventDefault(); open(visibleResults[active].id); }
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
        {visibleResults.length && !searching ? visibleResults.map((note, index) => <button className={`search-result ${index === active ? 'active' : ''}`} id={`result-${note.id}`} key={note.id} role="option" aria-selected={index === active} onMouseEnter={() => setActive(index)} onClick={() => open(note.id)}><FileText size={16} /><span><strong>{note.title.trim() || 'Untitled note'}</strong><span>{noteSnippet(note, query, 125) || 'No additional text'}</span></span></button>) : <div className="empty-list" role="status">{searching ? 'Searching your notes…' : error || 'No matching notes. Try another phrase or remove a filter.'}</div>}
      </div>
      {!searching && remaining > 0 && <div className="search-more" style={{ padding: '0 8px 8px' }}><button type="button" className="button" onClick={() => setVisibleCount((count) => Math.min(count + SEARCH_PAGE_SIZE, results.length))}>Show more ({remaining} remaining)</button></div>}
      <div className="search-hint"><span>↑ ↓ Navigate</span><span>↵ Open</span><span>Esc Close</span><span className="search-hint-end">On-device fuzzy search</span></div>
    </div>
  </div>;
}
