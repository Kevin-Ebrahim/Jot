import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors';
import type { PublicUser } from './auth';
import type { Role, ServerNote, ServerNotebook, ShareRole } from './validation';
import { cipherFor, type ContentCipher } from './content-crypto';

interface RecordRow { id: string; owner_id: string; version: number; data_json: string; deleted_at: string | null }
interface NoteRow extends RecordRow { notebook_id: string | null }
interface RoleRow extends RecordRow { role: Role }
interface NoteRoleRow extends NoteRow { role: Role }
interface Receipt { target: string; payload_hash: string; result_version: number; created_at: number }
export interface Envelope<T> { note?: T; notebook?: T; version: number; role: Role }
export interface Share { user: PublicUser; role: ShareRole }
export interface Comment { id: string; noteId: string; author: PublicUser; body: string; createdAt: string; updatedAt: string }
export interface AttachmentMetadata { id: string; noteId: string; name: string; mimeType: string; size: number; createdAt: string; deletedAt: string | null }
interface AttachmentRow { id: string; note_id: string; name: string; mime_type: string; size: number; created_at: string; deleted_at: string | null; sha256: string; data: Uint8Array | null }
function attachmentMetadata(row: AttachmentRow, cipher: ContentCipher): AttachmentMetadata {
  return { id: row.id, noteId: row.note_id, name: cipher.openText(row.name, `attachment-name:${row.id}`), mimeType: row.mime_type, size: row.size, createdAt: row.created_at, deletedAt: row.deleted_at };
}

