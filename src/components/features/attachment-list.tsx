"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileAudio, FileImage, FileText, Plus, Trash2 } from "lucide-react";
import type { Attachment } from "@/lib/types";
import { extractImageText, extractPdfText } from "@/lib/features/extraction";
import styles from "./attachment-list.module.css";

export interface AttachmentListProps {
  noteId: string;
  listAttachments(noteId: string): Promise<Attachment[]>;
  addAttachment?(noteId: string, file: Blob, name: string): Promise<Attachment>;
  deleteAttachment?(id: string): Promise<void>;
  /** Append extracted Markdown through the note's existing draft/save flow. */
  onAppendText?(markdown: string): void | Promise<void>;
  refreshKey?: number;
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const rasterTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const isImage = (attachment: Attachment) => rasterTypes.has(attachment.mimeType.toLowerCase());
const isPdf = (attachment: Attachment) => attachment.mimeType.toLowerCase() === "application/pdf" || /\.pdf$/i.test(attachment.name);
const isAudio = (attachment: Attachment) => attachment.mimeType.toLowerCase().startsWith("audio/");
const sizeLabel = (bytes: number) => bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;

function AttachmentCard({ attachment, onDelete, onAppendText }: { attachment: Attachment; onDelete?: (id: string) => Promise<void>; onAppendText?: (markdown: string) => void | Promise<void> }) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("");
  const [working, setWorking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
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
    setWorking(true); setStatus(isImage(attachment) ? "Loading English recognition data…" : "Reading PDF…");
    try {
      const file = new File([attachment.blob], attachment.name, { type: attachment.mimeType });
      const progress = (message: string) => { if (mounted.current) setStatus(message); };
      const text = isImage(attachment) ? await extractImageText(file, progress, abort.signal) : await extractPdfText(file, progress, abort.signal);
      if (abort.signal.aborted) return;
      if (!text) { setStatus(isPdf(attachment) ? "No selectable text found. Scanned PDF pages aren’t recognized yet." : "No text recognized."); return; }
      const name = attachment.name.replace(/[\r\n#\[\]\\]+/g, " ").trim();
      await onAppendText(`\n\n### Extracted from ${name}\n\n${text}`);
      if (mounted.current) setStatus("Text added to this note for search.");
    } catch (cause) {
      if (mounted.current && !abort.signal.aborted) setStatus(cause instanceof Error ? `Couldn’t extract text: ${cause.message}` : "Couldn’t extract text.");
    } finally { if (mounted.current) setWorking(false); if (controller.current === abort) controller.current = null; }
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
        {onAppendText && (isImage(attachment) || isPdf(attachment)) && (working
          ? <button type="button" className={styles.action} onClick={() => { controller.current?.abort(); setWorking(false); setStatus("Text extraction stopped."); }}>Stop</button>
          : <button type="button" className={styles.action} onClick={() => void extract()}>Make searchable</button>)}
        {onDelete && (confirmRemove ? <><button type="button" className={`${styles.action} ${styles.confirm}`} onClick={() => void remove()}>Confirm remove</button><button type="button" className={styles.action} onClick={() => setConfirmRemove(false)}>Cancel</button></> : <button type="button" className={styles.action} onClick={() => setConfirmRemove(true)}><Trash2 size={12} /> Remove</button>)}
      </div>
      {status && <div className={styles.status} role="status">{status}</div>}
    </div>
  </div>;
}

/** Safe attachment previews: raster images and audio only; all other types download. */
export function AttachmentList({ noteId, listAttachments, addAttachment, deleteAttachment, onAppendText, refreshKey = 0 }: AttachmentListProps) {
  const [items, setItems] = useState<Attachment[]>([]);
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
      if (request === generation.current && currentNote.current === noteId) { setItems(result.filter((item) => !item.deletedAt)); setError(""); }
    } catch (cause) { if (request === generation.current && currentNote.current === noteId) setError(cause instanceof Error ? cause.message : "Couldn’t load attachments."); }
  }, [listAttachments, noteId]);
  useEffect(() => { setItems([]); setBusy(false); void reload(); return () => { generation.current += 1; }; }, [reload, refreshKey]);
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
  if (!items.length && !addAttachment && !error) return null;
  return <section className={styles.root} aria-label="Attachments">
    <div className={styles.header}><h3 className={styles.heading}>Attachments <span className={styles.count}>{items.length}</span></h3>{addAttachment && <><button type="button" className={styles.add} onClick={() => input.current?.click()} disabled={busy}><Plus size={13} /> Add file</button><input type="file" ref={input} multiple hidden onChange={(event) => { void add(Array.from(event.target.files || [])); event.target.value = ""; }} /></>}</div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.list}>{items.map((item) => <AttachmentCard key={item.id} attachment={item} onDelete={remove} onAppendText={onAppendText} />)}</div>
    {onAppendText && items.some(isImage) && <p className={styles.hint}>English image OCR runs locally. Its code and language data download from public CDNs on first use; handwriting may be inaccurate.</p>}
  </section>;
}
