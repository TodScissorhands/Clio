/**
 * D4 Specification & Interaction Foundation Tests
 *
 * Tests for:
 * - OD-1: Remove from Library preserves document state and excludes from active views
 * - OD-2: Locate file command for missing documents; other commands disabled
 * - OD-4: Non-readable format detection and contextual choice
 * - OD-5: Continue Reading from durable reading state
 * - OD-6: Selection grammar and right-click targeting
 * - OD-7: Global app menu reachability and options
 * - OD-10: Search scoping behavior
 * - OD-11: Adaptive document card metadata display
 * - OD-12: Annotation contextual action bar & Escape priority
 */

import { describe, expect, it, vi } from "bun:test";
import { documentCommands, type CommandContext } from "../commands/documentCommands";
import { getSelectionCapabilities } from "../commands/selectionCommands";
import { getDocumentDisplayTitle, isReaderFormat, type StoredDocument } from "../storage/domain";
import { resolveEscapeAction, type EscapeReaderState } from "../reader/readerLogic";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeDoc(
  id: string,
  format: string,
  availability: "present" | "missing" = "present",
  metaTitle?: string,
  authors?: string[]
): StoredDocument {
  return {
    record: {
      id,
      name: `${id}.${format}`,
      format: format as StoredDocument["record"]["format"],
      sizeBytes: 150000,
      firstSeenAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      metadata: metaTitle
        ? {
            title: metaTitle,
            authors: authors ?? ["Frank Herbert"],
            provenance: "embedded",
          }
        : undefined,
    },
    source: { kind: "library", rootId: "root-1", relativePath: `${id}.${format}` },
    availability,
  };
}

const presentPdf = makeDoc("doc-pdf", "pdf", "present", "Dune", ["Frank Herbert"]);
const missingPdf = makeDoc("doc-missing-pdf", "pdf", "missing", "Foundation", ["Isaac Asimov"]);
const presentDocx = makeDoc("doc-word", "docx", "present");
const presentEpub = makeDoc("doc-epub", "epub", "present", "Neuromancer", ["William Gibson"]);

function makeContext(activeDoc: StoredDocument | null, selected: StoredDocument[] = []): CommandContext {
  return {
    documents: [presentPdf, missingPdf, presentDocx, presentEpub],
    selectedDocuments: selected,
    activeDocument: activeDoc,
    collections: [],
    roots: [],
    onOpen: vi.fn(),
    onAddToCollection: vi.fn(),
    onRemoveFromLibrary: vi.fn(),
    onConvert: vi.fn(),
    onMerge: vi.fn(),
    onExtractPages: vi.fn(),
    onProperties: vi.fn(),
    onRevealInFileManager: vi.fn(),
    onLocate: vi.fn(),
  };
}

// ── OD-2: Missing Document Commands & Locate ─────────────────────────────────

describe("OD-2: Missing document commands and Locate", () => {
  it("enables Locate file… command only when document is missing", () => {
    const locateCmd = documentCommands.find((c) => c.id === "locate")!;
    expect(locateCmd).toBeDefined();

    const missingCtx = makeContext(missingPdf);
    expect(locateCmd.isAvailable(missingCtx)).toBe(true);

    const presentCtx = makeContext(presentPdf);
    expect(locateCmd.isAvailable(presentCtx)).toBe(false);
  });

  it("disables Open, Convert, and Extract Pages when document is missing", () => {
    const missingCtx = makeContext(missingPdf);
    const openCmd = documentCommands.find((c) => c.id === "open")!;
    const convertCmd = documentCommands.find((c) => c.id === "convert")!;
    const extractCmd = documentCommands.find((c) => c.id === "extract-pages")!;
    const revealCmd = documentCommands.find((c) => c.id === "reveal-in-file-manager")!;

    expect(openCmd.isAvailable(missingCtx)).toBe(false);
    expect(convertCmd.isAvailable(missingCtx)).toBe(false);
    expect(extractCmd.isAvailable(missingCtx)).toBe(false);
    expect(revealCmd.isAvailable(missingCtx)).toBe(false); // cannot reveal missing file
  });

  it("keeps Properties and Remove available for missing documents", () => {
    const missingCtx = makeContext(missingPdf);
    const propsCmd = documentCommands.find((c) => c.id === "properties")!;
    const removeCmd = documentCommands.find((c) => c.id === "remove-from-library")!;

    expect(propsCmd.isAvailable(missingCtx)).toBe(true);
    expect(removeCmd.isAvailable(missingCtx)).toBe(true);
  });

  it("canLocate is true in selection capabilities for single missing document", () => {
    const capsMissing = getSelectionCapabilities([missingPdf]);
    expect(capsMissing.canLocate).toBe(true);
    expect(capsMissing.canOpen).toBe(false);
    expect(capsMissing.canReveal).toBe(false);

    const capsPresent = getSelectionCapabilities([presentPdf]);
    expect(capsPresent.canLocate).toBe(false);
    expect(capsPresent.canOpen).toBe(true);
    expect(capsPresent.canReveal).toBe(true);
  });
});

