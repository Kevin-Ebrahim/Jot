import assert from "node:assert/strict";
import { test } from "node:test";
import { approvedWhisperRequest, ocrRuntimePaths, onnxRuntimePaths, whisperFetch, WHISPER_MODEL, WHISPER_REVISION } from "../src/lib/features/runtime-paths";

const origin = "https://jot.example.test";

test("OCR worker, core and English data resolve only to versioned app-origin assets", () => {
  const options = ocrRuntimePaths(origin);
  for (const path of [options.workerPath, options.corePath, options.langPath]) assert.equal(new URL(path).origin, origin);
  assert.equal(options.workerPath, `${origin}/runtime/tesseract-6.0.1/worker.min.js`);
  assert.equal(options.corePath, `${origin}/runtime/tesseract-6.0.1/core-6.1.2`);
  assert.equal(options.langPath, `${origin}/runtime/tesseract-6.0.1/lang-eng-1.0.0`);
  assert.equal(options.workerBlobURL, false);
  assert.equal(options.cachePath, "jot-eng-1.0.0-local");
  assert.throws(() => ocrRuntimePaths("data:text/html,bad"), /HTTP/);
});

test("ONNX factory and WASM are same-origin for both supported variants", () => {
  for (const [oldFactory, suffix] of [["https://cdn.invalid/ort-wasm-simd-threaded.asyncify.mjs", ".asyncify"], ["https://cdn.invalid/ort-wasm-simd-threaded.mjs", ""]] as const) {
    const paths = onnxRuntimePaths(origin, oldFactory);
    assert.equal(paths.mjs, `${origin}/runtime/onnx-1.31.0-dev.20260914-8d85527a0/ort-wasm-simd-threaded${suffix}.mjs`);
    assert.equal(paths.wasm, `${origin}/runtime/onnx-1.31.0-dev.20260914-8d85527a0/ort-wasm-simd-threaded${suffix}.wasm`);
    assert.equal(approvedWhisperRequest(origin, paths.mjs), paths.mjs);
    assert.equal(approvedWhisperRequest(origin, paths.wasm), paths.wasm);
  }
});

test("Whisper permits only read-only pinned model data and local runtime requests", async () => {
  const main = `https://huggingface.co/${WHISPER_MODEL}/resolve/main/config.json`;
  const pinned = `https://huggingface.co/${WHISPER_MODEL}/resolve/${WHISPER_REVISION}/config.json`;
  assert.equal(approvedWhisperRequest(origin, main), pinned, "library main-branch metadata probes must be pinned");
  assert.equal(approvedWhisperRequest(origin, pinned), pinned);
  for (const bad of [
    "https://cdn.jsdelivr.net/evil.js",
    `${origin}/runtime/other.js`,
    `https://huggingface.co/${WHISPER_MODEL}/resolve/main/config.json?audio=secret`,
    `https://huggingface.co/${WHISPER_MODEL}/resolve/other/config.json`,
    `https://huggingface.co/${WHISPER_MODEL}/resolve/main/%2e%2e/other`,
    "https://user:pass@huggingface.co/Xenova/whisper-tiny.en/resolve/main/config.json",
  ]) assert.throws(() => approvedWhisperRequest(origin, bad), /Unapproved/);
  assert.throws(() => approvedWhisperRequest(origin, pinned, { method: "POST", body: "audio" }), /read-only/);
  assert.throws(() => approvedWhisperRequest(origin, pinned, { method: "GET", body: "audio" }), /read-only/);
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ input: String(input), init }); return new Response("ok"); }) as typeof fetch;
  await whisperFetch(origin, fetcher)(main, { headers: { Range: "bytes=0-0", Authorization: "secret" } });
  assert.equal(calls[0].input, pinned);
  assert.equal(calls[0].init?.credentials, "omit"); assert.equal(calls[0].init?.referrerPolicy, "no-referrer");
  assert.equal(new Headers(calls[0].init?.headers).get("range"), "bytes=0-0");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), null);
  assert.equal(calls[0].init?.body, undefined);
  const local = onnxRuntimePaths(origin, undefined).mjs;
  await whisperFetch(origin, fetcher)(local);
  assert.equal(calls[1].input, local); assert.equal(calls[1].init?.redirect, "error");
  assert.equal(calls[1].init?.credentials, "same-origin");
});
