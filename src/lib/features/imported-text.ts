/**
 * Imported HTML, OCR and speech output are untrusted plain text, not Markdown.
 * Escape syntax before storing it in a Markdown note so, for example, an OCR'd
 * image reference cannot load a remote tracking pixel when the note is previewed.
 */
export function escapeImportedText(text: string): string {
  return text.replace(/[\\`*_{}\[\]<>#+.!|~\-]/g, "\\$&");
}
