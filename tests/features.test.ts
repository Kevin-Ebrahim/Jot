import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import type { Note } from "../src/lib/types";
import { escapeImportedText } from "../src/lib/features/imported-text";
import { getBacklinks, extractWikiLinks, getRelatedNotes } from "../src/lib/features/links";
import { getDueRecurringNotes, getRecurringSchedule, prepareNextRecurringNote, removeRecurringSchedule, setRecurringSchedule } from "../src/lib/features/recurring";
import { getDueReviews, getPriorMeetings, getResurfacedNotes, rescheduleReview } from "../src/lib/features/resurface";
import { noteSnippet, plainNoteText, searchNotes } from "../src/lib/features/search";
import { extractTasks, nextRecurrenceDate, toggleTaskInBody } from "../src/lib/features/tasks";
import { NOTE_TEMPLATES, createFromTemplate } from "../src/lib/features/templates";
import { extractImageText } from "../src/lib/features/extraction";

function note(id: string, title: string, body = "", tags: string[] = []): Note {
  return { id, title, body, tags, notebookId: null, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null, revision: 1, serverVersion: null, syncState: "local", role: "owner", pinned: false };
}

test("search is lexical, typo-tolerant, tag/date-filtered and sees wiki targets", () => {
  const a = note("a", "Café launch", "A detailed marketing plan for summer", ["work"]);
  const b = note("b", "Projects", "See [[Café launch|the launch]]", ["work"]);
  assert.deepEqual(searchNotes([a, b], "cafe").map((item) => item.id), ["a", "b"]);
  assert.deepEqual(searchNotes([a, b], "markting").map((item) => item.id), ["a"]);
  assert.equal(searchNotes([a, b], "", { tags: ["work"], from: "2026-01-01", to: "2026-01-01" }).length, 2);
  assert.match(noteSnippet(a), /marketing/);
  assert.equal(plainNoteText("**Bold** [label](https://example.test) [[Topic|Alias]]"), "Bold label Alias");
});

test("rough descriptions rank useful partials, exact titles and OCR text without unrelated noise", () => {
  const partial = note("partial", "Indexing and query plans", "B-tree performance notes", ["engineering"]);
  const full = note("full", "Database indexes", "Query optimization reference", ["engineering"]);
  const unrelated = note("noise", "Dinner plans", "Buy pears and make soup", ["home"]);
  const description = searchNotes([unrelated, partial, full], "the note about database indexes");
  assert.ok(description.some((item) => item.id === "partial"), "stemming should match indexes to indexing");
  assert.equal(description[0].id, "full", "a full match should outrank a partial");
  assert.ok(!description.some((item) => item.id === "noise"), "unrelated notes should not match filler");
  assert.equal(searchNotes([partial, full], "database indexes")[0].id, "full", "exact title has priority");
  assert.equal(searchNotes([full], "datbase indexs")[0].id, "full", "small typos should match");
  const photo = note("photo", "Field trip", "An image from the coast", ["travel"]);
  assert.equal(searchNotes([photo], "picture")[0].id, "photo", "documented synonyms should match");
  const ocr = note("ocr", "Photo", `### Extracted from receipt\n\n${escapeImportedText("ORCHARD LANTERN 472")}`, ["receipts"]);
  assert.equal(searchNotes([ocr], "the photo with orchard lantern", { tags: ["receipts"], from: "2026-01-01", to: "2026-01-01" })[0].id, "ocr");
  assert.equal(searchNotes([ocr], "orchard", { tags: ["travel"] }).length, 0);
  assert.equal(searchNotes([ocr], "orchard", { from: "2027-01-01" }).length, 0);
  // Cached indexes must not hide edits if a caller mutates an object in place.
  ocr.body = "Changed to cobalt pears";
  assert.equal(searchNotes([ocr], "cobalt").length, 1);
});

test("wiki links exclude code, resolve backlinks and rank related tags", () => {
  const a = note("a", "Café launch", "A plan", ["work"]);
  const b = note("b", "Projects", "[[Café launch|Launch]]", ["work"]);
  assert.deepEqual(extractWikiLinks("[[A|B]] `[[ignored]]`\n```\n[[also ignored]]\n```"), [{ title: "A", label: "B" }]);
  assert.deepEqual(getBacklinks([a, b], a).map((item) => item.id), ["b"]);
  assert.deepEqual(getRelatedNotes([a, b], a).map((item) => item.id), ["b"]);
});

test("recurring checkboxes create one next occurrence and preserve reminder lead", () => {
  const body = "- [ ] Pay rent @due(2026-01-31) @remind(2026-01-30) @repeat(monthly)\n```\n- [ ] ignored\n```";
  assert.equal(extractTasks([note("t", "Tasks", body)]).length, 1);
  assert.equal(nextRecurrenceDate("2024-02-29", "yearly"), "2025-02-28");
  let toggled = toggleTaskInBody(body, 0);
  assert.match(toggled, /\[x\] Pay rent/);
  assert.match(toggled, /\[ \] Pay rent @due\(2026-02-28\) @remind\(2026-02-27\)/);
  toggled = toggleTaskInBody(toggleTaskInBody(toggled, 0), 0);
  assert.equal((toggled.match(/2026-02-28/g) || []).length, 1);
});

