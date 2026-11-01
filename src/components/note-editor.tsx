'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Bold, CalendarDays, Check, ChevronRight, CircleAlert, CloudOff,
  Eye, FileText, Heading2, Italic, Link2, List, ListChecks, MessageSquare,
  MoreHorizontal, PanelLeft, Pin, Plus, Share2, Trash2, X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Attachment, Note, Notebook, NotePatch } from '@/lib/types';
import { AttachmentList } from '@/components/features/attachment-list';
import { getBacklinks, getOutgoingLinks, getRelatedNotes } from '@/lib/features';
import type { NoteDraft } from './use-note-drafts';

type Props = {
  draft: NoteDraft;
  notes: Note[];
  notebooks: Notebook[];
  onChange: (patch: NotePatch) => void;
  onOpenNote: (id: string) => void;
  onBack: () => void;
  onOpenSidebar: () => void;
  onTrash: () => void;
  onShare: () => void;
  onComments: () => void;
  onKeepMine: () => void;
  onUseLatest: () => void;
  onRetry: () => void;
  listAttachments: (noteId: string) => Promise<Attachment[]>;
  addAttachment: (noteId: string, file: Blob, name: string) => Promise<Attachment>;
  deleteAttachment: (id: string) => Promise<void>;
  onAppendText: (text: string) => Promise<void>;
};

const shortDate = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Convert wiki syntax to in-document links, preserving ReactMarkdown's safe rendering. */
function renderWikiLinks(body: string) {
  return body.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_match, rawTitle: string, rawLabel?: string) => {
    const title = rawTitle.trim();
    const label = (rawLabel || rawTitle).trim().replace(/\]/g, '\\]');
    return `[${label}](#jot-wiki-${encodeURIComponent(title)})`;
  });
}

