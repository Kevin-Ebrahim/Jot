"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileAudio, FileImage, FileText, Plus, Trash2 } from "lucide-react";
import type { Attachment } from "@/lib/types";
import { subscribeStore } from "@/lib/store";
import { extractImageText, extractPdfText } from "@/lib/features/extraction";
import { escapeImportedText } from "@/lib/features/imported-text";
import { transcribeAudioOnDevice } from "@/lib/features/audio-transcription";
import styles from "./attachment-list.module.css";

export interface AttachmentListProps {
  noteId: string;
  listAttachments(noteId: string): Promise<Attachment[]>;
  addAttachment?(noteId: string, file: Blob, name: string): Promise<Attachment>;
  deleteAttachment?(id: string): Promise<void>;
  /** Append extracted Markdown through the note's existing draft/save flow. */
  onAppendText?(markdown: string): void | { saved: boolean } | Promise<void | { saved: boolean }>;
  refreshKey?: number;
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const rasterTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const isImage = (attachment: Attachment) => rasterTypes.has(attachment.mimeType.toLowerCase());
const isPdf = (attachment: Attachment) => attachment.mimeType.toLowerCase() === "application/pdf" || /\.pdf$/i.test(attachment.name);
const isAudio = (attachment: Attachment) => {
  const mime = attachment.mimeType.toLowerCase();
  return mime.startsWith("audio/") || ((!mime || mime === "application/octet-stream" || mime.startsWith("video/")) && /\.(?:wav|mp3|m4a|aac|ogg|opus|webm|flac)$/i.test(attachment.name));
};
const sizeLabel = (bytes: number) => bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;

function AttachmentCard({ attachment, onDelete, onAppendText }: { attachment: Attachment; onDelete?: (id: string) => Promise<void>; onAppendText?: (markdown: string) => void | { saved: boolean } | Promise<void | { saved: boolean }> }) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("");
  const [working, setWorking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pendingTranscript, setPendingTranscript] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const objectUrl = URL.createObjectURL(attachment.blob);
    setUrl(objectUrl);
    return () => { mounted.current = false; controller.current?.abort(); URL.revokeObjectURL(objectUrl); };
  }, [attachment.blob]);
  const Icon = isImage(attachment) ? FileImage : isAudio(attachment) ? FileAudio : FileText;

  const extract = async () => {
    if (!onAppendText) return;
    const abort = new AbortController();
    controller.current = abort;
    setWorking(true); setStatus(isAudio(attachment) ? "Preparing local transcription…" : isImage(attachment) ? "Loading English recognition data…" : "Reading PDF…");
    try {
      const file = new File([attachment.blob], attachment.name, { type: attachment.mimeType });
      const progress = (message: string) => { if (mounted.current && controller.current === abort && !abort.signal.aborted) setStatus(message); };
      const text = isAudio(attachment) ? await transcribeAudioOnDevice(file, progress, abort.signal)
        : isImage(attachment) ? await extractImageText(file, progress, abort.signal)
        : await extractPdfText(file, progress, abort.signal);
      if (abort.signal.aborted || controller.current !== abort) return;
      if (!text) { setStatus(isAudio(attachment) ? "No speech was recognized." : isPdf(attachment) ? "No selectable text found. Scanned PDF pages aren’t recognized yet." : "No text recognized."); return; }
      if (isAudio(attachment)) { setPendingTranscript(text); setStatus("Review the transcript before adding it to this note."); return; }
      const name = attachment.name.replace(/[\r\n#\[\]\\]+/g, " ").trim();
      setApplying(true);
      const outcome = await onAppendText(`\n\n### Extracted from ${escapeImportedText(name)}\n\n${escapeImportedText(text)}`);
      if (mounted.current && controller.current === abort) setStatus(outcome && !outcome.saved ? "Text added to the draft but not saved. Resolve the save issue in the note." : "Text added to this note for search.");
    } catch (cause) {
      if (mounted.current && controller.current === abort && !abort.signal.aborted) setStatus(cause instanceof Error ? `Couldn’t ${isAudio(attachment) ? "transcribe" : "extract text"}: ${cause.message}` : "Couldn’t process this file.");
    } finally { if (controller.current === abort) { controller.current = null; if (mounted.current) { setWorking(false); setApplying(false); } } }
  };
  const addTranscript = async () => {
    if (!onAppendText || !pendingTranscript?.trim() || applying) return;
    setApplying(true);
    try {
      const name = attachment.name.replace(/[\r\n#\[\]\\]+/g, " ").trim();
      const outcome = await onAppendText(`\n\n### Transcript of ${escapeImportedText(name)}\n\n${escapeImportedText(pendingTranscript.trim())}`);
      if (mounted.current) {
        setPendingTranscript(null);
        setStatus(outcome && !outcome.saved ? "Transcript added to the draft but not saved. Resolve the save issue in the note." : "Transcript added to this note for search.");
      }
    } catch (cause) {
      if (mounted.current) setStatus(cause instanceof Error ? `Couldn’t add transcript: ${cause.message}` : "Couldn’t add transcript.");
    } finally { if (mounted.current) setApplying(false); }
  };
  const remove = async () => {
    if (!onDelete) return;
    try { await onDelete(attachment.id); }
    catch (cause) { if (mounted.current) setStatus(cause instanceof Error ? cause.message : "Couldn’t remove attachment."); }
  };

  return <div className={styles.card}>
    <Icon size={16} className={styles.icon} />
    <div className={styles.info}>
      <div className={styles.name} title={attachment.name}>{attachment.name}</div>
      <div className={styles.meta}>{sizeLabel(attachment.size)}</div>
      {url && isImage(attachment) && <img className={styles.preview} src={url} alt={attachment.name} />}
      {url && isAudio(attachment) && <audio className={styles.audio} controls preload="none" src={url}>Your browser cannot play this recording.</audio>}
      <div className={styles.tools}>
        {url && <a className={styles.action} href={url} download={attachment.name}><Download size={12} /> Download</a>}
        {onAppendText && (isImage(attachment) || isPdf(attachment) || isAudio(attachment)) && (working
          ? <button type="button" className={styles.action} disabled={applying} onClick={() => { const previous = controller.current; controller.current = null; previous?.abort(); setWorking(false); setStatus("Processing stopped."); }}>{applying ? "Adding…" : "Stop"}</button>
          : !pendingTranscript && <button type="button" className={styles.action} disabled={applying} onClick={() => void extract()}>{isAudio(attachment) ? "Transcribe on device" : "Make searchable"}</button>)}
        {onDelete && (confirmRemove ? <><button type="button" className={`${styles.action} ${styles.confirm}`} disabled={applying} onClick={() => void remove()}>Confirm remove</button><button type="button" className={styles.action} disabled={applying} onClick={() => setConfirmRemove(false)}>Cancel</button></> : <button type="button" className={styles.action} disabled={applying} onClick={() => setConfirmRemove(true)}><Trash2 size={12} /> Remove</button>)}
      </div>
      {status && <div className={styles.status} role="status">{status}</div>}
      {pendingTranscript !== null && <div className={styles.transcriptReview}><label>Review transcript<textarea className={styles.transcriptInput} value={pendingTranscript} onChange={(event) => setPendingTranscript(event.target.value)} disabled={applying} /></label><p>Leaving this note before adding it discards this draft transcript.</p><div className={styles.tools}><button type="button" className={styles.action} disabled={applying || !pendingTranscript.trim()} onClick={() => void addTranscript()}>{applying ? "Adding…" : "Add to note"}</button><button type="button" className={styles.action} disabled={applying} onClick={() => { setPendingTranscript(null); setStatus("Transcript discarded; the recording is unchanged."); }}>Discard transcript</button></div></div>}
    </div>
  </div>;
}

/** Safe attachment previews: raster images and audio only; all other types download. */
export function AttachmentList({ noteId, listAttachments, addAttachment, deleteAttachment, onAppendText, refreshKey = 0 }: AttachmentListProps) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [itemsNoteId, setItemsNoteId] = useState(noteId);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const currentNote = useRef(noteId);
  currentNote.current = noteId;
  const reload = useCallback(async () => {
    const request = ++generation.current;
    try {
      const result = await listAttachments(noteId);
      if (request === generation.current && currentNote.current === noteId) {
        setItems((previous) => result.filter((item) => !item.deletedAt).map((item) => {
          const existing = previous.find((candidate) => candidate.id === item.id && candidate.size === item.size && candidate.mimeType === item.mimeType);
          return existing ? { ...item, blob: existing.blob } : item;
        }));
        setItemsNoteId(noteId);
        setError("");
      }
    } catch (cause) {
      if (request === generation.current && currentNote.current === noteId) {
        setItems([]); setItemsNoteId(noteId);
        setError(cause instanceof Error ? cause.message : "Couldn’t load attachments.");
      }
    }
  }, [listAttachments, noteId]);
  useEffect(() => { setItems([]); setBusy(false); void reload(); return () => { generation.current += 1; }; }, [reload, refreshKey]);
  useEffect(() => subscribeStore(() => { void reload(); }), [reload]);
  const add = async (files: File[]) => {
    if (!addAttachment || !files.length) return;
    const oversized = files.filter((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (oversized.length) { setError(`${oversized.map((file) => file.name).join(", ")} exceeds the 10 MiB per-file limit.`); return; }
    setBusy(true); setError("");
    try { for (const file of files) await addAttachment(noteId, file, file.name); await reload(); }
    catch (cause) { await reload(); if (currentNote.current === noteId) setError(cause instanceof Error ? cause.message : "Couldn’t add attachment."); }
    finally { if (currentNote.current === noteId) setBusy(false); }
  };
  const remove = deleteAttachment ? async (id: string) => { await deleteAttachment(id); await reload(); } : undefined;
  // Never render one note's cached attachments while another note is loading.
  const visibleItems = itemsNoteId === noteId ? items : [];
  const visibleError = itemsNoteId === noteId ? error : "";
  if (!visibleItems.length && !addAttachment && !visibleError) return null;
  return <section className={styles.root} aria-label="Attachments">
    <div className={styles.header}><h3 className={styles.heading}>Attachments <span className={styles.count}>{visibleItems.length}</span></h3>{addAttachment && <><button type="button" className={styles.add} onClick={() => input.current?.click()} disabled={busy}><Plus size={13} /> Add file</button><input type="file" ref={input} multiple hidden onChange={(event) => { void add(Array.from(event.target.files || [])); event.target.value = ""; }} /></>}</div>
    {visibleError && <p className={styles.error} role="alert">{visibleError}</p>}
    {onAppendText && visibleItems.some(isAudio) && <p className={styles.hint}>On-device transcription is English-only, up to 2 minutes and 10 MiB. First use downloads about 45 MB of model files plus runtime from Hugging Face and a CDN; it can take several minutes. Audio is not sent to a transcription service. If signed in, normal sync may send the attachment and saved transcript to your configured server. Review the result for mistakes.</p>}
    <div className={styles.list}>{visibleItems.map((item) => <AttachmentCard key={item.id} attachment={item} onDelete={remove} onAppendText={onAppendText} />)}</div>
    {onAppendText && visibleItems.some(isImage) && <p className={styles.hint}>English image OCR runs locally. Its code and language data download from public CDNs on first use; handwriting may be inaccurate.</p>}
  </section>;
}
