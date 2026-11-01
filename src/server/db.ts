import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { cipherFor, initializeCipher } from './content-crypto';
import { contentBytes } from './quota';
import type { ServerNote, ServerNotebook } from './validation';

/**
 * The database is deliberately local: no hosted account or network service is
 * required. The directory must be included in the operator's backups.
 */
export function openDatabase(filename: string): DatabaseSync {
  if (filename !== ':memory:') {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(filename);
  try {
    if (filename !== ':memory:') {
      try { chmodSync(filename, 0o600); } catch { /* directory permissions still apply */ }
    }
    db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA secure_delete = ON;
    `);
    // Validate the persisted mode and key before modifying application schema.
    initializeCipher(db, process.env.JOT_ENCRYPTION_KEY);
    db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      version INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      deleted_at TEXT,
      content_bytes INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      notebook_id TEXT REFERENCES notebooks(id),
      version INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      deleted_at TEXT,
      content_bytes INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_notebook ON notes(notebook_id);
    CREATE TABLE IF NOT EXISTS notebook_shares (
      notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
      PRIMARY KEY(notebook_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS note_shares (
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
      PRIMARY KEY(note_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      content_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comments_note ON comments(note_id, created_at);
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      sha256 TEXT NOT NULL,
      data BLOB
    );
    CREATE INDEX IF NOT EXISTS attachments_note ON attachments(note_id);
    CREATE TABLE IF NOT EXISTS operations (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      target TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, operation_id)
    );
  `);
  // Existing databases acquire logical content-byte accounting atomically.
  // Decrypt before measuring so encrypted and plaintext workspaces have the
  // same quota semantics; never rewrite the user's content during migration.
  db.exec('BEGIN IMMEDIATE');
  try {
    const cipher = cipherFor(db);
    for (const kind of ['note', 'notebook', 'comment'] as const) {
      const table = kind === 'note' ? 'notes' : kind === 'notebook' ? 'notebooks' : 'comments';
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
      if (columns.some((column) => column.name === 'content_bytes')) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN content_bytes INTEGER NOT NULL DEFAULT 0`);
      const field = kind === 'comment' ? 'body' : 'data_json';
      const rows = db.prepare(`SELECT id, ${field} AS content FROM ${table}`).all() as unknown as Array<{ id: string; content: string }>;
      const update = db.prepare(`UPDATE ${table} SET content_bytes = ? WHERE id = ?`);
      for (const row of rows) {
        const plaintext = cipher.openText(row.content, `${kind}:${row.id}`);
        const bytes = kind === 'note' ? contentBytes('note', JSON.parse(plaintext) as ServerNote)
          : kind === 'notebook' ? contentBytes('notebook', JSON.parse(plaintext) as ServerNotebook)
          : contentBytes('comment', plaintext);
        update.run(bytes, row.id);
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  db.exec('CREATE INDEX IF NOT EXISTS notes_owner ON notes(owner_id); CREATE INDEX IF NOT EXISTS notebooks_owner ON notebooks(owner_id)');
  // Earlier development snapshots stored entire response bodies. Migrate to
  // minimal receipts, retaining only their versions and request fingerprints.
  const operationColumns = db.prepare('PRAGMA table_info(operations)').all() as unknown as Array<{ name: string }>;
  if (operationColumns.some((column) => column.name === 'response_json')) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE operations RENAME TO operations_legacy;
      CREATE TABLE operations (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL, target TEXT NOT NULL, payload_hash TEXT NOT NULL,
        result_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, operation_id)
      );
      INSERT INTO operations (user_id, operation_id, target, payload_hash, result_version, created_at)
        SELECT user_id, operation_id, target, payload_hash,
               CAST(json_extract(response_json, '$.version') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER) * 1000
        FROM operations_legacy WHERE json_valid(response_json) AND json_extract(response_json, '$.version') IS NOT NULL;
      DROP TABLE operations_legacy;
      COMMIT;
    `);
  }
    db.exec('CREATE INDEX IF NOT EXISTS operations_created ON operations(created_at)');
    db.prepare('DELETE FROM operations WHERE created_at < ?').run(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const globalDb = globalThis as typeof globalThis & { __jotDatabase?: DatabaseSync };
export function getDatabase(): DatabaseSync {
  if (!globalDb.__jotDatabase) {
    const directory = process.env.JOT_DATA_DIR || path.join(process.cwd(), '.jot-data');
    globalDb.__jotDatabase = openDatabase(path.join(directory, 'jot.sqlite'));
  }
  return globalDb.__jotDatabase;
}
