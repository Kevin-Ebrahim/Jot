import { getWorkspaceDb, getWorkspaceId, notifyStoreChanged, ReadOnlyError } from './store';
import type { AccessRole, Attachment, Note, Notebook, OutboxChange, ServerNote, ServerNotebook, SyncConflict, SyncEntity, SyncResult } from './types';

export async function listConflicts(): Promise<SyncConflict[]> {
  const db = await getWorkspaceDb();
  const tx = db.transaction(['conflicts', 'notes', 'notebooks']);
  const conflicts = await tx.objectStore('conflicts').getAll();
  for (const conflict of conflicts) {
    const current = conflict.entity === 'note'
      ? await tx.objectStore('notes').get(conflict.entityId)
      : await tx.objectStore('notebooks').get(conflict.entityId);
    if (current) conflict.local = current;
  }
  await tx.done;
  return conflicts.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
}

/** The choice is explicit: never discard either side during automatic reconciliation. */
export async function resolveConflict(id: string, choice: 'local' | 'server' | 'both', expectedRevision: number, expectedServerVersion: number): Promise<void> {
  const workspace = getWorkspaceId();
  if (!workspace) throw new Error('Conflicts can only be resolved in an account workspace.');
  const db = await getWorkspaceDb(workspace);
  const tx = db.transaction(['notes', 'notebooks', 'attachments', 'outbox', 'conflicts'], 'readwrite');
  const conflicts = tx.objectStore('conflicts');
  const conflict = await conflicts.get(id);
  if (!conflict) throw new Error('That conflict has already been resolved.');
  if (conflict.serverVersion !== expectedServerVersion) throw new Error('The server version changed since review. Refresh the conflict before choosing.');
  const table = conflict.entity === 'note' ? tx.objectStore('notes') : tx.objectStore('notebooks');
  const current = await table.get(conflict.entityId) as Note | Notebook | undefined;
  if (!current) throw new Error('The local item no longer exists.');
  if (current.revision !== expectedRevision) throw new Error('The local item changed since review. Refresh the conflict before choosing.');
  if (choice === 'local') {
    if (conflict.role === 'viewer') throw new ReadOnlyError();
    if (current.deletedAt && conflict.role !== 'owner') throw new ReadOnlyError();
    await table.put({ ...current, serverVersion: conflict.serverVersion, role: conflict.role,
      syncState: 'dirty', revision: current.revision + 1 } as Note & Notebook);
  } else {
    if (choice === 'both') {
      const timestamp = new Date().toISOString();
      if (conflict.entity === 'note') {
        const local = current as Note;
        const attachments = tx.objectStore('attachments');
        const oldAttachments = await attachments.index('by-note').getAll(local.id);
        const copyId = crypto.randomUUID();
        let body = local.body;
        for (const attachment of oldAttachments.filter(item => !item.deletedAt)) {
          const newId = crypto.randomUUID();
          body = body.split(`attachment:${attachment.id}`).join(`attachment:${newId}`);
          await attachments.add({ ...attachment, id: newId, noteId: copyId,
            serverVersion: null, syncState: 'dirty', deletedAt: null });
        }
        const copy: Note = { ...local, id: copyId, body, title: `${local.title || 'Untitled'} (conflict copy)`.slice(0, 300),
          notebookId: null, createdAt: timestamp, updatedAt: timestamp, deletedAt: null,
          revision: 1, serverVersion: null, syncState: 'dirty', role: 'owner' };
        await tx.objectStore('notes').add(copy);
      } else {
        const local = current as Notebook;
        const copy: Notebook = { ...local, id: crypto.randomUUID(), name: `${local.name} (conflict copy)`.slice(0, 150),
          createdAt: timestamp, updatedAt: timestamp, deletedAt: null,
          revision: 1, serverVersion: null, syncState: 'dirty', role: 'owner' };
        await tx.objectStore('notebooks').add(copy);
      }
    }
    if (conflict.entity === 'note') {
      // Server wins on the original note. Unsent additions and local deletion
      // tombstones belong to the discarded draft: leaving them dirty would
      // upload/delete files after the user explicitly chose the server version.
      // For 'both', live local files were already copied to the new note above.
      const attachments = tx.objectStore('attachments');
      const localAttachments = await attachments.index('by-note').getAll(current.id);
      for (const attachment of localAttachments) {
        if (attachment.serverVersion === null || attachment.syncState !== 'synced') await attachments.delete(attachment.id);
      }
      const remote: Note = { ...conflict.server as ServerNote, revision: current.revision + 1,
        serverVersion: conflict.serverVersion, syncState: 'synced', role: conflict.role };
      await tx.objectStore('notes').put(remote);
    } else {
      const remote: Notebook = { ...conflict.server as ServerNotebook, revision: current.revision + 1,
        serverVersion: conflict.serverVersion, syncState: 'synced', role: conflict.role };
      await tx.objectStore('notebooks').put(remote);
    }
  }
  const pending = await tx.objectStore('outbox').index('by-entity').getAll(conflict.entityId);
  for (const operation of pending) if (operation.entity === conflict.entity) await tx.objectStore('outbox').delete(operation.operationId);
  await conflicts.delete(id);
  await tx.done;
  notifyStoreChanged(workspace);
}


