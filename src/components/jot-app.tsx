'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Plus, X } from 'lucide-react';
import { useJot } from '@/lib/use-jot';
import { useAutoRecurring } from '@/lib/use-auto-recurring';
import { setRecurringAutomation } from '@/lib/auto-recurring';
import type { NewNote, Note, Notebook } from '@/lib/types';
import { prepareNextRecurringNote, rescheduleReview, toggleTaskInBody } from '@/lib/features';
import { CollaborationProvider, useCollaboration, AccountDialog, ShareDialog, CommentsPanel } from '@/components/collaboration';
import { CapturePanel } from '@/components/features/capture-panel';
import { Sidebar, type View } from './sidebar';
import { NoteList } from './note-list';
import { NoteEditor } from './note-editor';
import { SearchDialog } from './search-dialog';
import { WorkspaceViews } from './workspace-views';
import { NotebookDialog, type NotebookDialogState } from './notebook-dialog';
import { useNoteDrafts } from './use-note-drafts';
import { useDialogFocus } from './use-dialog-focus';
import { createWorkspaceLease } from './workspace-lease';
import { createStableNoteMerger } from './note-derivations';
import { useTaskCount } from './use-task-count';

type Jot = ReturnType<typeof useJot>;
type Drafts = ReturnType<typeof useNoteDrafts>;

export function JotApp() {
  const jot = useJot();
  const drafts = useNoteDrafts(jot.notes, jot.updateNote);
  // The initial gate prevents editing before account reconciliation. The lease
  // synchronously blocks new edits before it awaits draft flushes or network work.
  const uiLocked = useRef(true);
  const workspaceGeneration = useRef(0);
  const activeNoteId = useRef<string | null>(null);
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const [transitioning, setTransitioning] = useState(true);
  const [transferring, setTransferring] = useState(false);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const leaseRef = useRef<ReturnType<typeof createWorkspaceLease> | null>(null);
  if (!leaseRef.current) leaseRef.current = createWorkspaceLease({
    flushDrafts: () => draftsRef.current.flushAll(),
    onChange: (state) => { uiLocked.current = state.locked; setTransitioning(state.transitioning); setTransferring(state.transferring); },
  });
  const lease = leaseRef.current;

  const beginWorkspaceTransition = useCallback(async (): Promise<() => void> => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const releaseLease = await lease.beginTransition();
    let released = false;
    return () => {
      if (released) return;
      released = true; releaseLease();
      requestAnimationFrame(() => { if (!lease.isLocked() && focused?.isConnected) focused.focus(); });
    };
  }, [lease]);
  const switchWorkspace = useCallback(async (userId: string | null) => {
    if (!lease.isTransitioning()) throw new Error('Workspace changes must hold the transition lock.');
    // No edit can enter between this flush and reset while the lease is held.
    await drafts.flushAll();
    await jot.switchWorkspace(userId);
    workspaceGeneration.current += 1;
    drafts.reset();
  }, [drafts.flushAll, drafts.reset, jot.switchWorkspace, lease]);
  const runOperation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => lease.runOperation(operation), [lease]);
  const runTransfer = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try { return await lease.runTransfer(operation); }
    finally { requestAnimationFrame(() => { if (!lease.isLocked() && focused?.isConnected) focused.focus(); }); }
  }, [lease]);

  const isNoteBusy = useCallback((id: string) => drafts.isBusy(id) || (activeNoteId.current === id && document.activeElement instanceof Element && !!document.activeElement.closest('.editor')), [drafts.isBusy]);
  useAutoRecurring({ workspaceId: jot.workspaceId, isLoading: jot.isLoading, locked: transitioning || transferring,
    isNoteBusy, runOperation, onError: setAutomationError });

  return <CollaborationProvider workspace={{
    workspaceId: jot.workspaceId, getCurrentWorkspaceId: jot.getCurrentWorkspaceId, switchWorkspace, beginWorkspaceTransition,
    copyGuestNotesToAccount: (userId) => runOperation(() => jot.copyGuestNotesToAccount(userId)),
    syncNow: jot.syncNow, syncStatus: jot.syncStatus, listConflicts: jot.listConflicts,
    resolveConflict: (id, choice, revision, version) => runOperation(async () => { await drafts.flushAll(); await jot.resolveConflict(id, choice, revision, version); }),
  }}><JotWorkspace jot={jot} drafts={drafts} uiLocked={uiLocked} workspaceGeneration={workspaceGeneration} activeNoteId={activeNoteId} locked={transitioning || transferring} transferring={transferring} runOperation={runOperation} runTransfer={runTransfer} automationError={automationError} clearAutomationError={() => setAutomationError(null)} /></CollaborationProvider>;
}

