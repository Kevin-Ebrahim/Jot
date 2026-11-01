import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * The database is deliberately local: no hosted account or network service is
 * required. The directory must be included in the operator's backups.
 */
export function openDatabase(filename: string): DatabaseSync {
  if (filename !== ':memory:') {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(filename);
  if (filename !== ':memory:') {
    try { chmodSync(filename, 0o600); } catch { /* directory permissions still apply */ }
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA secure_delete = ON;
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
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      notebook_id TEXT REFERENCES notebooks(id),
      version INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      deleted_at TEXT
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
  return db;
}

const globalDb = globalThis as typeof globalThis & { __jotDatabase?: DatabaseSync };
export function getDatabase(): DatabaseSync {
  if (!globalDb.__jotDatabase) {
    const directory = process.env.JOT_DATA_DIR || path.join(process.cwd(), '.jot-data');
    globalDb.__jotDatabase = openDatabase(path.join(directory, 'jot.sqlite'));
  }
  return globalDb.__jotDatabase;
}
