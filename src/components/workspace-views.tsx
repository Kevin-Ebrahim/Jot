'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowDownToLine, ArrowUpFromLine, CalendarDays, Check, ChevronRight, FileText, PanelLeft, RotateCcw } from 'lucide-react';
import type { NewNote, Note } from '@/lib/types';
import { createFromTemplate, getDueReviews, getPriorMeetings, getRecurringSchedule, getResurfacedNotes, NOTE_TEMPLATES, setRecurringSchedule } from '@/lib/features';
import type { View } from './sidebar';
import { cachedTasks } from './note-derivations';
import { isRecurringAutomationEnabled } from '@/lib/auto-recurring';

type Props = {
  view: View;
  notes: Note[];
  deletedNotes: Note[];
  theme: 'system' | 'dark' | 'light';
  workspaceId: string | null;
  onTheme: (theme: 'system' | 'dark' | 'light') => void;
  onOpenSidebar: () => void;
  onOpenNote: (id: string) => void;
  onToggleTask: (noteId: string, lineIndex: number) => void;
  onReviewed: (noteId: string) => void;
  onCreateRecurring: (source: Note) => Promise<void>;
  onSetAutomation: (source: Note, enabled: boolean) => Promise<void>;
  onCreate: (input: NewNote) => Promise<void>;
  onRestore: (note: Note) => Promise<void>;
  onExport: (password?: string) => Promise<Blob>;
  onExportMarkdown: () => Promise<Blob>;
  onImport: (file: Blob, password?: string) => Promise<void>;
  onAccount: () => void;
};

