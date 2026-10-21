import { describe, expect, it } from "bun:test";
import {
  cancelPdfRenderTask,
  runPdfRenderTask,
  type PdfRenderTaskLike,
} from "./pdfRenderLifecycle";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}

function cancellationError() {
  return Object.assign(new Error("Rendering cancelled"), { name: "RenderingCancelledException" });
}

describe("PDF.js render task lifecycle", () => {
  it("tracks the active PDF.js task and waits for its cancellation rejection", async () => {
    const render = deferred<void>();
    const task: PdfRenderTaskLike = {
      promise: render.promise,
      cancel: () => render.reject(cancellationError()),
    };
    const ref: { current: PdfRenderTaskLike | null } = { current: null };
    const rendering = runPdfRenderTask(ref, task, () => false);

    expect(ref.current).toBe(task);
    const cancellation = cancelPdfRenderTask(ref);
    expect(ref.current).toBeNull();
    expect(cancellation).not.toBeNull();
    await cancellation;
    await expect(rendering).resolves.toBe(false);
  });

  it("does not let an older render clear the newer active task", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const ref: { current: PdfRenderTaskLike | null } = { current: null };
    const firstTask: PdfRenderTaskLike = { promise: first.promise, cancel() {} };
    const secondTask: PdfRenderTaskLike = { promise: second.promise, cancel() {} };
    const firstRender = runPdfRenderTask(ref, firstTask, () => false);
    const secondRender = runPdfRenderTask(ref, secondTask, () => true);

    first.resolve();
    await expect(firstRender).resolves.toBe(false);
    expect(ref.current).toBe(secondTask);
    second.resolve();
    await expect(secondRender).resolves.toBe(true);
    expect(ref.current).toBeNull();
  });

  it("propagates non-cancellation failures and clears the task reference", async () => {
    const failure = new Error("PDF render failed");
    const task: PdfRenderTaskLike = {
      promise: Promise.reject(failure),
      cancel() {},
    };
    const ref: { current: PdfRenderTaskLike | null } = { current: null };

    await expect(runPdfRenderTask(ref, task, () => true)).rejects.toBe(failure);
    expect(ref.current).toBeNull();
  });
});
