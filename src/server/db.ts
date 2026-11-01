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
    CREATE TABLE IF NOT EXISTS operations (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      target TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      PRIMARY KEY(user_id, operation_id)
    );
  `);
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