test("templates and explicit review/meeting resurfacing have honest local dates", () => {
  const study = NOTE_TEMPLATES.find((item) => item.id === "study");
  assert.ok(study);
  assert.match(createFromTemplate(study, new Date(2026, 3, 30, 12)).body || "", /@review\(2026-05-01\)/);
  assert.ok(NOTE_TEMPLATES.some((item) => item.id === "journal"));
  const review = note("r", "Study", "```\n@review(2020-01-01)\n```\n@review(2026-10-31)");
  assert.equal(getDueReviews([review], new Date(2026, 10, 1, 12)).length, 1);
  assert.equal(rescheduleReview(review.body, "2026-11-08"), "```\n@review(2020-01-01)\n```\n@review(2026-11-08)");
  const meeting = note("m", "Old meeting", "", ["meeting"]);
  assert.equal(getPriorMeetings([meeting], new Date(2026, 10, 1, 12)).length, 1);
  assert.equal(getResurfacedNotes([meeting], new Date(2026, 10, 1, 12)).length, 1);
});

test("recurring note preparation has a stable occurrence key and advances only the source", () => {
  const source = note("a1", "Journal {{date}}", "## Today\n\nRepeat: @repeat-note(monthly,2026-01-31)\n\nPrompt for {{date}}", ["journal"]);
  assert.equal(getDueRecurringNotes([source], new Date(2026, 0, 30, 12)).length, 0);
  assert.equal(getDueRecurringNotes([source], new Date(2026, 0, 31, 12)).length, 1);
  const occurrence = prepareNextRecurringNote(source);
  assert.ok(occurrence);
  assert.equal(occurrence.occurrenceKey, "a1:2026-01-31");
  assert.equal(occurrence.nextDueAt, "2026-02-28");
  assert.match(occurrence.nextSourceBody, /@repeat-note\(monthly,2026-02-28\)/);
  assert.equal(occurrence.newInput.title, "Journal 2026-01-31");
  assert.doesNotMatch(occurrence.newInput.body || "", /@repeat-note/);
  assert.equal(prepareNextRecurringNote({ ...source, body: "```\n@repeat-note(daily,2026-01-01)\n```" }), undefined);
  const scheduled = setRecurringSchedule("Prompt", "weekly", "2026-11-01");
  assert.deepEqual(getRecurringSchedule({ ...source, body: scheduled }), { interval: "weekly", dueAt: "2026-11-01" });
  assert.equal(removeRecurringSchedule(scheduled), "Prompt\n\n");
  assert.throws(() => setRecurringSchedule("", "weekly", "2026-02-30"));
});

test("imported text cannot inject a Markdown image and remains searchable", () => {
  const text = '![tracker](https://tracker.invalid/pixel) and 2 < 3 and 4 > 1';
  const escaped = escapeImportedText(text);
  const rendered = renderToStaticMarkup(createElement(ReactMarkdown, { children: escaped }));
  assert.doesNotMatch(rendered, /<img/);
  assert.equal(plainNoteText(escaped), text);
  assert.equal(searchNotes([note("a", "Imported", escaped)], "tracker").length, 1);
});

test("OCR wrapper resolves, cancels and reports worker errors without leaving a live worker", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  let last: FakeWorker | undefined;
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { message: string }) => void;
    onmessageerror?: () => void;
    terminated = 0;
    constructor() { last = this; }
    postMessage() { /* messages are delivered explicitly by this test */ }
    terminate() { this.terminated += 1; }
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
  try {
    const file = { name: "synthetic.png" } as File;
    let progress = "";
    const success = extractImageText(file, (message) => { progress = message; });
    assert.ok(last); const successfulWorker: FakeWorker = last;
    successfulWorker.onmessage?.({ data: { type: "progress", message: "recognizing 40%" } });
    assert.equal(progress, "recognizing 40%");
    successfulWorker.onmessage?.({ data: { type: "done", text: "cobalt pears" } });
    assert.equal(await success, "cobalt pears"); assert.equal(successfulWorker.terminated, 1);
    const controller = new AbortController();
    const canceled = extractImageText(file, undefined, controller.signal); assert.ok(last); const canceledWorker: FakeWorker = last;
    controller.abort(); await assert.rejects(canceled, { name: "AbortError" }); assert.equal(canceledWorker.terminated, 1);
    const failed = extractImageText(file); assert.ok(last); const failedWorker: FakeWorker = last;
    failedWorker.onmessage?.({ data: { type: "error", message: "model failed" } });
    await assert.rejects(failed, /model failed/); assert.equal(failedWorker.terminated, 1);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker); else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("on-device audio bounds and segments are explicit and lossless", async () => {
  const { validateAudioDuration, MAX_TRANSCRIPTION_BYTES, decodeAudioToMono16k } = await import("../src/lib/features/audio-transcription");
  const { transcriptionSegments, isAudioEffectivelySilent } = await import("../src/lib/features/transcription-segments");
  assert.doesNotThrow(() => validateAudioDuration(120));
  assert.throws(() => validateAudioDuration(120.01), /up to 2 minutes/);
  assert.throws(() => validateAudioDuration(Infinity), /duration/);
  await assert.rejects(decodeAudioToMono16k({ size: MAX_TRANSCRIPTION_BYTES + 1 } as Blob), /10 MiB/);
  const samples = new Float32Array(70 * 16_000);
  samples.fill(.1, 16_000, 22 * 16_000);
  const segments = transcriptionSegments(samples);
  assert.ok(segments.length >= 3);
  assert.equal(segments[0].start, 0);
  assert.equal(segments.at(-1)?.end, samples.length);
  for (let i = 0; i < segments.length; i += 1) {
    assert.ok(segments[i].end - segments[i].start <= 29 * 16_000);
    if (i) assert.equal(segments[i - 1].end, segments[i].start);
  }
  assert.equal(isAudioEffectivelySilent(new Float32Array(100)), true);
  assert.equal(isAudioEffectivelySilent(new Float32Array([0, .1])), false);
});

