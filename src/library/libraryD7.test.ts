/**
 * D7 Library & Collection Experience Tests
 *
 * Covers:
 * - New sort options: author, added (firstSeenAt)
 * - remove-from-collection command availability logic
 * - Correct collection ID plumbing in CommandContext
 * - isDocumentStarted text-scroll semantics (regression)
 */

import { describe, expect, it } from "bun:test";
import type { StoredDocument } from "../storage/domain";
import { isDocumentStarted, sortDocuments } from "./libraryFilter";
import { documentCommands, type CommandContext } from "../commands/documentCommands";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeDoc(
  id: string,
  format: string,
  overrides: Partial<{
    author: string;
    firstSeenAt: string;
    title: string;
  }> = {}
): StoredDocument {
  return {
    record: {
      id,
      name: `${id}.${format}`,
      format: format as StoredDocument["record"]["format"],
      sizeBytes: 1000,
      firstSeenAt: overrides.firstSeenAt ?? "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      metadata: overrides.author || overrides.title
        ? {
            title: overrides.title ?? null,
            authors: overrides.author ? [overrides.author] : [],
            identifiers: [],
            provenance: "embedded",
          }
        : null,
    },
    source: { kind: "library", rootId: "root-1", relativePath: `${id}.${format}` },
    availability: "present",
  };
}

const docA = makeDoc("doc-a", "pdf", { author: "Alice Archer", firstSeenAt: "2026-03-01T00:00:00Z", title: "Anteater" });
const docB = makeDoc("doc-b", "epub", { author: "Bob Baker", firstSeenAt: "2026-01-01T00:00:00Z", title: "Basilisk" });
const docC = makeDoc("doc-c", "pdf", { firstSeenAt: "2026-02-01T00:00:00Z", title: "Centipede" });

// ── D7: Author sort ───────────────────────────────────────────────────────────

describe("D7: author sort", () => {
  it("sorts by first available author, places missing authors last, and uses title as tiebreak", () => {
    const sorted = sortDocuments([docB, docC, docA], "author");
    const ids = sorted.map((d) => d.record.id);
    expect(ids[0]).toBe("doc-a"); // Alice Archer
    expect(ids[1]).toBe("doc-b"); // Bob Baker
    expect(ids[2]).toBe("doc-c"); // Missing author metadata sorts last
  });

  it("uses title as tiebreak when authors are equal", () => {
    const docX = makeDoc("doc-x", "pdf", { author: "Same Author", title: "Zebra" });
    const docY = makeDoc("doc-y", "pdf", { author: "Same Author", title: "Apple" });
    const sorted = sortDocuments([docX, docY], "author");
    expect(sorted[0]!.record.id).toBe("doc-y"); // Apple < Zebra
    expect(sorted[1]!.record.id).toBe("doc-x");
  });
});

// ── D7: Added sort ────────────────────────────────────────────────────────────

describe("D7: added sort (firstSeenAt)", () => {
  it("sorts newest-added first", () => {
    const sorted = sortDocuments([docB, docC, docA], "added");
    const ids = sorted.map((d) => d.record.id);
    expect(ids[0]).toBe("doc-a"); // 2026-03-01 newest
    expect(ids[1]).toBe("doc-c"); // 2026-02-01
    expect(ids[2]).toBe("doc-b"); // 2026-01-01 oldest
  });

  it("uses title as tiebreak for identical timestamps", () => {
    const docP = makeDoc("doc-p", "pdf", { firstSeenAt: "2026-05-01T00:00:00Z", title: "Zephyr" });
    const docQ = makeDoc("doc-q", "pdf", { firstSeenAt: "2026-05-01T00:00:00Z", title: "Aardvark" });
    const sorted = sortDocuments([docP, docQ], "added");
    expect(sorted[0]!.record.id).toBe("doc-q"); // Aardvark < Zephyr
  });
});

// ── D7: remove-from-collection command ───────────────────────────────────────

const removeFromColCmd = documentCommands.find((c) => c.id === "remove-from-collection")!;

