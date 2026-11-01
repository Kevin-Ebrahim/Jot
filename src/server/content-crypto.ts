import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const TEXT_PREFIX = 'jotenc1:';
const BYTE_PREFIX = Buffer.from('JOTENC1\0', 'ascii');
const CHECK_PLAINTEXT = 'Jot encryption key check v1';
const CHECK_AAD = 'jot-key-check-v1';

/** Optional server-side content encryption. It is not end-to-end encryption. */
export class ContentCipher {
  private readonly encryptionKey: Buffer | null;
  private readonly fingerprintKey: Buffer | null;
  constructor(key: Buffer | null) {
    // Independent keys prevent use of the same key directly for AES and HMAC.
    this.encryptionKey = key ? Buffer.from(hkdfSync('sha256', key, 'jot-content-v1', 'aes-256-gcm', 32)) : null;
    this.fingerprintKey = key ? Buffer.from(hkdfSync('sha256', key, 'jot-content-v1', 'hmac-sha256', 32)) : null;
  }
  get encrypted(): boolean { return this.encryptionKey !== null; }

  private encrypt(data: Uint8Array, aad: string): Buffer {
    if (!this.encryptionKey) return Buffer.from(data);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  }
  private decrypt(data: Uint8Array, aad: string): Buffer {
    if (!this.encryptionKey) return Buffer.from(data);
    const bytes = Buffer.from(data);
    if (bytes.length < 28) throw new Error('Encrypted Jot data is invalid or has been modified');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    } catch {
      throw new Error('Encrypted Jot data cannot be authenticated');
    }
  }
  sealText(value: string, aad: string): string {
    return this.encryptionKey ? TEXT_PREFIX + this.encrypt(Buffer.from(value, 'utf8'), aad).toString('base64url') : value;
  }
  openText(value: string, aad: string): string {
    if (!this.encryptionKey) return value;
    if (!value.startsWith(TEXT_PREFIX)) throw new Error('Encrypted Jot data is missing its format marker');
    return this.decrypt(Buffer.from(value.slice(TEXT_PREFIX.length), 'base64url'), aad).toString('utf8');
  }
  sealBytes(value: Uint8Array, aad: string): Uint8Array {
    return this.encryptionKey ? Buffer.concat([BYTE_PREFIX, this.encrypt(value, aad)]) : Buffer.from(value);
  }
  openBytes(value: Uint8Array, aad: string): Uint8Array {
    if (!this.encryptionKey) return Buffer.from(value);
    const bytes = Buffer.from(value);
    if (bytes.length < BYTE_PREFIX.length || !bytes.subarray(0, BYTE_PREFIX.length).equals(BYTE_PREFIX)) {
      throw new Error('Encrypted Jot data is missing its format marker');
    }
    return this.decrypt(bytes.subarray(BYTE_PREFIX.length), aad);
  }
  /** HMAC avoids exposing an unkeyed content fingerprint in encrypted mode. */
  fingerprint(value: string | Uint8Array): string {
    return this.fingerprintKey ? createHmac('sha256', this.fingerprintKey).update(value).digest('hex') : createHash('sha256').update(value).digest('hex');
  }
}

const ciphers = new WeakMap<DatabaseSync, ContentCipher>();
export function cipherFor(db: DatabaseSync): ContentCipher {
  const cipher = ciphers.get(db);
  if (!cipher) throw new Error('Database encryption state was not initialized');
  return cipher;
}

/**
 * Establish an immutable on-disk mode. Existing plaintext databases are never
 * silently converted; encrypted databases cannot open with a missing/wrong key.
 */
export function initializeCipher(db: DatabaseSync, rawKey: string | undefined): void {
  if (rawKey !== undefined && !/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    throw new Error('JOT_ENCRYPTION_KEY must be exactly 64 hexadecimal characters');
  }
  const key = rawKey === undefined ? null : Buffer.from(rawKey, 'hex');
  const candidate = new ContentCipher(key);
  db.exec('BEGIN IMMEDIATE');
  try {
    const settingsExist = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='jot_settings'").get();
    if (!settingsExist) {
      const oldTables = db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'
        AND name IN ('users','sessions','notebooks','notes','notebook_shares','note_shares','comments','attachments','operations')`).get() as unknown as { count: number };
      if (key && oldTables.count > 0) throw new Error('Cannot enable encryption on an existing plaintext Jot database; use a fresh data directory');
      db.exec('CREATE TABLE jot_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      db.prepare('INSERT INTO jot_settings (key, value) VALUES (?, ?)').run('content_encryption', key ? 'aes-256-gcm-v1' : 'plaintext-v1');
      if (key) db.prepare('INSERT INTO jot_settings (key, value) VALUES (?, ?)').run('key_check', candidate.sealText(CHECK_PLAINTEXT, CHECK_AAD));
    } else {
      const mode = db.prepare("SELECT value FROM jot_settings WHERE key='content_encryption'").get() as unknown as { value: string } | undefined;
      if (!mode) throw new Error('Jot encryption mode is missing');
      if (mode.value === 'plaintext-v1') {
        if (key) throw new Error('Cannot enable encryption on an existing plaintext Jot database; use a fresh data directory');
      } else if (mode.value === 'aes-256-gcm-v1') {
        if (!key) throw new Error('JOT_ENCRYPTION_KEY is required for this encrypted Jot database');
        const check = db.prepare("SELECT value FROM jot_settings WHERE key='key_check'").get() as unknown as { value: string } | undefined;
        try {
          if (!check || candidate.openText(check.value, CHECK_AAD) !== CHECK_PLAINTEXT) throw new Error('Key mismatch');
        } catch { throw new Error('JOT_ENCRYPTION_KEY does not match this Jot database'); }
      } else throw new Error('Unknown Jot encryption mode');
    }
    db.exec('COMMIT');
    ciphers.set(db, candidate);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
