import type { Note } from "@/lib/types";

/** Text used for local, lexical search and previews. It is never rendered as HTML. */
export function plainNoteText(markdown: string): string {
  // Protect escaped literals before stripping real Markdown; otherwise imported
  // plain text such as \![x] or \<3 could disappear from previews/search.
  let prefix = "\uE000JOT";
  while (markdown.includes(prefix)) prefix += "X";
  const escaped: string[] = [];
  const protectedText = markdown.replace(/\\([\\`*_{}\[\]<>#+.!|~\-])/g, (_, character: string) => {
    const token = `${prefix}${escaped.length}\uE001`;
    escaped.push(character);
    return token;
  });
  const plain = protectedText
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
  return plain.replace(new RegExp(`${prefix}(\\d+)\uE001`, "g"), (_, index: string) => escaped[Number(index)] ?? "");
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

function words(value: string): string[] {
  return normalize(value).match(/[\p{L}\p{N}]+/gu) || [];
}

// Keep this intentionally modest: these are lexical aids, not semantic embeddings.
const STOP_WORDS = new Set("a an and are as at about by can could did do does find for from had has have how i in is it its just looking me my note notes of on or our please related remember saved search show some something that the their them these this those to was were what when where which who with would you your".split(" "));
function stem(value: string): string {
  const irregular: Record<string, string> = { indices: "index", indexes: "index", children: "child", people: "person" };
  if (irregular[value]) return irregular[value];
  let root = value;
  if (root.length > 5 && root.endsWith("ies")) root = `${root.slice(0, -3)}y`;
  else if (root.length > 5 && root.endsWith("ing")) root = root.slice(0, -3);
  else if (root.length > 4 && root.endsWith("ed")) root = root.slice(0, -2);
  else if (root.length > 4 && /(?:xes|ches|shes|sses|zes)$/.test(root)) root = root.slice(0, -2);
  else if (root.length > 3 && root.endsWith("s") && !root.endsWith("ss")) root = root.slice(0, -1);
  if (root.length > 3 && /([^aeiou])\1$/.test(root)) root = root.slice(0, -1);
  return root;
}
const SYNONYM_GROUPS = [
  ["database", "db"], ["index", "indices"], ["meeting", "call"],
  ["task", "todo"], ["photo", "image", "picture"], ["audio", "voice", "recording"],
  ["idea", "thought"], ["deadline", "due"], ["study", "learn", "review"],
  ["client", "customer"], ["project", "initiative"],
];
const SYNONYMS = new Map<string, Set<string>>();
for (const group of SYNONYM_GROUPS) {
  const roots = group.map(stem);
  for (const root of roots) SYNONYMS.set(root, new Set(roots.filter((other) => other !== root)));
}
interface QueryTerm { raw: string; root: string; alternatives: Set<string>; }
function queryTerms(query: string): QueryTerm[] {
  const all = words(query);
  const useful = all.filter((word) => !STOP_WORDS.has(word));
  const unique = new Map<string, QueryTerm>();
  for (const raw of (useful.length ? useful : all).slice(0, 20)) {
    const root = stem(raw);
    if (!unique.has(root)) unique.set(root, { raw, root, alternatives: SYNONYMS.get(root) || new Set() });
    if (unique.size >= 12) break;
  }
  return [...unique.values()];
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

interface WordIndex { text: string; tokens: Set<string>; roots: Set<string>; fuzzy: string[]; }
function indexText(value: string): WordIndex {
  const text = normalize(value);
  const tokens = new Set(words(text));
  return { text, tokens, roots: new Set([...tokens].map(stem)), fuzzy: [...tokens].slice(0, 1600) };
}
function quality(term: QueryTerm, index: WordIndex): number {
  if (index.tokens.has(term.raw)) return 1;
  if (index.roots.has(term.root)) return .92;
  if ([...term.alternatives].some((alternative) => index.roots.has(alternative))) return .72;
  if (term.raw.length >= 3 && index.fuzzy.some((word) => word.startsWith(term.raw))) return .76;
  if (term.raw.length >= 4 && index.fuzzy.some((word) => closeWord(term.raw, word))) return .56;
  return 0;
}
interface IndexedNote { title: WordIndex; tags: WordIndex; body: WordIndex; }
const indexCache = new WeakMap<Note, { title: string; body: string; tags: string; index: IndexedNote }>();
function indexNote(note: Note): IndexedNote {
  const tagText = note.tags.join(" ");
  const cached = indexCache.get(note);
  if (cached && cached.title === note.title && cached.body === note.body && cached.tags === tagText) return cached.index;
  const wikiTargets = [...note.body.matchAll(/\[\[([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/g)].map((match) => match[1]).join(" ");
  // Include the raw source as well as the display text so escaped OCR/imported
  // literals and link targets remain searchable even on very long notes.
  const indexed = {
    title: indexText(note.title), tags: indexText(tagText),
    body: indexText(`${plainNoteText(note.body)} ${note.body.replace(/\\([\\`*_{}\[\]<>#+.!|~\-])/g, "$1")} ${wikiTargets}`),
  };
  indexCache.set(note, { title: note.title, body: note.body, tags: tagText, index: indexed });
  return indexed;
}

export interface SearchOptions {
  /** Case-insensitive; every supplied tag must be present. */
  tags?: string[];
  /** Inclusive calendar date (YYYY-MM-DD) or ISO timestamp, compared to updatedAt. */
  from?: string;
  to?: string;
}

/**
 * On-device fuzzy lexical search. Query filler is ignored, common word forms and
 * a few explicit synonyms are matched, and useful partial matches are ranked
 * below stronger coverage. This does not use embeddings or claim semantic AI.
 */
export function searchNotes(notes: Note[], query: string, options: SearchOptions = {}): Note[] {
  const terms = queryTerms(query);
  const phrase = normalize(query.trim());
  const requiredTags = (options.tags || []).map((tag) => normalize(tag.replace(/^#/, "").trim())).filter(Boolean);
  const from = options.from ? Date.parse(options.from) : Number.NaN;
  const to = options.to ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(options.to) ? `${options.to}T23:59:59.999Z` : options.to) : Number.NaN;
  const candidates: Array<{ note: Note; index: number; matches: number[]; phraseTitle: number; phraseBody: number }> = [];
  notes.forEach((note, index) => {
    if (note.deletedAt) return;
    const updated = Date.parse(note.updatedAt);
    if ((!Number.isNaN(from) && updated < from) || (!Number.isNaN(to) && updated > to)) return;
    const tags = note.tags.map((tag) => normalize(tag));
    if (!requiredTags.every((tag) => tags.includes(tag))) return;
    if (!terms.length) { candidates.push({ note, index, matches: [], phraseTitle: 0, phraseBody: 0 }); return; }
    const indexed = indexNote(note);
    const matches = terms.map((term) => Math.max(quality(term, indexed.title) * 15, quality(term, indexed.tags) * 11, quality(term, indexed.body) * 5));
    const matched = matches.filter(Boolean).length;
    const phraseTitle = phrase && indexed.title.text === phrase ? 1000 : phrase && indexed.title.text.includes(phrase) ? 400 : 0;
    const phraseBody = phrase && indexed.body.text.includes(phrase) ? 18 : 0;
    const minimum = terms.length <= 2 ? 1 : Math.max(2, Math.ceil(terms.length / 2));
    if (matched >= minimum || phraseTitle || phraseBody) candidates.push({ note, index, matches, phraseTitle, phraseBody });
  });
  // Downweight words that occur in many matching notes, while rewarding coverage.
  const frequencies = terms.map((_, index) => candidates.filter((candidate) => candidate.matches[index] > 0).length);
  return candidates.map((candidate) => {
    const matched = candidate.matches.filter(Boolean).length;
    const coverage = terms.length ? matched / terms.length : 1;
    const lexical = candidate.matches.reduce((sum, score, index) => sum + score * (1 + Math.log((candidates.length + 1) / (frequencies[index] + 1))), 0);
    return { ...candidate, score: candidate.phraseTitle + candidate.phraseBody + lexical * (.5 + .5 * coverage) };
  }).sort((a, b) => b.score - a.score || Date.parse(b.note.updatedAt) - Date.parse(a.note.updatedAt) || a.index - b.index).map(({ note }) => note);
}

/** A safe plain-text excerpt, centered near a useful query word when possible. */
export function noteSnippet(note: Note, query = "", maxLength = 150): string {
  const text = plainNoteText(note.body);
  if (text.length <= maxLength) return text;
  const terms = queryTerms(query);
  const match = [...text.matchAll(/[\p{L}\p{N}]+/gu)].find((candidate) => {
    const root = stem(normalize(candidate[0]));
    return terms.some((term) => term.root === root || term.alternatives.has(root));
  });
  const index = match?.index ?? -1;
  const start = index > 30 ? Math.max(0, index - Math.floor(maxLength / 3)) : 0;
  const end = Math.min(text.length, start + maxLength);
  return `${start ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
