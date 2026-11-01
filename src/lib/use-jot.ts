'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getWorkspaceId, jotStore, subscribeStore } from './store';
import { listConflicts, resolveConflict, syncWorkspace } from './sync';
import type { NewNote, Note, Notebook, NotePatch, SyncResult, SyncStatus } from './types';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** One instance per shell; all mutations report persistence failures and keep the draft in the caller. */
export function useJot() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const mounted = useRef(false);
  const pending = useRef(0);

  const refresh = useCallback(async () => {
    const scope = getWorkspaceId();
    try {
      const [nextNotes, nextNotebooks] = await Promise.all([jotStore.listNotes(), jotStore.listNotebooks()]);
      if (mounted.current && scope === getWorkspaceId()) {
        setNotes(nextNotes); setNotebooks(nextNotebooks); setWorkspaceId(scope); setIsLoading(false);
      }
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error ? cause.message : 'Could not open local storage.'); setIsLoading(false); }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = subscribeStore(() => void refresh());
    if (process.env.NODE_ENV === 'production' && window.isSecureContext && 'serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js').catch(() => { /* app remains usable while online */ });
    }
    return () => { mounted.current = false; unsubscribe(); };
  }, [refresh]);

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    pending.current += 1;
    if (mounted.current) { setSaveState('saving'); setError(null); }
    try {
      const result = await operation();
      if (mounted.current && pending.current === 1) setSaveState('saved');
      return result;
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : 'Could not save your changes.');
        setSaveState('error');
      }
      throw cause;
    } finally { pending.current -= 1; }
  }, []);

  const createNote = useCallback((input?: NewNote) => run(() => jotStore.createNote(input)), [run]);
  const updateNote = useCallback((id: string, patch: NotePatch, expectedRevision: number) =>
    run(() => jotStore.updateNote(id, patch, expectedRevision)), [run]);
  const trashNote = useCallback((id: string, expectedRevision: number) => run(() => jotStore.trashNote(id, expectedRevision)), [run]);
  const restoreNote = useCallback((id: string, expectedRevision: number) => run(() => jotStore.restoreNote(id, expectedRevision)), [run]);
  const createNotebook = useCallback((name: string) => run(() => jotStore.createNotebook(name)), [run]);
  const renameNotebook = useCallback((id: string, name: string) => run(() => jotStore.renameNotebook(id, name)), [run]);
  const deleteNotebook = useCallback((id: string) => run(() => jotStore.deleteNotebook(id)), [run]);
  const addAttachment = useCallback((noteId: string, file: Blob, name: string) => run(() => jotStore.addAttachment(noteId, file, name)), [run]);
  const deleteAttachment = useCallback((id: string) => run(() => jotStore.deleteAttachment(id)), [run]);
  const importBackup = useCallback((file: Blob, password?: string) => run(() => jotStore.importBackup(file, password)), [run]);
  const switchWorkspace = useCallback(async (userId: string | null) => {
    await jotStore.switchWorkspace(userId); setWorkspaceId(userId); await refresh();
  }, [refresh]);
  const copyGuestNotesToAccount = useCallback((userId: string) => run(() => jotStore.copyGuestNotesToAccount(userId)), [run]);
  const syncNow = useCallback(async (): Promise<SyncResult> => {
    setSyncStatus('syncing');
    try {
      const result = await syncWorkspace();
      if (mounted.current) setSyncStatus(result.errors.length || result.conflicts ? 'error' : 'synced');
      return result;
    } catch (cause) {
      if (mounted.current) setSyncStatus('error');
      throw cause;
    }
  }, []);
  const resolve = useCallback((id: string, choice: 'local' | 'server' | 'both', expectedRevision: number) => run(() => resolveConflict(id, choice, expectedRevision)), [run]);

  return { notes, notebooks, isLoading, error, saveState, workspaceId, syncStatus, refresh,
    clearError: () => setError(null),
    listNotes: jotStore.listNotes, getNote: jotStore.getNote, listNotebooks: jotStore.listNotebooks,
    createNote, updateNote, trashNote, restoreNote, createNotebook, renameNotebook, deleteNotebook,
    listAttachments: jotStore.listAttachments, addAttachment, deleteAttachment,
    exportBackup: jotStore.exportBackup, importBackup, exportMarkdownZip: jotStore.exportMarkdownZip,
    switchWorkspace, copyGuestNotesToAccount, syncNow, listConflicts, resolveConflict: resolve };
}
