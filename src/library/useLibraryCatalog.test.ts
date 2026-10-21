import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Collection, LibraryRoot, StoredDocument } from "../storage/domain";
import type { LibraryCatalog } from "./useLibraryCatalog";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}

type StateSlot = {
  kind: "state";
  value: unknown;
  set: (value: unknown | ((previous: unknown) => unknown)) => void;
};
type RefSlot = { kind: "ref"; value: { current: unknown } };
type CallbackSlot = { kind: "callback"; value: unknown; deps: readonly unknown[] };
type EffectSlot = {
  kind: "effect";
  deps?: readonly unknown[];
  cleanup?: () => void;
};
type HookSlot = StateSlot | RefSlot | CallbackSlot | EffectSlot;

function sameDeps(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined): boolean {
  return left === right || Boolean(
    left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index])),
  );
}

let activeRunner: CatalogHookRunner | null = null;

// This repo has Bun tests but no DOM or React hook-testing package. The hook
// runner implements only state, callback memoization, effects, and cleanup.
const reactHookMock = {
  useState: (initial: unknown) => activeRunner!.useState(initial),
  useRef: (initial: unknown) => activeRunner!.useRef(initial),
  useCallback: (callback: unknown, deps: readonly unknown[]) => activeRunner!.useCallback(callback, deps),
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => activeRunner!.useEffect(effect, deps),
};

const ipcCalls = {
  roots: 0,
  documents: [] as Array<{ rootId?: string; includeMissing?: boolean }>,
  collections: 0,
};

let ipcHandlers: {
  roots: () => Promise<LibraryRoot[]>;
  documents: (rootId?: string, includeMissing?: boolean) => Promise<StoredDocument[]>;
  collections: () => Promise<Collection[]>;
};

function resetIpc(): void {
  ipcCalls.roots = 0;
  ipcCalls.documents = [];
  ipcCalls.collections = 0;
  ipcHandlers = {
    roots: async () => [],
    documents: async () => [],
    collections: async () => [],
  };
}

const documentStorageMock = {
  listLibraryRoots: () => {
    ipcCalls.roots += 1;
    return ipcHandlers.roots();
  },
  listLibraryDocuments: (rootId?: string, includeMissing?: boolean) => {
    ipcCalls.documents.push({ rootId, includeMissing });
    return ipcHandlers.documents(rootId, includeMissing);
  },
  listCollections: () => {
    ipcCalls.collections += 1;
    return ipcHandlers.collections();
  },
  addDocumentToCollection: async () => undefined,
  addExternalDocumentToLibrary: async () => ({}),
  addLibraryRoot: async () => ({}),
  createCollection: async () => ({}),
  deleteCollection: async () => undefined,
  removeDocumentFromCollection: async () => undefined,
  removeLibraryDocument: async () => undefined,
  relinkLibraryDocument: async () => ({}),
  renameCollection: async () => ({}),
};

mock.module("react", () => reactHookMock);
mock.module("../storage/documentStorage", () => documentStorageMock);

// Static imports execute before mock.module; load the real hook after registering its test mocks.
const { useLibraryCatalog } = await import("./useLibraryCatalog");

type CatalogHook = (options: { onError: (error: unknown) => void }) => LibraryCatalog;

class CatalogHookRunner {
  private slots: HookSlot[] = [];
  private cursor = 0;
  private pendingEffects: Array<{ slot: EffectSlot; create: () => void | (() => void) }> = [];
  private listeners = new Set<() => void>();
  private disposed = false;
  private rendering = false;
  private renderAgain = false;
  private writes = 0;
  private result: LibraryCatalog | null = null;

  constructor(private readonly hook: CatalogHook, private readonly onError: (error: unknown) => void) {
    this.render();
  }

  get current(): LibraryCatalog {
    if (!this.result) throw new Error("Hook has not rendered");
    return this.result;
  }

  get stateWrites(): number {
    return this.writes;
  }

  useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void] {
    const index = this.cursor++;
    let slot = this.slots[index];
    if (!slot) {
      const stateSlot: StateSlot = { kind: "state", value: initial, set: () => undefined };
      stateSlot.set = (next) => {
        this.writes += 1;
        if (this.disposed) return;
        const value = typeof next === "function"
          ? (next as (previous: unknown) => unknown)(stateSlot.value)
          : next;
        if (Object.is(value, stateSlot.value)) return;
        stateSlot.value = value;
        this.render();
      };
      slot = stateSlot;
      this.slots[index] = slot;
    }
    if (slot.kind !== "state") throw new Error("Hook order changed at state slot");
    return [slot.value as T, slot.set as (value: T | ((previous: T) => T)) => void];
  }
  useRef<T>(initial: T): { current: T } {
    const index = this.cursor++;
    let slot = this.slots[index];
    if (!slot) {
      slot = { kind: "ref", value: { current: initial } };
      this.slots[index] = slot;
    }
    if (slot.kind !== "ref") throw new Error("Hook order changed at ref slot");
    return slot.value as { current: T };
  }

  useCallback(callback: unknown, deps: readonly unknown[]): unknown {
    const index = this.cursor++;
    const previous = this.slots[index];
    if (previous?.kind === "callback" && sameDeps(previous.deps, deps)) return previous.value;
    this.slots[index] = { kind: "callback", value: callback, deps };
    return callback;
  }

  useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void {
    const index = this.cursor++;
    const previous = this.slots[index];
    if (previous?.kind === "effect" && sameDeps(previous.deps, deps)) return;
    const slot: EffectSlot = previous?.kind === "effect" ? previous : { kind: "effect" };
    slot.deps = deps;
    this.slots[index] = slot;
    this.pendingEffects.push({ slot, create: effect });
  }

  waitFor(predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const listener = () => {
      if (!predicate()) return;
      this.listeners.delete(listener);
      resolve();
    };
    this.listeners.add(listener);
    return promise;
  }

  unmount(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) {
      if (slot.kind === "effect") slot.cleanup?.();
    }
    this.listeners.clear();
  }

  private render(): void {
    if (this.disposed) return;
    if (this.rendering) {
      this.renderAgain = true;
      return;
    }
    do {
      this.renderAgain = false;
      this.cursor = 0;
      this.rendering = true;
      activeRunner = this;
      try {
        this.result = this.hook({ onError: this.onError });
      } finally {
        activeRunner = null;
        this.rendering = false;
      }
      this.flushEffects();
      for (const listener of this.listeners) listener();
    } while (this.renderAgain && !this.disposed);
  }

  private flushEffects(): void {
    while (this.pendingEffects.length > 0 && !this.disposed) {
      const effects = this.pendingEffects.splice(0);
      for (const { slot, create } of effects) {
        slot.cleanup?.();
        const cleanup = create();
        slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      }
    }
  }
}

