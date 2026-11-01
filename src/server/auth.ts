import { createHash, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors';
import * as validate from './validation';

export interface PublicUser { id: string; email: string }
export interface Session { user: PublicUser; csrfToken: string; token: string }
interface UserRow { id: string; email: string; password_salt: string; password_hash: string }
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const COOKIE = 'jot_session';

let scryptInFlight = 0;
async function scrypt(password: string, salt: string): Promise<Buffer> {
  // Bound memory/CPU pressure without a long-lived global lockout bucket.
  if (scryptInFlight >= 8) throw new HttpError(429, 'Server is busy; try again');
  scryptInFlight++;
  try {
    return await new Promise((resolve, reject) => {
      nodeScrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, derived) => {
        if (err) reject(err); else resolve(derived as Buffer);
      });
    });
  } finally { scryptInFlight--; }
}
function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Per-account buckets are bounded and process-local. Headers are untrusted by
// default; operators may opt in to a single IP header overwritten by a trusted
// reverse proxy. A proxy-level limiter is still recommended for public hosts.
const attempts = new Map<string, number[]>();
const MAX_ATTEMPT_BUCKETS = 5000;
function checkAttempts(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const previous = (attempts.get(key) || []).filter((time) => time > now - windowMs);
  attempts.delete(key);
  if (attempts.size >= MAX_ATTEMPT_BUCKETS) {
    const oldest = attempts.keys().next().value;
    if (oldest !== undefined) attempts.delete(oldest);
  }
  if (previous.length >= limit) {
    attempts.set(key, previous);
    throw new HttpError(429, 'Too many attempts; try again later');
  }
  previous.push(now);
  attempts.set(key, previous);
}
export function trustedClientIp(req: Request): string | undefined {
  const header = process.env.JOT_TRUST_PROXY_IP_HEADER;
  if (!header) return undefined;
  if (!/^[a-z0-9-]{1,64}$/i.test(header)) throw new HttpError(500, 'Invalid trusted proxy configuration');
  const value = req.headers.get(header)?.trim();
  const family = value ? isIP(value) : 0;
  if (!value || !family) throw new HttpError(400, 'Trusted proxy IP header is missing or invalid');
  // Normalize equivalent IPv6 spellings so they do not evade the same bucket.
  if (family === 6) {
    try { return new URL(`http://[${value}]/`).hostname.slice(1, -1); }
    catch { throw new HttpError(400, 'Trusted proxy IP header is missing or invalid'); }
  }
  return value;
}
function makeSession(db: DatabaseSync, user: PublicUser): Session {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), user.id, csrfToken, expires);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Math.floor(Date.now() / 1000));
  return { user, csrfToken, token };
}

export async function register(db: DatabaseSync, rawEmail: unknown, rawPassword: unknown, clientIp?: string): Promise<Session> {
  if (process.env.JOT_ALLOW_REGISTRATION === 'false') throw new HttpError(403, 'Registration is disabled');
  const email = validate.email(rawEmail);
  const password = validate.password(rawPassword);
  // Only explicitly trusted proxy-supplied IPs participate in the key. With no
  // trusted IP, the shared per-account bucket is the conservative fallback.
  checkAttempts(`register:${JSON.stringify([email, clientIp ?? null])}`, 5, 10 * 60_000);
  if (clientIp) checkAttempts(`register-ip:${clientIp}`, 20, 10 * 60_000);
  const salt = randomBytes(16).toString('hex');
  const passwordHash = (await scrypt(password, salt)).toString('hex');
  const user = { id: randomUUID(), email };
  db.exec('BEGIN IMMEDIATE');
  try {
    // By default only bootstrap the first account. Opening registration for
    // collaborators is an explicit operator decision, not a public default.
    if (process.env.JOT_ALLOW_REGISTRATION !== 'true') {
      const count = db.prepare('SELECT COUNT(*) AS count FROM users').get() as unknown as { count: number };
      if (count.count > 0) throw new HttpError(403, 'Additional registration is disabled by the server administrator');
    }
    db.prepare('INSERT INTO users (id, email, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, email, salt, passwordHash, new Date().toISOString());
    const result = makeSession(db, user);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    if ((error as Error).message.includes('UNIQUE constraint failed')) throw new HttpError(409, 'An account with that email already exists');
    throw error;
  }
}

export async function login(db: DatabaseSync, rawEmail: unknown, rawPassword: unknown, clientIp?: string): Promise<Session> {
  const email = validate.email(rawEmail);
  // A login accepts legacy-length strings too, but still bounds work and input.
  const password = validate.text(rawPassword, 'password', 256, false);
  checkAttempts(`login:${JSON.stringify([email, clientIp ?? null])}`, 10, 10 * 60_000);
  if (clientIp) checkAttempts(`login-ip:${clientIp}`, 100, 10 * 60_000);
  const row = db.prepare('SELECT id, email, password_salt, password_hash FROM users WHERE email = ?').get(email) as unknown as UserRow | undefined;
  const derived = await scrypt(password, row?.password_salt || '00000000000000000000000000000000');
  const stored = row ? Buffer.from(row.password_hash, 'hex') : Buffer.alloc(64);
  if (!row || stored.length !== derived.length || !timingSafeEqual(stored, derived)) throw new HttpError(401, 'Invalid email or password');
  return makeSession(db, { id: row.id, email: row.email });
}

export function session(db: DatabaseSync, req: Request): Session | null {
  const values = (req.headers.get('cookie') || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(COOKIE.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = db.prepare(`SELECT users.id, users.email, sessions.csrf_token
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`)
    .get(hashToken(token), Math.floor(Date.now() / 1000)) as unknown as { id: string; email: string; csrf_token: string } | undefined;
  return row ? { user: { id: row.id, email: row.email }, csrfToken: row.csrf_token, token } : null;
}
export function requireSession(db: DatabaseSync, req: Request): Session {
  const result = session(db, req);
  if (!result) throw new HttpError(401, 'Sign in required');
  const expectedWorkspace = req.headers.get('x-jot-workspace');
  if (expectedWorkspace !== null && expectedWorkspace !== result.user.id) throw new HttpError(409, 'Signed-in account changed; retry in the correct workspace');
  return result;
}
export function requireCsrf(req: Request, current: Session): void {
  const supplied = req.headers.get('x-csrf-token');
  if (!supplied || !equal(supplied, current.csrfToken)) throw new HttpError(403, 'Invalid CSRF token');
}
export function logout(db: DatabaseSync, current: Session): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(current.token));
}
function secureCookie(req: Request): boolean {
  return process.env.JOT_SECURE_COOKIES === 'true' || new URL(req.url).protocol === 'https:' || (process.env.JOT_APP_ORIGIN || '').startsWith('https://');
}
export function sessionCookie(req: Request, token: string): string {
  return `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Strict${secureCookie(req) ? '; Secure' : ''}`;
}
export function expiredCookie(req: Request): string {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secureCookie(req) ? '; Secure' : ''}`;
}
