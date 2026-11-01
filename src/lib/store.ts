import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { withWorkspaceLock } from './workspace-lock';
import { createAttachmentRewriter } from './attachment-refs';
import type { AccessRole, Attachment, NewNote, Note, Notebook, NotePatch, OutboxChange, SyncConflict, SyncState } from './types';

export interface JotDB extends DBSchema {
  notes: { key: string; value: Note; indexes: { 'by-notebook': string; 'by-updated': string } };
  notebooks: { key: string; value: Notebook };
  attachments: { key: string; value: Attachment; indexes: { 'by-note': string } };
  outbox: { key: string; value: OutboxChange; indexes: { 'by-entity': string } };
  conflicts: { key: string; value: SyncConflict };
  imports: { key: string; value: { key: string; targetId: string } };
}

const DATABASE_PREFIX = 'jot-workspace-v1-';
const WORKSPACE_KEY = 'jot-workspace';
let currentWorkspace: string | null | undefined;
const databases = new Map<string, Promise<IDBPDatabase<JotDB>>>();
let channel: BroadcastChannel | undefined;

function broadcastChannel(): BroadcastChannel | undefined {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return undefined;
  if (!channel) channel = new BroadcastChannel('jot-workspace-changes');
  return channel;
}

/** Notify this tab and other tabs only after a successful transaction. */
export function notifyStoreChanged(workspace = getWorkspaceId()): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('jot:changed', { detail: workspace }));
  broadcastChannel()?.postMessage({ workspace });
}

export function subscribeStore(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const local = (event: Event) => {
    if ((event as CustomEvent<string | null>).detail === getWorkspaceId()) listener();
  };
  const remote = (event: MessageEvent<{ workspace: string | null }>) => {
    if (event.data?.workspace === getWorkspaceId()) listener();
  };
  window.addEventListener('jot:changed', local);
  const bc = broadcastChannel();
  bc?.addEventListener('message', remote);
  return () => { window.removeEventListener('jot:changed', local); bc?.removeEventListener('message', remote); };
}

function validWorkspace(value: string | null): boolean {
  return value === null || /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function getWorkspaceId(): string | null {
  if (currentWorkspace === undefined) {
    let saved: string | null = null;
    try { if (typeof window !== 'undefined') saved = window.localStorage.getItem(WORKSPACE_KEY); } catch { /* private mode */ }
    currentWorkspace = validWorkspace(saved) ? saved : null;
  }
  return currentWorkspace;
}

function stateForWrite(old: SyncState, workspace: string | null): SyncState {
  if (old === 'conflict') return 'conflict';
  return workspace === null ? 'local' : 'dirty';
}
function stateForNew(workspace: string | null): SyncState { return workspace === null ? 'local' : 'dirty'; }
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

function createWelcome(): { notebook: Notebook; note: Note } {
  const createdAt = now();
  const notebook: Notebook = {
    id: uuid(), name: 'Personal', createdAt, updatedAt: createdAt, deletedAt: null,
    revision: 1, serverVersion: null, syncState: 'local', role: 'owner',
  };
  const note: Note = {
    id: uuid(), title: 'Welcome to Jot', notebookId: notebook.id, tags: ['welcome'],
    body: 'Your thoughts, in one quiet place.\n\nWrite in Markdown, make a checklist, or link ideas with [[double brackets]].\n\nThis workspace lives in this browser. Export a backup to keep a separate copy. Signing in gives you a separate account workspace; nothing here is uploaded unless you choose to copy it.\n',
    createdAt, updatedAt: createdAt, deletedAt: null, revision: 1, serverVersion: null,
    syncState: 'local', role: 'owner', pinned: false,
  };
  return { notebook, note };
}

export function getWorkspaceDb(workspace = getWorkspaceId()): Promise<IDBPDatabase<JotDB>> {
  if (!validWorkspace(workspace)) return Promise.reject(new Error('Invalid workspace.'));
  const key = workspace === null ? 'guest' : `account-${workspace}`;
  let promise = databases.get(key);
  if (!promise) {
    promise = openDB<JotDB>(`${DATABASE_PREFIX}${key}`, 2, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          const notes = db.createObjectStore('notes', { keyPath: 'id' });
          notes.createIndex('by-notebook', 'notebookId');
          notes.createIndex('by-updated', 'updatedAt');
          db.createObjectStore('notebooks', { keyPath: 'id' });
          const attachments = db.createObjectStore('attachments', { keyPath: 'id' });
          attachments.createIndex('by-note', 'noteId');
          const outbox = db.createObjectStore('outbox', { keyPath: 'operationId' });
          outbox.createIndex('by-entity', 'entityId');
          db.createObjectStore('conflicts', { keyPath: 'id' });
          if (workspace === null) {
            const { note, notebook } = createWelcome();
            void tx.objectStore('notes').add(note);
            void tx.objectStore('notebooks').add(notebook);
          }
        }
        if (oldVersion < 2) db.createObjectStore('imports', { keyPath: 'key' });
      },
      blocking(_currentVersion, _blockedVersion, event) { (event.target as IDBDatabase | null)?.close(); },
    });
    databases.set(key, promise);
    promise.catch(() => databases.delete(key));
  }
  return promise;
}

