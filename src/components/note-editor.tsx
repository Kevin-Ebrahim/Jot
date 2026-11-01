'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Bold, CalendarDays, Check, ChevronRight, CircleAlert, CloudOff,
  Eye, FileText, Heading2, Italic, Link2, List, ListChecks, MessageSquare,
  ImageOff, MoreHorizontal, PanelLeft, Pin, Plus, Repeat2, Share2, Trash2, X,
} from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Attachment, Note, Notebook, NotePatch } from '@/lib/types';
import { AttachmentList } from '@/components/features/attachment-list';
import { getBacklinks, getOutgoingLinks, getRecurringSchedule, getRelatedNotes, removeRecurringSchedule, setRecurringSchedule } from '@/lib/features';
import type { NoteDraft } from './use-note-drafts';
import { canLoadRemoteImage, isRemoteImageSource, remoteImageKey } from './image-policy';
import { useShortcutModifier } from './use-shortcut-modifier';

type Props = {
  draft: NoteDraft;
  busy?: boolean;
  forceReadOnly?: boolean;
  recoveryAvailable?: boolean;
  recoveryUnavailable?: boolean;
  onCopyUnavailable: () => Promise<void>;
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
  onAppendText: (text: string) => Promise<{ saved: boolean } | void>;
  allowedRemoteImages: ReadonlySet<string>;
  onAllowRemoteImage: (key: string) => void;
};

const shortDate = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Convert wiki syntax to in-document links, preserving ReactMarkdown's safe rendering. */
function renderWikiLinks(body: string) {
  let inFence = false;
  return body.split(/(\r?\n)/).map((line) => {
    if (/^\r?\n$/.test(line)) return line;
    if (/^\s*```/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    if (/^\s*@repeat-auto\s*$/i.test(line) || /^\s*Repeat(?: schedule)?\s*:\s*@repeat-note\((?:daily|weekly|monthly|yearly)\s*,\s*\d{4}-\d{2}-\d{2}\)\s*$/i.test(line)) return '';
    return line.split(/(`[^`]*`)/g).map((part, index) => index % 2 ? part : part.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_match, rawTitle: string, rawLabel?: string) => {
      const title = rawTitle.trim();
      const label = (rawLabel || rawTitle).trim().replace(/([\\\[\]])/g, '\\$1');
      const destination = encodeURIComponent(title).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      return `[${label}](#jot-wiki-${destination})`;
    })).join('');
  }).join('');
}

