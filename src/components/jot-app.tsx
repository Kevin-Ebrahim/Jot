'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Plus, X } from 'lucide-react';
import { useJot } from '@/lib/use-jot';
import type { NewNote, Note, Notebook } from '@/lib/types';
import { extractTasks, rescheduleReview, toggleTaskInBody } from '@/lib/features';
import { CollaborationProvider, AccountDialog, ShareDialog, CommentsPanel } from '@/components/collaboration';
import { CapturePanel } from '@/components/features/capture-panel';
import { Sidebar, type View } from './sidebar';
import { NoteList } from './note-list';
import { NoteEditor } from './note-editor';
import { SearchDialog } from './search-dialog';
import { WorkspaceViews } from './workspace-views';
import { NotebookDialog, type NotebookDialogState } from './notebook-dialog';
import { useNoteDrafts } from './use-note-drafts';

type Jot = ReturnType<typeof useJot>;
type Drafts = ReturnType<typeof useNoteDrafts>;

export function JotApp() {
  const jot = useJot();
  const drafts = useNoteDrafts(jot.notes, jot.updateNote);
  const switchWorkspace = useCallback(async (userId: string | null) => {
    await drafts.flushAll();
    await jot.switchWorkspace(userId);
    drafts.reset();
  }, [drafts.flushAll, drafts.reset, jot.switchWorkspace]);
  return <CollaborationProvider workspace={{
    workspaceId: jot.workspaceId, switchWorkspace, copyGuestNotesToAccount: jot.copyGuestNotesToAccount,
    syncNow: jot.syncNow, syncStatus: jot.syncStatus, listConflicts: jot.listConflicts, resolveConflict: jot.resolveConflict,
  }}><JotWorkspace jot={jot} drafts={drafts} /></CollaborationProvider>;
}

