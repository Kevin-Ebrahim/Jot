import type { Note } from "@/lib/types";

/** Text used for local, lexical search and previews. It is never rendered as HTML. */
export function plainNoteText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, title: string, label: string | undefined) => label || title)
    .replace(/<[^>]*>/g, " ")
    .replace(/^[\s>*#-]+/gm, " ")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

function words(value: string): string[] {
  return normalize(value).match(/[\p{L}\p{N}]+/gu) || [];
}

/** A bounded edit distance; stop early because search should remain responsive. */
function closeWord(a: string, b: string): boolean {
  if (a === b || (a.length >= 3 && b.startsWith(a))) return true;
  if (a.length < 4 || Math.abs(a.length - b.length) > (a.length > 7 ? 2 : 1)) return false;
  const allowance = a.length > 7 ? 2 : 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > allowance) return false;
    previous = current;
  }
  return previous[b.length] <= allowance;
}

export interface SearchOptions {
  /** Case-insensitive; every supplied tag must be present. */
  tags?: string[];
  /** Inclusive calendar date (YYYY-MM-DD) or ISO timestamp, compared to updatedAt. */
  from?: string;
  to?: string;
}

/**
 * Rank notes using title/body/tag words and small typo tolerance, entirely on-device.
 * This is lexical fuzzy search, not semantic/vector search. OCR and PDF text becomes
 * searchable when the capture panel adds it to the Markdown body.
 */
export function searchNotes(notes: Note[], query: string, options: SearchOptions = {}): Note[] {
  const terms = words(query).slice(0, 12);
  const phrase = normalize(query.trim());
  const requiredTags = (options.tags || []).map((tag) => normalize(tag.replace(/^#/, "").trim())).filter(Boolean);
  const from = options.from ? Date.parse(options.from) : Number.NaN;
  // A date-only upper bound includes its whole UTC day.
  const to = options.to ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(options.to) ? `${options.to}T23:59:59.999Z` : options.to) : Number.NaN;

  const ranked: Array<{ note: Note; score: number; index: number }> = [];
  notes.forEach((note, index) => {
    if (note.deletedAt) return;
    const updated = Date.parse(note.updatedAt);
    if ((!Number.isNaN(from) && updated < from) || (!Number.isNaN(to) && updated > to)) return;
    const noteTags = note.tags.map((tag) => normalize(tag));
    if (!requiredTags.every((tag) => noteTags.includes(tag))) return;

    if (!terms.length) {
      ranked.push({ note, score: 0, index });
      return;
    }
    const title = normalize(note.title);
    const wikiTargets = [...note.body.matchAll(/\[\[([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/g)].map((match) => match[1]).join(" ");
    const body = normalize(`${plainNoteText(note.body)} ${wikiTargets}`);
    const tagText = noteTags.join(" ");
    const titleWords = words(note.title);
    const tagWords = noteTags.flatMap(words);
    // Unique words bound both memory and typo comparisons on long documents.
    const bodyWords = [...new Set(words(body))].slice(0, 1600);
    let score = phrase && title.includes(phrase) ? 20 : 0;
    if (phrase && body.includes(phrase)) score += 8;
    let matches = true;
    for (const term of terms) {
      if (title.includes(term)) score += 12;
      else if (titleWords.some((word) => closeWord(term, word))) score += 8;
      else if (tagText.includes(term) || tagWords.some((word) => closeWord(term, word))) score += 7;
      else if (body.includes(term)) score += 4;
      else if (bodyWords.some((word) => closeWord(term, word))) score += 2;
      else { matches = false; break; }
    }
    if (matches) ranked.push({ note, score, index });
  });
  ranked.sort((a, b) => b.score - a.score || Date.parse(b.note.updatedAt) - Date.parse(a.note.updatedAt) || a.index - b.index);
  return ranked.map(({ note }) => note);
}

/** A safe plain-text excerpt, ideally centered near the first literal query term. */
export function noteSnippet(note: Note, query = "", maxLength = 150): string {
  const text = plainNoteText(note.body);
  if (text.length <= maxLength) return text;
  const term = words(query)[0];
  const index = term ? normalize(text).indexOf(term) : -1;
  const start = index > 30 ? Math.max(0, index - Math.floor(maxLength / 3)) : 0;
  const end = Math.min(text.length, start + maxLength);
  return `${start ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
