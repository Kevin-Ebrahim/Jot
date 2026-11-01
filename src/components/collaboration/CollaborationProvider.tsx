'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SyncConflict, SyncResult, SyncStatus } from '@/lib/types';
import { CollaborationApiError, messageForError, request, type CollaborationSession } from './api';
import { createSessionRecovery, sessionMatchesWorkspace } from './session-recovery';

export interface CollaborationWorkspace {
  workspaceId: string | null;
  getCurrentWorkspaceId: () => string | null;
  /** Atomically block workspace edits/transfers and flush drafts; release after the transition. */
  beginWorkspaceTransition: () => Promise<() => void>;
  switchWorkspace: (userId: string | null) => Promise<void>;
  copyGuestNotesToAccount: (userId: string) => Promise<number>;
  syncNow: () => Promise<SyncResult>;
  syncStatus: SyncStatus;
  listConflicts: () => Promise<SyncConflict[]>;
  resolveConflict: (id: string, choice: 'local' | 'server' | 'both', expectedRevision: number, expectedServerVersion: number) => Promise<void>;
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
  pendingSession: CollaborationSession | null;
  acceptSessionChange: () => Promise<void>;
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
  resolveConflict: (id: string, choice: 'local' | 'server' | 'both', expectedRevision: number, expectedServerVersion: number) => Promise<void>;
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
  const [pendingSession, setPendingSession] = useState<CollaborationSession | null>(null);
  const [workspacePhase, setWorkspacePhase] = useState<'switching' | 'ready' | 'error'>('switching');
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);
  const operation = useRef(0);
  const mounted = useRef(true);
  const switchQueue = useRef<Promise<void>>(Promise.resolve());
  const syncInFlight = useRef<{ workspaceId: string; promise: Promise<SyncResult> } | null>(null);
  const resolutionInFlight = useRef<Promise<void> | null>(null);
  const importInFlight = useRef<Promise<number> | null>(null);
  const activeRelease = useRef<(() => void) | null>(null);
  const activeAuthRequest = useRef<AbortController | null>(null);
  const refreshInFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; operation.current += 1;
      activeAuthRequest.current?.abort();
      activeRelease.current?.();
      activeRelease.current = null;
    };
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
      if (resolutionInFlight.current) await resolutionInFlight.current.catch(() => undefined);
      if (importInFlight.current) await importInFlight.current.catch(() => undefined);
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
      const reason = error instanceof Error ? error.message : 'Local storage is unavailable.';
      const message = `Could not open the confirmed workspace. ${reason} Your current local workspace was not reset.`;
      if (currentOperation === operation.current && mounted.current) {
        setWorkspacePhase('error');
        setSessionError(message);
        setSessionStatus('error');
      }
      throw new Error(message);
    }
  }, []);

  // A bounded request keeps a stalled network from locking the local editor
  // indefinitely. An aborted mutation is treated as an uncertain outcome.
  const authRequest = useCallback(async <T,>(path: string, options: Omit<RequestOptions, 'signal'> & { csrfToken?: string | null; workspaceId?: string } = {}): Promise<T> => {
    const controller = new AbortController();
    activeAuthRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try { return await request<T>(path, { ...options, signal: controller.signal }); }
    finally {
      window.clearTimeout(timeout);
      if (activeAuthRequest.current === controller) activeAuthRequest.current = null;
    }
  }, []);

  const refreshSession = useCallback((): Promise<void> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const pending = (async () => {
      const currentOperation = ++operation.current;
      setSessionStatus('checking');
      setSessionError(null);
      let release: (() => void) | undefined;
      let requestStarted = false;
      try {
        // The shell acquires this lease synchronously before awaiting draft flush.
        // It also excludes backup transfers and prevents new edits until release.
        release = await workspaceRef.current.beginWorkspaceTransition();
        if (currentOperation !== operation.current || !mounted.current) return;
        activeRelease.current = release;
        requestStarted = true;
        const next = validSession(await authRequest<CollaborationSession>('/api/auth/session'));
        if (currentOperation !== operation.current || !mounted.current) return;
        if (!sessionMatchesWorkspace(workspaceRef.current.getCurrentWorkspaceId(), next)) {
          // Never infer permission to abandon the active offline workspace just
          // because a different cookie appeared in another tab or after expiry.
          setPendingSession(next);
          setSessionStatus('error');
          setSessionError('The server session differs from this local workspace. Choose whether to switch; nothing will be copied automatically.');
          return;
        }
        setPendingSession(null);
        await applySession(next, currentOperation);
      } catch (error) {
        if (currentOperation === operation.current && mounted.current) {
          setSessionStatus('error');
          const message = error instanceof Error ? error.message : 'Local workspace preparation failed.';
          setSessionError(!requestStarted ? `${message} Your local workspace has not been changed.`
            : message.startsWith('Could not open the confirmed workspace.') ? message
              : 'Could not check your session. Your local workspace has not been changed. Check your connection and retry.');
        }
        throw error;
      } finally {
        release?.();
        if (activeRelease.current === release) activeRelease.current = null;
      }
    })();
    refreshInFlight.current = pending;
    void pending.finally(() => { if (refreshInFlight.current === pending) refreshInFlight.current = null; }).catch(() => undefined);
    return pending;
  }, [applySession, authRequest]);

  useEffect(() => {
    // React Strict Mode can mount, clean up, and remount effects synchronously.
    // Deferring the check lets that probe finish before acquiring the shell lease.
    const timer = window.setTimeout(() => { void refreshSession().catch(() => undefined); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshSession]);

  const recoveryState = useRef({ sessionStatus, pendingSession });
  recoveryState.current = { sessionStatus, pendingSession };
  const recovery = useRef<ReturnType<typeof createSessionRecovery> | null>(null);
  useEffect(() => {
    const controller = createSessionRecovery({
      canRetry: () => recoveryState.current.sessionStatus === 'error' && !recoveryState.current.pendingSession,
      isOnline: () => navigator.onLine,
      isVisible: () => document.visibilityState !== 'hidden',
      refresh: refreshSession,
      setTimer: (callback, delay) => window.setTimeout(callback, delay),
      clearTimer: (id) => window.clearTimeout(id),
    });
    recovery.current = controller;
    const wake = () => controller.wake();
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    if (recoveryState.current.sessionStatus === 'error' && !recoveryState.current.pendingSession) controller.schedule();
    return () => {
      controller.stop();
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      if (recovery.current === controller) recovery.current = null;
    };
  }, [refreshSession]);
  useEffect(() => {
    if (sessionStatus === 'ready') recovery.current?.reset();
    else if (sessionStatus === 'error' && !pendingSession) recovery.current?.schedule();
    else recovery.current?.pause();
  }, [sessionStatus, pendingSession]);

  const acceptSessionChange = useCallback(async () => {
    if (!pendingSession) throw new Error('There is no account change to confirm.');
    const chosenId = pendingSession.user?.id ?? null;
    const currentOperation = ++operation.current;
    setSessionStatus('checking'); setSessionError(null);
    let release: (() => void) | undefined;
    let requestStarted = false;
    try {
      release = await workspaceRef.current.beginWorkspaceTransition();
      if (currentOperation !== operation.current || !mounted.current) return;
      activeRelease.current = release;
      requestStarted = true;
      // Re-check the cookie immediately before switching. A different identity
      // needs a new decision; no stale approval is applied to another account.
      const next = validSession(await authRequest<CollaborationSession>('/api/auth/session'));
      if (currentOperation !== operation.current || !mounted.current) return;
      const nextId = next.user?.id ?? null;
      if (nextId !== chosenId && !sessionMatchesWorkspace(workspaceRef.current.getCurrentWorkspaceId(), next)) {
        setPendingSession(next);
        setSessionStatus('error');
        setSessionError('The server account changed again. Review the current account before switching.');
        return;
      }
      setPendingSession(null);
      await applySession(next, currentOperation);
    } catch (error) {
      if (currentOperation === operation.current && mounted.current) {
        setSessionStatus('error');
        const message = error instanceof Error ? error.message : 'Local workspace preparation failed.';
        setSessionError(!requestStarted ? `${message} Your local workspace has not been changed.`
          : message.startsWith('Could not open the confirmed workspace.') ? message
            : 'Could not confirm the server account. Your local workspace has not been changed. Try again.');
      }
      throw error;
    } finally {
      release?.();
      if (activeRelease.current === release) activeRelease.current = null;
    }
  }, [pendingSession, applySession, authRequest]);

  const authenticate = useCallback(async (mode: 'login' | 'register', email: string, password: string) => {
    const currentOperation = ++operation.current;
    setSessionStatus('checking');
    setSessionError(null);
    let release: (() => void) | undefined;
    let requestStarted = false;
    let responseConfirmed = false;
    try {
      release = await workspaceRef.current.beginWorkspaceTransition();
      if (currentOperation !== operation.current || !mounted.current) return;
      activeRelease.current = release;
      requestStarted = true;
      const next = validSession(await authRequest<CollaborationSession>(`/api/auth/${mode}`, {
        method: 'POST', body: { email, password },
      }));
      responseConfirmed = true;
      if (currentOperation !== operation.current || !mounted.current) return;
      setPendingSession(null);
      await applySession(next, currentOperation);
    } catch (error) {
      if (currentOperation === operation.current && mounted.current && !responseConfirmed) {
        // An explicit 4xx has a known result. Network errors and 5xx responses
        // may arrive after a cookie change, so require a fresh session check.
        if (!requestStarted || (error instanceof CollaborationApiError && error.status >= 400 && error.status < 500)) {
          setSessionStatus('ready');
          setSessionError(null);
        } else {
          setSessionStatus('error');
          setSessionError('Could not confirm the account request. Your local workspace has not been changed. Check the session before trying again.');
        }
      }
      throw error;
    } finally {
      release?.();
      if (activeRelease.current === release) activeRelease.current = null;
    }
  }, [applySession, authRequest]);

  const signIn = useCallback((email: string, password: string) => authenticate('login', email, password), [authenticate]);
  const register = useCallback((email: string, password: string) => authenticate('register', email, password), [authenticate]);

  const signOut = useCallback(async () => {
    if (!session?.user || !session.csrfToken) throw new Error('No confirmed account session to sign out.');
    const currentOperation = ++operation.current;
    setSessionStatus('checking');
    setSessionError(null);
    let release: (() => void) | undefined;
    let requestStarted = false;
    let serverSignedOut = false;
    try {
      release = await workspaceRef.current.beginWorkspaceTransition();
      if (currentOperation !== operation.current || !mounted.current) return;
      activeRelease.current = release;
      if (resolutionInFlight.current) await resolutionInFlight.current.catch(() => undefined);
      if (importInFlight.current) await importInFlight.current.catch(() => undefined);
      if (currentOperation !== operation.current || !mounted.current) return;
      requestStarted = true;
      await authRequest<{ ok: true }>('/api/auth/logout', { method: 'POST', csrfToken: session.csrfToken, workspaceId: session.user.id });
      serverSignedOut = true;
      setPendingSession(null);
      await applySession({ user: null, csrfToken: null }, currentOperation);
    } catch (error) {
      if (currentOperation === operation.current && mounted.current) {
        if (!requestStarted) {
          setSessionStatus('ready');
          setSessionError(null);
        } else if (serverSignedOut) {
          setSessionStatus('error');
          setSessionError('Signed out on the server, but the guest workspace could not be opened. Your account data remains on this device. Resolve any unsaved drafts, then check the session again.');
        } else {
          setSessionStatus('error');
          setSessionError('Could not confirm sign-out. Your local workspace has not been changed. Check the session and try again.');
        }
      }
      throw error;
    } finally {
      release?.();
      if (activeRelease.current === release) activeRelease.current = null;
    }
  }, [applySession, authRequest, session]);

  const workspaceReady = sessionStatus === 'ready' && workspacePhase === 'ready'
    && session !== null && workspace.workspaceId === (session.user?.id ?? null);

  const syncNow = useCallback(async (): Promise<SyncResult> => {
    if (!session?.user || !workspaceReady) throw new Error('Check your account session before syncing.');
    if (resolutionInFlight.current) throw new Error('Wait for the conflict resolution to finish before syncing.');
    if (importInFlight.current) throw new Error('Wait for guest notes to finish copying before syncing.');
    const userId = session.user.id;
    const currentOperation = operation.current;
    if (syncInFlight.current?.workspaceId === userId) return syncInFlight.current.promise;
    const pending = workspaceRef.current.syncNow();
    const entry = { workspaceId: userId, promise: pending };
    syncInFlight.current = entry;
    try {
      const result = await pending;
      if (mounted.current && currentOperation === operation.current && workspaceRef.current.workspaceId === userId) {
        setLastSync(result);
        if (result.errors.some((message) => /signed-in account changed|matching account|sign in required/i.test(message))) {
          setSessionStatus('error');
          setSessionError('The signed-in account changed or expired. Your local workspace has not been changed; check the session before syncing.');
        }
        if (result.errors.length) setSyncMessage(result.errors.join(' '));
        else if (result.conflicts) setSyncMessage(`${result.conflicts} ${result.conflicts === 1 ? 'conflict needs' : 'conflicts need'} your attention. Your local changes were kept.`);
        else setSyncMessage(null);
      }
      return result;
    } catch (error) {
      if (mounted.current && currentOperation === operation.current && workspaceRef.current.workspaceId === userId) {
        const message = messageForError(error);
        setSyncMessage(message);
        if (/signed-in account changed|matching account|sign in required/i.test(message)) {
          setSessionStatus('error');
          setSessionError('The signed-in account changed or expired. Your local workspace has not been changed; check the session before syncing.');
        }
      }
      throw error;
    } finally {
      if (syncInFlight.current === entry) syncInFlight.current = null;
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
    if (importInFlight.current) return importInFlight.current;
    const userId = session.user.id;
    const currentOperation = operation.current;
    const pending = (async () => {
      // Do not let a sync started before the copy make the new records look
      // synchronized. Wait for it, then copy atomically, then start a fresh sync.
      if (syncInFlight.current?.workspaceId === userId) await syncInFlight.current.promise.catch(() => undefined);
      if (currentOperation !== operation.current) throw new Error('The account changed before copying began.');
      return workspaceRef.current.copyGuestNotesToAccount(userId);
    })();
    importInFlight.current = pending;
    try {
      const count = await pending;
      if (importInFlight.current === pending) importInFlight.current = null;
      if (currentOperation === operation.current && mounted.current) void syncNow().catch(() => undefined);
      return count;
    } finally {
      if (importInFlight.current === pending) importInFlight.current = null;
    }
  }, [session, workspaceReady, syncNow]);

  const listConflicts = useCallback(async () => {
    if (!session?.user || !workspaceReady) throw new Error('Check your account session before reviewing conflicts.');
    return workspaceRef.current.listConflicts();
  }, [session, workspaceReady]);

  const resolveConflict = useCallback(async (id: string, choice: 'local' | 'server' | 'both', expectedRevision: number, expectedServerVersion: number) => {
    if (!session?.user || !workspaceReady) throw new Error('Check your account session before resolving conflicts.');
    if (resolutionInFlight.current) throw new Error('A conflict is already being resolved.');
    const pending = (async () => {
      if (syncInFlight.current?.workspaceId === session.user!.id) await syncInFlight.current.promise.catch(() => undefined);
      await workspaceRef.current.resolveConflict(id, choice, expectedRevision, expectedServerVersion);
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
    const userId = session.user.id;
    const currentOperation = operation.current;
    try {
      return await request<T>(path, { ...options, csrfToken: session.csrfToken, workspaceId: userId });
    } catch (error) {
      if (mounted.current && currentOperation === operation.current && workspaceRef.current.workspaceId === userId
          && error instanceof CollaborationApiError && (error.status === 401 || (error.status === 403 && /csrf/i.test(error.message)) || (error.status === 409 && /account changed|workspace/i.test(error.message)))) {
        setSessionStatus('error');
        setSessionError('Your session needs to be checked again. Your local workspace has not been changed.');
      }
      throw error;
    }
  }, [session, workspaceReady]);

  const value = useMemo<CollaborationContextValue>(() => ({
    session, sessionStatus, sessionError, pendingSession, acceptSessionChange, workspaceReady, syncStatus: workspace.syncStatus,
    syncMessage, lastSync, refreshSession, signIn, register, signOut, syncNow, importGuestNotes, listConflicts, resolveConflict, authenticatedRequest,
  }), [session, sessionStatus, sessionError, pendingSession, acceptSessionChange, workspaceReady, workspace.syncStatus, syncMessage, lastSync, refreshSession, signIn, register, signOut, syncNow, importGuestNotes, listConflicts, resolveConflict, authenticatedRequest]);

  return <CollaborationContext.Provider value={value}>{children}</CollaborationContext.Provider>;
}

export function useCollaboration(): CollaborationContextValue {
  const context = useContext(CollaborationContext);
  if (!context) throw new Error('useCollaboration must be used inside CollaborationProvider');
  return context;
}
