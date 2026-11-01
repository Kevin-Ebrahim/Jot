/**
 * Isolate Tesseract in a disposable parent worker. Tesseract itself starts a
 * nested worker; terminating this worker on cancel/timeout also tears down its
 * descendants, including initialization that never resolved.
 */
import { createWorker } from "tesseract.js";
import { ocrRuntimePaths } from "./runtime-paths";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ file: File }>) => void) | null;
  postMessage(message: { type: "progress" | "done" | "error"; message?: string; text?: string }): void;
};

scope.onmessage = async ({ data }) => {
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  try {
    // In Tesseract 6, some language-load errors do not reject createWorker's
    // outer promise. Race its explicit error callback so failure is visible.
    let rejectInitialization: (reason: Error) => void = () => undefined;
    const initializationError = new Promise<never>((_, reject) => { rejectInitialization = reject; });
    const initialization = createWorker("eng", 1, {
      ...ocrRuntimePaths(self.location.origin),
      logger: (progress) => {
        if (progress.status) {
          const percentage = typeof progress.progress === "number" ? ` ${Math.round(progress.progress * 100)}%` : "";
          scope.postMessage({ type: "progress", message: `${progress.status}${percentage}` });
        }
      },
      errorHandler: (error: unknown) => rejectInitialization(new Error(typeof error === "string" ? error : "English recognition data could not be loaded.")),
    });
    worker = await Promise.race([initialization, initializationError]);
    const result = await worker.recognize(data.file);
    scope.postMessage({ type: "done", text: result.data.text.trim() });
  } catch (cause) {
    scope.postMessage({ type: "error", message: cause instanceof Error ? cause.message : String(cause || "Text recognition failed.") });
  } finally {
    await worker?.terminate();
  }
};
