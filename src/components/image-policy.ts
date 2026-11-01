/** Consent is kept in memory per note and exact image URL, never persisted. */
export function remoteImageKey(noteId: string, source: string): string {
  return `${noteId}\u0000${source}`;
}

/** Only HTTP(S) and relative URLs may be loaded, and only after explicit consent. */
export function canLoadRemoteImage(noteId: string, source: string, allowed: ReadonlySet<string>): boolean {
  if (!source || /[\u0000-\u001f\u007f]/.test(source)) return false;
  try {
    const url = new URL(source, 'https://jot.invalid/');
    return (url.protocol === 'https:' || url.protocol === 'http:') && allowed.has(remoteImageKey(noteId, source));
  } catch { return false; }
}

export function isRemoteImageSource(source: string): boolean {
  if (!source || /[\u0000-\u001f\u007f]/.test(source)) return false;
  try {
    const url = new URL(source, 'https://jot.invalid/');
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch { return false; }
}
