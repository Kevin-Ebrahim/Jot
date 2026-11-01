import { HttpError } from './errors';

export type Role = 'owner' | 'editor' | 'viewer';
export type ShareRole = Exclude<Role, 'owner'>;
export interface ServerNote {
  id: string;
  title: string;
  body: string;
  tags: string[];
  notebookId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  pinned: boolean;
}
export interface ServerNotebook {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

function fail(message: string): never { throw new HttpError(400, message); }
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : fail('Expected an object');
}
export function id(value: unknown, label = 'id'): string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : fail(`Invalid ${label}`);
}
export function text(value: unknown, label: string, max: number, allowEmpty = true): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail(`Invalid ${label}`);
  return value as string;
}
function date(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 32 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`Invalid ${label}`);
  return value as string;
}
export function email(value: unknown): string {
  const result = text(value, 'email', 254, false).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail('Invalid email');
  return result;
}
export function password(value: unknown): string {
  const result = text(value, 'password', 256, false);
  if (result.length < 12) fail('Password must be at least 12 characters');
  return result;
}
export function shareRole(value: unknown): ShareRole {
  return value === 'viewer' || value === 'editor' ? value : fail('Invalid role');
}
export function baseVersion(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fail('Invalid baseVersion');
}
export function note(value: unknown, expectedId: string): ServerNote {
  const v = object(value);
  const noteId = id(v.id);
  if (noteId !== expectedId) fail('Note id does not match URL');
  if (!Array.isArray(v.tags) || v.tags.length > 50) fail('Invalid tags');
  const tags = (v.tags as unknown[]).map((tag) => text(tag, 'tag', 80, false));
  if (typeof v.pinned !== 'boolean') fail('Invalid pinned');
  return {
    id: noteId,
    title: text(v.title, 'title', 300),
    body: text(v.body, 'body', 1_000_000),
    tags,
    notebookId: v.notebookId === null ? null : id(v.notebookId, 'notebookId'),
    createdAt: date(v.createdAt, 'createdAt'),
    updatedAt: date(v.updatedAt, 'updatedAt'),
    deletedAt: v.deletedAt === null ? null : date(v.deletedAt, 'deletedAt'),
    pinned: v.pinned as boolean,
  };
}
export function notebook(value: unknown, expectedId: string): ServerNotebook {
  const v = object(value);
  const notebookId = id(v.id);
  if (notebookId !== expectedId) fail('Notebook id does not match URL');
  return {
    id: notebookId,
    name: text(v.name, 'name', 200, false),
    createdAt: date(v.createdAt, 'createdAt'),
    updatedAt: date(v.updatedAt, 'updatedAt'),
    deletedAt: v.deletedAt === null || v.deletedAt === undefined ? null : date(v.deletedAt, 'deletedAt'),
  };
}