type Entity = Note | Notebook;
type RemoteData = ServerNote | ServerNotebook;
interface Envelope { data: RemoteData; version: number; role: AccessRole }
interface RemoteAttachment {
  id: string; noteId: string; name: string; mimeType: string; size: number; createdAt: string; deletedAt: string | null;
}
class SyncHttpError extends Error {
  constructor(public status: number, message: string, public payload: Record<string, unknown> = {}) { super(message); }
}
const active = new Map<string, Promise<SyncResult>>();
const controllers = new Map<string, AbortController>();
const SYNC_TIMEOUT_MS = 20_000;
const validRole = (role: unknown): role is AccessRole => role === 'owner' || role === 'editor' || role === 'viewer';
const validId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validRemoteData(kind: SyncEntity, value: unknown): value is RemoteData {
  if (!object(value) || !validId(value.id) || !validDate(value.createdAt) || !validDate(value.updatedAt) ||
      !(value.deletedAt === null || validDate(value.deletedAt))) return false;
  if (kind === 'notebook') return typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 200;
  return typeof value.title === 'string' && value.title.length <= 300 && typeof value.body === 'string' && value.body.length <= 1_000_000 &&
    Array.isArray(value.tags) && value.tags.length <= 50 && value.tags.every(tag => typeof tag === 'string' && tag.length <= 80) &&
    (value.notebookId === null || validId(value.notebookId)) && typeof value.pinned === 'boolean';
}
function envelope(kind: SyncEntity, value: unknown): Envelope {
  if (!object(value)) throw new Error('Server returned an invalid sync record.');
  const data = value[kind];
  if (!validRemoteData(kind, data) || !Number.isSafeInteger(value.version) || (value.version as number) < 1 || !validRole(value.role)) {
    throw new Error('Server returned an invalid sync record.');
  }
  return { data, version: value.version as number, role: value.role };
}
function serverData(kind: SyncEntity, item: Entity): RemoteData {
  if (kind === 'note') {
    const { id, title, body, tags, notebookId, createdAt, updatedAt, deletedAt, pinned } = item as Note;
    return { id, title, body, tags, notebookId, createdAt, updatedAt, deletedAt, pinned };
  }
  const { id, name, createdAt, updatedAt, deletedAt } = item as Notebook;
  return { id, name, createdAt, updatedAt, deletedAt };
}
function localData(kind: SyncEntity, remote: Envelope, revision: number): Entity {
  return { ...remote.data, revision, serverVersion: remote.version, syncState: 'synced', role: remote.role } as Entity;
}
async function request(workspace: string, path: string, init: RequestInit = {}): Promise<Response> {
  if (getWorkspaceId() !== workspace) throw new Error('Workspace changed; sync paused.');
  const signal = controllers.get(workspace)?.signal;
  if (signal?.aborted) throw new Error('Sync timed out; pending changes remain on this device.');
  const headers = new Headers(init.headers);
  headers.set('X-Jot-Workspace', workspace);
  return fetch(path, { ...init, headers, signal, credentials: 'same-origin', cache: 'no-store' });
}
async function responseJson(response: Response): Promise<Record<string, unknown>> {
  let data: unknown;
  try { data = await response.json(); } catch { throw new SyncHttpError(response.status, 'Server returned an invalid response.'); }
  if (!object(data)) throw new SyncHttpError(response.status, 'Server returned an invalid response.');
  if (!response.ok) throw new SyncHttpError(response.status, typeof data.error === 'string' ? data.error : `Server returned ${response.status}.`, data);
  return data;
}
function addError(result: SyncResult, message: string): void { if (!result.errors.includes(message)) result.errors.push(message); }

