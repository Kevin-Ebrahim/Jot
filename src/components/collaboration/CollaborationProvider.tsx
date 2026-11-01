'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SyncConflict, SyncResult, SyncStatus } from '@/lib/types';
import { CollaborationApiError, messageForError, request, type CollaborationSession } from './api';

export interface CollaborationWorkspace {
  workspaceId: string | null;
  switchWorkspace: (userId: string | null) => Promise<void>;
  copyGuestNotesToAccount: (userId: string) => Promise<number>;
  syncNow: () => Promise<SyncResult>;
  syncStatus: SyncStatus;
  listConflicts: () => Promise<SyncConflict[]>;
  resolveConflict: (id: string, choice: 'local' | 'server' | 'both') => Promise<void>;
}

type SessionStatus = 'checking' | 'ready' | 'error';
interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

interface CollaborationContextValue {
  /** null means the session is not yet known; session.user === null is confirmed guest. */
  session: CollaborationSession | null;
  sessionStatus: SessionStatus;
  sessionError: string | null;
  workspaceReady: boolean;
  syncStatus: SyncStatus;
  syncMessage: string | null;
  lastSync: SyncResult | null;
  refreshSession: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  syncNow: () => Promise<SyncResult>;
  importGuestNotes: () => Promise<number>;
  listConflicts: () => Promise<SyncConflict[]>;
  resolveConflict: (id: string, choice: 'local' | 'server' | 'both') => Promise<void>;
  authenticatedRequest: <T>(path: string, options?: RequestOptions) => Promise<T>;
}

const CollaborationContext = createContext<CollaborationContextValue | null>(null);

function validSession(value: CollaborationSession): CollaborationSession {
  if (!value || typeof value !== 'object' || !('user' in value) || !('csrfToken' in value)) {
    throw new Error('The server returned an invalid session.');
  }
  if (value.user === null && value.csrfToken === null) return value;
  if (value.user && typeof value.user.id === 'string' && typeof value.user.email === 'string'
      && typeof value.csrfToken === 'string' && value.csrfToken.length > 0) return value;
  throw new Error('The server returned an invalid session.');
}

/** Coordinates confirmed sessions with separate local workspaces. Guest records
 * are never copied or uploaded by signing in; that is a separate explicit action. */
