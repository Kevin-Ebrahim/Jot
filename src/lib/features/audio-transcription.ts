/** Local-only prerecorded speech transcription. Audio bytes are never passed to a URL. */
export const MAX_TRANSCRIPTION_BYTES = 10 * 1024 * 1024;
export const MAX_TRANSCRIPTION_SECONDS = 120;
export const TRANSCRIPTION_SAMPLE_RATE = 16_000;
export type TranscriptionProgress = (message: string) => void;

function abortError(): DOMException { return new DOMException("Canceled", "AbortError"); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(); }

/** Reject unknown/long durations before the browser allocates a decoded buffer. */
export function validateAudioDuration(duration: number): void {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Couldn’t determine the audio duration. Try a supported WAV, MP3, M4A, OGG, or WebM file.");
  if (duration > MAX_TRANSCRIPTION_SECONDS) throw new Error(`Transcription supports recordings up to ${MAX_TRANSCRIPTION_SECONDS / 60} minutes. Split this recording and try again.`);
}

/** Read local media metadata, including the duration-less WebM produced by some browsers. */
export function probeAudioDuration(file: Blob, signal?: AbortSignal): Promise<number> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const media = document.createElement("audio");
    const url = URL.createObjectURL(file);
    let settled = false;
    let seekingEnd = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      media.removeEventListener("loadedmetadata", inspect);
      media.removeEventListener("durationchange", inspect);
      media.removeEventListener("seeked", inspect);
      media.removeEventListener("timeupdate", inspect);
      media.removeEventListener("error", failed);
      media.removeAttribute("src");
      try { media.load(); } catch { /* already detached */ }
      URL.revokeObjectURL(url);
    };
    const finish = (duration?: number, error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(duration!);
    };
    const cancel = () => finish(undefined, abortError());
    const failed = () => finish(undefined, new Error("This browser couldn’t read that audio file. Try WAV, MP3, M4A, OGG, or WebM."));
    const inspect = () => {
      if (Number.isFinite(media.duration) && media.duration > 0) {
        try { validateAudioDuration(media.duration); finish(media.duration); }
        catch (error) { finish(undefined, error instanceof Error ? error : new Error("Invalid audio duration.")); }
      } else if (media.readyState >= 1 && !seekingEnd) {
        // MediaRecorder WebM sometimes reports Infinity until it seeks to its end.
        seekingEnd = true;
        try { media.currentTime = 1e100; } catch { /* timeout yields a clear error */ }
      }
    };
    timer = setTimeout(() => finish(undefined, new Error("Couldn’t determine the audio duration. Try exporting it as WAV or MP3.")), 15_000);
    media.addEventListener("loadedmetadata", inspect);
    media.addEventListener("durationchange", inspect);
    media.addEventListener("seeked", inspect);
    media.addEventListener("timeupdate", inspect);
    media.addEventListener("error", failed);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    media.preload = "metadata";
    media.src = url;
    try { media.load(); } catch { failed(); }
  });
}

function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener("abort", cancel); reject(abortError()); };
    signal.addEventListener("abort", cancel, { once: true });
    operation.then((value) => { signal.removeEventListener("abort", cancel); resolve(value); }, (error) => { signal.removeEventListener("abort", cancel); reject(error); });
  });
}

/** Decode using the browser, resample to 16 kHz, and downmix locally to mono PCM. */
export async function decodeAudioToMono16k(file: Blob, signal?: AbortSignal): Promise<Float32Array> {
  if (file.size <= 0 || file.size > MAX_TRANSCRIPTION_BYTES) throw new Error("Choose a non-empty audio file no larger than 10 MiB.");
  await probeAudioDuration(file, signal);
  checkAbort(signal);
  const scope = window as Window & { webkitOfflineAudioContext?: typeof OfflineAudioContext };
  const Constructor = window.OfflineAudioContext || scope.webkitOfflineAudioContext;
  if (!Constructor) throw new Error("This browser cannot decode audio for on-device transcription.");
  let decoded: AudioBuffer;
  try {
    const context = new Constructor(1, 1, TRANSCRIPTION_SAMPLE_RATE);
    const bytes = await withAbort(file.arrayBuffer(), signal);
    decoded = await withAbort(context.decodeAudioData(bytes), signal);
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw abortError();
    throw new Error("This browser couldn’t decode that recording. Try exporting it as WAV or MP3.");
  }
  checkAbort(signal);
  validateAudioDuration(decoded.duration);
  if (decoded.sampleRate !== TRANSCRIPTION_SAMPLE_RATE) throw new Error("This browser couldn’t resample the audio to 16 kHz.");
  if (!decoded.numberOfChannels || decoded.numberOfChannels > 8 || decoded.length > MAX_TRANSCRIPTION_SECONDS * TRANSCRIPTION_SAMPLE_RATE + TRANSCRIPTION_SAMPLE_RATE) {
    throw new Error("This recording has too many channels or samples to transcribe safely.");
  }
  const mono = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    const source = decoded.getChannelData(channel);
    for (let i = 0; i < mono.length; i += 1) mono[i] += source[i] / decoded.numberOfChannels;
  }
  return mono;
}

/** A disposable worker owns model download and inference; Stop terminates it. */
export async function transcribeAudioOnDevice(file: Blob, onProgress?: TranscriptionProgress, signal?: AbortSignal): Promise<string> {
  checkAbort(signal);
  onProgress?.("Checking and decoding audio locally…");
  const samples = await decodeAudioToMono16k(file, signal);
  checkAbort(signal);
  onProgress?.("Loading the on-device speech model…");
  const worker = new Worker(new URL("./transcription-worker.ts", import.meta.url), { type: "module" });
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (text?: string, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error); else resolve(text || "");
    };
    const cancel = () => finish(undefined, abortError());
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => finish(undefined, new Error("Transcription timed out. Check your connection or try a shorter recording.")), 8 * 60_000);
    };
    worker.onmessage = ({ data }: MessageEvent<{ type: "progress" | "done" | "error"; message?: string; text?: string }>) => {
      if (settled) return;
      if (data.type === "progress") { resetTimeout(); onProgress?.(data.message || "Transcribing on this device…"); }
      else if (data.type === "done") finish(data.text || "");
      else if (data.type === "error") finish(undefined, new Error(data.message || "Transcription failed."));
    };
    worker.onerror = (event) => finish(undefined, new Error(event.message || "Couldn’t start on-device transcription."));
    worker.onmessageerror = () => finish(undefined, new Error("Couldn’t read the transcription result."));
    signal?.addEventListener("abort", cancel, { once: true });
    resetTimeout();
    if (signal?.aborted) cancel();
    else {
      try { worker.postMessage({ samples }, [samples.buffer as ArrayBuffer]); }
      catch (error) { finish(undefined, error instanceof Error ? error : new Error("Couldn’t start transcription.")); }
    }
  });
}