async function queueOperation(workspace: string, kind: SyncEntity, id: string): Promise<OutboxChange | null> {
  const db = await getWorkspaceDb(workspace);
  const tx = db.transaction([kind === 'note' ? 'notes' : 'notebooks', 'outbox'], 'readwrite');
  const item = kind === 'note' ? await tx.objectStore('notes').get(id) : await tx.objectStore('notebooks').get(id);
  if (!item || item.syncState !== 'dirty' || item.role === 'viewer') { await tx.done; return null; }
  const pending = (await tx.objectStore('outbox').index('by-entity').getAll(id)).find(entry => entry.entity === kind);
  if (pending) { await tx.done; return pending; }
  const operation: OutboxChange = { operationId: crypto.randomUUID(), entity: kind, entityId: id,
    baseVersion: item.serverVersion ?? 0, localRevision: item.revision, snapshot: serverData(kind, item), createdAt: new Date().toISOString() };
  await tx.objectStore('outbox').add(operation);
  await tx.done;
  return operation;
}
async function recordConflict(workspace: string, kind: SyncEntity, id: string, remote: Envelope, pendingOperationId?: string): Promise<boolean> {
  const db = await getWorkspaceDb(workspace);
  const tx = db.transaction([kind === 'note' ? 'notes' : 'notebooks', 'outbox', 'conflicts'], 'readwrite');
  const store = kind === 'note' ? tx.objectStore('notes') : tx.objectStore('notebooks');
  const current = await store.get(id) as Entity | undefined;
  if (!current) { await tx.done; return false; }
  if (pendingOperationId && !await tx.objectStore('outbox').get(pendingOperationId)) { await tx.done; return false; }
  const previous = await tx.objectStore('conflicts').get(`${kind}:${id}`);
  if (previous && previous.serverVersion > remote.version) {
    if (pendingOperationId) await tx.objectStore('outbox').delete(pendingOperationId);
    await tx.done; return false;
  }
  const conflict: SyncConflict = { id: `${kind}:${id}`, entity: kind, entityId: id, local: current,
    server: remote.data, serverVersion: remote.version, role: remote.role, detectedAt: new Date().toISOString() };
  await tx.objectStore('conflicts').put(conflict);
  await store.put({ ...current, role: remote.role, syncState: 'conflict' } as Note & Notebook);
  if (pendingOperationId) await tx.objectStore('outbox').delete(pendingOperationId);
  await tx.done;
  notifyStoreChanged(workspace);
  return true;
}
async function acknowledge(workspace: string, operation: OutboxChange, remote: Envelope): Promise<void> {
  const db = await getWorkspaceDb(workspace);
  const tx = db.transaction([operation.entity === 'note' ? 'notes' : 'notebooks', 'outbox'], 'readwrite');
  const outbox = tx.objectStore('outbox');
  if (!await outbox.get(operation.operationId)) { await tx.done; return; }
  const store = operation.entity === 'note' ? tx.objectStore('notes') : tx.objectStore('notebooks');
  const current = await store.get(operation.entityId) as Entity | undefined;
  if (current) {
    const changedSinceSend = current.revision !== operation.localRevision;
    const state = current.syncState === 'conflict' ? 'conflict' : changedSinceSend ? 'dirty' : 'synced';
    await store.put({ ...current, serverVersion: Math.max(current.serverVersion ?? 0, remote.version),
      role: remote.role, syncState: state } as Note & Notebook);
  }
  await outbox.delete(operation.operationId);
  await tx.done;
  notifyStoreChanged(workspace);
}
/** A denied previously-synced item stays as a local, read-only copy; never re-upload it under a new identity. */
async function retireUnavailable(workspace: string, operation: OutboxChange): Promise<void> {
  const db = await getWorkspaceDb(workspace);
  const tx = db.transaction([operation.entity === 'note' ? 'notes' : 'notebooks', 'outbox'], 'readwrite');
  const outbox = tx.objectStore('outbox');
  if (!await outbox.get(operation.operationId)) { await tx.done; return; }
  const store = operation.entity === 'note' ? tx.objectStore('notes') : tx.objectStore('notebooks');
  const current = await store.get(operation.entityId) as Entity | undefined;
  if (current) await store.put({ ...current, syncState: 'local', role: 'viewer' } as Note & Notebook);
  await outbox.delete(operation.operationId);
  await tx.done;
  notifyStoreChanged(workspace);
}
async function handleAccessFailure(workspace: string, operation: OutboxChange, result: SyncResult): Promise<boolean> {
  const kind = operation.entity;
  const path = `/api/${kind === 'note' ? 'notes' : 'notebooks'}`;
  try {
    const data = await responseJson(await request(workspace, path));
    const raw = data[kind === 'note' ? 'notes' : 'notebooks'];
    if (!Array.isArray(raw)) return false;
    const records = raw.map(item => envelope(kind, item));
    const remote = records.find(item => item.data.id === operation.entityId);
    if (remote) {
      if (await recordConflict(workspace, kind, operation.entityId, remote, operation.operationId)) result.conflicts += 1;
      return true;
    }
    await retireUnavailable(workspace, operation);
    addError(result, `Access to this ${kind} or its destination was removed; your unsynced local copy was kept and will not be uploaded.`);
    return true;
  } catch { /* Network/session errors are inconclusive; retain the original operation for retry. */ }
  return false;
}
async function sendOperation(workspace: string, csrf: string, operation: OutboxChange, result: SyncResult): Promise<void> {
  const kind = operation.entity;
  const path = `/api/${kind === 'note' ? 'notes' : 'notebooks'}/${encodeURIComponent(operation.entityId)}`;
  try {
    const response = await request(workspace, path, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ baseVersion: operation.baseVersion, operationId: operation.operationId, [kind]: operation.snapshot }) });
    const data = await responseJson(response);
    const remote = envelope(kind, data);
    if (remote.data.id !== operation.entityId) throw new Error('Server returned a mismatched item.');
    await acknowledge(workspace, operation, remote);
    result.pushed += 1;
  } catch (cause) {
    if (cause instanceof SyncHttpError && cause.status === 409) {
      const remoteData = cause.payload[kind === 'note' ? 'serverNote' : 'serverNotebook'];
      const version = cause.payload.serverVersion;
      if (validRemoteData(kind, remoteData) && remoteData.id === operation.entityId && Number.isSafeInteger(version) && (version as number) > 0) {
        const db = await getWorkspaceDb(workspace);
        const current = kind === 'note' ? await db.get('notes', operation.entityId) : await db.get('notebooks', operation.entityId);
        if (current && await recordConflict(workspace, kind, operation.entityId,
          { data: remoteData, version: version as number, role: current.role }, operation.operationId)) result.conflicts += 1;
        return;
      }
    }
    if (cause instanceof SyncHttpError && (cause.status === 403 || cause.status === 404) &&
        !/csrf|origin/i.test(cause.message) && await handleAccessFailure(workspace, operation, result)) return;
    addError(result, `${kind === 'note' ? 'Note' : 'Notebook'} could not sync: ${cause instanceof Error ? cause.message : 'network error'}`);
    // The exact immutable operation stays in the outbox for a safe idempotent retry.
  }
}
async function reconcile(workspace: string, kind: SyncEntity, remote: Envelope): Promise<'pulled' | 'conflict' | 'unchanged'> {
  const db = await getWorkspaceDb(workspace);
  const tx = db.transaction([kind === 'note' ? 'notes' : 'notebooks', 'outbox', 'conflicts'], 'readwrite');
  const store = kind === 'note' ? tx.objectStore('notes') : tx.objectStore('notebooks');
  const current = await store.get(remote.data.id) as Entity | undefined;
  if (!current) {
    await store.add(localData(kind, remote, 1) as Note & Notebook); await tx.done; notifyStoreChanged(workspace); return 'pulled';
  }
  const pending = (await tx.objectStore('outbox').index('by-entity').getAll(current.id)).some(item => item.entity === kind);
  if (pending) { await tx.done; return 'unchanged'; }
  // A stale snapshot must never roll back a newer acknowledged server version.
  if ((current.serverVersion ?? 0) > remote.version) { await tx.done; return 'unchanged'; }
  const changedRemote = current.serverVersion !== remote.version;
  const unsynced = current.syncState === 'dirty' || current.syncState === 'conflict' || current.syncState === 'local';
  if ((changedRemote && unsynced) || (remote.role === 'viewer' && unsynced)) {
    const previous = await tx.objectStore('conflicts').get(`${kind}:${current.id}`);
    if (previous && previous.serverVersion > remote.version) { await tx.done; return 'unchanged'; }
    const conflict: SyncConflict = { id: `${kind}:${current.id}`, entity: kind, entityId: current.id, local: current,
      server: remote.data, serverVersion: remote.version, role: remote.role, detectedAt: new Date().toISOString() };
    await tx.objectStore('conflicts').put(conflict);
    await store.put({ ...current, role: remote.role, syncState: 'conflict' } as Note & Notebook);
    await tx.done; notifyStoreChanged(workspace); return 'conflict';
  }
  if (changedRemote) {
    await store.put(localData(kind, remote, current.revision + 1) as Note & Notebook);
    await tx.done; notifyStoreChanged(workspace); return 'pulled';
  }
  if (current.role !== remote.role) {
    await store.put({ ...current, role: remote.role } as Note & Notebook);
    await tx.done; notifyStoreChanged(workspace); return 'pulled';
  }
  await tx.done;
  return 'unchanged';
}
async function pull(workspace: string, result: SyncResult): Promise<void> {
  for (const kind of ['notebook', 'note'] as const) {
    const path = `/api/${kind === 'note' ? 'notes' : 'notebooks'}`;
    const data = await responseJson(await request(workspace, path));
    const raw = data[kind === 'note' ? 'notes' : 'notebooks'];
    if (!Array.isArray(raw)) throw new Error('Server returned an invalid workspace.');
    const records = raw.map(item => envelope(kind, item));
    const seen = new Set<string>();
    for (const remote of records) {
      if (seen.has(remote.data.id)) throw new Error('Server returned duplicate records.');
      seen.add(remote.data.id);
      const outcome = await reconcile(workspace, kind, remote);
      if (outcome === 'pulled') result.pulled += 1;
      if (outcome === 'conflict') result.conflicts += 1;
    }
    const db = await getWorkspaceDb(workspace);
    const locals = kind === 'note' ? await db.getAll('notes') : await db.getAll('notebooks');
    if (locals.some(item => item.serverVersion !== null && !seen.has(item.id))) {
      addError(result, `Some previously synced ${kind === 'note' ? 'notes' : 'notebooks'} are no longer accessible on the server; local copies were kept.`);
    }
  }
}