export function NoteEditor({ draft, busy = false, forceReadOnly = false, recoveryAvailable = false, recoveryUnavailable = false, onCopyUnavailable, notes, notebooks, onChange, onOpenNote, onBack, onOpenSidebar, onTrash, onShare, onComments, onKeepMine, onUseLatest, onRetry, listAttachments, addAttachment, deleteAttachment, onAppendText, allowedRemoteImages, onAllowRemoteImage }: Props) {
  const note = draft.note;
  const modifier = useShortcutModifier();
  const viewer = forceReadOnly || note.role === 'viewer';
  const readOnly = viewer || busy;
  const [mode, setMode] = useState<'write' | 'preview'>('preview');
  const [addingTag, setAddingTag] = useState(false);
  const [tagValue, setTagValue] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [conflictChoice, setConflictChoice] = useState<'mine' | 'latest' | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleInterval, setScheduleInterval] = useState<'daily' | 'weekly' | 'monthly' | 'yearly'>('weekly');
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  const [recoverConfirm, setRecoverConfirm] = useState(false);
  const [recoverBusy, setRecoverBusy] = useState(false);
  const [recoverError, setRecoverError] = useState('');
  const [attachmentVersion, setAttachmentVersion] = useState(0);
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, { downloadUrl: string; imageUrl?: string; name: string; mimeType: string }>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const tagRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const scheduleRef = useRef<HTMLDivElement>(null);
  const title = note.title.trim() || 'Untitled note';
  const notebook = notebooks.find((item) => item.id === note.notebookId);
  const backlinks = useMemo(() => getBacklinks(notes, note), [notes, note]);
  const outgoing = useMemo(() => getOutgoingLinks(notes, note), [notes, note]);
  const related = useMemo(() => getRelatedNotes(notes, note, 4).filter((item) => !backlinks.some((backlink) => backlink.id === item.id)), [notes, note, backlinks]);
  const unresolved = outgoing.filter((item) => item.matches.length !== 1);
  const schedule = useMemo(() => getRecurringSchedule(note), [note]);

  useEffect(() => {
    setMode(note.body.trim() ? 'preview' : 'write');
    setAddingTag(false);
    setMenuOpen(false);
    setConflictChoice(null);
    setScheduleOpen(false);
    setRecoverConfirm(false); setRecoverError('');
    if (!note.title && !note.body && !viewer) requestAnimationFrame(() => titleRef.current?.focus());
  }, [note.id]);
  useEffect(() => { if (draft.status !== 'conflict') setConflictChoice(null); }, [draft.status]);
  useEffect(() => { if (addingTag) tagRef.current?.focus(); }, [addingTag]);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.max(380, textarea.scrollHeight)}px`; }
  }, [note.body, mode]);
  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    setAttachmentUrls({});
    void listAttachments(note.id).then((items) => {
      if (!active) return;
      const next: Record<string, { downloadUrl: string; imageUrl?: string; name: string; mimeType: string }> = {};
      const rasterTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'];
      for (const item of items.filter((attachment) => !attachment.deletedAt)) {
        // Never expose an active HTML/SVG Blob as a navigable same-origin URL.
        const downloadUrl = URL.createObjectURL(new Blob([item.blob], { type: 'application/octet-stream' })); urls.push(downloadUrl);
        const mimeType = item.mimeType.toLowerCase();
        const imageUrl = rasterTypes.includes(mimeType) ? URL.createObjectURL(item.blob) : undefined;
        if (imageUrl) urls.push(imageUrl);
        next[item.id] = { downloadUrl, imageUrl, name: item.name, mimeType };
      }
      if (active) setAttachmentUrls(next);
      else urls.forEach((url) => URL.revokeObjectURL(url));
    }).catch(() => { if (active) setAttachmentUrls({}); });
    return () => { active = false; urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [note.id, listAttachments, attachmentVersion]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuOpen]);

  useEffect(() => {
    if (!scheduleOpen) return;
    const close = (event: MouseEvent) => { if (!scheduleRef.current?.contains(event.target as Node)) setScheduleOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setScheduleOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [scheduleOpen]);
  const openSchedule = () => {
    const today = new Date();
    const date = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
    setScheduleInterval(schedule?.interval || 'weekly'); setScheduleDate(schedule?.dueAt || date); setScheduleError(''); setScheduleOpen(true);
  };
  const saveSchedule = (event: React.FormEvent) => {
    event.preventDefault();
    try { onChange({ body: setRecurringSchedule(note.body, scheduleInterval, scheduleDate) }); setScheduleOpen(false); }
    catch (error) { setScheduleError(error instanceof Error ? error.message : 'Choose a valid date.'); }
  };

  const addTag = () => {
    const next = tagValue.trim().replace(/^#/, '');
    if (next && note.tags.length < 50 && !note.tags.some((tag) => tag.toLocaleLowerCase() === next.toLocaleLowerCase())) onChange({ tags: [...note.tags, next] });
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
  const formatLine = (prefix: string, fallback: string) => {
    const input = textareaRef.current;
    if (!input) return;
    const start = note.body.lastIndexOf('\n', input.selectionStart - 1) + 1;
    const foundEnd = note.body.indexOf('\n', input.selectionEnd);
    const end = foundEnd < 0 ? note.body.length : foundEnd;
    const text = note.body.slice(start, end) || fallback;
    onChange({ body: `${note.body.slice(0, start)}${prefix}${text}${note.body.slice(end)}` });
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + prefix.length, start + prefix.length + text.length); });
  };
  const addFile = async (noteId: string, file: Blob, name: string) => {
    const attachment = await addAttachment(noteId, file, name); setAttachmentVersion((version) => version + 1); return attachment;
  };
  const deleteFile = async (id: string) => { await deleteAttachment(id); setAttachmentVersion((version) => version + 1); };
  const statusLabel = draft.status === 'saving' || draft.status === 'dirty' ? 'Saving…'
    : draft.status === 'conflict' ? 'Conflict'
      : draft.status === 'error' ? 'Not saved'
        : note.syncState === 'conflict' ? 'Sync conflict'
          : note.syncState === 'synced' ? 'Synced' : 'Saved locally';

  return (
    <main className="editor" aria-label="Note editor" aria-busy={busy}>
      <header className="editor-header">
        <button className="icon-button mobile-only" onClick={onBack} title="Back to notes" aria-label="Back to notes"><ArrowLeft size={17} /></button>
        <button className="icon-button mobile-only editor-menu" onClick={onOpenSidebar} title="Open navigation" aria-label="Open navigation"><PanelLeft size={17} /></button>
        <div className="breadcrumb"><span>{notebook?.name || 'Inbox'}</span><ChevronRight size={13} /><span className="current">{title}</span></div>
        <div className="editor-actions">
          <span className="save-indicator" role="status">{draft.status === 'conflict' || draft.status === 'error' || note.syncState === 'conflict' ? <CircleAlert size={13} /> : <Check size={13} />}{statusLabel}</span>
          <div className="header-divider" />
          <button className={`icon-button ${note.pinned ? 'is-active' : ''}`} onClick={() => onChange({ pinned: !note.pinned })} disabled={readOnly} title={note.pinned ? 'Unpin note' : 'Pin note'} aria-label={note.pinned ? 'Unpin note' : 'Pin note'}><Pin size={16} /></button>
          <div className="header-divider" />
          <button className="icon-button" disabled={busy} onClick={onComments} title="Comments" aria-label="Comments"><MessageSquare size={16} /></button>
          <button className="button ghost header-share" disabled={busy} onClick={onShare} title="Share note" aria-label="Share note"><Share2 size={16} /><span>Share</span></button>
          <div className="header-divider" />
          <div className="popover-wrap" ref={menuRef}>
            <button className="icon-button" disabled={busy} onClick={() => setMenuOpen((open) => !open)} title="More note actions" aria-label="More note actions" aria-expanded={menuOpen}><MoreHorizontal size={18} /></button>
            {menuOpen && <div className="small-menu" role="menu"><button role="menuitem" disabled={viewer || note.role !== 'owner'} onClick={() => { setMenuOpen(false); onTrash(); }}><Trash2 size={14} /> Move to trash</button></div>}
          </div>
        </div>
      </header>
      <div className="editor-scroll">
        <article className="editor-document">
          {!recoveryAvailable && (draft.status === 'conflict' || draft.status === 'error') && <div className="notice danger editor-notice" role="alert">
            <CircleAlert size={16} />
            <div><strong>{draft.status === 'conflict' ? 'This note changed elsewhere' : 'Your changes could not be saved'}</strong>
              {draft.status === 'conflict' ? 'Your draft is still here. Compare it with the latest saved version before choosing.' : `${draft.error || 'Try saving again.'} Your draft is still here.`}
              {draft.status === 'conflict' && draft.conflict && <details className="conflict-details"><summary>View latest saved version</summary><strong>{draft.conflict.title || 'Untitled note'}</strong><pre>{draft.conflict.body || 'No body text'}</pre></details>}
              {draft.status === 'conflict' && conflictChoice && <p className="conflict-confirm">{conflictChoice === 'mine' ? 'This replaces the newer saved version with your draft.' : 'This discards your unsaved draft and loads the newer version.'}</p>}
              <div className="notice-actions">{draft.status === 'conflict' ? conflictChoice ? <><button className="button" onClick={() => { if (conflictChoice === 'mine') onKeepMine(); else onUseLatest(); }}>{conflictChoice === 'mine' ? 'Confirm overwrite' : 'Confirm discard'}</button><button className="button ghost" onClick={() => setConflictChoice(null)}>Cancel</button></> : <><button className="button" onClick={() => setConflictChoice('mine')}>Keep my draft</button><button className="button ghost" onClick={() => setConflictChoice('latest')}>Use latest version</button></> : <button className="button" onClick={onRetry}>Retry save</button>}</div>
            </div>
          </div>}
          {recoveryAvailable ? <div className="notice editor-notice recovery-notice"><CircleAlert size={15} /><div><strong>{recoveryUnavailable ? 'This shared note is no longer available' : 'Your editing access changed'}</strong>Your local version and any visible draft are still here. You can make a personal copy, including its local files.
            {recoverConfirm ? <><p className="conflict-confirm">The new copy will be in your Inbox and queued to sync to this account. Reconnect and sign in if needed. The original stays read-only.</p><div className="notice-actions"><button className="button" disabled={recoverBusy} onClick={() => { setRecoverBusy(true); setRecoverError(''); void onCopyUnavailable().catch((error) => setRecoverError(error instanceof Error ? error.message : 'Could not make a copy.')).finally(() => setRecoverBusy(false)); }}>{recoverBusy ? 'Copying…' : 'Confirm personal copy'}</button><button className="button ghost" disabled={recoverBusy} onClick={() => setRecoverConfirm(false)}>Cancel</button></div></> : <div className="notice-actions"><button className="button" onClick={() => setRecoverConfirm(true)}>Make personal copy</button></div>}
            {recoverError && <p className="dialog-error" role="alert">{recoverError}</p>}</div></div> : viewer && <div className="notice editor-notice"><Eye size={15} /><span>You have view-only access to this note.</span></div>}
          <input ref={titleRef} aria-label="Note title" className="note-title-input" value={note.title} onChange={(event) => onChange({ title: event.target.value })} placeholder="Untitled note" maxLength={300} readOnly={readOnly} />
          <div className="note-properties">
            <span className="property"><CalendarDays size={13} /> Edited <strong>{shortDate(note.updatedAt)}</strong></span>
            <label className="property notebook-property"><FileText size={13} /><span className="sr-only">Notebook</span><select value={note.notebookId || ''} disabled={readOnly} onChange={(event) => onChange({ notebookId: event.target.value || null })}><option value="">Inbox</option>{notebooks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <div className="repeat-control" ref={scheduleRef}>
              <button className="property-button" type="button" disabled={readOnly} onClick={openSchedule} aria-expanded={scheduleOpen}><Repeat2 size={13} />{schedule ? `${schedule.interval[0].toUpperCase() + schedule.interval.slice(1)} · ${schedule.dueAt}` : 'Repeat'}</button>
              {scheduleOpen && <form className="schedule-popover" onSubmit={saveSchedule}>
                <strong>Recurring note</strong><p>Create the next note from Templates, or turn on auto while Jot is open. Nothing runs when it is closed.</p>
                <label>Repeat<select className="field" value={scheduleInterval} onChange={(event) => setScheduleInterval(event.target.value as typeof scheduleInterval)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
                <label>Next date<input className="field" type="date" value={scheduleDate} onChange={(event) => setScheduleDate(event.target.value)} required /></label>
                {scheduleError && <span className="dialog-error" role="alert">{scheduleError}</span>}
                <div className="schedule-popover-actions">{schedule && <button className="button ghost" type="button" onClick={() => { onChange({ body: removeRecurringSchedule(note.body) }); setScheduleOpen(false); }}>Remove</button>}<span /><button className="button" type="button" onClick={() => setScheduleOpen(false)}>Cancel</button><button className="button primary" type="submit">Save</button></div>
              </form>}
            </div>
            {viewer && <span className="property">View only</span>}
          </div>
          <div className="tags-row" aria-label="Tags">
            {note.tags.map((tag) => <span className="tag" key={tag}>#{tag}{!readOnly && <button onClick={() => onChange({ tags: note.tags.filter((item) => item !== tag) })} aria-label={`Remove tag ${tag}`}><X size={11} /></button>}</span>)}
            {!readOnly && (addingTag ? <input ref={tagRef} className="tag-input" maxLength={80} value={tagValue} placeholder="Tag name" aria-label="Tag name" onChange={(event) => setTagValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addTag(); if (event.key === 'Escape') { setAddingTag(false); setTagValue(''); } }} onBlur={addTag} /> : <button className="add-tag" onClick={() => setAddingTag(true)}><Plus size={12} /> Add tag</button>)}
          </div>
          <div className="document-divider" />
          <div className="editor-modebar" role="group" aria-label="Editor mode">
            <button className={`mode-button ${mode === 'write' ? 'active' : ''}`} onClick={() => setMode('write')}>{readOnly ? 'Markdown' : 'Write'}</button>
            <button className={`mode-button ${mode === 'preview' ? 'active' : ''}`} onClick={() => setMode('preview')}>Preview</button>
            <span className="mode-spacer" />
            {mode === 'write' && !readOnly && <div className="formatting" aria-label="Formatting">
              <button className="icon-button" onClick={() => formatLine('## ', 'Heading')} title="Heading" aria-label="Insert heading"><Heading2 size={15} /></button>
              <button className="icon-button" onClick={() => format('**', '**', 'bold text')} title="Bold" aria-label="Bold"><Bold size={15} /></button>
              <button className="icon-button" onClick={() => format('*', '*', 'italic text')} title="Italic" aria-label="Italic"><Italic size={15} /></button>
              <button className="icon-button" onClick={() => formatLine('- ', 'List item')} title="List" aria-label="Insert list"><List size={15} /></button>
              <button className="icon-button" onClick={() => formatLine('- [ ] ', 'Task')} title="Task" aria-label="Insert task"><ListChecks size={15} /></button>
              <button className="icon-button" onClick={() => format('[[', ']]', 'Note title')} title="Link a note" aria-label="Insert note link"><Link2 size={15} /></button>
            </div>}
          </div>
          {mode === 'write' ? <textarea ref={textareaRef} className="editor-textarea" aria-label="Note body in Markdown" value={note.body} onChange={(event) => onChange({ body: event.target.value })} placeholder="Start writing, or type [[ to link a note…" maxLength={1000000} readOnly={readOnly} spellCheck />
            : <div className="markdown">{note.body.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url) => url.startsWith('attachment:') ? url : defaultUrlTransform(url)} components={{
              a: ({ href, children, ...props }) => {
                if (href?.startsWith('attachment:')) {
                  const attachment = attachmentUrls[href.slice('attachment:'.length)];
                  return attachment ? <a href={attachment.downloadUrl} download={attachment.name}>{children}</a> : <span title="Attachment unavailable">{children}</span>;
                }
                if (href?.startsWith('#jot-wiki-')) {
                  let target = '';
                  try { target = decodeURIComponent(href.slice('#jot-wiki-'.length)); } catch { target = ''; }
                  const matches = notes.filter((item) => item.id !== note.id && item.title.trim().toLocaleLowerCase() === target.trim().toLocaleLowerCase());
                  return <a href={href} title={matches.length === 1 ? `Open ${matches[0].title}` : matches.length ? 'Multiple notes have this title' : 'No matching note yet'} onClick={(event) => { event.preventDefault(); if (matches.length === 1) onOpenNote(matches[0].id); }}>{children}</a>;
                }
                const external = !!href && /^(https?:)?\/\//i.test(href);
                return <a href={href} {...props} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined} referrerPolicy={external ? 'no-referrer' : undefined}>{children}</a>;
              },
              img: ({ src, alt }) => {
                const source = typeof src === 'string' ? src : '';
                if (source.startsWith('attachment:')) {
                  const attachment = attachmentUrls[source.slice('attachment:'.length)];
                  const safeRaster = attachment?.imageUrl;
                  return safeRaster ? <img src={safeRaster} alt={alt || attachment.name} /> : <span className="image-placeholder">Local image unavailable.</span>;
                }
                if (!isRemoteImageSource(source)) return <span className="image-placeholder">Image unavailable.</span>;
                if (!canLoadRemoteImage(note.id, source, allowedRemoteImages)) return <span className="image-placeholder"><ImageOff size={14} /><span>{alt || 'External image'} · not loaded for privacy</span><button type="button" className="text-button" onClick={() => onAllowRemoteImage(remoteImageKey(note.id, source))}>Load external image</button></span>;
                return <img src={source} alt={alt || ''} referrerPolicy="no-referrer" loading="lazy" decoding="async" />;
              },
            }}>{renderWikiLinks(note.body)}</ReactMarkdown> : <p className="empty-body">Nothing here yet. Switch to Write to add your thoughts.</p>}</div>}
          {!note.body.trim() && mode === 'write' && <p className="editor-empty-hint">Markdown is supported. Use <code>[[note title]]</code> to link a note or <code>- [ ]</code> to add a task.</p>}
          <AttachmentList noteId={note.id} listAttachments={listAttachments} addAttachment={readOnly ? undefined : addFile} deleteAttachment={readOnly ? undefined : deleteFile} onAppendText={readOnly ? undefined : onAppendText} refreshKey={attachmentVersion} />
          <section className="document-footer" aria-label="Note connections">
            <div className="document-footer-heading"><Link2 size={14} /> Connections</div>
            {backlinks.length === 0 && related.length === 0 && outgoing.length === 0 ? <p>No connections yet. Link another note with <code>[[note title]]</code>.</p> : <>
              {backlinks.length > 0 && <><p>Linked from</p><div className="connection-links">{backlinks.map((item) => <button className="connection-link" key={item.id} onClick={() => onOpenNote(item.id)}>{item.title || 'Untitled note'}</button>)}</div></>}
              {related.length > 0 && <><p>Related by shared words or tags</p><div className="connection-links">{related.map((item) => <button className="connection-link" key={item.id} onClick={() => onOpenNote(item.id)}>{item.title || 'Untitled note'}</button>)}</div></>}
              {unresolved.length > 0 && <p>{unresolved.map(({ link, matches }) => `${link.title} (${matches.length ? 'multiple matches' : 'not found'})`).join(' · ')}</p>}
            </>}
          </section>
          <div className="editor-shortcuts"><span>Markdown supported</span><span><kbd>{modifier}</kbd> <kbd>K</kbd> Search</span><span><kbd>{modifier}</kbd> <kbd>N</kbd> New note</span></div>
        </article>
      </div>
    </main>
  );
}