/** Scope account data by stable server user ID; a failed switch never changes the active workspace. */
export async function switchWorkspace(userId: string | null): Promise<void> {
  if (!validWorkspace(userId)) throw new Error('Invalid account workspace.');
  await getWorkspaceDb(userId);
  currentWorkspace = userId;
  try {
    if (typeof window !== 'undefined') {
      if (userId === null) window.localStorage.removeItem(WORKSPACE_KEY);
      else window.localStorage.setItem(WORKSPACE_KEY, userId);
    }
  } catch { /* the active in-memory workspace still works */ }
  notifyStoreChanged(userId);
}

export class ConflictError extends Error {
  current: Note;
  constructor(current: Note) {
    super('This note changed in another tab. Your draft has not been saved over it.');
    this.name = 'ConflictError';
    this.current = current;
  }
}
export class ReadOnlyError extends Error {
  constructor() { super('You have view-only access to this item.'); this.name = 'ReadOnlyError'; }
}

function requireEditable(role: AccessRole): void { if (role === 'viewer') throw new ReadOnlyError(); }
function validNotePatch(patch: NotePatch): NotePatch {
  const result: NotePatch = {};
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || patch.title.length > 300) throw new Error('Invalid title.');
    result.title = patch.title;
  }
  if (patch.body !== undefined) {
    if (typeof patch.body !== 'string' || patch.body.length > 1_000_000) throw new Error('Note is too large.');
    result.body = patch.body;
  }
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags) || patch.tags.length > 50 || patch.tags.some(t => typeof t !== 'string' || t.length > 80)) throw new Error('Invalid tags.');
    result.tags = [...new Set(patch.tags.map(t => t.trim()).filter(Boolean))];
  }
  if (patch.notebookId !== undefined) {
    if (patch.notebookId !== null && typeof patch.notebookId !== 'string') throw new Error('Invalid notebook.');
    result.notebookId = patch.notebookId;
  }
  if (patch.pinned !== undefined) {
    if (typeof patch.pinned !== 'boolean') throw new Error('Invalid pin state.');
    result.pinned = patch.pinned;
  }
  return result;
}

async function listNotes(options: { includeDeleted?: boolean } = {}): Promise<Note[]> {
  const notes = await (await getWorkspaceDb()).getAll('notes');
  return notes.filter(note => options.includeDeleted || !note.deletedAt)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}
async function getNote(id: string): Promise<Note | undefined> { return (await getWorkspaceDb()).get('notes', id); }
async function createNote(input: NewNote = {}): Promise<Note> {
  const workspace = getWorkspaceId();
  const patch = validNotePatch(input);
  const timestamp = now();
  const note: Note = {
    id: uuid(), title: patch.title ?? '', body: patch.body ?? '', tags: patch.tags ?? [],
    notebookId: patch.notebookId ?? null, pinned: patch.pinned ?? false,
    createdAt: timestamp, updatedAt: timestamp, deletedAt: null, revision: 1,
    serverVersion: null, syncState: stateForNew(workspace), role: 'owner',
  };
  const db = await getWorkspaceDb(workspace);
  const tx = db.transaction(['notes', 'notebooks'], 'readwrite');
  if (note.notebookId) {
    const notebook = await tx.objectStore('notebooks').get(note.notebookId);
    if (!notebook || notebook.deletedAt) { throw new Error('Notebook no longer exists.'); }
    requireEditable(notebook.role);
    // A note created inside a shared notebook is owned by that notebook's owner.
    note.role = notebook.role;
  }
  await tx.objectStore('notes').add(note);
  await tx.done;
  notifyStoreChanged(workspace);
  return note;
}
async function changeNote(id: string, expectedRevision: number, patch: NotePatch, deletion?: string | null): Promise<Note> {
  const workspace = getWorkspaceId();
  const validPatch = validNotePatch(patch);
  const db = await getWorkspaceDb(workspace);
  const tx = db.transaction(['notes', 'notebooks'], 'readwrite');
  const notes = tx.objectStore('notes');
  const current = await notes.get(id);
  if (!current) { throw new Error('Note no longer exists.'); }
  requireEditable(current.role);
  if (deletion !== undefined && current.role !== 'owner') throw new Error('Only the owner can trash or restore a note.');
  if (current.revision !== expectedRevision) { throw new ConflictError(current); }
  if (validPatch.notebookId !== undefined && validPatch.notebookId !== current.notebookId) {
    if (current.role !== 'owner') { throw new Error('Only the owner can move this note.'); }
    if (validPatch.notebookId) {
      const target = await tx.objectStore('notebooks').get(validPatch.notebookId);
      if (!target || target.deletedAt) { throw new Error('Notebook no longer exists.'); }
      if (target.role !== 'owner') { throw new Error('A note can be moved only into a notebook you own.'); }
    }
  }
  const updated: Note = {
    ...current, ...validPatch, ...(deletion !== undefined ? { deletedAt: deletion } : {}),
    revision: current.revision + 1, updatedAt: now(), syncState: stateForWrite(current.syncState, workspace),
  };
  await notes.put(updated);
  await tx.done;
  notifyStoreChanged(workspace);
  return updated;
}
async function updateNote(id: string, patch: NotePatch, expectedRevision: number): Promise<Note> {
  return changeNote(id, expectedRevision, patch);
}
async function trashNote(id: string, expectedRevision: number): Promise<Note> { return changeNote(id, expectedRevision, {}, now()); }
async function restoreNote(id: string, expectedRevision: number): Promise<Note> { return changeNote(id, expectedRevision, {}, null); }