test("audio decoding stays local and transcription worker cancellation terminates it", async () => {
  const { decodeAudioToMono16k, transcribeAudioOnDevice } = await import("../src/lib/features/audio-transcription");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;
  const previousFetch = globalThis.fetch;
  class FakeMedia extends EventTarget {
    duration = Infinity;
    readyState = 1;
    preload = "";
    src = "";
    set currentTime(_value: number) { this.duration = 2; queueMicrotask(() => this.dispatchEvent(new Event("durationchange"))); }
    load() { if (this.src) queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata"))); }
    removeAttribute() { this.src = ""; }
  }
  class FakeOfflineAudioContext {
    constructor(_channels: number, _length: number, _rate: number) { /* test double */ }
    async decodeAudioData(_bytes: ArrayBuffer) {
      return { duration: 2, sampleRate: 16_000, numberOfChannels: 2, length: 4,
        getChannelData: (channel: number) => channel ? new Float32Array([.1, .2, .3, .4]) : new Float32Array([.3, .4, .5, .6]) };
    }
  }
  let last: FakeWorker | undefined;
  let workerReady: (() => void) | undefined;
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { message: string }) => void;
    onmessageerror?: () => void;
    terminated = 0;
    samples?: Float32Array;
    constructor() { last = this; workerReady?.(); }
    postMessage(message: { samples: Float32Array }) { this.samples = message.samples; }
    terminate() { this.terminated += 1; }
  }
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new FakeMedia() } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { OfflineAudioContext: FakeOfflineAudioContext } });
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
  URL.createObjectURL = () => "blob:local-test";
  URL.revokeObjectURL = () => undefined;
  globalThis.fetch = (() => { throw new Error("Audio decoding must not fetch or upload"); }) as typeof fetch;
  try {
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
    const mono = await decodeAudioToMono16k(file);
    assert.equal(mono.length, 4);
    assert.ok(Math.abs(mono[0] - .2) < .00001);
    const controller = new AbortController();
    const ready = new Promise<void>((resolve) => { workerReady = resolve; });
    const pending = transcribeAudioOnDevice(file, undefined, controller.signal);
    await ready;
    assert.ok(last);
    const worker: FakeWorker = last;
    assert.ok(worker.samples instanceof Float32Array);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(worker.terminated, 1);
    assert.equal(worker.onmessage, null);

    let progress = "";
    const readyAgain = new Promise<void>((resolve) => { workerReady = resolve; });
    const successful = transcribeAudioOnDevice(file, (message) => { progress = message; });
    await readyAgain;
    assert.ok(last); const successWorker: FakeWorker = last;
    successWorker.onmessage?.({ data: { type: "progress", message: "Transcribing part 1 of 1" } });
    assert.equal(progress, "Transcribing part 1 of 1");
    successWorker.onmessage?.({ data: { type: "done", text: "Only words returned by the model" } });
    assert.equal(await successful, "Only words returned by the model");
    assert.equal(successWorker.terminated, 1);

    const readyFailure = new Promise<void>((resolve) => { workerReady = resolve; });
    const failing = transcribeAudioOnDevice(file);
    await readyFailure;
    assert.ok(last); const failedWorker: FakeWorker = last;
    failedWorker.onmessage?.({ data: { type: "error", message: "Model download failed" } });
    await assert.rejects(failing, /Model download failed/);
    assert.equal(failedWorker.terminated, 1);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker); else Reflect.deleteProperty(globalThis, "Worker");
    URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl; globalThis.fetch = previousFetch;
  }
});