export function CollaborationProvider({ workspace, children }: { workspace: CollaborationWorkspace; children: ReactNode }) {
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [session, setSession] = useState<CollaborationSession | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('checking');
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [workspacePhase, setWorkspacePhase] = useState<'switching' | 'ready' | 'error'>('switching');
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);
  const operation = useRef(0);
  const mounted = useRef(true);
  const switchQueue = useRef<Promise<void>>(Promise.resolve());
  const syncInFlight = useRef<Promise<SyncResult> | null>(null);
  const resolutionInFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current += 1; };
  }, []);

  const applySession = useCallback(async (next: CollaborationSession, currentOperation: number) => {
    if (currentOperation !== operation.current || !mounted.current) return;
    setSession(next);
    setWorkspacePhase('switching');
    setSyncMessage(null);
    setLastSync(null);
    // Serialize switches so an older, slow IndexedDB open cannot win a race with
    // a newer sign-in or sign-out. Never switch based on an unsuccessful fetch.
    const transition = switchQueue.current.catch(() => undefined).then(async () => {
      if (syncInFlight.current) await syncInFlight.current.catch(() => undefined);
      if (resolutionInFlight.current) await resolutionInFlight.current.catch(() => undefined);
      if (currentOperation !== operation.current || !mounted.current) return;
      await workspaceRef.current.switchWorkspace(next.user?.id ?? null);
    });
    switchQueue.current = transition;
    try {
      await transition;
      if (currentOperation === operation.current && mounted.current) {
        setWorkspacePhase('ready');
        setSessionError(null);
        setSessionStatus('ready');
      }
    } catch (error) {
      if (currentOperation === operation.current && mounted.current) {
        setWorkspacePhase('error');
        setSessionError('Your account was checked, but its local workspace could not be opened. Try checking the session again.');
        setSessionStatus('error');
      }
      throw error;
    }
  }, []);

  const refreshSession = useCallback(async () => {
    const currentOperation = ++operation.current;
    setSessionStatus('checking');
    setSessionError(null);
    try {
      const next = validSession(await request<CollaborationSession>('/api/auth/session'));
      if (currentOperation !== operation.current || !mounted.current) return;
      await applySession(next, currentOperation);
    } catch (error) {
      if (currentOperation === operation.current && mounted.current) {
        setSessionStatus('error');
        setSessionError(error instanceof Error && error.message.startsWith('Your account')
          ? error.message
          : 'Could not check your session. Your local workspace has not been changed. Check your connection and retry.');
      }
      throw error;
    }
  }, [applySession]);

  useEffect(() => { void refreshSession().catch(() => undefined); }, [refreshSession]);

  const authenticate = useCallback(async (mode: 'login' | 'register', email: string, password: string) => {
    const currentOperation = ++operation.current;
    try {
      const next = validSession(await request<CollaborationSession>(`/api/auth/${mode}`, {
        method: 'POST', body: { email, password },
      }));
      if (currentOperation !== operation.current || !mounted.current) return;
      setSessionStatus('checking');
      await applySession(next, currentOperation);
    } catch (error) {
      // Failed credentials leave the previously confirmed guest workspace alone.
      throw error;
    }
  }, [applySession]);

  const signIn = useCallback((email: string, password: string) => authenticate('login', email, password), [authenticate]);
  const register = useCallback((email: string, password: string) => authenticate('register', email, password), [authenticate]);

  const signOut = useCallback(async () => {
    if (!session?.user || !session.csrfToken) throw new Error('No confirmed account session to sign out.');
    const currentOperation = ++operation.current;
    setSessionStatus('checking');
    setSessionError(null);
    try {
      if (syncInFlight.current) await syncInFlight.current.catch(() => undefined);
      if (resolutionInFlight.current) await resolutionInFlight.current.catch(() => undefined);
      await request<{ ok: true }>('/api/auth/logout', { method: 'POST', csrfToken: session.csrfToken });
      await applySession({ user: null, csrfToken: null }, currentOperation);
    } catch (error) {
      if (currentOperation === operation.current && mounted.current) {
        setSessionStatus('error');
        setSessionError('Could not confirm sign-out. Your local workspace has not been changed. Check the session and try again.');
      }
      throw error;
    }
  }, [applySession, session]);

  const workspaceReady = sessionStatus === 'ready' && workspacePhase === 'ready'
    && session !== null && workspace.workspaceId === (session.user?.id ?? null);

  const syncNow = useCallback(async (): Promise<SyncResult> => {
    if (!session?.user || !workspaceReady) throw new Error('Check your account session before syncing.');
    if (resolutionInFlight.current) throw new Error('Wait for the conflict resolution to finish before syncing.');
    if (syncInFlight.current) return syncInFlight.current;
    const pending = workspaceRef.current.syncNow();
    syncInFlight.current = pending;
    try {
      const result = await pending;
      if (mounted.current) {
        setLastSync(result);
        if (result.errors.length) setSyncMessage(result.errors.join(' '));
        else if (result.conflicts) setSyncMessage(`${result.conflicts} ${result.conflicts === 1 ? 'conflict needs' : 'conflicts need'} your attention. Your local changes were kept.`);
        else setSyncMessage(null);
      }
      return result;
    } catch (error) {
      if (mounted.current) setSyncMessage(messageForError(error));
      throw error;
    } finally {
      if (syncInFlight.current === pending) syncInFlight.current = null;
    }
  }, [session, workspaceReady]);

  // Only the confirmed account workspace is synchronized. Guest notes cannot
  // enter it until the user explicitly chooses the copy action in AccountDialog.
  useEffect(() => {
    if (!session?.user || !workspaceReady) return;
    let active = true;
    const run = () => {
      if (!active || document.visibilityState === 'hidden' || !navigator.onLine) return;
      void syncNow().catch(() => undefined);
    };
    run();
    const interval = window.setInterval(run, 30_000);
    window.addEventListener('online', run);
    document.addEventListener('visibilitychange', run);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('online', run);
      document.removeEventListener('visibilitychange', run);
    };
  }, [session?.user?.id, syncNow, workspaceReady]);

  const importGuestNotes = useCallback(async () => {
    if (!session?.user || !workspaceReady) throw new Error('Check your account session before copying guest notes.');
    return workspaceRef.current.copyGuestNotesToAccount(session.user.id);
  }, [session, workspaceReady]);

  const listConflicts = useCallback(async () => {
    if (!session?.user || !workspaceReady) throw new Error('Check your account session before reviewing conflicts.');
    return workspaceRef.current.listConflicts();
  }, [session, workspaceReady]);

  const resolveConflict = useCallback(async (id: string, choice: 'local' | 'server' | 'both') => {
    if (!session?.user || !workspaceReady) throw new Error('Check your account session before resolving conflicts.');
    if (resolutionInFlight.current) throw new Error('A conflict is already being resolved.');
    const pending = (async () => {
      if (syncInFlight.current) await syncInFlight.current.catch(() => undefined);
      await workspaceRef.current.resolveConflict(id, choice);
      const remaining = await workspaceRef.current.listConflicts();
      if (mounted.current) {
        setSyncMessage(remaining.length ? `${remaining.length} ${remaining.length === 1 ? 'conflict needs' : 'conflicts need'} your attention. Your local changes were kept.` : null);
        setLastSync((previous) => previous ? { ...previous, conflicts: remaining.length } : previous);
      }
    })();
    resolutionInFlight.current = pending;
    try { await pending; }
    finally { if (resolutionInFlight.current === pending) resolutionInFlight.current = null; }
  }, [session, workspaceReady]);

  const authenticatedRequest = useCallback(async <T,>(path: string, options: RequestOptions = {}): Promise<T> => {
    if (!session?.user || !session.csrfToken || !workspaceReady) throw new Error('Check your account session before continuing.');
    try {
      return await request<T>(path, { ...options, csrfToken: session.csrfToken });
    } catch (error) {
      if (error instanceof CollaborationApiError && (error.status === 401 || (error.status === 403 && /csrf/i.test(error.message)))) {
        setSessionStatus('error');
        setSessionError('Your session needs to be checked again. Your local workspace has not been changed.');
      }
      throw error;
    }
  }, [session, workspaceReady]);

  const value = useMemo<CollaborationContextValue>(() => ({
    session, sessionStatus, sessionError, workspaceReady, syncStatus: workspace.syncStatus,
    syncMessage, lastSync, refreshSession, signIn, register, signOut, syncNow, importGuestNotes, listConflicts, resolveConflict, authenticatedRequest,
  }), [session, sessionStatus, sessionError, workspaceReady, workspace.syncStatus, syncMessage, lastSync, refreshSession, signIn, register, signOut, syncNow, importGuestNotes, listConflicts, resolveConflict, authenticatedRequest]);

  return <CollaborationContext.Provider value={value}>{children}</CollaborationContext.Provider>;
}

export function useCollaboration(): CollaborationContextValue {
  const context = useContext(CollaborationContext);
  if (!context) throw new Error('useCollaboration must be used inside CollaborationProvider');
  return context;
}
