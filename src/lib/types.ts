/** A workspace record is local-first; serverVersion is distinct from the local CAS revision. */
export type SyncState = 'local' | 'dirty' | 'synced' | 'conflict';
export type AccessRole = 'owner' | 'editor' | 'viewer';

export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  notebookId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revision: number;
  serverVersion: number | null;
  syncState: SyncState;
  role: AccessRole;
  pinned: boolean;
}

export interface Notebook {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revision: number;
  serverVersion: number | null;
  syncState: SyncState;
  role: AccessRole;
}

export interface Attachment {
  id: string;
  noteId: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  blob: Blob;
  deletedAt: string | null;
  serverVersion: number | null;
  syncState: SyncState;
}

export type NotePatch = Partial<Pick<Note, 'title' | 'body' | 'tags' | 'notebookId' | 'pinned'>>;
export type NewNote = NotePatch;
/** Reminders are best-effort while the app is open; they are not a background alarm. */
export interface Reminder { id: string; noteId: string; dueAt: string; completedAt: string | null; }
export interface NoteTask { id: string; noteId: string; text: string; completed: boolean; dueAt?: string | null; }
export interface Comment { id: string; noteId: string; author: { id: string; email: string }; body: string; createdAt: string; updatedAt: string; }

export type ServerNote = Omit<Note, 'revision' | 'serverVersion' | 'syncState' | 'role'>;
export type ServerNotebook = Omit<Notebook, 'revision' | 'serverVersion' | 'syncState' | 'role'>;
export interface ServerRecord<T> { note: T; version: number; role: AccessRole; }
export interface SyncResult { pushed: number; pulled: number; conflicts: number; errors: string[]; }
export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error';
export type SyncEntity = 'note' | 'notebook';
export interface OutboxChange {
  operationId: string;
  entity: SyncEntity;
  entityId: string;
  baseVersion: number;
  localRevision: number;
  snapshot: ServerNote | ServerNotebook;
  createdAt: string;
}
export interface SyncConflict {
  id: string; // `${entity}:${entityId}`
  entity: SyncEntity;
  entityId: string;
  /** Local draft and server version are kept separately until the user resolves. */
  local: Note | Notebook;
  server: ServerNote | ServerNotebook;
  serverVersion: number;
  role: AccessRole;
  detectedAt: string;
}
