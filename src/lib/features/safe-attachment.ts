/** A download must not expose active HTML or SVG under its original MIME type. */
export function safeDownloadBlob(blob: Blob): Blob {
  return new Blob([blob], { type: "application/octet-stream" });
}