function JotWorkspace({ jot, drafts, uiLocked, workspaceGeneration, activeNoteId, locked, transferring, runOperation, runTransfer, automationError, clearAutomationError }: {
  jot: Jot; drafts: Drafts; uiLocked: React.RefObject<boolean>; workspaceGeneration: React.RefObject<number>; activeNoteId: React.RefObject<string | null>;
  locked: boolean; transferring: boolean; automationError: string | null; clearAutomationError: () => void;
  runOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  runTransfer: <T>(operation: () => Promise<T>) => Promise<T>;
}) {
  const account = useCollaboration();
  const accountAttention = account.pendingSession ? 'Account change needs review' : account.sessionStatus === 'error' ? 'Account sync needs attention' : null;
  const [view, setView] = useState<View>({ kind: 'all' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  activeNoteId.current = selectedId;
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
  const [allowedRemoteImages, setAllowedRemoteImages] = useState<Set<string>>(() => new Set());
  const [editorBusy, setEditorBusy] = useState(false);
  const editorActionLock = useRef(false);
  const captureProgress = useRef<{ noteId: string; files: Map<File, string> } | null>(null);
  const captureReturnFocus = useRef<HTMLElement | null>(null);
  const creating = useRef(false);
  const previousWorkspace = useRef(jot.workspaceId);
  const mergeRef = useRef<{ workspaceId: string | null; merge: ReturnType<typeof createStableNoteMerger> }>({ workspaceId: jot.workspaceId, merge: createStableNoteMerger() });
  if (mergeRef.current.workspaceId !== jot.workspaceId) mergeRef.current = { workspaceId: jot.workspaceId, merge: createStableNoteMerger() };
  const mergeNotes = mergeRef.current.merge;
  const generationAtRender = workspaceGeneration.current;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('jot:theme');
      if (saved === 'system' || saved === 'dark' || saved === 'light') setTheme(saved);
    } catch { /* Theme persistence is optional when storage is unavailable. */ }
    setThemeReady(true);
    setOnline(navigator.onLine);
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    if (!themeReady) return;
    try { window.localStorage.setItem('jot:theme', theme); } catch { /* Keep the selected theme for this session. */ }
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'light' : 'dark') : theme; };
    apply(); media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme, themeReady]);
  useEffect(() => {
    if (previousWorkspace.current === jot.workspaceId) return;
    previousWorkspace.current = jot.workspaceId;
    setSelectedId(null); setView({ kind: 'all' }); setMobileNoteOpen(false); setSearchOpen(false); setCommentsOpen(false); setShareTarget(null); setAllowedRemoteImages(new Set());
  }, [jot.workspaceId]);

  useEffect(() => { if (locked) setSearchOpen(false); }, [locked]);

  const effectiveNotes = useMemo(() => mergeNotes(jot.notes, drafts.entries), [jot.notes, drafts.entries, mergeNotes]);
  const taskCount = useTaskCount(effectiveNotes, jot.workspaceId);
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

  const counts = useMemo(() => {
    let inbox = 0, starred = 0;
    const notebookCounts: Record<string, number> = {};
    for (const note of effectiveNotes) {
      if (note.notebookId) notebookCounts[note.notebookId] = (notebookCounts[note.notebookId] || 0) + 1;
      else inbox += 1;
      if (note.pinned) starred += 1;
    }
    return { all: effectiveNotes.length, inbox, starred, tasks: taskCount ?? 0, notebooks: notebookCounts };
  }, [effectiveNotes, taskCount]);
  const selected = effectiveNotes.find((note) => note.id === selectedId) || null;
  const persistedSelected = jot.notes.find((note) => note.id === selectedId) || null;
  const selectedEntry = selectedId ? drafts.entries[selectedId] : undefined;
  const recoveryAvailable = !!jot.workspaceId && persistedSelected?.role === 'viewer' && (persistedSelected.syncState === 'local' || (!!selectedEntry && selectedEntry.status !== 'saved'));
  const selectedDraft = selected ? drafts.get(selected) : null;
  const listTitle = view.kind === 'inbox' ? 'Inbox' : view.kind === 'starred' ? 'Pinned' : view.kind === 'notebook' ? (jot.notebooks.find((notebook) => notebook.id === view.id)?.name || 'Notebook') : 'All notes';

  const openNote = useCallback((id: string) => {
    setView({ kind: 'all' }); setSelectedId(id); setMobileNoteOpen(true); setSidebarOpen(false);
  }, []);
  const createNote = useCallback(async (input: NewNote = {}) => runOperation(async () => {
    const note = await jot.createNote(input);
    await jot.refresh();
    setView({ kind: 'all' }); setSelectedId(note.id); setMobileNoteOpen(true); setSidebarOpen(false);
  }), [jot.createNote, jot.refresh, runOperation]);
  const newNote = useCallback(() => {
    if (creating.current) return;
    creating.current = true;
    const notebookId = view.kind === 'notebook' ? view.id || null : null;
    void createNote({ notebookId }).catch((error) => setNotice(error instanceof Error ? error.message : 'Could not create a note.')).finally(() => { creating.current = false; });
  }, [createNote, view]);
  const selectNote = useCallback((id: string) => { setSelectedId(id); setMobileNoteOpen(true); }, []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const closeNotebookDialog = useCallback(() => setNotebookDialog(null), []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (uiLocked.current) { if ((event.metaKey || event.ctrlKey) && ['k', 'n'].includes(event.key.toLowerCase())) event.preventDefault(); return; }
      if (event.key === 'Escape') setSidebarOpen(false);
      if (captureOpen || notebookDialog || accountOpen || commentsOpen || shareTarget || searchOpen) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); newNote(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [newNote, captureOpen, notebookDialog, accountOpen, commentsOpen, shareTarget, searchOpen]);

  const capture = async (input: NewNote, files: File[]) => runOperation(async () => {
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
  });
  const trashSelected = async () => {
    if (!selected || editorActionLock.current) return;
    editorActionLock.current = true; setEditorBusy(true);
    try {
      await runOperation(async () => {
        const saved = drafts.entries[selected.id] ? await drafts.save(selected.id) : selected;
        if (!saved) throw new Error('Resolve the unsaved changes before moving this note to trash.');
        await jot.trashNote(saved.id, saved.revision); await jot.refresh();
        setSelectedId(null); setMobileNoteOpen(false);
      });
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not move this note to trash.'); }
    finally { editorActionLock.current = false; setEditorBusy(false); }
  };
  const toggleTask = (noteId: string, lineIndex: number) => {
    const note = effectiveNotes.find((item) => item.id === noteId);
    if (!note || note.role === 'viewer' || uiLocked.current) return;
    const current = drafts.get(note).note;
    const body = toggleTaskInBody(current.body, lineIndex);
    if (body !== current.body) drafts.change(current, { body });
  };
  const reviewed = (noteId: string) => {
    const note = effectiveNotes.find((item) => item.id === noteId);
    if (!note || note.role === 'viewer' || uiLocked.current) return;
    const next = new Date(); next.setDate(next.getDate() + 7);
    const date = [next.getFullYear(), String(next.getMonth() + 1).padStart(2, '0'), String(next.getDate()).padStart(2, '0')].join('-');
    const current = drafts.get(note).note;
    const body = rescheduleReview(current.body, date);
    if (body !== current.body) drafts.change(current, { body });
  };
  const setAutomation = async (source: Note, enabled: boolean) => runOperation(async () => {
    const current = drafts.get(source).note;
    if (source.role === 'viewer') throw new Error('You need edit access to change this routine.');
    drafts.change(current, { body: setRecurringAutomation(current.body, enabled) });
    const saved = await drafts.save(current.id);
    if (!saved) throw new Error('The routine change is still in your draft. Resolve its save issue before continuing.');
  });
  const createRecurring = async (source: Note) => runOperation(async () => {
    const saved = drafts.entries[source.id] ? await drafts.save(source.id) : source;
    if (!saved) throw new Error('Resolve the source note’s unsaved changes first.');
    const occurrence = prepareNextRecurringNote(saved);
    if (!occurrence) throw new Error('This note no longer has a valid recurring schedule.');
    const created = await jot.createRecurringOccurrence(saved.id, saved.revision, occurrence.nextSourceBody, occurrence.newInput, occurrence.occurrenceKey);
    await jot.refresh();
    setView({ kind: 'all' }); setSelectedId(created.id); setMobileNoteOpen(true);
  });
  const copyUnavailable = async () => runOperation(async () => {
    if (!persistedSelected || !recoveryAvailable) throw new Error('This note no longer needs recovery.');
    const id = persistedSelected.id;
    try {
      // Pause the forbidden original write; do not require it to save before copying.
      const reviewed = await drafts.prepareRecovery(persistedSelected);
      const source = await jot.getNote(id);
      if (!source || source.role !== 'viewer') throw new Error('The note changed. Refresh and review it before copying.');
      const visible = reviewed.note;
      const copy = await jot.copyUnavailableNoteToInbox(source.id, source.revision, { title: visible.title, body: visible.body, tags: visible.tags, pinned: visible.pinned });
      const accepted = drafts.finishRecovery(source, reviewed.sequence);
      await jot.refresh();
      if (!accepted) throw new Error('A copy was created, but newer edits remain in this draft. Review them and make another copy if needed.');
      jot.clearError();
      setView({ kind: 'all' }); setSelectedId(copy.id); setMobileNoteOpen(true);
    } finally { drafts.cancelRecovery(id); }
  });
  const closeCapture = () => {
    if (captureProgress.current) {
      setView({ kind: 'all' }); setSelectedId(captureProgress.current.noteId); setMobileNoteOpen(true);
      setNotice('The note was created, but capture did not finish. Check its attachments before retrying.');
    }
    setCaptureOpen(false); captureProgress.current = null;
  };
  const handleNotebook = async (value: string) => runOperation(async () => {
    if (!notebookDialog) return;
    if (notebookDialog.mode === 'create') await jot.createNotebook(value);
    else if (notebookDialog.mode === 'rename') await jot.renameNotebook(notebookDialog.notebook.id, value);
    else {
      await drafts.flushAll();
      await jot.deleteNotebook(notebookDialog.notebook.id);
      if (view.kind === 'notebook' && view.id === notebookDialog.notebook.id) setView({ kind: 'all' });
    }
    await jot.refresh();
  });

  return <><div className={`jot-app ${mobileNoteOpen ? 'has-mobile-note' : ''}`} inert={locked ? true : undefined} aria-busy={locked}>
    <Sidebar view={view} notebooks={jot.notebooks} counts={counts} online={online} accountAttention={accountAttention} open={sidebarOpen} onClose={() => setSidebarOpen(false)} onNavigate={(next) => { setView(next); setMobileNoteOpen(false); }} onNew={newNote} onCapture={() => { captureProgress.current = null; captureReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setCaptureOpen(true); setSidebarOpen(false); }} onSearch={() => { setSearchOpen(true); setSidebarOpen(false); }} onCreateNotebook={() => setNotebookDialog({ mode: 'create' })} onRenameNotebook={(notebook) => setNotebookDialog({ mode: 'rename', notebook })} onShareNotebook={(notebook) => setShareTarget({ noteId: null, notebookId: notebook.id })} onDeleteNotebook={(notebook) => setNotebookDialog({ mode: 'delete', notebook })} onAccount={() => setAccountOpen(true)} />
    {listView ? <>
      <NoteList title={listTitle} viewKey={`${view.kind}:${view.id || ''}`} notes={filteredNotes} notebooks={jot.notebooks} selectedId={selectedId} onSelect={selectNote} onNew={newNote} onSearch={() => setSearchOpen(true)} onOpenSidebar={() => setSidebarOpen(true)} />
      {selectedDraft ? <NoteEditor draft={selectedDraft} busy={editorBusy} forceReadOnly={persistedSelected?.role === 'viewer'} recoveryAvailable={recoveryAvailable} recoveryUnavailable={persistedSelected?.syncState === 'local'} onCopyUnavailable={copyUnavailable} notes={effectiveNotes} notebooks={jot.notebooks} onChange={(patch) => { if (!editorActionLock.current && !uiLocked.current && persistedSelected?.role !== 'viewer') drafts.change(selectedDraft.note, patch); }} onOpenNote={openNote} onBack={() => setMobileNoteOpen(false)} onOpenSidebar={() => setSidebarOpen(true)} onTrash={() => { void trashSelected(); }} onShare={() => { void runOperation(async () => { const saved = drafts.entries[selectedDraft.note.id] ? await drafts.save(selectedDraft.note.id) : selectedDraft.note; if (!saved) throw new Error('Resolve the unsaved changes before sharing this note.'); setShareTarget({ noteId: saved.id, notebookId: saved.notebookId }); }).catch((error) => setNotice(error instanceof Error ? error.message : 'Could not prepare this note for sharing.')); }} onComments={() => setCommentsOpen(true)} onKeepMine={() => { if (!uiLocked.current) void drafts.keepMine(selectedDraft.note.id); }} onUseLatest={() => { if (!uiLocked.current) drafts.useLatest(selectedDraft.note.id); }} onRetry={() => { if (!uiLocked.current) void drafts.retry(selectedDraft.note.id); }} listAttachments={jot.listAttachments} addAttachment={(noteId, file, name) => runOperation(() => { if (workspaceGeneration.current !== generationAtRender) throw new Error('The workspace changed. Please reopen the note.'); return jot.addAttachment(noteId, file, name); })} deleteAttachment={(id) => runOperation(() => { if (workspaceGeneration.current !== generationAtRender) throw new Error('The workspace changed. Please reopen the note.'); return jot.deleteAttachment(id); })} allowedRemoteImages={allowedRemoteImages} onAllowRemoteImage={(key) => setAllowedRemoteImages((current) => new Set(current).add(key))} onAppendText={async (text) => runOperation(async () => {
        if (workspaceGeneration.current !== generationAtRender) throw new Error('The workspace changed before extraction finished. Please try again.');
        const current = drafts.get(selectedDraft.note).note;
        if (current.body.length + text.length > 1_000_000) throw new Error('This note would exceed the 1,000,000-character limit. Keep the attachment or shorten the note before extracting text.');
        drafts.change(current, { body: current.body + text });
        const saved = await drafts.save(current.id);
        return { saved: !!saved };
      })} /> : <main className="editor"><div className="empty-editor"><div><div className="empty-editor-icon"><FileText size={19} /></div><h2>{jot.isLoading ? 'Opening your notes…' : 'A little space to think.'}</h2><p>{jot.isLoading ? 'Your workspace is being prepared.' : 'Choose a note from the list, or start with a blank page.'}</p>{!jot.isLoading && <button className="button" style={{ marginTop: 18 }} onClick={newNote}><Plus size={14} /> New note</button>}</div></div></main>}
    </> : <WorkspaceViews view={view} notes={effectiveNotes} deletedNotes={deletedNotes} theme={theme} workspaceId={jot.workspaceId} onTheme={setTheme} onOpenSidebar={() => setSidebarOpen(true)} onOpenNote={openNote} onToggleTask={toggleTask} onReviewed={reviewed} onCreateRecurring={createRecurring} onSetAutomation={setAutomation} onCreate={createNote} onRestore={(note) => runOperation(async () => { await jot.restoreNote(note.id, note.revision); await jot.refresh(); setDeletedNotes((items) => items.filter((item) => item.id !== note.id)); })} onExport={(password) => runTransfer(() => jot.exportBackup(password))} onExportMarkdown={() => runTransfer(() => jot.exportMarkdownZip())} onImport={(file, password) => runTransfer(async () => { await jot.importBackup(file, password); await jot.refresh(); })} onAccount={() => setAccountOpen(true)} />}
    {accountAttention && <div className={`account-attention-mobile ${notice || jot.error || automationError ? 'has-app-notice' : ''}`} role="status"><span>{accountAttention}</span><button className="text-button" onClick={() => setAccountOpen(true)}>Review</button></div>}
    {(notice || jot.error || automationError) && <div className="app-notice" role="alert"><span>{notice || jot.error || automationError}</span><button className="icon-button" onClick={() => { setNotice(null); jot.clearError(); clearAutomationError(); }} aria-label="Dismiss"><X size={15} /></button></div>}
    {searchOpen && <SearchDialog workspaceId={jot.workspaceId} notes={effectiveNotes} onClose={closeSearch} onOpenNote={openNote} />}
    {captureOpen && <CaptureOverlay returnFocus={captureReturnFocus.current}><CapturePanel onClose={closeCapture} onCreate={capture} /></CaptureOverlay>}
    {notebookDialog && <NotebookDialog key={notebookDialog.mode === 'create' ? 'create' : `${notebookDialog.mode}:${notebookDialog.notebook.id}`} state={notebookDialog} onClose={closeNotebookDialog} onSubmit={handleNotebook} />}
    <AccountDialog open={accountOpen} onClose={() => setAccountOpen(false)} />
    <ShareDialog open={!!shareTarget} onClose={() => setShareTarget(null)} note={effectiveNotes.find((note) => note.id === shareTarget?.noteId) || null} notebook={jot.notebooks.find((notebook) => notebook.id === shareTarget?.notebookId) || null} />
    <CommentsPanel open={commentsOpen} onClose={() => setCommentsOpen(false)} note={selectedDraft?.note || null} />
  </div>{locked && <div className="workspace-transition" role="status" aria-live="polite"><span className="transition-spinner" />{transferring ? 'Preparing your backup…' : 'Opening workspace…'}</div>}</>;
}

function CaptureOverlay({ children, returnFocus }: { children: React.ReactNode; returnFocus: HTMLElement | null }) {
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, { returnFocus });
  return <div className="panel-overlay capture-overlay"><div ref={dialog} className="dialog capture-dialog" role="dialog" aria-modal="true" aria-label="Quick capture">{children}</div></div>;
}
