'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Note, NotePatch } from '@/lib/types';
import { canAcceptRecoveredDraft } from './draft-recovery';
import { createDraftSaveScheduler, scheduleDraftEdit } from './draft-save-scheduler';

type DraftStatus = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';
export interface NoteDraft {
  note: Note;
  baseRevision: number;
  status: DraftStatus;
  sequence: number;
  conflict?: Note;
  error?: string;
}

type UpdateNote = (id: string, patch: NotePatch, expectedRevision: number) => Promise<Note>;
const fields = (note: Note): NotePatch => ({
  title: note.title, body: note.body, tags: note.tags,
  notebookId: note.notebookId, pinned: note.pinned,
});

/**
 * Keeps a separate draft per note while writes are debounced and serialized.
 * CAS failures never replace the text the person is editing.
 */
export function useNoteDrafts(notes: Note[], updateNote: UpdateNote) {
  const [entries, setEntries] = useState<Record<string, NoteDraft>>({});
  const entriesRef = useRef(entries);
  const updateRef = useRef(updateNote);
  const running = useRef<Partial<Record<string, Promise<Note | undefined>>>>({});
  const recoveryPaused = useRef(new Set<string>());
  const saveRef = useRef<(id: string) => Promise<Note | undefined>>(async () => undefined);
  const schedulerRef = useRef<ReturnType<typeof createDraftSaveScheduler> | null>(null);
  if (!schedulerRef.current) schedulerRef.current = createDraftSaveScheduler((id) => { void saveRef.current(id); });
  const scheduler = schedulerRef.current;
  updateRef.current = updateNote;

  const writeEntry = useCallback((id: string, entry: NoteDraft) => {
    entriesRef.current = { ...entriesRef.current, [id]: entry };
    setEntries(entriesRef.current);
  }, []);

  const get = useCallback((note: Note): NoteDraft => entriesRef.current[note.id] ?? {
    note, baseRevision: note.revision, status: 'saved', sequence: 0,
  }, []);

  const save = useCallback(async (id: string): Promise<Note | undefined> => {
    scheduler.clear(id);
    if (recoveryPaused.current.has(id)) return undefined;
    if (running.current[id]) {
      await running.current[id];
      if (recoveryPaused.current.has(id)) return undefined;
      const latest = entriesRef.current[id];
      if (latest?.status === 'dirty') return saveRef.current(id);
      return latest?.status === 'saved' ? latest.note : undefined;
    }
    const entry = entriesRef.current[id];
    if (!entry) return undefined;
    if (entry.status === 'saved') return entry.note;
    if (entry.status === 'conflict' || entry.status === 'error') return undefined;
    const sequence = entry.sequence;
    writeEntry(id, { ...entry, status: 'saving', error: undefined });
    const request = (async () => {
      try {
        const saved = await updateRef.current(id, fields(entry.note), entry.baseRevision);
        const latest = entriesRef.current[id];
        if (!latest) return saved;
        if (latest.sequence === sequence) {
          writeEntry(id, { note: saved, baseRevision: saved.revision, status: 'saved', sequence });
          return saved;
        }
        // Retain edits made while the previous write was in flight.
        writeEntry(id, {
          ...latest, note: { ...saved, ...fields(latest.note) },
          baseRevision: saved.revision, status: 'dirty',
        });
        return saved;
      } catch (error) {
        const latest = entriesRef.current[id];
        if (!latest) return undefined;
        const current = typeof error === 'object' && error !== null && 'current' in error
          ? (error as { current?: Note }).current : undefined;
        if (current) writeEntry(id, { ...latest, status: 'conflict', conflict: current, error: undefined });
        else writeEntry(id, { ...latest, status: 'error', error: error instanceof Error ? error.message : 'Could not save this note.' });
        return undefined;
      }
    })();
    running.current[id] = request;
    const result = await request;
    delete running.current[id];
    if (!recoveryPaused.current.has(id) && entriesRef.current[id]?.status === 'dirty') return saveRef.current(id);
    return result;
  }, [writeEntry, scheduler]);
  saveRef.current = save;

  const change = useCallback((note: Note, patch: NotePatch) => {
    if (note.role === 'viewer') return;
    const current = get(note);
    const next: NoteDraft = {
      ...current,
      note: { ...current.note, ...patch },
      sequence: current.sequence + 1,
      status: current.status === 'conflict' ? 'conflict' : 'dirty',
      error: undefined,
    };
    writeEntry(note.id, next);
    scheduleDraftEdit(scheduler, note.id, next.status !== 'conflict' && !recoveryPaused.current.has(note.id));
  }, [get, writeEntry, scheduler]);

  const keepMine = useCallback(async (id: string) => {
    const entry = entriesRef.current[id];
    if (!entry?.conflict) return;
    writeEntry(id, { ...entry, baseRevision: entry.conflict.revision, conflict: undefined, status: 'dirty' });
    await saveRef.current(id);
  }, [writeEntry]);
  const useLatest = useCallback((id: string) => {
    const entry = entriesRef.current[id];
    if (!entry?.conflict) return;
    writeEntry(id, { note: entry.conflict, baseRevision: entry.conflict.revision, status: 'saved', sequence: entry.sequence });
  }, [writeEntry]);
  const retry = useCallback(async (id: string) => {
    const entry = entriesRef.current[id];
    if (!entry) return;
    writeEntry(id, { ...entry, status: 'dirty', error: undefined });
    await saveRef.current(id);
  }, [writeEntry]);

  // Clean drafts follow changes from another tab/sync; dirty drafts keep their own base revision.
  useEffect(() => {
    let changed = false;
    const next = { ...entriesRef.current };
    for (const note of notes) {
      const entry = next[note.id];
      if (entry?.status === 'saved' && note.revision >= entry.baseRevision && (note.revision > entry.baseRevision || note.serverVersion !== entry.note.serverVersion || note.syncState !== entry.note.syncState || note.role !== entry.note.role || note.unavailable !== entry.note.unavailable)) {
        next[note.id] = { ...entry, note, baseRevision: note.revision };
        changed = true;
      } else if (entry && entry.status !== 'saved' && (note.role !== entry.note.role || note.unavailable !== entry.note.unavailable || note.syncState !== entry.note.syncState || note.serverVersion !== entry.note.serverVersion)) {
        // Permission changes apply immediately, but never replace unsaved text.
        // Do not keep retrying a write that the new role cannot perform.
        if (note.role === 'viewer') scheduler.clear(note.id);
        next[note.id] = { ...entry, note: { ...entry.note, role: note.role, syncState: note.syncState, serverVersion: note.serverVersion, unavailable: note.unavailable },
          ...(note.role === 'viewer' && entry.status === 'dirty' ? { status: 'error' as const, error: 'Access changed before this draft could be saved.' } : {}) };
        changed = true;
      }
    }
    if (changed) { entriesRef.current = next; setEntries(next); }
  }, [notes, scheduler]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (Object.values(entriesRef.current).some((entry) => entry.status !== 'saved')) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      scheduler.clearAll();
    };
  }, [scheduler]);

  const isBusy = useCallback((id: string) => {
    const entry = entriesRef.current[id];
    return !!entry && entry.status !== 'saved';
  }, []);
  const flushAll = useCallback(async () => {
    for (const id of Object.keys(entriesRef.current)) {
      const entry = entriesRef.current[id];
      if (entry.status === 'conflict' || entry.status === 'error') throw new Error('Resolve unsaved note changes before switching workspaces.');
      if (entry.status !== 'saved') await saveRef.current(id);
      if (entriesRef.current[id]?.status !== 'saved') throw new Error('Could not save every draft. Resolve the note before switching workspaces.');
    }
  }, []);
  const prepareRecovery = useCallback(async (note: Note): Promise<NoteDraft> => {
    recoveryPaused.current.add(note.id);
    scheduler.clear(note.id);
    // An already-started write may settle, but no retry may start while copying.
    const pending = running.current[note.id];
    if (pending) await pending;
    return get(note);
  }, [get, scheduler]);
  const finishRecovery = useCallback((note: Note, reviewedSequence: number): boolean => {
    scheduler.clear(note.id);
    const entry = entriesRef.current[note.id];
    if (!canAcceptRecoveredDraft(entry?.sequence, reviewedSequence)) { recoveryPaused.current.delete(note.id); return false; }
    writeEntry(note.id, { note, baseRevision: note.revision, status: 'saved', sequence: reviewedSequence + 1 });
    recoveryPaused.current.delete(note.id);
    return true;
  }, [writeEntry, scheduler]);
  const cancelRecovery = useCallback((id: string) => { recoveryPaused.current.delete(id); }, []);
  const reset = useCallback(() => {
    scheduler.clearAll();
    recoveryPaused.current.clear();
    entriesRef.current = {};
    setEntries({});
  }, [scheduler]);

  return { entries, get, change, save, keepMine, useLatest, retry, isBusy, flushAll, prepareRecovery, finishRecovery, cancelRecovery, reset };
}