/** Stable ID prevents two offline devices from silently creating the same scheduled occurrence. */
async function occurrenceId(sourceId: string, occurrenceKey: string): Promise<string> {
  const prefix = `${sourceId}:`;
  if (!occurrenceKey.startsWith(prefix) || !/^\d{4}-\d{2}-\d{2}$/.test(occurrenceKey.slice(prefix.length))) {
    throw new Error('A valid recurring occurrence date is required.');
  }
  if (!globalThis.crypto?.subtle) throw new Error('Recurring notes require HTTPS or localhost with Web Crypto.');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`jot-occurrence-v1\0${occurrenceKey}`)));
  const bytes = hash.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // UUIDv8: application-defined SHA-256 name-based ID
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Advance the source marker and create an occurrence together, or do neither. */
async function createRecurringOccurrence(sourceId: string, expectedRevision: number, sourceBody: string, newInput: NewNote, occurrenceKey: string): Promise<Note> {
  const workspace = getWorkspaceId();
  const generatedId = await occurrenceId(sourceId, occurrenceKey);
  if (workspace !== getWorkspaceId()) throw new Error('Workspace changed; occurrence was not created.');
  const sourcePatch = validNotePatch({ body: sourceBody });
  const input = validNotePatch(newInput);
  const timestamp = now();
  const db = await getWorkspaceDb(workspace);
  const tx = db.transaction(['notes', 'notebooks'], 'readwrite');
  const notes = tx.objectStore('notes');
  const source = await notes.get(sourceId);
  if (!source || source.deletedAt) throw new Error('The recurring note no longer exists.');
  requireEditable(source.role);
  if (source.revision !== expectedRevision) throw new ConflictError(source);
  const targetId = input.notebookId === undefined ? source.notebookId : input.notebookId;
  let targetRole: AccessRole = 'owner';
  if (targetId) {
    const notebook = await tx.objectStore('notebooks').get(targetId);
    if (!notebook || notebook.deletedAt) throw new Error('The destination notebook no longer exists.');
    requireEditable(notebook.role);
    targetRole = notebook.role;
  }
  const occurrence: Note = { id: generatedId, title: input.title ?? source.title, body: input.body ?? '',
    tags: input.tags ?? [...source.tags], notebookId: targetId, pinned: input.pinned ?? false,
    createdAt: timestamp, updatedAt: timestamp, deletedAt: null, revision: 1, serverVersion: null,
    syncState: stateForNew(workspace), role: targetRole };
  const existing = await notes.get(generatedId);
  if (existing && (existing.deletedAt || existing.title !== occurrence.title || existing.body !== occurrence.body ||
      existing.notebookId !== occurrence.notebookId || existing.pinned !== occurrence.pinned ||
      JSON.stringify(existing.tags) !== JSON.stringify(occurrence.tags))) {
    throw new Error('This recurring occurrence already exists with different content; no changes were made.');
  }
  const advanced: Note = { ...source, body: sourcePatch.body!, updatedAt: timestamp, revision: source.revision + 1,
    syncState: stateForWrite(source.syncState, workspace) };
  await notes.put(advanced);
  if (!existing) await notes.add(occurrence);
  await tx.done;
  notifyStoreChanged(workspace);
  return existing ?? occurrence;
}