type Kind = 'note' | 'notebook';
function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECEIPTS_PER_ACCOUNT = 10_000;
function receipt(db: DatabaseSync, userId: string, operationId: string, target: string, payloadHash: string): number | null {
  const row = db.prepare('SELECT target, payload_hash, result_version, created_at FROM operations WHERE user_id = ? AND operation_id = ?')
    .get(userId, operationId) as unknown as Receipt | undefined;
  if (!row) return null;
  if (row.created_at < Date.now() - RECEIPT_TTL_MS) {
    db.prepare('DELETE FROM operations WHERE user_id = ? AND operation_id = ?').run(userId, operationId);
    return null;
  }
  if (row.target !== target || row.payload_hash !== payloadHash) throw new HttpError(409, 'Operation id was already used with different content');
  return row.result_version;
}
function saveReceipt(db: DatabaseSync, userId: string, operationId: string, target: string, payloadHash: string, resultVersion: number): void {
  const now = Date.now();
  db.prepare('DELETE FROM operations WHERE created_at < ?').run(now - RECEIPT_TTL_MS);
  db.prepare('INSERT INTO operations (user_id, operation_id, target, payload_hash, result_version, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, operationId, target, payloadHash, resultVersion, now);
  db.prepare(`DELETE FROM operations WHERE user_id = ? AND operation_id IN (
    SELECT operation_id FROM operations WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
  )`).run(userId, userId, MAX_RECEIPTS_PER_ACCOUNT);
}
function openNote(row: RecordRow, cipher: ContentCipher): ServerNote {
  return JSON.parse(cipher.openText(row.data_json, `note:${row.id}`)) as ServerNote;
}
function openNotebook(row: RecordRow, cipher: ContentCipher): ServerNotebook {
  return JSON.parse(cipher.openText(row.data_json, `notebook:${row.id}`)) as ServerNotebook;
}
function noteEnvelope(row: NoteRoleRow, cipher: ContentCipher): { note: ServerNote; version: number; role: Role } {
  return { note: openNote(row, cipher), version: row.version, role: row.role };
}
function notebookEnvelope(row: RoleRow, cipher: ContentCipher): { notebook: ServerNotebook; version: number; role: Role } {
  return { notebook: openNotebook(row, cipher), version: row.version, role: row.role };
}

// A notebook grant covers its notes; direct and inherited permissions combine
// using the stronger role. Once a notebook is trashed, it grants no note access.
const noteSelect = `SELECT n.*,
  CASE WHEN n.owner_id = ? THEN 'owner'
       WHEN direct.role = 'editor' OR inherited.role = 'editor' THEN 'editor'
       WHEN direct.role = 'viewer' OR inherited.role = 'viewer' THEN 'viewer'
       ELSE NULL END AS role
  FROM notes n
  LEFT JOIN note_shares direct ON direct.note_id = n.id AND direct.user_id = ?
  LEFT JOIN notebooks b ON b.id = n.notebook_id AND b.deleted_at IS NULL
  LEFT JOIN notebook_shares inherited ON inherited.notebook_id = b.id AND inherited.user_id = ?`;
const notebookSelect = `SELECT b.*,
  CASE WHEN b.owner_id = ? THEN 'owner' ELSE shared.role END AS role
  FROM notebooks b LEFT JOIN notebook_shares shared ON shared.notebook_id = b.id AND shared.user_id = ?`;

export class Repository {
  private readonly cipher: ContentCipher;
  constructor(private readonly db: DatabaseSync) { this.cipher = cipherFor(db); }
  private noteRow(userId: string, noteId: string): NoteRoleRow | undefined {
    const row = this.db.prepare(`${noteSelect} WHERE n.id = ?`).get(userId, userId, userId, noteId) as unknown as NoteRoleRow | undefined;
    return row?.role ? row : undefined;
  }
  private notebookRow(userId: string, notebookId: string): RoleRow | undefined {
    const row = this.db.prepare(`${notebookSelect} WHERE b.id = ?`).get(userId, userId, notebookId) as unknown as RoleRow | undefined;
    return row?.role ? row : undefined;
  }
  private ownerRow(kind: Kind, userId: string, resourceId: string): RecordRow {
    const row = kind === 'note' ? this.noteRow(userId, resourceId) : this.notebookRow(userId, resourceId);
    if (!row) throw new HttpError(404, `${kind === 'note' ? 'Note' : 'Notebook'} not found`);
    if (row.role !== 'owner') throw new HttpError(403, 'Only the owner can manage sharing');
    return row;
  }
  listNotes(userId: string): Array<{ note: ServerNote; version: number; role: Role }> {
    const rows = this.db.prepare(`${noteSelect} WHERE n.owner_id = ? OR direct.user_id IS NOT NULL OR inherited.user_id IS NOT NULL`)
      .all(userId, userId, userId, userId) as unknown as NoteRoleRow[];
    return rows.map((row) => noteEnvelope(row, this.cipher));
  }
  listNotebooks(userId: string): Array<{ notebook: ServerNotebook; version: number; role: Role }> {
    const rows = this.db.prepare(`${notebookSelect} WHERE b.owner_id = ? OR shared.user_id IS NOT NULL`)
      .all(userId, userId, userId) as unknown as RoleRow[];
    return rows.map((row) => notebookEnvelope(row, this.cipher));
  }
  putNote(userId: string, operationId: string, baseVersion: number, input: ServerNote): { note: ServerNote; version: number; role: Role } {
    const payloadHash = this.cipher.fingerprint(JSON.stringify({ baseVersion, note: input }));
    const target = `note:${input.id}`;
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(input.id) as unknown as NoteRow | undefined;
      const current = existing ? this.noteRow(userId, input.id) : undefined;
      if (existing && !current) throw new HttpError(404, 'Note not found');
      const prior = receipt(this.db, userId, operationId, target, payloadHash);
      if (prior !== null) {
        if (!current) throw new HttpError(404, 'Note not found');
        // A later edit makes the original response unavailable; a conflict is
        // safer than acknowledging the wrong version or retaining note bodies.
        if (current.version !== prior) throw new HttpError(409, 'conflict', { serverVersion: current.version, serverNote: openNote(current, this.cipher) });
        return noteEnvelope(current, this.cipher);
      }
      if (current?.role === 'viewer') throw new HttpError(403, 'This note is read-only');
      if (existing && existing.version !== baseVersion) {
        throw new HttpError(409, 'conflict', { serverVersion: existing.version, serverNote: openNote(existing, this.cipher) });
      }
      if (!existing && baseVersion !== 0) throw new HttpError(409, 'Note does not exist');
      if (existing && current?.role !== 'owner' && existing.notebook_id !== input.notebookId) {
        throw new HttpError(403, 'Only the owner can move a note');
      }
      if (existing && current?.role !== 'owner' && existing.deleted_at !== input.deletedAt) {
        throw new HttpError(403, 'Only the owner can trash or restore a note');
      }
      let ownerId = existing?.owner_id || userId;
      // Direct access to a note does not imply access to its notebook. Check
      // the destination only for creation or an actual move.
      if (input.notebookId && (!existing || existing.notebook_id !== input.notebookId)) {
        const notebook = this.notebookRow(userId, input.notebookId);
        if (!notebook || notebook.deleted_at) throw new HttpError(404, 'Notebook not found');
        if (notebook.role === 'viewer') throw new HttpError(403, 'This notebook is read-only');
        if (existing && notebook.owner_id !== existing.owner_id) throw new HttpError(403, 'Notes cannot be moved between owners');
        if (!existing) ownerId = notebook.owner_id;
      }
      const version = (existing?.version || 0) + 1;
      const stored = this.cipher.sealText(JSON.stringify(input), `note:${input.id}`);
      if (existing) {
        this.db.prepare('UPDATE notes SET notebook_id = ?, version = ?, data_json = ?, deleted_at = ? WHERE id = ?')
          .run(input.notebookId, version, stored, input.deletedAt, input.id);
      } else {
        this.db.prepare('INSERT INTO notes (id, owner_id, notebook_id, version, data_json, deleted_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(input.id, ownerId, input.notebookId, version, stored, input.deletedAt);
      }
      const updated = this.noteRow(userId, input.id);
      if (!updated) throw new HttpError(403, 'No access to note');
      const response = noteEnvelope(updated, this.cipher);
      saveReceipt(this.db, userId, operationId, target, payloadHash, response.version);
      return response;
    });
  }
  putNotebook(userId: string, operationId: string, baseVersion: number, input: ServerNotebook): { notebook: ServerNotebook; version: number; role: Role } {
    const payloadHash = this.cipher.fingerprint(JSON.stringify({ baseVersion, notebook: input }));
    const target = `notebook:${input.id}`;
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM notebooks WHERE id = ?').get(input.id) as unknown as RecordRow | undefined;
      const current = existing ? this.notebookRow(userId, input.id) : undefined;
      if (existing && !current) throw new HttpError(404, 'Notebook not found');
      const prior = receipt(this.db, userId, operationId, target, payloadHash);
      if (prior !== null) {
        if (!current) throw new HttpError(404, 'Notebook not found');
        if (current.version !== prior) throw new HttpError(409, 'conflict', { serverVersion: current.version, serverNotebook: openNotebook(current, this.cipher) });
        return notebookEnvelope(current, this.cipher);
      }
      if (current?.role === 'viewer') throw new HttpError(403, 'This notebook is read-only');
      if (existing && existing.version !== baseVersion) {
        throw new HttpError(409, 'conflict', { serverVersion: existing.version, serverNotebook: openNotebook(existing, this.cipher) });
      }
      if (!existing && baseVersion !== 0) throw new HttpError(409, 'Notebook does not exist');
      if (existing && existing.deleted_at !== input.deletedAt && current?.role !== 'owner') {
        throw new HttpError(403, 'Only the owner can trash or restore a notebook');
      }
      const version = (existing?.version || 0) + 1;
      const stored = this.cipher.sealText(JSON.stringify(input), `notebook:${input.id}`);
      if (existing) {
        this.db.prepare('UPDATE notebooks SET version = ?, data_json = ?, deleted_at = ? WHERE id = ?')
          .run(version, stored, input.deletedAt, input.id);
      } else {
        this.db.prepare('INSERT INTO notebooks (id, owner_id, version, data_json, deleted_at) VALUES (?, ?, ?, ?, ?)')
          .run(input.id, userId, version, stored, input.deletedAt);
      }
      // A deleted notebook does not delete notes. Detach them atomically and
      // bump each note's version so stale offline changes conflict safely.
      if (existing && !existing.deleted_at && input.deletedAt) {
        const notes = this.db.prepare('SELECT * FROM notes WHERE notebook_id = ?').all(input.id) as unknown as NoteRow[];
        const update = this.db.prepare('UPDATE notes SET notebook_id = NULL, version = ?, data_json = ? WHERE id = ?');
        const now = new Date().toISOString();
        for (const item of notes) {
          const note = openNote(item, this.cipher);
          note.notebookId = null;
          note.updatedAt = now;
          update.run(item.version + 1, this.cipher.sealText(JSON.stringify(note), `note:${item.id}`), item.id);
        }
      }
      const updated = this.notebookRow(userId, input.id);
      if (!updated) throw new HttpError(403, 'No access to notebook');
      const response = notebookEnvelope(updated, this.cipher);
      saveReceipt(this.db, userId, operationId, target, payloadHash, response.version);
      return response;
    });
  }
  listShares(kind: Kind, userId: string, resourceId: string): Share[] {
    this.ownerRow(kind, userId, resourceId);
    const table = kind === 'note' ? 'note_shares' : 'notebook_shares';
    const column = kind === 'note' ? 'note_id' : 'notebook_id';
    const rows = this.db.prepare(`SELECT users.id, users.email, shares.role FROM ${table} shares JOIN users ON users.id = shares.user_id WHERE shares.${column} = ? ORDER BY users.email`)
      .all(resourceId) as unknown as Array<{ id: string; email: string; role: ShareRole }>;
    return rows.map((row) => ({ user: { id: row.id, email: row.email }, role: row.role }));
  }
  changeShare(kind: Kind, userId: string, resourceId: string, targetEmail: string, role: ShareRole | null): Share[] {
    return transaction(this.db, () => {
      this.ownerRow(kind, userId, resourceId);
      const target = this.db.prepare('SELECT id FROM users WHERE email = ?').get(targetEmail) as unknown as { id: string } | undefined;
      if (!target) throw new HttpError(404, 'Account not found');
      if (target.id === userId) throw new HttpError(400, 'The owner already has access');
      const table = kind === 'note' ? 'note_shares' : 'notebook_shares';
      const column = kind === 'note' ? 'note_id' : 'notebook_id';
      if (role) this.db.prepare(`INSERT INTO ${table} (${column}, user_id, role) VALUES (?, ?, ?) ON CONFLICT(${column}, user_id) DO UPDATE SET role = excluded.role`)
        .run(resourceId, target.id, role);
      else this.db.prepare(`DELETE FROM ${table} WHERE ${column} = ? AND user_id = ?`).run(resourceId, target.id);
      return this.listShares(kind, userId, resourceId);
    });
  }
  listComments(userId: string, noteId: string): Comment[] {
    if (!this.noteRow(userId, noteId)) throw new HttpError(404, 'Note not found');
    const rows = this.db.prepare(`SELECT c.id, c.note_id, c.body, c.created_at, c.updated_at, u.id AS author_id, u.email AS author_email
      FROM comments c JOIN users u ON u.id = c.author_id WHERE c.note_id = ? ORDER BY c.created_at, c.id`).all(noteId) as unknown as Array<{
        id: string; note_id: string; body: string; created_at: string; updated_at: string; author_id: string; author_email: string;
      }>;
    return rows.map((row) => ({ id: row.id, noteId: row.note_id, author: { id: row.author_id, email: row.author_email }, body: this.cipher.openText(row.body, `comment:${row.id}`), createdAt: row.created_at, updatedAt: row.updated_at }));
  }
  addComment(user: PublicUser, noteId: string, body: string): Comment {
    return transaction(this.db, () => {
      const row = this.noteRow(user.id, noteId);
      if (!row) throw new HttpError(404, 'Note not found');
      if (row.role === 'viewer') throw new HttpError(403, 'This note is read-only');
      const now = new Date().toISOString();
      const comment = { id: randomUUID(), noteId, author: user, body, createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO comments (id, note_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(comment.id, noteId, user.id, this.cipher.sealText(body, `comment:${comment.id}`), now, now);
      return comment;
    });
  }
  deleteComment(userId: string, noteId: string, commentId: string): void {
    transaction(this.db, () => {
      const note = this.noteRow(userId, noteId);
      if (!note) throw new HttpError(404, 'Note not found');
      if (note.role === 'viewer') throw new HttpError(403, 'This note is read-only');
      const comment = this.db.prepare('SELECT author_id FROM comments WHERE id = ? AND note_id = ?').get(commentId, noteId) as unknown as { author_id: string } | undefined;
      if (!comment) throw new HttpError(404, 'Comment not found');
      if (comment.author_id !== userId && note.role !== 'owner') throw new HttpError(403, 'Only the author or note owner can delete this comment');
      this.db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
    });
  }
  /** Authorize both before reading a body and inside the final write transaction. */
  requireAttachmentAccess(userId: string, noteId: string, write = false): number {
    const note = this.noteRow(userId, noteId);
    if (!note) throw new HttpError(404, 'Note not found');
    if (write && note.role === 'viewer') throw new HttpError(403, 'This note is read-only');
    return note.version;
  }
  listAttachments(userId: string, noteId: string): AttachmentMetadata[] {
    this.requireAttachmentAccess(userId, noteId);
    const rows = this.db.prepare('SELECT id, note_id, name, mime_type, size, created_at, deleted_at FROM attachments WHERE note_id = ? ORDER BY created_at, id')
      .all(noteId) as unknown as AttachmentRow[];
    return rows.map((row) => attachmentMetadata(row, this.cipher));
  }
  putAttachment(userId: string, noteId: string, attachmentId: string, name: string, mimeType: string, createdAt: string, data: Uint8Array, expectedNoteVersion: number): AttachmentMetadata {
    const sha = this.cipher.fingerprint(data);
    return transaction(this.db, () => {
      const currentVersion = this.requireAttachmentAccess(userId, noteId, true);
      if (currentVersion !== expectedNoteVersion) throw new HttpError(409, 'Note version changed; refresh before modifying attachments', { serverVersion: currentVersion });
      const existing = this.db.prepare('SELECT id, note_id, name, mime_type, size, created_at, deleted_at, sha256 FROM attachments WHERE id = ?')
        .get(attachmentId) as unknown as AttachmentRow | undefined;
      if (existing) {
        if (existing.note_id !== noteId) throw new HttpError(404, 'Attachment not found');
        if (existing.deleted_at) throw new HttpError(409, 'A deleted attachment cannot be recreated');
        if (existing.sha256 !== sha || existing.size !== data.byteLength || this.cipher.openText(existing.name, `attachment-name:${existing.id}`) !== name || existing.mime_type !== mimeType || existing.created_at !== createdAt) {
          throw new HttpError(409, 'Attachment id was already used with different content');
        }
        return attachmentMetadata(existing, this.cipher);
      }
      const owner = this.db.prepare('SELECT owner_id FROM notes WHERE id = ?').get(noteId) as unknown as { owner_id: string };
      const total = this.db.prepare(`SELECT COALESCE(SUM(a.size), 0) AS total FROM attachments a
        JOIN notes n ON n.id = a.note_id WHERE n.owner_id = ? AND a.deleted_at IS NULL`).get(owner.owner_id) as unknown as { total: number };
      const count = this.db.prepare(`SELECT COUNT(*) AS total FROM attachments a
        JOIN notes n ON n.id = a.note_id WHERE n.owner_id = ?`).get(owner.owner_id) as unknown as { total: number };
      const configuredLimit = process.env.JOT_MAX_USER_STORAGE_BYTES;
      const quota = configuredLimit === undefined ? 1024 * 1024 * 1024 : Number(configuredLimit);
      if (!Number.isSafeInteger(quota) || quota < 0) throw new HttpError(500, 'Invalid storage quota configuration');
      const configuredRecordLimit = process.env.JOT_MAX_USER_ATTACHMENT_RECORDS;
      const recordQuota = configuredRecordLimit === undefined ? 10_000 : Number(configuredRecordLimit);
      if (!Number.isSafeInteger(recordQuota) || recordQuota < 0) throw new HttpError(500, 'Invalid attachment record quota configuration');
      if (total.total + data.byteLength > quota) throw new HttpError(413, 'Attachment storage quota exceeded');
      if (count.total >= recordQuota) throw new HttpError(413, 'Attachment record quota exceeded');
      this.db.prepare('INSERT INTO attachments (id, note_id, name, mime_type, size, created_at, deleted_at, sha256, data) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)')
        .run(attachmentId, noteId, this.cipher.sealText(name, `attachment-name:${attachmentId}`), mimeType, data.byteLength, createdAt, sha, this.cipher.sealBytes(data, `attachment-data:${attachmentId}`));
      return { id: attachmentId, noteId, name, mimeType, size: data.byteLength, createdAt, deletedAt: null };
    });
  }
  getAttachment(userId: string, noteId: string, attachmentId: string): { metadata: AttachmentMetadata; data: Uint8Array } {
    this.requireAttachmentAccess(userId, noteId);
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ? AND note_id = ?').get(attachmentId, noteId) as unknown as AttachmentRow | undefined;
    if (!row || row.deleted_at || !row.data) throw new HttpError(404, 'Attachment not found');
    return { metadata: attachmentMetadata(row, this.cipher), data: this.cipher.openBytes(row.data, `attachment-data:${attachmentId}`) };
  }
  deleteAttachment(userId: string, noteId: string, attachmentId: string, expectedNoteVersion: number): AttachmentMetadata {
    return transaction(this.db, () => {
      const currentVersion = this.requireAttachmentAccess(userId, noteId, true);
      if (currentVersion !== expectedNoteVersion) throw new HttpError(409, 'Note version changed; refresh before modifying attachments', { serverVersion: currentVersion });
      const row = this.db.prepare('SELECT id, note_id, name, mime_type, size, created_at, deleted_at FROM attachments WHERE id = ? AND note_id = ?')
        .get(attachmentId, noteId) as unknown as AttachmentRow | undefined;
      if (!row) throw new HttpError(404, 'Attachment not found');
      if (!row.deleted_at) {
        row.deleted_at = new Date().toISOString();
        // Keep a permanent tombstone but discard the remote bytes to reclaim space.
        this.db.prepare('UPDATE attachments SET deleted_at = ?, data = NULL WHERE id = ?').run(row.deleted_at, attachmentId);
      }
      return attachmentMetadata(row, this.cipher);
    });
  }
}