export function NoteEditor({ draft, notes, notebooks, onChange, onOpenNote, onBack, onOpenSidebar, onTrash, onShare, onComments, onKeepMine, onUseLatest, onRetry, listAttachments, addAttachment, deleteAttachment, onAppendText }: Props) {
  const note = draft.note;
  const readOnly = note.role === 'viewer';
  const [mode, setMode] = useState<'write' | 'preview'>('preview');
  const [addingTag, setAddingTag] = useState(false);
  const [tagValue, setTagValue] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tagRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const title = note.title.trim() || 'Untitled note';
  const notebook = notebooks.find((item) => item.id === note.notebookId);
  const backlinks = useMemo(() => getBacklinks(notes, note), [notes, note]);
  const outgoing = useMemo(() => getOutgoingLinks(notes, note), [notes, note]);
  const related = useMemo(() => getRelatedNotes(notes, note, 4).filter((item) => !backlinks.some((backlink) => backlink.id === item.id)), [notes, note, backlinks]);
  const unresolved = outgoing.filter((item) => item.matches.length !== 1);

  useEffect(() => {
    setMode(note.body.trim() ? 'preview' : 'write');
    setAddingTag(false);
    setMenuOpen(false);
  }, [note.id]);
  useEffect(() => { if (addingTag) tagRef.current?.focus(); }, [addingTag]);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.max(380, textarea.scrollHeight)}px`; }
  }, [note.body, mode]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const addTag = () => {
    const next = tagValue.trim().replace(/^#/, '');
    if (next && !note.tags.some((tag) => tag.toLocaleLowerCase() === next.toLocaleLowerCase())) onChange({ tags: [...note.tags, next] });
    setTagValue('');
    setAddingTag(false);
  };
  const format = (before: string, after = '', fallback = '') => {
    const input = textareaRef.current;
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = note.body.slice(start, end) || fallback;
    const insertion = `${before}${selected}${after}`;
    onChange({ body: note.body.slice(0, start) + insertion + note.body.slice(end) });
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };
  const statusLabel = draft.status === 'saving' || draft.status === 'dirty' ? 'Saving…'
    : draft.status === 'conflict' ? 'Conflict'
      : draft.status === 'error' ? 'Not saved'
        : note.syncState === 'conflict' ? 'Sync conflict'
          : note.syncState === 'synced' ? 'Synced' : 'Saved locally';

  return (
    <main className="editor" aria-label="Note editor">
      <header className="editor-header">
        <button className="icon-button mobile-only" onClick={onBack} title="Back to notes" aria-label="Back to notes"><ArrowLeft size={17} /></button>
        <button className="icon-button mobile-only" onClick={onOpenSidebar} title="Open navigation" aria-label="Open navigation"><PanelLeft size={17} /></button>
        <div className="breadcrumb"><span>{notebook?.name || 'Inbox'}</span><ChevronRight size={13} /><span className="current">{title}</span></div>
        <div className="editor-actions">
          <span className="save-indicator" role="status">{draft.status === 'conflict' || draft.status === 'error' || note.syncState === 'conflict' ? <CircleAlert size={13} /> : note.syncState === 'synced' ? <Check size={13} /> : <CloudOff size={13} />}{statusLabel}</span>
          <button className={`icon-button ${note.pinned ? 'is-active' : ''}`} onClick={() => onChange({ pinned: !note.pinned })} disabled={readOnly} title={note.pinned ? 'Unpin note' : 'Pin note'} aria-label={note.pinned ? 'Unpin note' : 'Pin note'}><Pin size={16} /></button>
          <button className="icon-button" onClick={onComments} title="Comments" aria-label="Comments"><MessageSquare size={16} /></button>
          <button className="icon-button" onClick={onShare} title="Share note" aria-label="Share note"><Share2 size={16} /></button>
          <div className="header-divider" />
          <div className="popover-wrap" ref={menuRef}>
            <button className="icon-button" onClick={() => setMenuOpen((open) => !open)} title="More note actions" aria-label="More note actions" aria-expanded={menuOpen}><MoreHorizontal size={18} /></button>
            {menuOpen && <div className="small-menu" role="menu"><button role="menuitem" disabled={note.role !== 'owner'} onClick={() => { setMenuOpen(false); onTrash(); }}><Trash2 size={14} /> Move to trash</button></div>}
          </div>
        </div>
      </header>
      <div className="editor-scroll">
        <article className="editor-document">
          {(draft.status === 'conflict' || draft.status === 'error') && <div className="notice danger editor-notice" role="alert">
            <CircleAlert size={16} />
            <div><strong>{draft.status === 'conflict' ? 'This note changed elsewhere' : 'Your changes could not be saved'}</strong>
              {draft.status === 'conflict' ? 'Your draft is still here. Keep it, or replace it with the latest saved version.' : `${draft.error || 'Try saving again.'} Your draft is still here.`}
              <div className="notice-actions">{draft.status === 'conflict' ? <><button className="button" onClick={onKeepMine}>Keep my draft</button><button className="button ghost" onClick={onUseLatest}>Use latest version</button></> : <button className="button" onClick={onRetry}>Retry save</button>}</div>
            </div>
          </div>}
          {readOnly && <div className="notice editor-notice"><Eye size={15} /><span>You have view-only access to this note.</span></div>}
          <input aria-label="Note title" className="note-title-input" value={note.title} onChange={(event) => onChange({ title: event.target.value })} placeholder="Untitled note" readOnly={readOnly} />
          <div className="note-properties">
            <span className="property"><CalendarDays size={13} /> Edited <strong>{shortDate(note.updatedAt)}</strong></span>
            <label className="property notebook-property"><FileText size={13} /><span className="sr-only">Notebook</span><select value={note.notebookId || ''} disabled={readOnly} onChange={(event) => onChange({ notebookId: event.target.value || null })}><option value="">Inbox</option>{notebooks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            {readOnly && <span className="property">View only</span>}
          </div>
          <div className="tags-row" aria-label="Tags">
            {note.tags.map((tag) => <span className="tag" key={tag}>#{tag}{!readOnly && <button onClick={() => onChange({ tags: note.tags.filter((item) => item !== tag) })} aria-label={`Remove tag ${tag}`}><X size={11} /></button>}</span>)}
            {!readOnly && (addingTag ? <input ref={tagRef} className="tag-input" value={tagValue} placeholder="Tag name" aria-label="Tag name" onChange={(event) => setTagValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addTag(); if (event.key === 'Escape') { setAddingTag(false); setTagValue(''); } }} onBlur={addTag} /> : <button className="add-tag" onClick={() => setAddingTag(true)}><Plus size={12} /> Add tag</button>)}
          </div>
          <div className="document-divider" />
          <div className="editor-modebar" role="group" aria-label="Editor mode">
            <button className={`mode-button ${mode === 'write' ? 'active' : ''}`} onClick={() => setMode('write')}>{readOnly ? 'Markdown' : 'Write'}</button>
            <button className={`mode-button ${mode === 'preview' ? 'active' : ''}`} onClick={() => setMode('preview')}>Preview</button>
            <span className="mode-spacer" />
            {mode === 'write' && !readOnly && <div className="formatting" aria-label="Formatting">
              <button className="icon-button" onClick={() => format('## ', '', 'Heading')} title="Heading" aria-label="Insert heading"><Heading2 size={15} /></button>
              <button className="icon-button" onClick={() => format('**', '**', 'bold text')} title="Bold" aria-label="Bold"><Bold size={15} /></button>
              <button className="icon-button" onClick={() => format('*', '*', 'italic text')} title="Italic" aria-label="Italic"><Italic size={15} /></button>
              <button className="icon-button" onClick={() => format('- ', '', 'List item')} title="List" aria-label="Insert list"><List size={15} /></button>
              <button className="icon-button" onClick={() => format('- [ ] ', '', 'Task')} title="Task" aria-label="Insert task"><ListChecks size={15} /></button>
              <button className="icon-button" onClick={() => format('[[', ']]', 'Note title')} title="Link a note" aria-label="Insert note link"><Link2 size={15} /></button>
            </div>}
          </div>
          {mode === 'write' ? <textarea ref={textareaRef} className="editor-textarea" aria-label="Note body in Markdown" value={note.body} onChange={(event) => onChange({ body: event.target.value })} placeholder="Start writing, or type [[ to link a note…" readOnly={readOnly} spellCheck />
            : <div className="markdown">{note.body.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
              a: ({ href, children, ...props }) => {
                if (href?.startsWith('#jot-wiki-')) {
                  let target = '';
                  try { target = decodeURIComponent(href.slice('#jot-wiki-'.length)); } catch { target = ''; }
                  const matches = notes.filter((item) => item.title.trim().toLocaleLowerCase() === target.trim().toLocaleLowerCase());
                  return <a href={href} title={matches.length === 1 ? `Open ${matches[0].title}` : matches.length ? 'Multiple notes have this title' : 'No matching note yet'} onClick={(event) => { event.preventDefault(); if (matches.length === 1) onOpenNote(matches[0].id); }}>{children}</a>;
                }
                return <a href={href} {...props} target={href?.startsWith('http') ? '_blank' : undefined} rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}>{children}</a>;
              },
            }}>{renderWikiLinks(note.body)}</ReactMarkdown> : <p className="empty-body">Nothing here yet. Switch to Write to add your thoughts.</p>}</div>}
          <AttachmentList noteId={note.id} listAttachments={listAttachments} addAttachment={readOnly ? undefined : addAttachment} deleteAttachment={readOnly ? undefined : deleteAttachment} onAppendText={readOnly ? undefined : onAppendText} />
          <section className="document-footer" aria-label="Note connections">
            <div className="document-footer-heading"><Link2 size={14} /> Connections</div>
            {backlinks.length === 0 && related.length === 0 && outgoing.length === 0 ? <p>No connections yet. Link another note with <code>[[note title]]</code>.</p> : <>
              {backlinks.length > 0 && <><p>Linked from</p><div className="connection-links">{backlinks.map((item) => <button className="connection-link" key={item.id} onClick={() => onOpenNote(item.id)}>{item.title || 'Untitled note'}</button>)}</div></>}
              {related.length > 0 && <><p>Related by shared words or tags</p><div className="connection-links">{related.map((item) => <button className="connection-link" key={item.id} onClick={() => onOpenNote(item.id)}>{item.title || 'Untitled note'}</button>)}</div></>}
              {unresolved.length > 0 && <p>{unresolved.map(({ link, matches }) => `${link.title} (${matches.length ? 'multiple matches' : 'not found'})`).join(' · ')}</p>}
            </>}
          </section>
        </article>
      </div>
    </main>
  );
}
