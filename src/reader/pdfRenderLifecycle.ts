export type PdfRenderTaskLike = {
  readonly promise: Promise<unknown>;
  cancel(): void;
};

export type PdfRenderTaskRef = { current: PdfRenderTaskLike | null };

export function cancelPdfRenderTask(ref: PdfRenderTaskRef) {
  const task = ref.current;
  ref.current = null;
  if (!task) return null;
  task.cancel();
  return task.promise.catch(() => undefined);
}

export async function runPdfRenderTask(
  ref: PdfRenderTaskRef,
  task: PdfRenderTaskLike,
  isCurrent: () => boolean,
): Promise<boolean> {
  ref.current = task;
  try {
    await task.promise;
    return isCurrent();
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "RenderingCancelledException" || error.message.toLowerCase().includes("cancel"))
    ) {
      return false;
    }
    throw error;
  } finally {
    if (ref.current === task) ref.current = null;
  }
}