/** Explicit recovery after access loss; never silently re-upload the shared source. */
async function copyUnavailableNoteToInboxLocked(sourceId: string, expectedRevision: number, draftPatch: NotePatch = {}): Promise<Note> {
  const workspace = getWorkspaceId();
  if (!workspace) throw new Error('Recovery requires an account workspace.');
  const patch = validNotePatch(draftPatch);
  if (patch.notebookId !== undefined) throw new Error('Recovered notes must be copied to Inbox.');
  if (!globalThis.crypto?.subtle) throw new Error('Recovery requires HTTPS or localhost with Web Crypto.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(patch))));
  const fingerprint = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (getWorkspaceId() !== workspace) throw new Error('Workspace changed; recovery was cancelled.');
  const db = await getWorkspaceDb(workspace);
  if (getWorkspaceId() !== workspace) throw new Error('Workspace changed; recovery was cancelled.');
  const tx = db.transaction(['notes', 'attachments', 'imports'], 'readwrite');
  const notes = tx.objectStore('notes');
  const source = await notes.get(sourceId);
  if (!source || source.revision !== expectedRevision) {
    if (source) throw new ConflictError(source);
    throw new Error('That local note no longer exists.');
  }
  if (source.role !== 'viewer') throw new Error('This note does not need view-only recovery.');
  const key = `recovery:${source.id}:${source.revision}:${fingerprint}`;
  const previous = await tx.objectStore('imports').get(key);
  if (previous) {
    const copy = await notes.get(previous.targetId);
    if (copy && !copy.deletedAt) { await tx.done; return copy; }
  }
  const id = uuid(), timestamp = now();
  const attachments = tx.objectStore('attachments');
  const files = await attachments.index('by-note').getAll(source.id);
  const referenceMap = new Map<string, string>();
  for (const file of files.filter(item => !item.deletedAt)) {
    const newId = uuid();
    referenceMap.set(file.id, `attachment:${newId}`);
    await attachments.add({ ...file, id: newId, noteId: id, serverVersion: null, syncState: 'dirty', deletedAt: null });
  }
  const body = createAttachmentRewriter(referenceMap)(patch.body ?? source.body);
  const { unavailable: _unavailable, ...sourceContent } = source;
  const copy: Note = { ...sourceContent, ...patch, id, body, title: `${(patch.title ?? source.title) || 'Untitled'} (recovered copy)`.slice(0, 300),
    notebookId: null, createdAt: timestamp, updatedAt: timestamp, deletedAt: null, revision: 1,
    serverVersion: null, syncState: 'dirty', role: 'owner' };
  await notes.add(copy);
  await tx.objectStore('imports').put({ key, targetId: copy.id });
  await tx.done;
  notifyStoreChanged(workspace);
  return copy;
}

async function copyUnavailableNoteToInbox(sourceId: string, expectedRevision: number, draftPatch: NotePatch = {}): Promise<Note> {
  const workspace = getWorkspaceId();
  if (!workspace) throw new Error('Recovery requires an account workspace.');
  return withWorkspaceLock(workspace, async () => {
    if (getWorkspaceId() !== workspace) throw new Error('Workspace changed; recovery was cancelled.');
    return copyUnavailableNoteToInboxLocked(sourceId, expectedRevision, draftPatch);
  });
}

/** A successful, explicitly reviewed recovery can acknowledge a missing share without deleting it. */
async function acknowledgeUnavailableNote(sourceId: string, expectedRevision: number, recoveredCopyId: string): Promise<void> {
  const workspace = getWorkspaceId();
  if (!workspace) throw new Error('Recovery requires an account workspace.');
  await withWorkspaceLock(workspace, async () => {
    if (getWorkspaceId() !== workspace) throw new Error('Workspace changed; acknowledgement was cancelled.');
    const db = await getWorkspaceDb(workspace);
    const tx = db.transaction(['notes', 'imports'], 'readwrite');
    const notes = tx.objectStore('notes'), imports = tx.objectStore('imports');
    const source = await notes.get(sourceId), copy = await notes.get(recoveredCopyId);
    if (!source || source.revision !== expectedRevision) {
      if (source) throw new ConflictError(source);
      throw new Error('The original local note no longer exists.');
    }
    if (source.role !== 'viewer' || source.syncState !== 'local') { await tx.done; return; }
    if (!copy || copy.deletedAt || copy.role !== 'owner' || copy.id === source.id) throw new Error('The recovered personal copy is not available.');
    const ledger = await imports.getAll();
    if (!ledger.some(item => item.key.startsWith(`recovery:${source.id}:${source.revision}:`) && item.targetId === copy.id)) {
      throw new Error('The personal copy does not match this recovery.');
    }
    await imports.put({ key: `ack-unavailable-note:${source.id}`, targetId: copy.id });
    await notes.put({ ...source, unavailable: 'recovered' });
    await tx.done;
    notifyStoreChanged(workspace);
  });
}

/** Explicitly retain an unavailable notebook locally; never delete or upload it. */
async function acknowledgeUnavailableNotebook(id: string, expectedRevision: number): Promise<void> {
  const workspace = getWorkspaceId();
  if (!workspace) throw new Error('This action requires an account workspace.');
  await withWorkspaceLock(workspace, async () => {
    if (getWorkspaceId() !== workspace) throw new Error('Workspace changed; acknowledgement was cancelled.');
    const db = await getWorkspaceDb(workspace);
    const tx = db.transaction('notebooks', 'readwrite');
    const notebook = await tx.store.get(id);
    if (!notebook) throw new Error('The cached notebook no longer exists.');
    if (notebook.revision !== expectedRevision) throw new Error('The notebook changed; review it again.');
    if (notebook.role !== 'viewer' || notebook.syncState !== 'local' || !notebook.unavailable) {
      throw new Error('This notebook is not unavailable.');
    }
    await tx.store.put({ ...notebook, unavailable: 'recovered' });
    await tx.done;
    notifyStoreChanged(workspace);
  });
}

async function listNotebooks(options: { includeDeleted?: boolean } = {}): Promise<Notebook[]> {
  return (await (await getWorkspaceDb()).getAll('notebooks')).filter(n => options.includeDeleted || !n.deletedAt).sort((a, b) => a.name.localeCompare(b.name));
}
function validateNotebookName(name: string): string {
  if (typeof name !== 'string' || !name.trim() || name.length > 150) throw new Error('Choose a notebook name (up to 150 characters).');
  return name.trim();
}
async function createNotebook(name: string): Promise<Notebook> {
  const workspace = getWorkspaceId();
  const timestamp = now();
  const notebook: Notebook = { id: uuid(), name: validateNotebookName(name), createdAt: timestamp, updatedAt: timestamp,
    deletedAt: null, revision: 1, serverVersion: null, syncState: stateForNew(workspace), role: 'owner' };
  await (await getWorkspaceDb(workspace)).add('notebooks', notebook);
  notifyStoreChanged(workspace);
  return notebook;
}
async function renameNotebook(id: string, name: string): Promise<Notebook> {
  const workspace = getWorkspaceId();
  const db = await getWorkspaceDb(workspace);
  const tx = db.transaction('notebooks', 'readwrite');
  const current = await tx.store.get(id);
  if (!current || current.deletedAt) { throw new Error('Notebook no longer exists.'); }
  requireEditable(current.role);
  const updated: Notebook = { ...current, name: validateNotebookName(name), updatedAt: now(), revision: current.revision + 1,
    syncState: stateForWrite(current.syncState, workspace) };
  await tx.store.put(updated); await tx.done;
  notifyStoreChanged(workspace);
  return updated;
}
async function deleteNotebook(id: string): Promise<void> {
  const workspace = getWorkspaceId();
  const db = await getWorkspaceDb(workspace);
  const tx = db.transaction(['notebooks', 'notes'], 'readwrite');
  const notebooks = tx.objectStore('notebooks');
  const current = await notebooks.get(id);
  if (!current || current.deletedAt) { throw new Error('Notebook no longer exists.'); }
  if (current.role !== 'owner') { throw new Error('Only the owner can delete this notebook.'); }
  const notes = tx.objectStore('notes');
  const affected = await notes.index('by-notebook').getAll(id);
  if (affected.some(note => note.role !== 'owner')) { throw new Error('Some notes cannot be moved from this notebook.'); }
  const timestamp = now();
  for (const note of affected) await notes.put({ ...note, notebookId: null, revision: note.revision + 1, updatedAt: timestamp,
    syncState: stateForWrite(note.syncState, workspace) });
  await notebooks.put({ ...current, deletedAt: timestamp, updatedAt: timestamp, revision: current.revision + 1,
    syncState: stateForWrite(current.syncState, workspace) });
  await tx.done;
  notifyStoreChanged(workspace);
}

async function listAttachments(noteId: string): Promise<Attachment[]> {
  const db = await getWorkspaceDb();
  return (await db.getAllFromIndex('attachments', 'by-note', noteId)).filter(attachment => !attachment.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
async function addAttachment(noteId: string, file: Blob, name: string): Promise<Attachment> {
  if (!(file instanceof Blob) || file.size > 10 * 1024 * 1024) throw new Error('Attachments must be 10 MB or smaller.');
  if (typeof name !== 'string' || !name.trim() || name.length > 255) throw new Error('Invalid attachment name.');
  const workspace = getWorkspaceId();
  const db = await getWorkspaceDb(workspace);
  const tx = db.transaction(['notes', 'attachments'], 'readwrite');
  const note = await tx.objectStore('notes').get(noteId);
  if (!note || note.deletedAt) { throw new Error('Note no longer exists.'); }
  requireEditable(note.role);
  const attachment: Attachment = { id: uuid(), noteId, name, mimeType: file.type || 'application/octet-stream', size: file.size, createdAt: now(), blob: file, deletedAt: null, serverVersion: null, syncState: stateForNew(workspace) };
  await tx.objectStore('attachments').add(attachment); await tx.done;
  notifyStoreChanged(workspace);
  return attachment;
}
async function deleteAttachment(id: string): Promise<void> {
  const workspace = getWorkspaceId();
  const db = await getWorkspaceDb(workspace);
  const tx = db.transaction(['notes', 'attachments'], 'readwrite');
  const attachments = tx.objectStore('attachments');
  const attachment = await attachments.get(id);
  if (!attachment) { await tx.done; return; }
  const note = await tx.objectStore('notes').get(attachment.noteId);
  if (note) requireEditable(note.role);
  if (workspace === null) await attachments.delete(id);
  else await attachments.put({ ...attachment, blob: new Blob([], { type: 'application/octet-stream' }), deletedAt: now(), syncState: 'dirty' });
  await tx.done;
  notifyStoreChanged(workspace);
}

interface BackupAttachment extends Omit<Attachment, 'blob'> { data: string }
interface BackupFile { format: 'jot-backup'; version: 1; exportedAt: string; notes: Note[]; notebooks: Notebook[]; attachments: BackupAttachment[] }
interface EncryptedBackup {
  format: 'jot-encrypted-backup'; version: 1; kdf: 'PBKDF2-SHA256'; iterations: number;
  salt: string; cipher: 'AES-256-GCM'; iv: string; ciphertext: string;
}
const BACKUP_LIMIT = 150 * 1024 * 1024;
const PBKDF2_ITERATIONS = 600_000;

function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 0x8000) result += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(result);
}
function base64ToBytes(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid backup encoding.');
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
async function snapshotWorkspace(workspace: string | null): Promise<{ notes: Note[]; notebooks: Notebook[]; attachments: Attachment[] }> {
  const db = await getWorkspaceDb(workspace);
  const tx = db.transaction(['notes', 'notebooks', 'attachments']);
  const [notes, notebooks, attachments] = await Promise.all([
    tx.objectStore('notes').getAll(), tx.objectStore('notebooks').getAll(), tx.objectStore('attachments').getAll(),
  ]);
  await tx.done;
  // A direct note share can legitimately refer to an unshared notebook. A
  // portable copy must not claim access to that notebook or contain a dangling
  // reference; preserve the note itself and place its copy in Inbox.
  const availableNotebooks = new Set(notebooks.filter(notebook => !notebook.deletedAt).map(notebook => notebook.id));
  const portableNotes = notes.map(note => note.notebookId && !availableNotebooks.has(note.notebookId) ? { ...note, notebookId: null } : note);
  // A deleted attachment is a sync tombstone, not backup content. Never export its bytes.
  return { notes: portableNotes, notebooks, attachments: attachments.filter(attachment => !attachment.deletedAt) };
}
async function makeBackup(workspace: string | null): Promise<BackupFile> {
  const snapshot = await snapshotWorkspace(workspace);
  const attachments = await Promise.all(snapshot.attachments.map(async ({ blob, ...attachment }) => ({
    ...attachment, data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
  })));
  return { format: 'jot-backup', version: 1, exportedAt: now(), notes: snapshot.notes, notebooks: snapshot.notebooks, attachments };
}
function encryptedHeader(value: Omit<EncryptedBackup, 'ciphertext'>): string {
  // Fixed property order makes every security-relevant header field authenticated.
  return JSON.stringify({ format: value.format, version: value.version, kdf: value.kdf, iterations: value.iterations,
    salt: value.salt, cipher: value.cipher, iv: value.iv });
}
async function backupKey(password: string, salt: Uint8Array, iterations: number, usages: KeyUsage[]): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) throw new Error('Encrypted backup requires HTTPS or localhost with Web Crypto.');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: copyBuffer(salt), iterations }, material,
    { name: 'AES-GCM', length: 256 }, false, usages);
}
async function encryptBackup(plaintext: string, password: string): Promise<EncryptedBackup> {
  if (password.length < 10 || password.length > 1024) throw new Error('Choose a backup password of at least 10 characters.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header: Omit<EncryptedBackup, 'ciphertext'> = { format: 'jot-encrypted-backup', version: 1, kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS, salt: bytesToBase64(salt), cipher: 'AES-256-GCM', iv: bytesToBase64(iv) };
  const key = await backupKey(password, salt, header.iterations, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(encryptedHeader(header)) }, key,
    new TextEncoder().encode(plaintext));
  return { ...header, ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}
async function decryptBackup(value: EncryptedBackup, password?: string): Promise<string> {
  if (!password) throw new Error('This backup is encrypted. Enter its password.');
  if (value.version !== 1 || value.kdf !== 'PBKDF2-SHA256' || value.cipher !== 'AES-256-GCM' ||
      !Number.isInteger(value.iterations) || value.iterations < PBKDF2_ITERATIONS || value.iterations > 2_000_000)
    throw new Error('Unsupported encrypted backup format.');
  const salt = base64ToBytes(value.salt), iv = base64ToBytes(value.iv), ciphertext = base64ToBytes(value.ciphertext);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) throw new Error('Invalid encrypted backup.');
  const header: Omit<EncryptedBackup, 'ciphertext'> = { format: value.format, version: value.version, kdf: value.kdf,
    iterations: value.iterations, salt: value.salt, cipher: value.cipher, iv: value.iv };
  try {
    const key = await backupKey(password, salt, value.iterations, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: copyBuffer(iv),
      additionalData: new TextEncoder().encode(encryptedHeader(header)) }, key, copyBuffer(ciphertext));
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch { throw new Error('Could not decrypt backup. Check the password and that the file is intact.'); }
}
async function exportBackup(password?: string): Promise<Blob> {
  const workspace = getWorkspaceId();
  const plain = JSON.stringify(await makeBackup(workspace));
  const result = password ? JSON.stringify(await encryptBackup(plain, password)) : plain;
  if (getWorkspaceId() !== workspace) throw new Error('Workspace changed; backup was not exported.');
  const blob = new Blob([result], { type: 'application/json' });
  assertBackupSize(blob);
  return blob;
}
function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/^\.+/, '').trim().slice(0, 100) || 'Untitled';
}
async function exportMarkdownZip(): Promise<Blob> {
  const workspace = getWorkspaceId();
  const JSZip = (await import('jszip')).default;
  if (getWorkspaceId() !== workspace) throw new Error('Workspace changed; export was cancelled.');
  const snapshot = await snapshotWorkspace(workspace);
  const zip = new JSZip();
  const attachmentPaths = new Map<string, string>();
  for (const attachment of snapshot.attachments) {
    const path = `attachments/${attachment.id}-${safeFilename(attachment.name)}`;
    attachmentPaths.set(attachment.id, path);
    zip.file(path, await attachment.blob.arrayBuffer());
  }
  const rewrite = createAttachmentRewriter(new Map([...attachmentPaths].map(([id, path]) => [id, `../${path}`])));
  for (const note of snapshot.notes) {
    const dir = note.deletedAt ? 'trash/' : 'notes/';
    const filename = `${dir}${safeFilename(note.title)}-${note.id}.md`;
    zip.file(filename, `# ${note.title || 'Untitled'}\n\n${rewrite(note.body)}`);
  }
  zip.file('manifest.json', JSON.stringify({ format: 'jot-markdown-export', version: 1, exportedAt: now(),
    notebooks: snapshot.notebooks, notes: snapshot.notes.map(({ body: _body, ...metadata }) => metadata) }, null, 2));
  const result = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  if (getWorkspaceId() !== workspace) throw new Error('Workspace changed; export was cancelled.');
  return result;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 200; }
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 32) return false;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === `${match[1]}.${(match[2] || '').padEnd(3, '0')}Z`;
}
/** Check actual UTF-8 bytes, not UTF-16 JavaScript string length. */
export function assertBackupSize(blob: Blob, limit = BACKUP_LIMIT): void {
  if (blob.size > limit) throw new Error('Backup exceeds the 150 MiB import limit. Export Markdown ZIP, or back up the server database for an account workspace.');
}
function validateBackup(value: unknown): BackupFile {
  if (!plainObject(value) || value.format !== 'jot-backup' || value.version !== 1 || !validDate(value.exportedAt) ||
      !Array.isArray(value.notes) || !Array.isArray(value.notebooks) || !Array.isArray(value.attachments) ||
      value.notes.length > 20_000 || value.notebooks.length > 5_000 || value.attachments.length > 20_000)
    throw new Error('This is not a supported Jot backup.');
  const noteIds = new Set<string>(), notebookIds = new Set<string>(), attachmentIds = new Set<string>();
  for (const notebook of value.notebooks) {
    if (!plainObject(notebook) || !validId(notebook.id) || notebookIds.has(notebook.id) ||
        typeof notebook.name !== 'string' || !notebook.name.trim() || notebook.name.length > 200 ||
        !validDate(notebook.createdAt) || !validDate(notebook.updatedAt) ||
        !(notebook.deletedAt === null || validDate(notebook.deletedAt))) throw new Error('Invalid notebook in backup.');
    notebookIds.add(notebook.id);
  }
  for (const note of value.notes) {
    if (!plainObject(note) || !validId(note.id) || noteIds.has(note.id) || typeof note.title !== 'string' || note.title.length > 300 ||
        typeof note.body !== 'string' || note.body.length > 1_000_000 || !Array.isArray(note.tags) || note.tags.length > 50 ||
        note.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 80) ||
        !(note.notebookId === null || validId(note.notebookId)) ||
        !validDate(note.createdAt) || !validDate(note.updatedAt) || !(note.deletedAt === null || validDate(note.deletedAt)) ||
        typeof note.pinned !== 'boolean') throw new Error('Invalid note in backup.');
    noteIds.add(note.id);
  }
  for (const attachment of value.attachments) {
    if (!plainObject(attachment) || !validId(attachment.id) || attachmentIds.has(attachment.id) ||
        !validId(attachment.noteId) || !noteIds.has(attachment.noteId) ||
        typeof attachment.name !== 'string' || !attachment.name || attachment.name.length > 255 ||
        typeof attachment.mimeType !== 'string' || attachment.mimeType.length > 255 ||
        typeof attachment.data !== 'string' || attachment.data.length > 15_000_000 || !validDate(attachment.createdAt) ||
        !Number.isInteger(attachment.size) || (attachment.size as number) < 0 || (attachment.size as number) > 10 * 1024 * 1024)
      throw new Error('Invalid attachment in backup.');
    attachmentIds.add(attachment.id);
  }
  return value as unknown as BackupFile;
}
/** Merge as new IDs so importing can never replace existing notes or attachments. */
async function mergeBackup(value: BackupFile, workspace: string | null): Promise<number> {
  const backup = validateBackup(value);
  const noteIds = new Map(backup.notes.map(note => [note.id, uuid()]));
  const notebookIds = new Map(backup.notebooks.map(notebook => [notebook.id, uuid()]));
  const attachmentIds = new Map(backup.attachments.map(attachment => [attachment.id, uuid()]));
  // Decode and validate everything before opening the write transaction.
  const attachments: Attachment[] = backup.attachments.map(attachment => {
    const data = base64ToBytes(attachment.data);
    if (data.length !== attachment.size) throw new Error('Attachment size does not match backup.');
    return { id: attachmentIds.get(attachment.id)!, noteId: noteIds.get(attachment.noteId)!, name: attachment.name,
      mimeType: attachment.mimeType, size: data.length, createdAt: attachment.createdAt,
      blob: new Blob([copyBuffer(data)], { type: attachment.mimeType }),
      deletedAt: attachment.deletedAt ?? null, serverVersion: null, syncState: stateForNew(workspace) };
  });
  const notebooks: Notebook[] = backup.notebooks.map(notebook => ({ id: notebookIds.get(notebook.id)!, name: notebook.name,
    createdAt: notebook.createdAt, updatedAt: notebook.updatedAt, deletedAt: notebook.deletedAt,
    revision: 1, serverVersion: null, syncState: stateForNew(workspace), role: 'owner' }));
  const rewrite = createAttachmentRewriter(new Map([...attachmentIds].map(([oldId, newId]) => [oldId, `attachment:${newId}`])));
  const notes: Note[] = backup.notes.map(note => {
    const body = rewrite(note.body);
    return { id: noteIds.get(note.id)!, title: note.title, body, tags: note.tags, notebookId: note.notebookId ? notebookIds.get(note.notebookId) ?? null : null,
      pinned: note.pinned, createdAt: note.createdAt, updatedAt: note.updatedAt, deletedAt: note.deletedAt,
      revision: 1, serverVersion: null, syncState: stateForNew(workspace), role: 'owner' };
  });
  if (getWorkspaceId() !== workspace) throw new Error('Workspace changed; import was cancelled.');
  const db = await getWorkspaceDb(workspace);
  if (getWorkspaceId() !== workspace) throw new Error('Workspace changed; import was cancelled.');
  const tx = db.transaction(['notes', 'notebooks', 'attachments'], 'readwrite');
  for (const notebook of notebooks) await tx.objectStore('notebooks').add(notebook);
  for (const note of notes) await tx.objectStore('notes').add(note);
  for (const attachment of attachments) await tx.objectStore('attachments').add(attachment);
  await tx.done;
  notifyStoreChanged(workspace);
  return notes.length;
}
async function importBackup(file: Blob, password?: string): Promise<void> {
  const workspace = getWorkspaceId();
  if (!(file instanceof Blob) || file.size > BACKUP_LIMIT) throw new Error('Choose a Jot backup no larger than 150 MiB.');
  let value: unknown;
  try { value = JSON.parse(await file.text()); } catch { throw new Error('Backup is not valid JSON.'); }
  if (plainObject(value) && value.format === 'jot-encrypted-backup') {
    const plaintext = await decryptBackup(value as unknown as EncryptedBackup, password);
    try { value = JSON.parse(plaintext); } catch { throw new Error('Decrypted backup is not valid JSON.'); }
  }
  if (getWorkspaceId() !== workspace) throw new Error('Workspace changed; import was cancelled.');
  const merge = async () => {
    if (getWorkspaceId() !== workspace) throw new Error('Workspace changed; import was cancelled.');
    await mergeBackup(validateBackup(value), workspace);
  };
  if (workspace) await withWorkspaceLock(workspace, merge); else await merge();
}
async function copyGuestNotesToAccountLocked(userId: string): Promise<number> {
  if (!userId || getWorkspaceId() !== userId) throw new Error('Switch to the matching signed-in account before copying guest notes.');
  const source = await snapshotWorkspace(null);
  if (getWorkspaceId() !== userId) throw new Error('Workspace changed; guest copy was cancelled.');
  const db = await getWorkspaceDb(userId);
  if (getWorkspaceId() !== userId) throw new Error('Workspace changed; guest copy was cancelled.');
  // The import ledger and copied records commit together. Readwrite transactions over
  // these stores serialize concurrent clicks and prevent duplicate imports.
  const tx = db.transaction(['notes', 'notebooks', 'attachments', 'imports'], 'readwrite');
  const imports = tx.objectStore('imports');
  const notesStore = tx.objectStore('notes');
  const notebooksStore = tx.objectStore('notebooks');
  const attachmentsStore = tx.objectStore('attachments');
  const notebookMap = new Map<string, string>();
  for (const notebook of source.notebooks.filter(item => !item.deletedAt)) {
    const key = `guest-notebook:${notebook.id}`;
    const previous = await imports.get(key);
    let target = previous && await notebooksStore.get(previous.targetId);
    if (!target || target.deletedAt) {
      target = { ...notebook, id: uuid(), deletedAt: null, revision: 1, serverVersion: null, syncState: 'dirty', role: 'owner' };
      await notebooksStore.add(target);
      await imports.put({ key, targetId: target.id });
    }
    notebookMap.set(notebook.id, target.id);
  }
  const newNotes: Note[] = [];
  const newNoteIds = new Map<string, string>();
  for (const note of source.notes.filter(item => !item.deletedAt)) {
    if (await imports.get(`guest-note:${note.id}`)) continue;
    newNoteIds.set(note.id, uuid());
    newNotes.push(note);
  }
  const sourceAttachments = source.attachments.filter(attachment => !attachment.deletedAt && newNoteIds.has(attachment.noteId));
  const attachmentIds = new Map(sourceAttachments.map(attachment => [attachment.id, uuid()]));
  const rewrite = createAttachmentRewriter(new Map([...attachmentIds].map(([oldId, newId]) => [oldId, `attachment:${newId}`])));
  for (const note of newNotes) {
    const body = rewrite(note.body);
    const target: Note = { ...note, id: newNoteIds.get(note.id)!, body,
      notebookId: note.notebookId ? notebookMap.get(note.notebookId) ?? null : null,
      revision: 1, serverVersion: null, syncState: 'dirty', role: 'owner' };
    await notesStore.add(target);
    await imports.put({ key: `guest-note:${note.id}`, targetId: target.id });
  }
  for (const attachment of sourceAttachments) {
    const target: Attachment = { ...attachment, id: attachmentIds.get(attachment.id)!, noteId: newNoteIds.get(attachment.noteId)!,
      serverVersion: null, syncState: 'dirty' };
    await attachmentsStore.add(target);
  }
  await tx.done;
  notifyStoreChanged(userId);
  return newNotes.length;
}
async function copyGuestNotesToAccount(userId: string): Promise<number> {
  if (!userId || getWorkspaceId() !== userId) throw new Error('Switch to the matching signed-in account before copying guest notes.');
  return withWorkspaceLock(userId, async () => {
    if (getWorkspaceId() !== userId) throw new Error('Workspace changed; guest copy was cancelled.');
    return copyGuestNotesToAccountLocked(userId);
  });
}


export const jotStore = {
  listNotes, getNote, createNote, updateNote, trashNote, restoreNote, createRecurringOccurrence, copyUnavailableNoteToInbox, acknowledgeUnavailableNote, acknowledgeUnavailableNotebook,
  listNotebooks, createNotebook, renameNotebook, deleteNotebook,
  listAttachments, addAttachment, deleteAttachment,
  exportBackup, importBackup, exportMarkdownZip, switchWorkspace, copyGuestNotesToAccount,
};
