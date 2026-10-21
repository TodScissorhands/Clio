export const PDF_THUMBNAIL_CONCURRENCY = 2;
export const PDF_THUMBNAIL_DEMAND_LIMIT = 16;
export const PDF_THUMBNAIL_WIDTH = 72;
export const PDF_THUMBNAIL_HEIGHT = 96;
export const PDF_THUMBNAIL_DATA_URL_LIMIT = 64 * 1024;

export type PdfThumbnail = { page: number; dataUrl?: string; error?: true };
type Task = { controller: AbortController; generation: number };

/** Limits work to 16 requested pages, two active renders, 72×96 surfaces and 64KiB data URLs. */
export class PdfThumbnailScheduler {
  private generation = 0;
  private demand = new Set<number>();
  private tasks = new Map<number, Task>();
  private active = new Set<Task>();
  private results = new Map<number, PdfThumbnail>();
  private failures = new Set<number>();
  private disposed = false;

  constructor(
    private readonly render: (page: number, signal: AbortSignal) => Promise<string>,
    private readonly onChange: (results: readonly PdfThumbnail[]) => void,
  ) {}

  setDemand(pages: readonly number[]) {
    if (this.disposed) return;
    const next = new Set(pages.filter((page) => Number.isSafeInteger(page) && page > 0).slice(0, PDF_THUMBNAIL_DEMAND_LIMIT));
    if (next.size === this.demand.size && [...next].every((page) => this.demand.has(page))) return;
    this.demand = next;
    for (const [page, task] of this.tasks) {
      if (!next.has(page)) {
        task.controller.abort();
        this.tasks.delete(page);
      }
    }
    for (const page of this.results.keys()) if (!next.has(page)) this.results.delete(page);
    for (const page of this.failures) if (!next.has(page)) this.failures.delete(page);
    this.emit();
    this.pump();
  }

  setDocument() {
    this.disposed = false;
    this.generation += 1;
    this.demand.clear();
    this.tasks.clear();
    this.results.clear();
    this.failures.clear();
    for (const task of this.active) task.controller.abort();
    this.emit();
  }

  cancelAll() {
    this.disposed = true;
    this.generation += 1;
    this.demand.clear();
    this.tasks.clear();
    for (const task of this.active) task.controller.abort();
    this.results.clear();
    this.failures.clear();
  }

  private emit() {
    if (this.disposed) return;
    this.onChange([...this.results.values()]);
  }

  private pump() {
    if (this.disposed) return;
    for (const page of this.demand) {
      if (this.active.size >= PDF_THUMBNAIL_CONCURRENCY) break;
      if (this.tasks.has(page) || this.results.has(page) || this.failures.has(page)) continue;
      const task: Task = { controller: new AbortController(), generation: this.generation };
      this.tasks.set(page, task);
      this.active.add(task);
      void this.render(page, task.controller.signal).then((dataUrl) => {
        if (!this.disposed && task.generation === this.generation && this.demand.has(page) && this.tasks.get(page) === task) {
          if (dataUrl.length <= PDF_THUMBNAIL_DATA_URL_LIMIT) this.results.set(page, { page, dataUrl });
          else {
            this.failures.add(page);
            this.results.set(page, { page, error: true });
          }
        }
      }).catch(() => {
        if (!this.disposed && task.generation === this.generation && this.demand.has(page) && this.tasks.get(page) === task) {
          this.failures.add(page);
          this.results.set(page, { page, error: true });
        }
      }).finally(() => {
        this.active.delete(task);
        if (this.tasks.get(page) === task) this.tasks.delete(page);
        this.emit();
        this.pump();
      });
    }
  }
}

export function getThumbnailDemand(visiblePages: readonly number[], currentPage: number, totalPages: number) {
  const result: number[] = [];
  const seen = new Set<number>();
  const add = (page: number) => {
    if (page >= 1 && page <= totalPages && !seen.has(page) && result.length < PDF_THUMBNAIL_DEMAND_LIMIT) {
      seen.add(page);
      result.push(page);
    }
  };
  visiblePages.forEach(add);
  for (let offset = -2; offset <= 2; offset += 1) add(currentPage + offset);
  return result;
}

export function getPdfThumbnailPresentation(page: number, currentPage: number, unavailable = false) {
  const current = page === currentPage;
  return {
    current,
    ariaCurrent: current ? "page" as const : undefined,
    ariaLabel: `Go to page ${page}${current ? ", current page" : ""}${unavailable ? ", preview unavailable" : ""}`,
  };
}