function ViewHeading({ title, description, onOpenSidebar }: { title: string; description: string; onOpenSidebar: () => void }) {
  return <div className="view-heading"><button className="icon-button mobile-only view-menu" onClick={onOpenSidebar} aria-label="Open navigation"><PanelLeft size={18} /></button><div><h1>{title}</h1><p>{description}</p></div></div>;
}
function formatDay(value: string) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function WorkspaceViews(props: Props) {
  const { view, notes, deletedNotes, theme, workspaceId, onTheme, onOpenSidebar, onOpenNote, onToggleTask, onReviewed, onCreateRecurring, onSetAutomation, onCreate, onRestore, onExport, onExportMarkdown, onImport, onAccount } = props;
  const tasks = useMemo(() => view.kind === 'tasks' ? cachedTasks(notes) : [], [notes, view.kind]);
  const resurfaced = useMemo(() => getResurfacedNotes(notes, new Date(), 20), [notes]);
  const meetings = useMemo(() => getPriorMeetings(notes, new Date(), 5), [notes]);
  const dueReviews = useMemo(() => getDueReviews(notes, new Date(), 20), [notes]);
  const schedules = useMemo(() => notes.flatMap((note) => { const schedule = getRecurringSchedule(note); return schedule ? [{ note, ...schedule }] : []; }).sort((a, b) => a.dueAt.localeCompare(b.dueAt)), [notes]);
  const [password, setPassword] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [confirmAccountImport, setConfirmAccountImport] = useState(false);
  const accountWorkspace = !!workspaceId;
  const [working, setWorking] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleTitle, setScheduleTitle] = useState('');
  const [scheduleInterval, setScheduleInterval] = useState<'daily' | 'weekly' | 'monthly' | 'yearly'>('weekly');
  const [scheduleDate, setScheduleDate] = useState(() => { const date = new Date(); return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'); });
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const reducedMotion = useReducedMotion();
  useEffect(() => { setConfirmAccountImport(false); setImportFile(null); setImportPassword(''); if (fileRef.current) fileRef.current.value = ''; }, [workspaceId]);
  const run = async (action: () => Promise<void>, success: string) => {
    setWorking(true); setFeedback(null);
    try { await action(); if (success) setFeedback({ text: success }); }
    catch (error) { setFeedback({ text: error instanceof Error ? error.message : 'Something went wrong. Please try again.', error: true }); }
    finally { setWorking(false); }
  };

  if (view.kind === 'tasks') {
    const open = tasks.filter((task) => !task.done).sort((a, b) => (a.dueAt || '9999').localeCompare(b.dueAt || '9999'));
    const done = tasks.filter((task) => task.done);
    const today = new Date();
    const todayKey = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
    const reminders = open.filter((task) => task.remindAt && task.remindAt <= todayKey);
    const otherOpen = open.filter((task) => !task.remindAt || task.remindAt > todayKey);
    const taskRows = (items: typeof tasks) => items.map((task) => <div className={`view-row ${task.done ? 'task-done' : ''}`} key={task.id}>
      <input className="task-check" type="checkbox" checked={task.done} disabled={notes.find((note) => note.id === task.noteId)?.role === 'viewer'} onChange={() => onToggleTask(task.noteId, task.lineIndex)} aria-label={`${task.done ? 'Reopen' : 'Complete'} ${task.text || 'task'}`} />
      <div className="view-row-main"><span className="view-row-title">{task.text || 'Untitled task'}</span><span className="view-row-description"><button className="text-button muted-link" onClick={() => onOpenNote(task.noteId)}>{task.noteTitle || 'Untitled note'}</button>{task.dueAt && ` · Due ${formatDay(task.dueAt)}`}{task.remindAt && ` · Reminder ${formatDay(task.remindAt)}`}{task.repeat && ` · Repeats ${task.repeat}`}</span></div>
      <button className="icon-button view-row-action" onClick={() => onOpenNote(task.noteId)} aria-label={`Open ${task.noteTitle || 'note'}`}><ChevronRight size={16} /></button>
    </div>);
    return <main className="workspace-view"><div className="workspace-view-inner"><ViewHeading title="Tasks" description="A clear view of the checkboxes in your notes." onOpenSidebar={onOpenSidebar} />
      {reminders.length > 0 && <section className="view-section"><h2>Reminders due · {reminders.length}</h2>{taskRows(reminders)}</section>}
      <section className="view-section"><h2>To do · {otherOpen.length}</h2>{otherOpen.length ? taskRows(otherOpen) : open.length ? <div className="empty-view">Your remaining tasks are listed under reminders.</div> : <div className="empty-view"><strong>All clear.</strong>Add a task in any note with <code>- [ ]</code> and it will appear here.</div>}</section>
      {done.length > 0 && <section className="view-section"><h2>Completed · {done.length}</h2>{taskRows(done)}</section>}
      <p className="view-footnote">Add <code>@due(YYYY-MM-DD)</code>, <code>@remind(YYYY-MM-DD)</code>, or <code>@repeat(weekly)</code> to a task. Reminders are shown here; Jot does not send background alerts.</p>
    </div></main>;
  }
  if (view.kind === 'resurface') {
    return <main className="workspace-view"><div className="workspace-view-inner"><ViewHeading title="Rediscover" description="Make room for the ideas and conversations you saved." onOpenSidebar={onOpenSidebar} />
      <section className="view-section"><h2>From your notes</h2>{resurfaced.length ? resurfaced.map(({ note, reason }) => <button className="view-row row-button" key={note.id} onClick={() => onOpenNote(note.id)}><FileText size={17} /><span className="view-row-main"><span className="view-row-title">{note.title || 'Untitled note'}</span><span className="view-row-description">{reason}</span></span><ChevronRight size={16} /></button>) : <div className="empty-view"><strong>Nothing to bring back just yet.</strong>Notes you haven’t edited in 30 days will appear here.</div>}</section>
      <section className="view-section"><h2>Study reviews due</h2>{dueReviews.length ? dueReviews.map(({ note, dueAt }) => <div className="view-row" key={note.id}><CalendarDays size={17} /><div className="view-row-main"><button className="text-button view-row-title" onClick={() => onOpenNote(note.id)}>{note.title || 'Untitled note'}</button><span className="view-row-description">Due {formatDay(dueAt)}</span></div><button className="button" disabled={note.role === 'viewer'} onClick={() => onReviewed(note.id)}>Reviewed · +7 days</button></div>) : <div className="empty-view">No reviews due. Add <code>@review(YYYY-MM-DD)</code> to a note, or start with the Study template.</div>}</section>
      <section className="view-section"><h2>Previous meetings</h2>{meetings.length ? meetings.map(({ note, reason }) => <button className="view-row row-button" key={note.id} onClick={() => onOpenNote(note.id)}><CalendarDays size={17} /><span className="view-row-main"><span className="view-row-title">{note.title || 'Untitled note'}</span><span className="view-row-description">{reason}</span></span><ChevronRight size={16} /></button>) : <div className="empty-view">Meeting notes appear here after a week when you add a <code>meeting</code> tag.</div>}</section>
    </div></main>;
  }
  if (view.kind === 'templates') {
    return <main className="workspace-view"><div className="workspace-view-inner"><ViewHeading title="Templates" description="A useful place to start, ready to make your own." onOpenSidebar={onOpenSidebar} />
      {feedback?.error && <p className="dialog-error" role="alert">{feedback.text}</p>}
      <section className="view-section"><div className="section-heading-row"><h2>Recurring notes</h2><button className="text-button" onClick={() => setScheduleOpen((open) => !open)}>{scheduleOpen ? 'Cancel' : 'New recurring note'}</button></div>
        {scheduleOpen && <form className="schedule-form" onSubmit={(event) => { event.preventDefault(); void run(async () => { if (!scheduleTitle.trim()) throw new Error('Give the recurring note a title.'); const body = setRecurringSchedule('', scheduleInterval, scheduleDate); await onCreate({ title: scheduleTitle.trim(), body, tags: ['recurring'] }); }, ''); }}>
          <label>Title<input className="field" value={scheduleTitle} maxLength={300} onChange={(event) => setScheduleTitle(event.target.value)} placeholder="e.g. Weekly planning · {{date}}" required /></label>
          <label>Repeat<select className="field" value={scheduleInterval} onChange={(event) => setScheduleInterval(event.target.value as typeof scheduleInterval)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
          <label>First date<input className="field" type="date" value={scheduleDate} onChange={(event) => setScheduleDate(event.target.value)} required /></label>
          <p>Create an editable source note, then use “Create next” when you’re ready. Add <code>{'{{date}}'}</code> to insert the scheduled date.</p><button className="button primary" disabled={working}>Create source note</button>
        </form>}
        {schedules.length ? schedules.map(({ note, interval, dueAt }) => { const auto = isRecurringAutomationEnabled(note); return <div className="view-row routine-row" key={note.id}><div className="view-row-main"><button className="text-button view-row-title" onClick={() => onOpenNote(note.id)}>{note.title || 'Untitled note'}</button><span className="view-row-description">{interval[0].toUpperCase() + interval.slice(1)} · next {formatDay(dueAt)}</span></div><div className="routine-actions"><button className="automation-toggle" type="button" role="switch" aria-checked={auto} disabled={working || note.role === 'viewer'} onClick={() => { void run(() => onSetAutomation(note, !auto), ''); }}><span className="toggle-track"><span /></span>Auto while open</button><button className="button" disabled={working || note.role === 'viewer'} onClick={() => { void run(() => onCreateRecurring(note), ''); }}>Create next</button></div></div>; }) : !scheduleOpen && <div className="empty-view">Create a recurring source note, or add a schedule to an existing note.</div>}
        <p className="view-footnote">Auto creates one due copy while Jot is open, then advances to the next future date. It does not run when Jot is closed; missed copies aren’t backfilled.</p>
      </section>
      <section className="view-section"><h2>Start from a template</h2>{NOTE_TEMPLATES.map((template) => <div className="view-row" key={template.id}><div className="template-icon"><FileText size={16} /></div><div className="view-row-main"><span className="view-row-title">{template.name}</span><span className="view-row-description">{template.description}</span></div><button className="button" disabled={working} onClick={() => { void run(() => onCreate(createFromTemplate(template)), ''); }}>Use template</button></div>)}</section>
    </div></main>;
  }
  if (view.kind === 'trash') {
    return <main className="workspace-view"><div className="workspace-view-inner"><ViewHeading title="Trash" description="Notes you’ve removed are kept here until you restore them." onOpenSidebar={onOpenSidebar} />
      <section className="view-section">{feedback?.error && <p className="dialog-error" role="alert">{feedback.text}</p>}{deletedNotes.length ? deletedNotes.map((note) => <div className="view-row" key={note.id}><FileText size={17} /><div className="view-row-main"><span className="view-row-title">{note.title || 'Untitled note'}</span><span className="view-row-description">Removed {note.deletedAt ? new Date(note.deletedAt).toLocaleDateString() : ''}</span></div><button className="button" disabled={note.role !== 'owner' || working} onClick={() => { void run(() => onRestore(note), ''); }}><RotateCcw size={14} /> Restore</button></div>) : <div className="empty-view"><strong>Trash is empty.</strong>Removed notes will be kept here.</div>}</section>
    </div></main>;
  }
  return <main className="workspace-view"><div className="workspace-view-inner"><ViewHeading title="Settings" description="Make Jot feel like yours, and keep a copy of what matters." onOpenSidebar={onOpenSidebar} />
    <section className="view-section"><h2>Appearance</h2><div className="view-row"><div className="view-row-main"><span className="view-row-title">Theme</span><span className="view-row-description">Choose how your workspace looks.</span></div><div className="theme-options" role="group" aria-label="Theme">{(['system', 'light', 'dark'] as const).map((item) => <button key={item} className={`theme-option ${theme === item ? 'active' : ''}`} aria-pressed={theme === item} onClick={() => onTheme(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div></div></section>
    <section className="view-section"><h2>Account &amp; privacy</h2><div className="view-row"><div className="view-row-main"><span className="view-row-title">Account and sync</span><span className="view-row-description">Use Jot locally, or sign in to a self-hosted account.</span></div><button className="button" onClick={onAccount}>Manage account</button></div>
      <div className="settings-copy">Notes are stored in this browser. Clearing site data can remove them, so keep a backup. Attachments are stored locally; sync availability depends on the server.</div>
    </section>
    <section className="view-section"><h2>Back up your work</h2><div className="settings-copy">The JSON backup includes notes, notebooks, and local attachments, up to 150 MiB encoded. Comments, shares, and account settings require a server database backup. An optional password protects this file only—not browser storage or account sync. Save it safely; it cannot be recovered.</div>
      <label className="settings-label" htmlFor="backup-password">Backup password <span>optional</span></label><div className="settings-action-line"><input id="backup-password" className="field" type="password" autoComplete="new-password" placeholder="Leave blank for an unencrypted backup" value={password} onChange={(event) => setPassword(event.target.value)} /><button className="button" disabled={working} onClick={() => { void run(async () => download(await onExport(password || undefined), `jot-backup-${new Date().toISOString().slice(0, 10)}.json`), password ? 'Encrypted backup downloaded.' : 'Unencrypted backup downloaded.'); }}><ArrowDownToLine size={14} /> Export backup</button></div>
      <div className="view-row"><div className="view-row-main"><span className="view-row-title">Export Markdown</span><span className="view-row-description">Download notes and attachments as a portable ZIP; server comments and shares are not included.</span></div><button className="button" disabled={working} onClick={() => { void run(async () => download(await onExportMarkdown(), `jot-markdown-${new Date().toISOString().slice(0, 10)}.zip`), 'Markdown export downloaded.'); }}>Export ZIP</button></div>
    </section>
    <section className="view-section"><h2>Restore a backup</h2><div className="settings-copy">Import merges notes as new copies; existing notes are not overwritten. {accountWorkspace ? 'Imported notes and files are queued to sync to this account when signed in and online.' : 'In the guest workspace, imports stay on this device.'}</div><div className="settings-import"><input ref={fileRef} className="field" type="file" accept=".json,application/json" aria-label="Choose a Jot backup" onChange={(event) => { setImportFile(event.target.files?.[0] || null); setConfirmAccountImport(false); }} /><input className="field" type="password" autoComplete="off" placeholder="Backup password, if encrypted" aria-label="Backup password, if encrypted" value={importPassword} onChange={(event) => setImportPassword(event.target.value)} /><button className="button" disabled={!importFile || working || (accountWorkspace && !confirmAccountImport)} onClick={() => { if (!importFile || (accountWorkspace && !confirmAccountImport)) return; void run(async () => { await onImport(importFile, importPassword || undefined); setImportFile(null); setImportPassword(''); setConfirmAccountImport(false); if (fileRef.current) fileRef.current.value = ''; }, 'Backup imported.'); }}><ArrowUpFromLine size={14} /> {accountWorkspace ? 'Import to account' : 'Import locally'}</button></div>{accountWorkspace && <label className="import-confirm"><input type="checkbox" checked={confirmAccountImport} onChange={(event) => setConfirmAccountImport(event.target.checked)} /> I understand these notes and files will be queued for account sync.</label>}</section>
    <AnimatePresence>{feedback && <motion.div initial={reducedMotion ? { opacity: 0 } : { opacity: 0, transform: 'translateY(5px)' }} animate={{ opacity: 1, transform: 'translateY(0)' }} exit={{ opacity: 0 }} transition={{ duration: .18, ease: [0.23, 1, 0.32, 1] }} className={`notice settings-feedback ${feedback.error ? 'danger' : ''}`} role="status">{!feedback.error && <Check size={15} />}{feedback.text}</motion.div>}</AnimatePresence>
  </div></main>;
}
