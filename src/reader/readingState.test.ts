import { describe, expect, it } from "bun:test";
import type { ReadingPosition, ReadingState } from "../storage/domain";
import { ReadingStateCoordinator, type ReadingStateStorage } from "./readingState";

class MockReadingStateStorage implements ReadingStateStorage {
  public states = new Map<string, ReadingState>();
  public getCalls: string[] = [];
  public setCalls: ReadingState[] = [];
  public shouldFail = false;

  async getReadingState(documentId: string): Promise<ReadingState | null> {
    this.getCalls.push(documentId);
    if (this.shouldFail) {
      throw new Error("Simulated storage read error");
    }
    return this.states.get(documentId) ?? null;
  }

  async setReadingState(state: ReadingState): Promise<void> {
    this.setCalls.push(state);
    if (this.shouldFail) {
      throw new Error("Simulated storage write error");
    }
    this.states.set(state.documentId, state);
  }
}

describe("ReadingStateCoordinator", () => {
  it("requests saved PDF page when opening a document", async () => {
    const storage = new MockReadingStateStorage();
    const docId = "doc-pdf-1";
    storage.states.set(docId, {
      documentId: docId,
      position: { kind: "pdf-page", page: 15 },
      lastOpenedAt: "2026-10-01T12:00:00Z",
      updatedAt: "2026-10-01T12:00:00Z",
    });

    const coordinator = new ReadingStateCoordinator(storage, 50);
    const initialPos = await coordinator.loadInitialPosition(docId);

    expect(storage.getCalls).toEqual([docId]);
    expect(initialPos).toEqual({ kind: "pdf-page", page: 15 });
  });

  it("requests saved EPUB locator when opening a document", async () => {
    const storage = new MockReadingStateStorage();
    const docId = "doc-epub-1";
    storage.states.set(docId, {
      documentId: docId,
      position: { kind: "epub-cfi", cfi: "epubcfi(/6/4[chap1]!/4/2)", progression: 0.35 },
      lastOpenedAt: "2026-10-01T12:00:00Z",
      updatedAt: "2026-10-01T12:00:00Z",
    });

    const coordinator = new ReadingStateCoordinator(storage, 50);
    const initialPos = await coordinator.loadInitialPosition(docId);

    expect(storage.getCalls).toEqual([docId]);
    expect(initialPos).toEqual({ kind: "epub-cfi", cfi: "epubcfi(/6/4[chap1]!/4/2)", progression: 0.35 });
  });

  it("navigation changes schedule persistence and debounce prevents excessive writes", async () => {
    const storage = new MockReadingStateStorage();
    const docId = "doc-pdf-2";
    const coordinator = new ReadingStateCoordinator(storage, 60);

    // Rapid navigation through pages 2, 3, 4
    coordinator.recordPositionChange(docId, { kind: "pdf-page", page: 2 });
    coordinator.recordPositionChange(docId, { kind: "pdf-page", page: 3 });
    coordinator.recordPositionChange(docId, { kind: "pdf-page", page: 4 });

    // Before debounce flush, no writes have occurred
    expect(storage.setCalls.length).toBe(0);

    // Deterministically flush the debounced pending position
    await coordinator.flush();

    // Only the final position was persisted
    expect(storage.setCalls.length).toBe(1);
    expect(storage.setCalls[0].documentId).toBe(docId);
    expect(storage.setCalls[0].position).toEqual({ kind: "pdf-page", page: 4 });
  });

  it("replacing document flushes previous document position under the previous document ID", async () => {
    const storage = new MockReadingStateStorage();
    const docA = "doc-a";
    const docB = "doc-b";
    const coordinator = new ReadingStateCoordinator(storage, 500);

    // Read doc A and advance to page 7
    await coordinator.loadInitialPosition(docA);
    coordinator.recordPositionChange(docA, { kind: "pdf-page", page: 7 });

    // Immediately replace with doc B before debounce timer fires
    await coordinator.loadInitialPosition(docB);

    // Pending state for doc A was flushed under doc A's ID
    expect(storage.setCalls.length).toBe(1);
    expect(storage.setCalls[0].documentId).toBe(docA);
    expect(storage.setCalls[0].position).toEqual({ kind: "pdf-page", page: 7 });

    // Doc B was queried
    expect(storage.getCalls).toEqual([docA, docB]);
  });

  it("closing/destroying the reader flushes pending state", async () => {
    const storage = new MockReadingStateStorage();
    const docId = "doc-epub-2";
    const coordinator = new ReadingStateCoordinator(storage, 500);

    coordinator.recordPositionChange(docId, { kind: "epub-cfi", cfi: "epubcfi(/6/8!/4)", progression: 0.8 });
    expect(storage.setCalls.length).toBe(0);

    // Flush/destroy on reader unmount
    coordinator.destroy();
    await coordinator.flush();

    expect(storage.setCalls.length).toBe(1);
    expect(storage.setCalls[0].documentId).toBe(docId);
    expect(storage.setCalls[0].position).toEqual({ kind: "epub-cfi", cfi: "epubcfi(/6/8!/4)", progression: 0.8 });
  });

  it("handles storage errors and missing state gracefully without throwing", async () => {
    const storage = new MockReadingStateStorage();
    storage.shouldFail = true;
    const coordinator = new ReadingStateCoordinator(storage, 50);

    // Loading from failing storage returns undefined instead of throwing
    const pos = await coordinator.loadInitialPosition("doc-fail");
    expect(pos).toBeUndefined();

    // Saving to failing storage (e.g. uncataloged document) does not throw
    coordinator.recordPositionChange("doc-fail", { kind: "pdf-page", page: 1 });
    await expect(coordinator.flush()).resolves.toBeUndefined();
  });
});
