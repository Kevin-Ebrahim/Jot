/** Versioned, generated-at-install runtime assets. No executable CDN is used. */
const TESSERACT_ROOT = "/runtime/tesseract-6.0.1";
const ONNX_ROOT = "/runtime/onnx-1.31.0-dev.20260914-8d85527a0";
export const WHISPER_MODEL = "Xenova/whisper-tiny.en";
export const WHISPER_REVISION = "5ba193d28a5ee3cb91de94d6a04fa6f115fb9655";
const WHISPER_DATA_FILES = new Set([
  "config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json",
  "special_tokens_map.json", "added_tokens.json", "merges.txt", "normalizer.json", "vocab.json",
  "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx",
]);

function appOrigin(origin: string): string {
  const base = new URL(origin);
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.origin === "null") throw new Error("Local runtime requires an HTTP(S) app origin.");
  return base.origin;
}
function sameOrigin(origin: string, path: string): string {
  const base = appOrigin(origin);
  const result = new URL(path, base);
  if (result.origin !== base) throw new Error("Runtime assets must be same-origin.");
  return result.href;
}

export function ocrRuntimePaths(origin: string) {
  return {
    workerPath: sameOrigin(origin, `${TESSERACT_ROOT}/worker.min.js`),
    corePath: sameOrigin(origin, `${TESSERACT_ROOT}/core-6.1.2`),
    langPath: sameOrigin(origin, `${TESSERACT_ROOT}/lang-eng-1.0.0`),
    // Do not reuse language data previously cached from an external CDN.
    cachePath: "jot-eng-1.0.0-local",
    workerBlobURL: false,
  };
}

/** Preserve Transformers.js's Safari-compatible factory selection, but not its CDN origin. */
export function onnxRuntimePaths(origin: string, defaultFactory: unknown) {
  const nonAsync = typeof defaultFactory === "string" && /(?:^|\/)ort-wasm-simd-threaded\.mjs(?:[?#].*)?$/.test(defaultFactory);
  const suffix = nonAsync ? "" : ".asyncify";
  return {
    mjs: sameOrigin(origin, `${ONNX_ROOT}/ort-wasm-simd-threaded${suffix}.mjs`),
    wasm: sameOrigin(origin, `${ONNX_ROOT}/ort-wasm-simd-threaded${suffix}.wasm`),
  };
}

/**
 * Permit only same-origin ONNX files and the pinned Whisper model repository.
 * Transformers.js v4 probes `main` for progress metadata even when a revision is
 * supplied, so rewrite that probe to the same immutable revision as inference.
 */
export function approvedWhisperRequest(origin: string, input: string | URL, init?: RequestInit): string {
  const base = appOrigin(origin);
  const method = (init?.method || "GET").toUpperCase();
  if ((method !== "GET" && method !== "HEAD") || init?.body != null) throw new Error("Transcription network requests must be read-only.");
  const url = new URL(input, base);
  if (url.username || url.password || url.search || url.hash) throw new Error("Unapproved transcription resource.");
  const allowedRuntime = new Set([
    `${ONNX_ROOT}/ort-wasm-simd-threaded.mjs`, `${ONNX_ROOT}/ort-wasm-simd-threaded.wasm`,
    `${ONNX_ROOT}/ort-wasm-simd-threaded.asyncify.mjs`, `${ONNX_ROOT}/ort-wasm-simd-threaded.asyncify.wasm`,
  ]);
  if (url.origin === base && allowedRuntime.has(url.pathname)) return url.href;
  const prefix = `/${WHISPER_MODEL}/resolve/`;
  if (url.origin !== "https://huggingface.co" || !url.pathname.startsWith(prefix)) throw new Error("Unapproved transcription resource.");
  const remainder = url.pathname.slice(prefix.length);
  const slash = remainder.indexOf("/");
  const revision = slash < 0 ? "" : remainder.slice(0, slash);
  const file = slash < 0 ? "" : remainder.slice(slash + 1);
  if ((revision !== "main" && revision !== WHISPER_REVISION) || !WHISPER_DATA_FILES.has(file)) {
    throw new Error("Unapproved transcription model resource.");
  }
  return `https://huggingface.co${prefix}${WHISPER_REVISION}/${file}`;
}

/** Only read-only model/runtime requests leave the inference library; no audio body can be uploaded. */
export function whisperFetch(origin: string, fetcher: typeof fetch = fetch): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const url = approvedWhisperRequest(origin, input, init);
    const source = new Headers(init?.headers);
    const headers = new Headers();
    const range = source.get("range");
    if (range && /^bytes=\d+-\d*$/.test(range)) headers.set("range", range);
    const localRuntime = new URL(url).origin === appOrigin(origin);
    return fetcher(url, { method: (init?.method || "GET").toUpperCase(), headers, credentials: localRuntime ? "same-origin" : "omit", referrerPolicy: "no-referrer", redirect: localRuntime ? "error" : "follow", cache: init?.cache, signal: init?.signal });
  };
}
