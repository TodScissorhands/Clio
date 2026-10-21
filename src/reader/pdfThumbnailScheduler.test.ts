import { describe, expect, it } from "bun:test";
import {
  getPdfThumbnailPresentation,
  getThumbnailDemand,
  PDF_THUMBNAIL_CONCURRENCY,
  PDF_THUMBNAIL_DATA_URL_LIMIT,
  PDF_THUMBNAIL_DEMAND_LIMIT,
  PDF_THUMBNAIL_HEIGHT,
  PDF_THUMBNAIL_WIDTH,
  PdfThumbnailScheduler,
} from "./pdfThumbnailScheduler";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("bounded PDF thumbnail demand", () => {
  it("prioritizes visible pages and caps each demand to a small current-page neighborhood", () => {
    const demand = getThumbnailDemand(Array.from({ length: 24 }, (_, index) => index + 20), 3, 100);
    expect(demand).toHaveLength(PDF_THUMBNAIL_DEMAND_LIMIT);
    expect(demand.slice(0, 3)).toEqual([20, 21, 22]);
    expect(demand).not.toContain(1);
    expect(getThumbnailDemand([], 3, 10)).toEqual([1, 2, 3, 4, 5]);
    expect(PDF_THUMBNAIL_CONCURRENCY).toBe(2);
    expect(PDF_THUMBNAIL_WIDTH).toBe(72);
    expect(PDF_THUMBNAIL_HEIGHT).toBe(96);
    expect(PDF_THUMBNAIL_DATA_URL_LIMIT).toBe(64 * 1024);
  });

  it("identifies the current page for an accessible Navigator state", () => {
    expect(getPdfThumbnailPresentation(7, 7)).toEqual({
      current: true,
      ariaCurrent: "page",
      ariaLabel: "Go to page 7, current page",
    });
    expect(getPdfThumbnailPresentation(6, 7)).toEqual({
      current: false,
      ariaCurrent: undefined,
      ariaLabel: "Go to page 6",
    });
    expect(getPdfThumbnailPresentation(7, 7, true)).toEqual({
      current: true,
      ariaCurrent: "page",
      ariaLabel: "Go to page 7, current page, preview unavailable",
    });
  });

  it("schedules no more than two renders and starts later work as capacity settles", async () => {
    const jobs = new Map<number, Deferred<string>>();
    const started: number[] = [];
    const scheduler = new PdfThumbnailScheduler((page) => {
      started.push(page);
      const job = deferred<string>();
      jobs.set(page, job);
      return job.promise;
    }, () => {});

    scheduler.setDemand([1, 2, 3, 4]);
    expect(started).toEqual([1, 2]);
    jobs.get(1)!.resolve("data:one");
    await settle();
    expect(started).toEqual([1, 2, 3]);
    jobs.get(2)!.resolve("data:two");
    jobs.get(3)!.resolve("data:three");
    await settle();
    expect(started).toEqual([1, 2, 3, 4]);
    scheduler.cancelAll();
  });

  it("aborts removed demand and suppresses stale results during rapid navigation", async () => {
    const jobs = new Map<number, Deferred<string>>();
    const signals = new Map<number, AbortSignal>();
    const changes: number[][] = [];
    const scheduler = new PdfThumbnailScheduler((page, signal) => {
      const job = deferred<string>();
      jobs.set(page, job);
      signals.set(page, signal);
      return job.promise;
    }, (items) => changes.push(items.map((item) => item.page)));

    scheduler.setDemand([1, 2]);
    scheduler.setDemand([8]);
    expect(signals.get(1)?.aborted).toBe(true);
    expect(signals.get(2)?.aborted).toBe(true);
    jobs.get(1)!.resolve("stale-1");
    jobs.get(2)!.resolve("stale-2");
    await settle();
    expect(jobs.has(8)).toBe(true);
    jobs.get(8)!.resolve("current-8");
    await settle();
    expect(changes.flat()).toEqual([8]);
    scheduler.cancelAll();
  });

  it("invalidates work on document change, Navigator close and unmount", async () => {
    const jobs: Deferred<string>[] = [];
    const signals: AbortSignal[] = [];
    const changes: number[][] = [];
    const scheduler = new PdfThumbnailScheduler((_page, signal) => {
      const job = deferred<string>();
      jobs.push(job);
      signals.push(signal);
      return job.promise;
    }, (items) => changes.push(items.map((item) => item.page)));

    scheduler.setDemand([1]);
    scheduler.setDocument();
    jobs[0]!.resolve("late document result");
    await settle();
    scheduler.setDemand([2]);
    scheduler.setDemand([]);
    expect(signals[1]?.aborted).toBe(true);
    jobs[1]!.resolve("closed Navigator result");
    await settle();
    scheduler.setDemand([3]);
    scheduler.cancelAll();
    expect(signals[2]?.aborted).toBe(true);
    const changeCount = changes.length;
    jobs.forEach((job) => job.resolve("late result"));
    await settle();
    expect(changes).toHaveLength(changeCount);
  });

  it("surfaces a bounded failure without retry loops and retries only after demand changes", async () => {
    let attempts = 0;
    const changes: { page: number; error?: true }[][] = [];
    const scheduler = new PdfThumbnailScheduler(async () => {
      attempts += 1;
      throw new Error("thumbnail failed");
    }, (items) => changes.push([...items]));

    scheduler.setDemand([4]);
    await settle();
    expect(attempts).toBe(1);
    expect(changes.at(-1)).toEqual([{ page: 4, error: true }]);
    scheduler.setDemand([4]);
    await settle();
    expect(attempts).toBe(1);
    scheduler.setDemand([]);
    scheduler.setDemand([4]);
    await settle();
    expect(attempts).toBe(2);
    scheduler.cancelAll();
  });

  it("drops oversized encoded results instead of retaining them", async () => {
    const changes: { page: number; error?: true }[][] = [];
    const scheduler = new PdfThumbnailScheduler(async () => "x".repeat(PDF_THUMBNAIL_DATA_URL_LIMIT + 1), (items) => changes.push([...items]));
    scheduler.setDemand([1]);
    await settle();
    expect(changes.at(-1)).toEqual([{ page: 1, error: true }]);
    scheduler.cancelAll();
  });
});
