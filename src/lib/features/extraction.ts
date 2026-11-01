/** Browser-only capture helpers. No captured file is sent to an application server. */

export type ExtractionProgress = (message: string) => void;

/**
 * Extract a PDF's selectable text layer locally. Scanned pages without a text layer
 * cannot be recognized here; image OCR is an explicit separate action.
 */
export async function extractPdfText(file: File, onProgress?: ExtractionProgress, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException("Canceled", "AbortError");
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const data = await file.arrayBuffer();
  if (signal?.aborted) throw new DOMException("Canceled", "AbortError");
  const loading = pdfjs.getDocument({ data, useSystemFonts: true });
  const cancel = () => { void loading.destroy(); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const pdf = await loading.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (signal?.aborted) throw new DOMException("Canceled", "AbortError");
      onProgress?.(`Reading page ${pageNumber} of ${pdf.numPages}`);
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if ("str" in item) text += `${item.str}${item.hasEOL ? "\n" : " "}`;
      }
      pages.push(text.replace(/[ \t]+\n/g, "\n").trim());
      page.cleanup();
    }
    return pages.filter(Boolean).join("\n\n").trim();
  } finally {
    signal?.removeEventListener("abort", cancel);
    await loading.destroy();
  }
}

/**
 * English OCR runs in a browser worker. Tesseract downloads its worker, engine and
 * trained language data on first use; the selected image itself stays in the worker.
 */
export async function extractImageText(file: File, onProgress?: ExtractionProgress, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException("Canceled", "AbortError");
  onProgress?.("Loading English recognition data…");
  const worker = new Worker(new URL("./ocr-worker.ts", import.meta.url), { type: "module" });
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (value?: string, error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      worker.terminate();
      if (error) reject(error); else resolve(value || "");
    };
    const cancel = () => finish(undefined, new DOMException("Canceled", "AbortError"));
    const timeout = window.setTimeout(() => finish(undefined, new Error("Text recognition timed out. Check your connection and retry.")), 120_000);
    worker.onmessage = ({ data }: MessageEvent<{ type: "progress" | "done" | "error"; message?: string; text?: string }>) => {
      if (data.type === "progress") onProgress?.(data.message || "Recognizing text…");
      else if (data.type === "done") finish(data.text || "");
      else if (data.type === "error") finish(undefined, new Error(data.message || "Text recognition failed."));
    };
    worker.onerror = (event) => finish(undefined, new Error(event.message || "Couldn’t start text recognition."));
    worker.onmessageerror = () => finish(undefined, new Error("Couldn’t read the text recognition result."));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    else {
      try { worker.postMessage({ file }); }
      catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error("Couldn’t start text recognition.")); }
    }
  });
}

/**
 * Parse an HTML import in an inert template, discard active/non-content elements,
 * and return only text. The markup is never inserted into the page or note preview.
 * This does not fetch a URL or try to bypass CORS.
 */
export function htmlToPlainText(html: string): string {
  if (typeof document === "undefined") throw new Error("HTML import is available in the browser only.");
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script, style, noscript, template, iframe, frame, object, embed, svg, math, canvas, audio, video, source, link, meta, base, form, input, button, select, textarea").forEach((node) => node.remove());
  const block = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DIV", "DL", "DT", "DD", "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TR", "UL"]);
  let text = "";
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { text += node.textContent || ""; return; }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    const tag = node instanceof Element ? node.tagName : "";
    if (block.has(tag)) text += "\n";
    node.childNodes.forEach(visit);
    if (block.has(tag)) text += "\n";
  };
  visit(template.content);
  return text.replace(/\r/g, "").replace(/[\t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