function remoteAttachment(value: unknown, noteId: string): RemoteAttachment {
  if (!object(value) || !validId(value.id) || value.noteId !== noteId || typeof value.name !== 'string' || !value.name || value.name.length > 255 ||
      typeof value.mimeType !== 'string' || value.mimeType.length > 127 || !Number.isSafeInteger(value.size) || (value.size as number) < 0 ||
      (value.size as number) > 10 * 1024 * 1024 || !validDate(value.createdAt) || !(value.deletedAt === null || validDate(value.deletedAt))) {
    throw new Error('Server returned invalid attachment metadata.');
  }
  return value as unknown as RemoteAttachment;
}
function safeBlobType(mime: string): string {
  const value = mime.toLowerCase();
  // Never turn untrusted HTML, SVG or script into active same-origin blob content.
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(value) || /^audio\/[a-z0-9!#$&^_.+-]+$/.test(value) ||
      value === 'application/pdf' || value === 'text/plain') return value;
  return 'application/octet-stream';
}
async function acknowledgeAttachment(workspace: string, metadata: RemoteAttachment): Promise<void> {
  const db = await getWorkspaceDb(workspace);
  const tx = db.transaction('attachments', 'readwrite');
  const current = await tx.store.get(metadata.id);
  if (current) {
    const pendingDelete = !!current.deletedAt && !metadata.deletedAt;
    await tx.store.put({ ...current, name: metadata.name, mimeType: metadata.mimeType,
      serverVersion: metadata.deletedAt ? 2 : 1, deletedAt: current.deletedAt ?? metadata.deletedAt,
      syncState: pendingDelete ? 'dirty' : 'synced' });
  }
  await tx.done;
  notifyStoreChanged(workspace);
}
async function syncAttachments(workspace: string, csrf: string, result: SyncResult): Promise<void> {
  const db = await getWorkspaceDb(workspace);
  // A conflicted/dirty note must not leak attachments from its unresolved draft.
  const notes = (await db.getAll('notes')).filter(note => note.serverVersion !== null && note.syncState === 'synced');
  for (const note of notes) {
    if (controllers.get(workspace)?.signal.aborted) break;
    try {
      const prefix = `/api/notes/${encodeURIComponent(note.id)}/attachments`;
      const list = await responseJson(await request(workspace, prefix));
      if (!Array.isArray(list.attachments)) throw new Error('Server returned an invalid attachment list.');
      const remote = list.attachments.map(item => remoteAttachment(item, note.id));
      const remoteById = new Map(remote.map(item => [item.id, item]));
      if (remoteById.size !== remote.length) throw new Error('Server returned duplicate attachment IDs.');
      const local = await db.getAllFromIndex('attachments', 'by-note', note.id);
      for (const item of local) {
        const server = remoteById.get(item.id);
        const path = `${prefix}/${encodeURIComponent(item.id)}`;
        if (item.deletedAt) {
          if (server && !server.deletedAt) {
            if (note.role === 'viewer') { addError(result, 'An attachment deletion is waiting for edit access.'); continue; }
            const response = await responseJson(await request(workspace, path, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf } }));
            await acknowledgeAttachment(workspace, remoteAttachment(response.attachment, note.id));
            result.pushed += 1;
          } else if (server?.deletedAt) {
            await acknowledgeAttachment(workspace, server);
          } else if (item.serverVersion === null) {
            // Retain the tombstone in case an upload in another tab finishes later.
            const tx = db.transaction('attachments', 'readwrite');
            const latest = await tx.store.get(item.id);
            if (latest?.deletedAt && latest.serverVersion === null) await tx.store.put({ ...latest, syncState: 'synced' });
            await tx.done;
          } else {
            addError(result, 'An attachment is missing on the server; its local copy was kept.');
          }
          continue;
        }
        if (server?.deletedAt) {
          if (item.serverVersion === null && item.syncState === 'dirty') {
            addError(result, `An attachment named “${item.name}” was deleted remotely; the local copy was kept.`);
          } else {
            const tx = db.transaction('attachments', 'readwrite');
            const latest = await tx.store.get(item.id);
            if (latest && !latest.deletedAt && latest.serverVersion !== null) {
              await tx.store.put({ ...latest, blob: new Blob([], { type: 'application/octet-stream' }), deletedAt: server.deletedAt, serverVersion: 2, syncState: 'synced' });
            }
            await tx.done;
            notifyStoreChanged(workspace);
          }
          continue;
        }
        if (item.serverVersion === null) {
          if (note.role === 'viewer') { addError(result, 'An attachment is waiting for edit access.'); continue; }
          const response = await responseJson(await request(workspace, path, { method: 'PUT',
            headers: { 'X-CSRF-Token': csrf, 'X-Jot-Filename': encodeURIComponent(item.name),
              'X-Jot-Created-At': item.createdAt, 'Content-Type': item.mimeType || 'application/octet-stream' }, body: item.blob }));
          await acknowledgeAttachment(workspace, remoteAttachment(response.attachment, note.id));
          result.pushed += 1;
        } else if (!server) {
          addError(result, 'An attachment is missing on the server; its local copy was kept.');
        }
      }
      // Read additions only after local pushes/deletions; never overwrite a local blob.
      for (const metadata of remote) {
        if (metadata.deletedAt || await db.get('attachments', metadata.id)) continue;
        const response = await request(workspace, `${prefix}/${encodeURIComponent(metadata.id)}`);
        if (!response.ok) { await responseJson(response); continue; }
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== metadata.size) throw new Error('Downloaded attachment size did not match.');
        const attachment: Attachment = { ...metadata, blob: new Blob([bytes], { type: safeBlobType(metadata.mimeType) }),
          serverVersion: 1, syncState: 'synced' };
        const tx = db.transaction('attachments', 'readwrite');
        if (!await tx.store.get(metadata.id)) { await tx.store.add(attachment); result.pulled += 1; }
        await tx.done;
        notifyStoreChanged(workspace);
      }
    } catch (cause) {
      addError(result, `Attachments for “${note.title || 'Untitled'}” could not sync: ${cause instanceof Error ? cause.message : 'network error'}`);
    }
  }
}
function orderOutbox(a: OutboxChange, b: OutboxChange): number {
  const rank = (operation: OutboxChange) => operation.entity === 'notebook' ? (operation.snapshot.deletedAt ? 2 : 0) : 1;
  return rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt);
}
async function performSync(workspace: string): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, pulled: 0, conflicts: 0, errors: [] };
  const sessionResponse = await request(workspace, '/api/auth/session');
  const session = await responseJson(sessionResponse);
  if (!object(session.user) || session.user.id !== workspace || typeof session.csrfToken !== 'string' || !session.csrfToken) {
    throw new Error('Sign in to the matching account before syncing this workspace.');
  }
  const csrf = session.csrfToken;
  const db = await getWorkspaceDb(workspace);
  // Replay the exact durable operation before pulling; a lost response may have
  // already committed on the server, where the operation receipt makes it safe.
  const pending = (await db.getAll('outbox')).sort(orderOutbox);
  for (const operation of pending) {
    if (controllers.get(workspace)?.signal.aborted) break;
    await sendOperation(workspace, csrf, operation, result);
  }
  try { await pull(workspace, result); }
  catch (cause) { addError(result, `Could not read the server workspace: ${cause instanceof Error ? cause.message : 'network error'}`); return result; }
  const notebooks = await db.getAll('notebooks');
  const notes = await db.getAll('notes');
  // Create/update notebooks before their notes, but delete notebooks after moving
  // notes out, avoiding needless remote version bumps on detach.
  const candidates: Array<{ kind: SyncEntity; id: string }> = [
    ...notebooks.filter(item => item.syncState === 'dirty' && !item.deletedAt).map(item => ({ kind: 'notebook' as const, id: item.id })),
    ...notes.filter(item => item.syncState === 'dirty').map(item => ({ kind: 'note' as const, id: item.id })),
    ...notebooks.filter(item => item.syncState === 'dirty' && !!item.deletedAt).map(item => ({ kind: 'notebook' as const, id: item.id })),
  ];
  for (const candidate of candidates) {
    if (controllers.get(workspace)?.signal.aborted) break;
    const operation = await queueOperation(workspace, candidate.kind, candidate.id);
    if (operation) await sendOperation(workspace, csrf, operation, result);
  }
  try { await pull(workspace, result); }
  catch (cause) { addError(result, `Could not refresh the server workspace: ${cause instanceof Error ? cause.message : 'network error'}`); }
  await syncAttachments(workspace, csrf, result);
  // Count the outstanding records once, not the same conflict from both pulls.
  result.conflicts = (await db.getAll('conflicts')).length;
  const remainingNotes = await db.getAll('notes');
  const remainingNotebooks = await db.getAll('notebooks');
  const remainingOutbox = await db.count('outbox');
  if (remainingOutbox || remainingNotes.some(item => item.syncState === 'dirty') || remainingNotebooks.some(item => item.syncState === 'dirty')) {
    addError(result, 'Some newer changes are still waiting to sync.');
  }
  return result;
}

/** Sync only a verified matching account; multiple calls in a tab share one run. */
export function syncWorkspace(): Promise<SyncResult> {
  const workspace = getWorkspaceId();
  if (!workspace) return Promise.reject(new Error('Sign in before syncing.'));
  const existing = active.get(workspace);
  if (existing) return existing;
  const controller = new AbortController();
  controllers.set(workspace, controller);
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  const job = performSync(workspace).finally(() => {
    clearTimeout(timer);
    if (controllers.get(workspace) === controller) controllers.delete(workspace);
    if (active.get(workspace) === job) active.delete(workspace);
  });
  active.set(workspace, job);
  return job;
}