const root: LibraryRoot = {
  id: "root-1",
  label: "Books",
  kind: "filesystem-directory",
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const document: StoredDocument = {
  record: {
    id: "doc-1",
    name: "Novel.pdf",
    format: "pdf",
    sizeBytes: 100,
    firstSeenAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  source: { kind: "library", rootId: root.id, relativePath: "Novel.pdf" },
  availability: "present",
};
const collection: Collection = {
  id: "collection-1",
  name: "Favorites",
  documentCount: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const runners: CatalogHookRunner[] = [];
function mount(onError: (error: unknown) => void): CatalogHookRunner {
  const runner = new CatalogHookRunner(useLibraryCatalog, onError);
  runners.push(runner);
  return runner;
}

async function mountPopulatedCatalog(onError: (error: unknown) => void): Promise<CatalogHookRunner> {
  ipcHandlers.roots = async () => [root];
  ipcHandlers.documents = async () => [document];
  ipcHandlers.collections = async () => [collection];
  const runner = mount(onError);
  await runner.waitFor(() => runner.current.catalogLoadState === "ready");
  return runner;
}

afterEach(() => {
  for (const runner of runners.splice(0)) runner.unmount();
});

beforeEach(resetIpc);

describe("useLibraryCatalog asynchronous loading", () => {
  it("loads all catalog values and becomes ready", async () => {
    ipcHandlers.roots = async () => [root];
    ipcHandlers.documents = async () => [document];
    ipcHandlers.collections = async () => [collection];
    const errors: unknown[] = [];
    const runner = mount((error) => errors.push(error));

    await runner.waitFor(() => runner.current.catalogLoadState === "ready");

    expect(runner.current.roots).toEqual([root]);
    expect(runner.current.documents).toEqual([document]);
    expect(runner.current.collections).toEqual([collection]);
    expect(ipcCalls.roots).toBe(1);
    expect(ipcCalls.documents).toEqual([{ rootId: undefined, includeMissing: true }]);
    expect(ipcCalls.collections).toBe(1);
    expect(errors).toEqual([]);
  });

  it("treats successful empty IPC responses as ready", async () => {
    const runner = mount(() => undefined);

    await runner.waitFor(() => runner.current.catalogLoadState === "ready");

    expect(runner.current.roots).toEqual([]);
    expect(runner.current.documents).toEqual([]);
    expect(runner.current.collections).toEqual([]);
    expect(ipcCalls.roots).toBe(1);
    expect(ipcCalls.documents).toHaveLength(1);
    expect(ipcCalls.collections).toBe(1);
  });

  it("sets error and reports a rejected initial catalog request", async () => {
    const error = new Error("documents IPC failed");
    ipcHandlers.documents = () => Promise.reject(error);
    const errors: unknown[] = [];
    const runner = mount((caught) => errors.push(caught));

    await runner.waitFor(() => runner.current.catalogLoadState === "error");

    expect(errors).toEqual([error]);
    expect(runner.current.roots).toEqual([]);
    expect(runner.current.documents).toEqual([]);
    expect(runner.current.collections).toEqual([]);
  });

  it("recovers from initial failure when retried", async () => {
    const initialError = new Error("catalog unavailable");
    let documentCalls = 0;
    ipcHandlers.roots = async () => documentCalls === 0 ? [] : [root];
    ipcHandlers.documents = () => {
      documentCalls += 1;
      return documentCalls === 1 ? Promise.reject(initialError) : Promise.resolve([document]);
    };
    ipcHandlers.collections = async () => documentCalls === 0 ? [] : [collection];
    const errors: unknown[] = [];
    const runner = mount((error) => errors.push(error));

    await runner.waitFor(() => runner.current.catalogLoadState === "error");
    await runner.current.retryCatalog();

    expect(runner.current.catalogLoadState).toBe("ready");
    expect(runner.current.roots).toEqual([root]);
    expect(runner.current.documents).toEqual([document]);
    expect(runner.current.collections).toEqual([collection]);
    expect(errors).toEqual([initialError]);
    expect(ipcCalls.roots).toBe(2);
    expect(ipcCalls.documents).toHaveLength(2);
    expect(ipcCalls.collections).toBe(2);
  });

  it("preserves populated catalog data and ready state after refresh failure", async () => {
    const errors: unknown[] = [];
    const runner = await mountPopulatedCatalog((error) => errors.push(error));
    const previousRoots = runner.current.roots;
    const previousDocuments = runner.current.documents;
    const previousCollections = runner.current.collections;
    const refreshRoots = deferred<LibraryRoot[]>();
    const refreshError = new Error("refresh IPC failed");
    ipcHandlers.roots = () => refreshRoots.promise;

    const refresh = runner.current.refreshLibrary();
    refreshRoots.reject(refreshError);
    await refresh;

    expect(errors).toEqual([refreshError]);
    expect(runner.current.catalogLoadState).toBe("ready");
    expect(runner.current.roots).toEqual([root]);
    expect(runner.current.documents).toEqual([document]);
    expect(runner.current.collections).toEqual([collection]);
    expect(runner.current.roots).toBe(previousRoots);
    expect(runner.current.documents).toBe(previousDocuments);
    expect(runner.current.collections).toBe(previousCollections);
  });

  it("does not update hook state when the initial request resolves after unmount", async () => {
    const roots = deferred<LibraryRoot[]>();
    const documents = deferred<StoredDocument[]>();
    const collections = deferred<Collection[]>();
    ipcHandlers.roots = () => roots.promise;
    ipcHandlers.documents = () => documents.promise;
    ipcHandlers.collections = () => collections.promise;
    const errors: unknown[] = [];
    const runner = mount((error) => errors.push(error));
    const writesAtUnmount = runner.stateWrites;
    runner.unmount();

    roots.resolve([root]);
    documents.resolve([document]);
    collections.resolve([collection]);
    await Promise.all([roots.promise, documents.promise, collections.promise]);

    expect(runner.stateWrites).toBe(writesAtUnmount);
    expect(errors).toEqual([]);
    expect(runner.current.catalogLoadState).toBe("loading");
  });
  it("ignores a retry that resolves after unmount without attempting state updates", async () => {
    const errors: unknown[] = [];
    const runner = await mountPopulatedCatalog((error) => errors.push(error));
    const roots = deferred<LibraryRoot[]>();
    const documents = deferred<StoredDocument[]>();
    const collections = deferred<Collection[]>();
    ipcHandlers.roots = () => roots.promise;
    ipcHandlers.documents = () => documents.promise;
    ipcHandlers.collections = () => collections.promise;

    const retry = runner.current.retryCatalog();
    const writesAtUnmount = runner.stateWrites;
    runner.unmount();
    roots.resolve([root]);
    documents.resolve([document]);
    collections.resolve([collection]);
    await retry;

    expect(runner.stateWrites).toBe(writesAtUnmount);
    expect(errors).toEqual([]);
    expect(runner.current.catalogLoadState).toBe("loading");
    expect(runner.current.roots).toEqual([root]);
    expect(runner.current.documents).toEqual([document]);
    expect(runner.current.collections).toEqual([collection]);
  });

  it("does not call onError or set error state when retry rejects after unmount", async () => {
    const errors: unknown[] = [];
    const runner = await mountPopulatedCatalog((error) => errors.push(error));
    const roots = deferred<LibraryRoot[]>();
    const documents = deferred<StoredDocument[]>();
    const collections = deferred<Collection[]>();
    const retryError = new Error("late retry failure");
    ipcHandlers.roots = () => roots.promise;
    ipcHandlers.documents = () => documents.promise;
    ipcHandlers.collections = () => collections.promise;

    const retry = runner.current.retryCatalog();
    const writesAtUnmount = runner.stateWrites;
    runner.unmount();
    roots.resolve([root]);
    collections.resolve([collection]);
    documents.reject(retryError);
    await retry;

    expect(runner.stateWrites).toBe(writesAtUnmount);
    expect(errors).toEqual([]);
    expect(runner.current.catalogLoadState).toBe("loading");
    expect(runner.current.roots).toEqual([root]);
    expect(runner.current.documents).toEqual([document]);
    expect(runner.current.collections).toEqual([collection]);
  });

  it("ignores a refresh that settles after unmount", async () => {
    const errors: unknown[] = [];
    const runner = await mountPopulatedCatalog((error) => errors.push(error));
    const roots = deferred<LibraryRoot[]>();
    const documents = deferred<StoredDocument[]>();
    const collections = deferred<Collection[]>();
    ipcHandlers.roots = () => roots.promise;
    ipcHandlers.documents = () => documents.promise;
    ipcHandlers.collections = () => collections.promise;

    const refresh = runner.current.refreshLibrary();
    const writesAtUnmount = runner.stateWrites;
    runner.unmount();
    roots.resolve([root]);
    documents.resolve([document]);
    collections.resolve([collection]);
    await refresh;

    expect(runner.stateWrites).toBe(writesAtUnmount);
    expect(errors).toEqual([]);
    expect(runner.current.catalogLoadState).toBe("ready");
    expect(runner.current.roots).toEqual([root]);
    expect(runner.current.documents).toEqual([document]);
    expect(runner.current.collections).toEqual([collection]);
  });
});
