/** Disposable Web Worker: all audio inference stays in this browser. */
import { env, pipeline } from "@huggingface/transformers";
import { isAudioEffectivelySilent, transcriptionSegments } from "./transcription-segments";

const MODEL = "Xenova/whisper-tiny.en";
const MODEL_REVISION = "5ba193d28a5ee3cb91de94d6a04fa6f115fb9655";
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ samples: Float32Array }>) => void) | null;
  postMessage(message: { type: "progress" | "done" | "error"; message?: string; text?: string }): void;
};

scope.onmessage = async ({ data }) => {
  let transcriber: Awaited<ReturnType<typeof pipeline<"automatic-speech-recognition">>> | undefined;
  try {
    const segments = transcriptionSegments(data.samples);
    if (!segments.length || isAudioEffectivelySilent(data.samples)) { scope.postMessage({ type: "done", text: "" }); return; }
    // One WASM thread works without cross-origin isolation; model files and runtime
    // are downloaded on demand, while the audio remains a local typed array.
    env.allowLocalModels = false;
    if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;
    scope.postMessage({ type: "progress", message: "Loading the English speech model…" });
    transcriber = await pipeline("automatic-speech-recognition", MODEL, {
      revision: MODEL_REVISION,
      dtype: "q8",
      device: "wasm",
      progress_callback: (event) => {
        if (event.status === "progress_total" && typeof event.progress === "number") {
          scope.postMessage({ type: "progress", message: `Downloading speech model… ${Math.round(event.progress)}%` });
        } else if (event.status === "progress" && typeof event.progress === "number") {
          scope.postMessage({ type: "progress", message: `Downloading model file… ${Math.round(event.progress)}%` });
        }
      },
    });
    const texts: string[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      scope.postMessage({ type: "progress", message: `Transcribing on this device · part ${index + 1} of ${segments.length}…` });
      const { start, end } = segments[index];
      const audio = data.samples.subarray(start, end);
      if (isAudioEffectivelySilent(audio)) continue;
      const result = await transcriber(audio, { do_sample: false, max_new_tokens: 256 });
      if (!result || typeof result.text !== "string") throw new Error("The speech model returned an invalid result.");
      if (result.text.trim()) texts.push(result.text.trim());
    }
    scope.postMessage({ type: "done", text: texts.join(" ").trim() });
  } catch (cause) {
    scope.postMessage({ type: "error", message: cause instanceof Error ? cause.message : "On-device transcription failed." });
  } finally {
    await transcriber?.dispose();
  }
};