function makeCtx(overrides: Partial<CommandContext>): CommandContext {
  return {
    documents: [docA],
    selectedDocuments: [docA],
    activeDocument: null,
    collections: [],
    roots: [],
    activeCollectionId: null,
    onOpen: () => {},
    onAddToCollection: async () => {},
    onRemoveFromLibrary: async () => {},
    onConvert: () => {},
    onMerge: () => {},
    onExtractPages: () => {},
    onProperties: () => {},
    onRevealInFileManager: async () => {},
    ...overrides,
  };
}

describe("D7: remove-from-collection command", () => {
  it("is registered in documentCommands", () => {
    expect(removeFromColCmd).toBeDefined();
    expect(removeFromColCmd.group).toBe(3);
  });

  it("is not available when no activeCollectionId", () => {
    const ctx = makeCtx({ activeCollectionId: null });
    expect(removeFromColCmd.isAvailable(ctx)).toBe(false);
  });

  it("is not available when onRemoveFromCollection is absent", () => {
    const ctx = makeCtx({ activeCollectionId: "col-1", onRemoveFromCollection: undefined });
    expect(removeFromColCmd.isAvailable(ctx)).toBe(false);
  });

  it("is not available when no documents targeted", () => {
    const ctx = makeCtx({
      activeCollectionId: "col-1",
      onRemoveFromCollection: async () => {},
      selectedDocuments: [],
      activeDocument: null,
    });
    expect(removeFromColCmd.isAvailable(ctx)).toBe(false);
  });

  it("is available only when the targeted document belongs to the active collection", () => {
    const member = {
      ...docA,
      record: { ...docA.record, collections: ["col-1"] },
    };
    const ctx = makeCtx({
      documents: [member],
      activeCollectionId: "col-1",
      onRemoveFromCollection: async () => {},
      selectedDocuments: [member],
    });
    expect(removeFromColCmd.isAvailable(ctx)).toBe(true);

    const outsideCollection = makeCtx({
      documents: [docA],
      activeCollectionId: "col-1",
      onRemoveFromCollection: async () => {},
      selectedDocuments: [docA],
    });
    expect(removeFromColCmd.isAvailable(outsideCollection)).toBe(false);
  });

  it("does not remove selected documents outside the active collection", async () => {
    const member = {
      ...docA,
      record: { ...docA.record, collections: ["col-42"] },
    };
    const calls: { colId: string; docIds: string[] }[] = [];
    const ctx = makeCtx({
      documents: [member, docB],
      activeCollectionId: "col-42",
      onRemoveFromCollection: async (colId, docIds) => {
        calls.push({ colId, docIds });
      },
      selectedDocuments: [member, docB],
    });
    await removeFromColCmd.execute(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.colId).toBe("col-42");
    expect(calls[0]!.docIds).toEqual(["doc-a"]);
  });
});

// ── D7: isDocumentStarted text-scroll regression ──────────────────────────────


describe("D7: isDocumentStarted text-scroll regression", () => {
  it("counts a text-scroll document at progression 0 as started (D4 spec)", () => {
    const doc: StoredDocument = {
      ...makeDoc("txt-1", "txt"),
      readingState: {
        documentId: "txt-1",
        position: { kind: "text-scroll", progression: 0 },
        lastOpenedAt: "2026-06-01T12:00:00Z",
        updatedAt: "2026-06-01T12:00:00Z",
      },
    };
    expect(isDocumentStarted(doc)).toBe(true);
  });

  it("counts a text-scroll document at progression 0.5 as started", () => {
    const doc: StoredDocument = {
      ...makeDoc("txt-2", "txt"),
      readingState: {
        documentId: "txt-2",
        position: { kind: "text-scroll", progression: 0.5 },
        lastOpenedAt: "2026-06-01T12:00:00Z",
        updatedAt: "2026-06-01T12:00:00Z",
      },
    };
    expect(isDocumentStarted(doc)).toBe(true);
  });

  it("does not count a document without readingState as started", () => {
    expect(isDocumentStarted(makeDoc("txt-3", "txt"))).toBe(false);
  });

  it("does not count a document without lastOpenedAt as started", () => {
    const doc: StoredDocument = {
      ...makeDoc("txt-4", "txt"),
      readingState: {
        documentId: "txt-4",
        position: { kind: "text-scroll", progression: 0.5 },
        lastOpenedAt: "",
        updatedAt: "2026-06-01T12:00:00Z",
      },
    };
    expect(isDocumentStarted(doc)).toBe(false);
  });
});