function JotWorkspace({ jot, drafts }: { jot: Jot; drafts: Drafts }) {
  const [view, setView] = useState<View>({ kind: 'all' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileNoteOpen, setMobileNoteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [shareTarget, setShareTarget] = useState<{ noteId: string | null; notebookId: string | null } | null>(null);
  const [notebookDialog, setNotebookDialog] = useState<NotebookDialogState | null>(null);
  const [deletedNotes, setDeletedNotes] = useState<Note[]>([]);
  const [online, setOnline] = useState(true);
  const [theme, setTheme] = useState<'system' | 'dark' | 'light'>('dark');
  const [themeReady, setThemeReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const captureProgress = useRef<{ noteId: string; files: Map<File, string> } | null>(null);
  const previousWorkspace = useRef(jot.workspaceId);

  useEffect(() => {
    const saved = window.localStorage.getItem('jot:theme');
    if (saved === 'system' || saved === 'dark' || saved === 'light') setTheme(saved);
    setThemeReady(true);
    setOnline(navigator.onLine);
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    if (!themeReady) return;
    window.localStorage.setItem('jot:theme', theme);
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'light' : 'dark') : theme; };
    apply(); media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme, themeReady]);
  useEffect(() => {
    if (previousWorkspace.current === jot.workspaceId) return;
    previousWorkspace.current = jot.workspaceId;
    setSelectedId(null); setView({ kind: 'all' }); setMobileNoteOpen(false); setCommentsOpen(false); setShareTarget(null);
  }, [jot.workspaceId]);

  const effectiveNotes = useMemo(() => jot.notes.map((note) => drafts.entries[note.id]?.note || note), [jot.notes, drafts.entries]);
  const listView = view.kind === 'all' || view.kind === 'inbox' || view.kind === 'starred' || view.kind === 'notebook';
  const filteredNotes = useMemo(() => effectiveNotes.filter((note) => {
    if (view.kind === 'inbox') return !note.notebookId;
    if (view.kind === 'starred') return note.pinned;
    if (view.kind === 'notebook') return note.notebookId === view.id;
    return true;
  }), [effectiveNotes, view]);
  useEffect(() => {
    if (!listView || jot.isLoading) return;
    if (!selectedId || !filteredNotes.some((note) => note.id === selectedId)) {
      const first = [...filteredNotes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
      setSelectedId(first?.id || null);
    }
  }, [listView, jot.isLoading, filteredNotes, selectedId]);
  useEffect(() => {
    if (view.kind !== 'trash') return;
    let active = true;
    void jot.listNotes({ includeDeleted: true }).then((all) => { if (active) setDeletedNotes(all.filter((note) => !!note.deletedAt)); }).catch((error) => { if (active) setNotice(error instanceof Error ? error.message : 'Could not load trash.'); });
    return () => { active = false; };
  }, [view.kind, jot.notes, jot.listNotes]);

  const counts = useMemo(() => ({
    all: effectiveNotes.length,
    inbox: effectiveNotes.filter((note) => !note.notebookId).length,
    starred: effectiveNotes.filter((note) => note.pinned).length,
    tasks: extractTasks(effectiveNotes).filter((task) => !task.done).length,
    notebooks: Object.fromEntries(jot.notebooks.map((notebook) => [notebook.id, effectiveNotes.filter((note) => note.notebookId === notebook.id).length])),
  }), [effectiveNotes, jot.notebooks]);
  const selected = effectiveNotes.find((note) => note.id === selectedId) || null;
  const selectedDraft = selected ? drafts.get(selected) : null;
  const listTitle = view.kind === 'inbox' ? 'Inbox' : view.kind === 'starred' ? 'Pinned' : view.kind === 'notebook' ? (jot.notebooks.find((notebook) => notebook.id === view.id)?.name || 'Notebook') : 'All notes';

  const openNote = useCallback((id: string) => {
    setView({ kind: 'all' }); setSelectedId(id); setMobileNoteOpen(true); setSidebarOpen(false);
  }, []);
  const createNote = useCallback(async (input: NewNote = {}) => {
    const note = await jot.createNote(input);
    await jot.refresh();
    setView({ kind: 'all' }); setSelectedId(note.id); setMobileNoteOpen(true); setSidebarOpen(false);
  }, [jot.createNote, jot.refresh]);
  const newNote = useCallback(() => {
    const notebookId = view.kind === 'notebook' ? view.id || null : null;
    void createNote({ notebookId }).catch((error) => setNotice(error instanceof Error ? error.message : 'Could not create a note.'));
  }, [createNote, view]);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const closeNotebookDialog = useCallback(() => setNotebookDialog(null), []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); newNote(); }
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [newNote]);

  const capture = async (input: NewNote, files: File[]) => {
    // Keep progress if an attachment fails, so retrying cannot create duplicate notes.
    if (!captureProgress.current) {
      const created = await jot.createNote(input);
      captureProgress.current = { noteId: created.id, files: new Map() };
    } else {
      const existing = await jot.getNote(captureProgress.current.noteId);
      if (!existing) throw new Error('The captured note is no longer available. Close capture and try again.');
      await jot.updateNote(existing.id, input, existing.revision);
    }
    const progress = captureProgress.current;
    for (const [file, attachmentId] of progress.files) {
      if (!files.includes(file)) {
        await jot.deleteAttachment(attachmentId);
        progress.files.delete(file);
      }
    }
    for (const file of files) {
      if (progress.files.has(file)) continue;
      const attachment = await jot.addAttachment(progress.noteId, file, file.name);
      progress.files.set(file, attachment.id);
    }
    await jot.refresh();
    setView({ kind: 'all' }); setSelectedId(progress.noteId); setMobileNoteOpen(true);
    captureProgress.current = null;
  };
  const trashSelected = async () => {
    if (!selected) return;
    try {
      const saved = await drafts.save(selected.id);
      if (!saved) { setNotice('Resolve the unsaved changes before moving this note to trash.'); return; }
      await jot.trashNote(saved.id, saved.revision); await jot.refresh();
      setSelectedId(null); setMobileNoteOpen(false);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not move this note to trash.'); }
  };
  const toggleTask = (noteId: string, lineIndex: number) => {
    const note = effectiveNotes.find((item) => item.id === noteId);
    if (!note || note.role === 'viewer') return;
    const body = toggleTaskInBody(note.body, lineIndex);
    if (body !== note.body) drafts.change(note, { body });
  };
  const reviewed = (noteId: string) => {
    const note = effectiveNotes.find((item) => item.id === noteId);
    if (!note || note.role === 'viewer') return;
    const next = new Date(); next.setDate(next.getDate() + 7);
    const date = [next.getFullYear(), String(next.getMonth() + 1).padStart(2, '0'), String(next.getDate()).padStart(2, '0')].join('-');
    const body = rescheduleReview(note.body, date);
    if (body !== note.body) drafts.change(note, { body });
  };
  const closeCapture = () => {
    if (captureProgress.current) {
      setView({ kind: 'all' }); setSelectedId(captureProgress.current.noteId); setMobileNoteOpen(true);
      setNotice('The note was created, but capture did not finish. Check its attachments before retrying.');
    }
    setCaptureOpen(false); captureProgress.current = null;
  };
  const handleNotebook = async (value: string) => {
    if (!notebookDialog) return;
    if (notebookDialog.mode === 'create') await jot.createNotebook(value);
    else if (notebookDialog.mode === 'rename') await jot.renameNotebook(notebookDialog.notebook.id, value);
    else {
      await jot.deleteNotebook(notebookDialog.notebook.id);
      if (view.kind === 'notebook' && view.id === notebookDialog.notebook.id) setView({ kind: 'all' });
    }
    await jot.refresh();
  };

  return <div className={`jot-app ${mobileNoteOpen ? 'has-mobile-note' : ''}`}>
    <Sidebar view={view} notebooks={jot.notebooks} counts={counts} online={online} open={sidebarOpen} onClose={() => setSidebarOpen(false)} onNavigate={(next) => { setView(next); setMobileNoteOpen(false); }} onNew={newNote} onCapture={() => { captureProgress.current = null; setCaptureOpen(true); setSidebarOpen(false); }} onSearch={() => { setSearchOpen(true); setSidebarOpen(false); }} onCreateNotebook={() => setNotebookDialog({ mode: 'create' })} onRenameNotebook={(notebook) => setNotebookDialog({ mode: 'rename', notebook })} onShareNotebook={(notebook) => setShareTarget({ noteId: null, notebookId: notebook.id })} onDeleteNotebook={(notebook) => setNotebookDialog({ mode: 'delete', notebook })} onAccount={() => setAccountOpen(true)} />
    {listView ? <>
      <NoteList title={listTitle} notes={filteredNotes} notebooks={jot.notebooks} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setMobileNoteOpen(true); }} onNew={newNote} onSearch={() => setSearchOpen(true)} onOpenSidebar={() => setSidebarOpen(true)} />
      {selectedDraft ? <NoteEditor draft={selectedDraft} notes={effectiveNotes} notebooks={jot.notebooks} onChange={(patch) => drafts.change(selectedDraft.note, patch)} onOpenNote={openNote} onBack={() => setMobileNoteOpen(false)} onOpenSidebar={() => setSidebarOpen(true)} onTrash={() => { void trashSelected(); }} onShare={() => { void (async () => { const saved = await drafts.save(selectedDraft.note.id); if (!saved) { setNotice('Resolve the unsaved changes before sharing this note.'); return; } setShareTarget({ noteId: saved.id, notebookId: saved.notebookId }); })(); }} onComments={() => setCommentsOpen(true)} onKeepMine={() => { void drafts.keepMine(selectedDraft.note.id); }} onUseLatest={() => drafts.useLatest(selectedDraft.note.id)} onRetry={() => { void drafts.retry(selectedDraft.note.id); }} listAttachments={jot.listAttachments} addAttachment={jot.addAttachment} deleteAttachment={jot.deleteAttachment} onAppendText={async (text) => {
        const current = drafts.get(selectedDraft.note).note;
        drafts.change(current, { body: current.body + text });
        const saved = await drafts.save(current.id);
        if (!saved) throw new Error('The extracted text is still in your draft. Resolve the save issue before continuing.');
      }} /> : <main className="editor"><div className="empty-editor"><div><div className="empty-editor-icon"><FileText size={19} /></div><h2>{jot.isLoading ? 'Opening your notes…' : 'A little space to think.'}</h2><p>{jot.isLoading ? 'Your workspace is being prepared.' : 'Choose a note from the list, or start with a blank page.'}</p>{!jot.isLoading && <button className="button" style={{ marginTop: 18 }} onClick={newNote}><Plus size={14} /> New note</button>}</div></div></main>}
    </> : <WorkspaceViews view={view} notes={effectiveNotes} deletedNotes={deletedNotes} theme={theme} onTheme={setTheme} onOpenSidebar={() => setSidebarOpen(true)} onOpenNote={openNote} onToggleTask={toggleTask} onReviewed={reviewed} onCreate={createNote} onRestore={async (note) => { await jot.restoreNote(note.id, note.revision); await jot.refresh(); setDeletedNotes((items) => items.filter((item) => item.id !== note.id)); }} onExport={jot.exportBackup} onExportMarkdown={jot.exportMarkdownZip} onImport={async (file, password) => { await jot.importBackup(file, password); await jot.refresh(); }} onAccount={() => setAccountOpen(true)} />}
    {(notice || jot.error) && <div className="app-notice" role="alert"><span>{notice || jot.error}</span><button className="icon-button" onClick={() => { setNotice(null); jot.clearError(); }} aria-label="Dismiss"><X size={15} /></button></div>}
    {searchOpen && <SearchDialog notes={effectiveNotes} onClose={closeSearch} onOpenNote={openNote} />}
    {captureOpen && <CaptureOverlay><CapturePanel onClose={closeCapture} onCreate={capture} /></CaptureOverlay>}
    {notebookDialog && <NotebookDialog key={notebookDialog.mode === 'create' ? 'create' : `${notebookDialog.mode}:${notebookDialog.notebook.id}`} state={notebookDialog} onClose={closeNotebookDialog} onSubmit={handleNotebook} />}
    <AccountDialog open={accountOpen} onClose={() => setAccountOpen(false)} />
    <ShareDialog open={!!shareTarget} onClose={() => setShareTarget(null)} note={effectiveNotes.find((note) => note.id === shareTarget?.noteId) || null} notebook={jot.notebooks.find((notebook) => notebook.id === shareTarget?.notebookId) || null} />
    <CommentsPanel open={commentsOpen} onClose={() => setCommentsOpen(false)} note={selectedDraft?.note || null} />
  </div>;
}

function CaptureOverlay({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => { previous?.focus(); };
  }, []);
  return <div className="panel-overlay capture-overlay"><div className="dialog capture-dialog" role="dialog" aria-modal="true" aria-label="Quick capture">{children}</div></div>;
}