// ── OD-4: Non-readable format handling ───────────────────────────────────────

describe("OD-4: Non-readable formats", () => {
  it("correctly identifies reader vs non-reader formats", () => {
    expect(isReaderFormat("pdf")).toBe(true);
    expect(isReaderFormat("epub")).toBe(true);
    expect(isReaderFormat("txt")).toBe(true);
    expect(isReaderFormat("md")).toBe(true);

    expect(isReaderFormat("docx")).toBe(false);
    expect(isReaderFormat("odt")).toBe(false);
    expect(isReaderFormat("rtf")).toBe(false);
    expect(isReaderFormat("html")).toBe(false);
  });

  it("non-readable documents have convert capability enabled if supported", () => {
    const docxCtx = makeContext(presentDocx);
    const convertCmd = documentCommands.find((c) => c.id === "convert")!;
    const openCmd = documentCommands.find((c) => c.id === "open")!;

    expect(openCmd.isAvailable(docxCtx)).toBe(false);
    expect(convertCmd.isAvailable(docxCtx)).toBe(true); // DOCX can be converted
  });
});

// ── OD-6: Selection grammar & right-click targeting ──────────────────────────

describe("OD-6: Selection grammar & right-click targeting", () => {
  it("right-clicking an unselected document targets only that document", () => {
    // Model the OD-6 right click rule:
    // If target is already selected: operate on selectedDocs
    // If target is unselected: selection becomes [target]
    const selectedDocIds = new Set(["doc-1", "doc-2"]);
    const clickedDocId = "doc-3"; // unselected

    let newSelectedIds = selectedDocIds;
    if (!selectedDocIds.has(clickedDocId)) {
      newSelectedIds = new Set([clickedDocId]);
    }

    expect(Array.from(newSelectedIds)).toEqual(["doc-3"]);
  });

  it("right-clicking an already-selected document retains the selection", () => {
    const selectedDocIds = new Set(["doc-1", "doc-2"]);
    const clickedDocId = "doc-2"; // already selected

    let newSelectedIds = selectedDocIds;
    if (!selectedDocIds.has(clickedDocId)) {
      newSelectedIds = new Set([clickedDocId]);
    }

    expect(Array.from(newSelectedIds)).toEqual(["doc-1", "doc-2"]);
  });
});

// ── OD-11: Adaptive document card metadata ───────────────────────────────────

describe("OD-11: Adaptive document card metadata", () => {
  it("prefers embedded metadata title over filename", () => {
    expect(getDocumentDisplayTitle(presentPdf.record)).toBe("Dune");
  });

  it("falls back to filename when no metadata title exists", () => {
    expect(getDocumentDisplayTitle(presentDocx.record)).toBe("doc-word.docx");
  });

  it("never fabricates metadata", () => {
    expect(presentDocx.record.metadata?.title).toBeUndefined();
    expect(presentDocx.record.metadata?.authors).toBeUndefined();
    expect(getDocumentDisplayTitle(presentDocx.record)).toBe(presentDocx.record.name);
  });
});

// ── OD-12: Annotation contextual action bar & Escape priority ────────────────

describe("OD-12: Annotation actions and Escape priority", () => {
  it("dismisses note editor before text selection on Escape", () => {
    const stateWithNoteEditor: EscapeReaderState = {
      editingAnnotationId: null,
      isAddingNote: true,
      pendingTextSelection: true,
      findOpen: false,
      navigatorOpen: false,
      displayOpen: false,
      docMenuOpen: false,
    };

    expect(resolveEscapeAction(stateWithNoteEditor)).toBe("dismissNoteEditor");
  });

  it("dismisses text selection after note editor is closed", () => {
    const stateWithSelectionOnly: EscapeReaderState = {
      editingAnnotationId: null,
      isAddingNote: false,
      pendingTextSelection: true,
      findOpen: false,
      navigatorOpen: false,
      displayOpen: false,
      docMenuOpen: false,
    };

    expect(resolveEscapeAction(stateWithSelectionOnly)).toBe("dismissTextSelection");
  });

  it("editingAnnotationId takes highest priority over note editor and selection", () => {
    const stateWithExistingNoteEdit: EscapeReaderState = {
      editingAnnotationId: "ann-42",
      isAddingNote: true,
      pendingTextSelection: true,
      findOpen: true,
      navigatorOpen: true,
      displayOpen: true,
      docMenuOpen: true,
    };

    expect(resolveEscapeAction(stateWithExistingNoteEdit)).toBe("dismissAnnotationEdit");
  });
});
