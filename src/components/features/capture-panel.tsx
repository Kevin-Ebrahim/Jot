"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AudioLines, FileAudio, FileImage, FileText, ImagePlus, Link2, Mic, Paperclip, PenLine, Square, Upload, X } from "lucide-react";
import type { NewNote } from "@/lib/types";
import { extractImageText, extractPdfText, htmlToPlainText } from "@/lib/features/extraction";
import { escapeImportedText } from "@/lib/features/imported-text";
import styles from "./capture-panel.module.css";

export interface CapturePanelProps {
  onClose(): void;
  onCreate(input: NewNote, files: File[]): Promise<void>;
}

type Mode = "file" | "voice" | "web" | "sketch";
type FileState = "ready" | "working" | "done" | "empty" | "error";
interface PendingFile { id: string; file: File; state: FileState; message: string; extracted: string; }
interface RecognitionResult { isFinal: boolean; [index: number]: { transcript: string }; }
interface RecognitionEvent { resultIndex: number; results: ArrayLike<RecognitionResult>; }
interface RecognitionErrorEvent { error: string; }
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionConstructor = new () => SpeechRecognitionLike;

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const makeId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const isImage = (file: File) => file.type.startsWith("image/") && file.type !== "image/svg+xml";
const isPdf = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);
const isAudio = (file: File) => file.type.startsWith("audio/");
const fileLabel = (file: File) => `${file.name} · ${file.size < 1_000_000 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1_000_000).toFixed(1)} MB`}`;
const cleanName = (name: string) => name.replace(/[\r\n]+/g, " ").replace(/[#\[\]\\]/g, "").trim();

/** Capture a note and attachments without uploading them to a capture service. */
export function CapturePanel({ onClose, onCreate }: CapturePanelProps) {
  const [mode, setMode] = useState<Mode>("file");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [webUrl, setWebUrl] = useState("");
  const [html, setHtml] = useState("");
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [recognitionSupported, setRecognitionSupported] = useState(false);
  const [speechState, setSpeechState] = useState<"idle" | "listening" | "stopping">("idle");
  const [recordState, setRecordState] = useState<"idle" | "starting" | "recording" | "stopping">("idle");
  const [seconds, setSeconds] = useState(0);
  const [notice, setNotice] = useState("");
  const [overflowRecording, setOverflowRecording] = useState<{ blob: Blob; name: string } | null>(null);
  const [overflowUrl, setOverflowUrl] = useState("");
  const [hasSketch, setHasSketch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const htmlInput = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const initializedCanvas = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const speechWindow = window as Window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
    setRecognitionSupported(!!(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition));
    return () => {
      mounted.current = false;
      controllers.current.forEach((controller) => controller.abort());
      controllers.current.clear();
      try { recognition.current?.stop(); } catch { /* already stopped */ }
      if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!overflowRecording) { setOverflowUrl(""); return; }
    const url = URL.createObjectURL(overflowRecording.blob);
    setOverflowUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [overflowRecording]);

  useEffect(() => {
    if (recordState !== "recording") return;
    const start = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, [recordState]);

  // The canvas remains mounted while modes change, so an unfinished drawing survives tab switches.
  useEffect(() => {
    if (mode !== "sketch" || initializedCanvas.current || !canvas.current) return;
    const context = canvas.current.getContext("2d");
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.current.width, canvas.current.height);
    initializedCanvas.current = true;
  }, [mode]);

  const updateFile = useCallback((id: string, patch: Partial<PendingFile>) => {
    if (mounted.current) setFiles((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }, []);

  const runExtraction = useCallback(async (item: PendingFile, kind: "pdf" | "image") => {
    const controller = new AbortController();
    controllers.current.get(item.id)?.abort();
    controllers.current.set(item.id, controller);
    updateFile(item.id, { state: "working", message: kind === "pdf" ? "Reading PDF…" : "Loading recognition…", extracted: "" });
    try {
      const progress = (message: string) => updateFile(item.id, { message });
      const text = kind === "pdf"
        ? await extractPdfText(item.file, progress, controller.signal)
        : await extractImageText(item.file, progress, controller.signal);
      if (!controller.signal.aborted) updateFile(item.id, text
        ? { state: "done", message: `${text.length.toLocaleString()} characters ready to search`, extracted: text }
        : { state: "empty", message: kind === "pdf" ? "No selectable text found. Scanned PDF pages aren’t recognized yet." : "No text recognized. You can still save the image.", extracted: "" });
    } catch (cause) {
      if (!controller.signal.aborted) updateFile(item.id, { state: "error", message: cause instanceof Error ? `Text extraction failed: ${cause.message}` : "Text extraction failed. You can still save the file.", extracted: "" });
    } finally {
      if (controllers.current.get(item.id) === controller) controllers.current.delete(item.id);
    }
  }, [updateFile]);

  const addFiles = useCallback((incoming: File[]) => {
    const tooLarge = incoming.filter((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (tooLarge.length) setError(`${tooLarge.map((file) => file.name).join(", ")} ${tooLarge.length === 1 ? "is" : "are"} over the 10 MiB per-file limit and ${tooLarge.length === 1 ? "was" : "were"} not added.`);
    const added = incoming.filter((file) => file.size <= MAX_ATTACHMENT_BYTES).map((file): PendingFile => ({ id: makeId(), file, state: "ready", message: isImage(file) ? "Image attached. Choose Make searchable to run OCR." : isAudio(file) ? "Audio attached. Existing recordings cannot be transcribed here." : "Attached to this note.", extracted: "" }));
    setFiles((current) => [...current, ...added]);
    for (const item of added) if (isPdf(item.file)) void runExtraction(item, "pdf");
  }, [runExtraction]);

  const removeFile = (id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    setFiles((current) => current.filter((item) => item.id !== id));
  };
  const cancelExtraction = (id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    updateFile(id, { state: "ready", message: "Text extraction stopped. The file can still be saved.", extracted: "" });
  };

  const startRecording = async () => {
    setError("");
    setNotice("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Audio recording isn’t supported in this browser. You can attach an existing recording instead.");
      return;
    }
    setRecordState("starting");
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) { media.getTracks().forEach((track) => track.stop()); return; }
      stream.current = media;
      const preferred = typeof MediaRecorder.isTypeSupported === "function" ? ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type)) : undefined;
      const current = preferred ? new MediaRecorder(media, { mimeType: preferred }) : new MediaRecorder(media);
      const chunks: BlobPart[] = [];
      let recordedBytes = 0;
      let autoStopped = false;
      current.ondataavailable = (event) => {
        if (event.data.size) { chunks.push(event.data); recordedBytes += event.data.size; }
        // Reserve space for the final chunk so recordings are not silently lost at the 10 MiB limit.
        if (recordedBytes >= 9 * 1024 * 1024 && current.state === "recording") {
          autoStopped = true;
          if (mounted.current) { setNotice("Recording reached the attachment limit; finishing…"); setRecordState("stopping"); }
          current.stop();
        }
      };
      current.onerror = () => { if (mounted.current) setError("The recording stopped unexpectedly. Please try again."); };
      current.onstop = () => {
        media.getTracks().forEach((track) => track.stop());
        if (stream.current === media) stream.current = null;
        recorder.current = null;
        if (!mounted.current) return;
        setRecordState("idle");
        const type = current.mimeType || "audio/webm";
        const blob = new Blob(chunks, { type });
        if (blob.size) {
          const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
          const name = `Recording-${stamp}.${extension}`;
          if (blob.size > MAX_ATTACHMENT_BYTES) {
            setNotice("");
            setOverflowRecording({ blob, name });
            setError("This recording exceeded 10 MiB and wasn’t attached. Download it below before discarding it.");
          } else {
            addFiles([new File([blob], name, { type })]);
            if (autoStopped) setNotice("Recording stopped near the 10 MiB limit and was added to this note.");
          }
        } else setError("No audio was captured. Please check your microphone and try again.");
      };
      recorder.current = current;
      current.start(1000);
      setSeconds(0);
      setRecordState("recording");
    } catch (cause) {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      if (mounted.current) {
        setRecordState("idle");
        setError(cause instanceof Error ? `Couldn’t start recording: ${cause.message}` : "Couldn’t access the microphone.");
      }
    }
  };
  const stopRecording = () => {
    if (recorder.current?.state === "recording") { setRecordState("stopping"); recorder.current.stop(); }
  };

  const startTranscription = () => {
    setError("");
    const speechWindow = window as Window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
    const Constructor = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Constructor) { setError("Live transcription isn’t supported in this browser."); return; }
    const current = new Constructor();
    current.continuous = true;
    current.interimResults = true;
    current.lang = navigator.language || "en-US";
    current.onresult = (event) => {
      if (!mounted.current) return;
      let finalText = "";
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      if (finalText) setTranscript((previous) => `${previous}${previous && !/\s$/.test(previous) ? " " : ""}${finalText}`);
      setInterim(interimText);
    };
    current.onerror = (event) => { if (mounted.current) setError(`Live transcription stopped: ${event.error}.`); };
    current.onend = () => { if (mounted.current) { setSpeechState("idle"); setInterim(""); } if (recognition.current === current) recognition.current = null; };
    recognition.current = current;
    try { current.start(); setSpeechState("listening"); }
    catch (cause) { recognition.current = null; setError(cause instanceof Error ? cause.message : "Couldn’t start live transcription."); }
  };
  const stopTranscription = () => {
    try { recognition.current?.stop(); setSpeechState("stopping"); }
    catch { setSpeechState("idle"); }
  };

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * target.width / rect.width, y: (event.clientY - rect.top) * target.height / rect.height };
  };
  const beginStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = point(event);
    drawing.current = true;
    context.beginPath(); context.moveTo(x, y); context.lineTo(x + .01, y + .01);
    context.strokeStyle = "#242424"; context.lineWidth = 3; context.lineCap = "round"; context.lineJoin = "round"; context.stroke();
    setHasSketch(true);
  };
  const moveStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const { x, y } = point(event);
    context.lineTo(x, y); context.stroke();
  };
  const clearSketch = () => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (element && context) { context.fillStyle = "#fff"; context.fillRect(0, 0, element.width, element.height); }
    setHasSketch(false);
  };
  const addSketch = () => {
    canvas.current?.toBlob((blob) => {
      if (!blob || !mounted.current) return;
      addFiles([new File([blob], `Sketch-${new Date().toISOString().slice(0, 10)}.png`, { type: "image/png" })]);
      clearSketch();
      setMode("file");
    }, "image/png");
  };

  const save = async () => {
    setError("");
    if (recordState !== "idle") { setError("Stop the recording before saving."); return; }
    if (speechState !== "idle") { setError("Stop live transcription before saving."); return; }
    if (files.some((item) => item.state === "working")) { setError("Wait for text extraction or stop it before saving."); return; }
    if (hasSketch) { setError("Add your sketch to the note or clear it before saving."); setMode("sketch"); return; }
    if (overflowRecording) { setError("Download or discard the oversized recording before saving."); setMode("voice"); return; }
    let attemptedSave = false;
    try {
      const sections = [body.trim()];
      if (webUrl.trim()) {
        let url: URL;
        try { url = new URL(webUrl.trim()); } catch { throw new Error("Enter a valid web address including https://."); }
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Use an http:// or https:// web address.");
        if (url.username || url.password) throw new Error("For your privacy, remove the username and password from the web address before saving.");
        sections.push(`### Saved link\n\n[${url.hostname.replace(/[\[\]]/g, "")}](<${url.href.replace(/>/g, "%3E")}>)`);
      }
      if (html.trim()) {
        const text = htmlToPlainText(html);
        if (text) sections.push(`### Saved page text\n\n${escapeImportedText(text)}`);
        else throw new Error("The imported HTML didn’t contain any readable text.");
      }
      if (transcript.trim()) sections.push(`### Live transcript\n\n${escapeImportedText(transcript.trim())}`);
      for (const item of files) if (item.extracted) sections.push(`### Extracted from ${escapeImportedText(cleanName(item.file.name))}\n\n${escapeImportedText(item.extracted)}`);
      const noteBody = sections.filter(Boolean).join("\n\n");
      if (noteBody.length > 1_000_000) throw new Error("This note exceeds the 1,000,000-character limit. Shorten it or choose ‘Keep file only’ for an extracted attachment.");
      setBusy(true);
      attemptedSave = true;
      await onCreate({ title: title.trim() || "Untitled", body: noteBody }, files.map((item) => item.file));
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Couldn’t save this capture. Please try again.";
      setError(`${message}${attemptedSave ? " A partial note may already be saved. Retry to finish, or close and find it in All notes." : ""}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const locked = recordState !== "idle" || speechState !== "idle";
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.heading}><h2>Quick capture</h2><p>Get it down now. Make sense of it later.</p></div>
        <button className={styles.close} type="button" onClick={onClose} disabled={busy} aria-label="Close capture"><X size={17} /></button>
      </div>
      <div className={styles.content}>
        <fieldset className={styles.fields} disabled={busy}>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {notice && <p className={styles.copy} role="status" style={{ marginBottom: 12 }}>{notice}</p>}
        <div className={styles.field}><label className={styles.fieldLabel} htmlFor="capture-title">Title</label><input id="capture-title" className={styles.title} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} placeholder="Give this a name…" autoFocus /></div>
        <div className={styles.field}><label className={styles.fieldLabel} htmlFor="capture-body">Note <span style={{ fontWeight: 400 }}>(optional)</span></label><textarea id="capture-body" className={styles.body} value={body} onChange={(event) => setBody(event.target.value)} placeholder="A thought, a link, a little detail…" /></div>
        <div className={styles.tabs} role="tablist" aria-label="Capture format">
          {([{ id: "file", label: "Files", Icon: Paperclip }, { id: "voice", label: "Voice", Icon: Mic }, { id: "web", label: "Web", Icon: Link2 }, { id: "sketch", label: "Sketch", Icon: PenLine }] as const).map(({ id, label, Icon }) => <button key={id} type="button" role="tab" aria-selected={mode === id} className={styles.tab} disabled={locked && mode !== id} onClick={() => setMode(id)}><Icon size={14} />{label}</button>)}
        </div>
        {mode === "file" && <div className={styles.captureBox} role="tabpanel">
          <p className={styles.boxTitle}>Bring a little more along</p><p className={styles.copy}>Attach photos, PDFs, audio, or other files. PDF text is extracted locally when available.</p>
          <div className={styles.actions}><button type="button" className={styles.smallButton} onClick={() => fileInput.current?.click()}><ImagePlus size={14} /> Choose files</button><input ref={fileInput} type="file" multiple hidden onChange={(event) => { addFiles(Array.from(event.target.files || [])); event.target.value = ""; }} /></div>
          <p className={styles.copy} style={{ marginTop: 10 }}>For images, “Make searchable” runs English OCR in your browser. First use downloads recognition code and language data from public CDNs; the image is processed locally. Handwriting may be inaccurate.</p>
        </div>}
        {mode === "voice" && <div className={styles.captureBox} role="tabpanel">
          <p className={styles.boxTitle}>Catch it in your own words</p><p className={styles.copy}>Record audio locally or attach an existing recording. Playback is available after saving. Recordings stop near the 10 MiB attachment limit.</p>
          <div className={styles.actions}>
            {recordState === "recording" ? <button type="button" className={`${styles.smallButton} ${styles.recording}`} onClick={stopRecording}><span className={styles.dot} /> Stop recording · {time}</button> : <button type="button" className={styles.smallButton} onClick={() => void startRecording()} disabled={recordState !== "idle" || !!overflowRecording}><Mic size={14} /> {recordState === "starting" ? "Opening microphone…" : recordState === "stopping" ? "Finishing…" : "Record audio"}</button>}
            <button type="button" className={styles.smallButton} onClick={() => audioInput.current?.click()} disabled={recordState !== "idle"}><Upload size={14} /> Attach audio</button><input ref={audioInput} type="file" accept="audio/*" multiple hidden onChange={(event) => { addFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
          </div>
          {overflowRecording && <div className={styles.transcript}><p style={{ margin: 0 }}>This recording is too large to attach. Download it, then discard this local copy to continue.</p><div className={styles.actions}>{overflowUrl && <a className={styles.smallButton} href={overflowUrl} download={overflowRecording.name}>Download recording</a>}<button type="button" className={styles.smallButton} onClick={() => { setOverflowRecording(null); setError(""); }}>Discard local copy</button></div></div>}
          <p className={styles.copy} style={{ marginTop: 12 }}>Optional live transcription uses your browser’s speech service, which may send audio to its provider. It listens only after you start it; existing audio files cannot be transcribed here.</p>
          <div className={styles.actions}>{speechState !== "idle" ? <button type="button" className={styles.smallButton} onClick={stopTranscription} disabled={speechState === "stopping"}><Square size={12} /> {speechState === "stopping" ? "Finishing transcript…" : "Stop live transcript"}</button> : <button type="button" className={styles.smallButton} onClick={startTranscription} disabled={!recognitionSupported}><AudioLines size={14} /> {recognitionSupported ? "Start live transcript" : "Live transcript unavailable"}</button>}</div>
          {(transcript || interim) && <div className={styles.transcript} aria-live="polite">{transcript}{interim && <span style={{ opacity: .6 }}> {interim}</span>}</div>}
        </div>}
        {mode === "web" && <div className={styles.captureBox} role="tabpanel">
          <p className={styles.boxTitle}>Save something from the web</p><p className={styles.copy}>Save a link and optionally paste or import page HTML. Jot extracts plain text; it does not fetch the page for you.</p>
          <div className={styles.webFields}>
            <input className={styles.input} type="url" aria-label="Web address" placeholder="https://example.com" value={webUrl} onChange={(event) => setWebUrl(event.target.value)} />
            <textarea className={styles.input} aria-label="Page HTML" placeholder="Paste page HTML here (optional)" value={html} onChange={(event) => setHtml(event.target.value)} />
          </div>
          <div className={styles.actions}><button type="button" className={styles.smallButton} onClick={() => htmlInput.current?.click()}><Upload size={14} /> Import HTML file</button><input ref={htmlInput} type="file" accept=".html,.htm,text/html" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then(setHtml).catch(() => setError("Couldn’t read that HTML file.")); event.target.value = ""; }} /></div>
        </div>}
        {/* Keep the canvas in the tree to retain an unsaved sketch when switching tabs. */}
        <div className={styles.captureBox} role="tabpanel" hidden={mode !== "sketch"}>
          <p className={styles.boxTitle}>A little room to draw</p><p className={styles.copy}>Write or sketch with a mouse, touch, or stylus. Add it as an image when you’re done.</p>
          <canvas ref={canvas} className={styles.canvas} width={900} height={420} aria-label="Handwriting canvas" onPointerDown={beginStroke} onPointerMove={moveStroke} onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }} />
          <div className={styles.actions}><button type="button" className={styles.smallButton} onClick={addSketch} disabled={!hasSketch}>Add sketch</button><button type="button" className={styles.smallButton} onClick={clearSketch} disabled={!hasSketch}>Clear</button></div>
        </div>
        {files.length > 0 && <div className={styles.fileList} aria-label="Files to attach">{files.map((item) => {
          const Icon = isImage(item.file) ? FileImage : isAudio(item.file) ? FileAudio : FileText;
          return <div className={styles.fileRow} key={item.id}><Icon className={styles.fileIcon} size={16} /><div className={styles.fileInfo}><div className={styles.fileName} title={item.file.name}>{fileLabel(item.file)}</div><div className={styles.fileStatus} aria-live="polite">{item.message}</div></div><div className={styles.fileActions}>{item.state === "working" ? <button type="button" className={styles.textButton} onClick={() => cancelExtraction(item.id)}>Stop</button> : item.state === "done" ? <button type="button" className={styles.textButton} onClick={() => updateFile(item.id, { state: "ready", message: "Extracted text removed; the file will still be attached.", extracted: "" })}>Keep file only</button> : (isImage(item.file) || isPdf(item.file)) ? <button type="button" className={styles.textButton} onClick={() => void runExtraction(item, isPdf(item.file) ? "pdf" : "image")}>Make searchable</button> : null}<button type="button" className={styles.remove} onClick={() => removeFile(item.id)} aria-label={`Remove ${item.file.name}`}><X size={14} /></button></div></div>;
        })}</div>}
        </fieldset>
      </div>
      <div className={styles.footer}><span className={styles.privacy}>Files are stored on this device.</span><button type="button" className="button" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="button primary" onClick={() => void save()} disabled={busy || locked}>{busy ? "Saving…" : "Save note"}</button></div>
    </div>
  );
}
