import type { Note } from "@/lib/types";
import { plainNoteText } from "./search";

export interface WikiLink { title: string; label: string; }

/** Resolve wiki links by normalized title, not by unsafe HTML or executable URLs. */
export function extractWikiLinks(markdown: string): WikiLink[] {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  return [...withoutCode.matchAll(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g)]
    .map((match) => ({ title: match[1].trim(), label: (match[2] || match[1]).trim() }))
    .filter((link) => !!link.title);
}

const linkCache = new WeakMap<Note, { source: string; links: WikiLink[] }>();
function noteLinks(note: Note): WikiLink[] {
  const cached = linkCache.get(note);
  if (cached?.source === note.body) return cached.links;
  const links = extractWikiLinks(note.body);
  linkCache.set(note, { source: note.body, links });
  return links;
}

function key(value: string): string { return value.trim().replace(/\s+/g, " ").toLocaleLowerCase(); }

export function getBacklinks(notes: Note[], target: Note): Note[] {
  const title = key(target.title);
  if (!title) return [];
  return notes.filter((note) => !note.deletedAt && note.id !== target.id && noteLinks(note).some((link) => key(link.title) === title));
}

export function getOutgoingLinks(notes: Note[], source: Note): Array<{ link: WikiLink; matches: Note[] }> {
  return noteLinks(source).map((link) => ({
    link,
    // Duplicate titles are explicitly retained rather than silently choosing one.
    matches: notes.filter((note) => !note.deletedAt && note.id !== source.id && key(note.title) === key(link.title)),
  }));
}

const STOP_WORDS = new Set("about after again also and are been before being between both but can could did does doing for from had has have how into its just more most not our out over same she some than that the their them then there these they this those through too under until very was were what when where which while who will with would you your".split(" "));
const wordCache = new WeakMap<Note, { title: string; body: string; words: Set<string> }>();
function meaningfulWords(note: Note): Set<string> {
  const cached = wordCache.get(note);
  if (cached?.title === note.title && cached.body === note.body) return cached.words;
  const result = new Set(`${note.title} ${note.title} ${plainNoteText(note.body)}`.toLocaleLowerCase().match(/[\p{L}\p{N}]{4,}/gu)?.filter((word) => !STOP_WORDS.has(word)).slice(0, 1000) || []);
  wordCache.set(note, { title: note.title, body: note.body, words: result });
  return result;
}

/** Related by shared tags and meaningful words; not an AI/semantic recommendation. */
export function getRelatedNotes(notes: Note[], target: Note, limit = 4): Note[] {
  const tags = new Set(target.tags.map(key));
  const sourceWords = meaningfulWords(target);
  return notes.filter((note) => !note.deletedAt && note.id !== target.id).map((note) => {
    let score = note.tags.filter((tag) => tags.has(key(tag))).length * 6;
    for (const word of meaningfulWords(note)) if (sourceWords.has(word)) score += 1;
    return { note, score };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.note.updatedAt) - Date.parse(a.note.updatedAt))
    .slice(0, Math.max(0, limit)).map(({ note }) => note);
}
