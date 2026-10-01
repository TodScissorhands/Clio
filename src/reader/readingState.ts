import type { ReadingPosition, ReadingState } from "../storage/domain";

export interface ReadingStateStorage {
  getReadingState(documentId: string): Promise<ReadingState | null>;
  setReadingState(state: ReadingState): Promise<void>;
}

export class ReadingStateCoordinator {
  private pendingPosition: ReadingPosition | null = null;
  private pendingDocId: string | null = null;
  private timer: number | null = null;
  private storage: ReadingStateStorage;
  private debounceMs: number;

  constructor(storage: ReadingStateStorage, debounceMs = 1000) {
    this.storage = storage;
    this.debounceMs = debounceMs;
  }

  async loadInitialPosition(documentId: string): Promise<ReadingPosition | undefined> {
    await this.flush();
    try {
      const state = await this.storage.getReadingState(documentId);
      return state?.position;
    } catch {
      return undefined;
    }
  }

  recordPositionChange(documentId: string, position: ReadingPosition): void {
    this.pendingDocId = documentId;
    this.pendingPosition = position;

    clearTimeout(this.timer ?? undefined);
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs) as unknown as number;
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer ?? undefined);
    this.timer = null;

    if (!this.pendingDocId || !this.pendingPosition) return;
    const docId = this.pendingDocId;
    const pos = this.pendingPosition;
    this.pendingDocId = null;
    this.pendingPosition = null;

    const now = new Date().toISOString();
    try {
      await this.storage.setReadingState({
        documentId: docId,
        position: pos,
        lastOpenedAt: now,
        updatedAt: now,
      });
    } catch {
      // Ignored for non-catalog documents or closed DB
    }
  }

  destroy(): void {
    void this.flush();
  }
}
