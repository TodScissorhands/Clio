import { describe, expect, it } from "bun:test";
import {
  canMergeSelected,
  documentCommands,
  getTargetDocument,
  getTargetDocumentIds,
  type CommandContext,
} from "./documentCommands";
import type { StoredDocument } from "../storage/domain";

describe("Document Commands & Action Architecture", () => {
  const pdfDoc: StoredDocument = {
    record: {
      id: "pdf-1",
      name: "doc.pdf",
      format: "pdf",
      sizeBytes: 1000,
      firstSeenAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    },
    source: { kind: "library", rootId: "r1", relativePath: "doc.pdf" },
    availability: "present",
  };

  const epubDoc: StoredDocument = {
    record: {
      id: "epub-1",
      name: "story.epub",
      format: "epub",
      sizeBytes: 2000,
      firstSeenAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    },
    source: { kind: "library", rootId: "r1", relativePath: "story.epub" },
    availability: "present",
  };

  const docxDoc: StoredDocument = {
    record: {
      id: "docx-1",
      name: "report.docx",
      format: "docx",
      sizeBytes: 3000,
      firstSeenAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    },
    source: { kind: "library", rootId: "r1", relativePath: "report.docx" },
    availability: "present",
  };

  const missingPdf: StoredDocument = {
    ...pdfDoc,
    record: { ...pdfDoc.record, id: "missing-1" },
    availability: "missing",
  };

  function createMockContext(overrides: Partial<CommandContext> = {}): CommandContext {
    return {
      documents: [pdfDoc, epubDoc, docxDoc],
      selectedDocuments: [],
      activeDocument: null,
      collections: [],
      roots: [],
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

  it("identifies target document and IDs properly", () => {
    const ctxActive = createMockContext({ activeDocument: pdfDoc });
    expect(getTargetDocument(ctxActive)?.record.id).toBe("pdf-1");
    expect(getTargetDocumentIds(ctxActive)).toEqual(["pdf-1"]);

    const ctxMulti = createMockContext({ selectedDocuments: [pdfDoc, epubDoc] });
    expect(getTargetDocument(ctxMulti)).toBeNull(); // multi-select has no single target
    expect(getTargetDocumentIds(ctxMulti)).toEqual(["pdf-1", "epub-1"]);
  });

  it("validates Open command availability based on format capabilities", () => {
    const openCmd = documentCommands.find((c) => c.id === "open")!;
    expect(openCmd).toBeDefined();

    // PDF is readable
    expect(openCmd.isAvailable(createMockContext({ activeDocument: pdfDoc }))).toBe(true);
    // EPUB is readable
    expect(openCmd.isAvailable(createMockContext({ activeDocument: epubDoc }))).toBe(true);
    // DOCX is NOT readable directly in reader
    expect(openCmd.isAvailable(createMockContext({ activeDocument: docxDoc }))).toBe(false);
    // Missing document cannot be opened
    expect(openCmd.isAvailable(createMockContext({ activeDocument: missingPdf }))).toBe(false);
  });

  it("validates Convert command availability", () => {
    const convertCmd = documentCommands.find((c) => c.id === "convert")!;
    // PDF, EPUB, and DOCX are all convertible
    expect(convertCmd.isAvailable(createMockContext({ activeDocument: pdfDoc }))).toBe(true);
    expect(convertCmd.isAvailable(createMockContext({ activeDocument: docxDoc }))).toBe(true);
    expect(convertCmd.isAvailable(createMockContext({ activeDocument: missingPdf }))).toBe(false);
  });

  it("restricts Extract pages command strictly to PDF", () => {
    const extractCmd = documentCommands.find((c) => c.id === "extract-pages")!;
    expect(extractCmd.isAvailable(createMockContext({ activeDocument: pdfDoc }))).toBe(true);
    expect(extractCmd.isAvailable(createMockContext({ activeDocument: epubDoc }))).toBe(false);
    expect(extractCmd.isAvailable(createMockContext({ activeDocument: docxDoc }))).toBe(false);
  });

  it("validates canMergeSelected for PDF selections", () => {
    const pdf2: StoredDocument = {
      ...pdfDoc,
      record: { ...pdfDoc.record, id: "pdf-2", name: "doc2.pdf" },
    };

    expect(canMergeSelected([pdfDoc])).toBe(false); // requires >= 2
    expect(canMergeSelected([pdfDoc, pdf2])).toBe(true); // 2 present PDFs
    expect(canMergeSelected([pdfDoc, epubDoc])).toBe(false); // non-PDF rejected
    expect(canMergeSelected([pdfDoc, missingPdf])).toBe(false); // missing PDF rejected
  });

  it("executes commands calling corresponding context functions", () => {
    let openedDoc: StoredDocument | null = null;
    let convertedDoc: StoredDocument | null = null;
    let extractedDoc: StoredDocument | null = null;
    let propertiesDoc: StoredDocument | null = null;
    let removedIds: string[] = [];

    const ctx = createMockContext({
      activeDocument: pdfDoc,
      onOpen: (doc) => {
        openedDoc = doc;
      },
      onConvert: (doc) => {
        convertedDoc = doc;
      },
      onExtractPages: (doc) => {
        extractedDoc = doc;
      },
      onProperties: (doc) => {
        propertiesDoc = doc;
      },
      onRemoveFromLibrary: async (ids) => {
        removedIds = ids;
      },
    });

    documentCommands.find((c) => c.id === "open")!.execute(ctx);
    expect(openedDoc).toBe(pdfDoc);

    documentCommands.find((c) => c.id === "convert")!.execute(ctx);
    expect(convertedDoc).toBe(pdfDoc);

    documentCommands.find((c) => c.id === "extract-pages")!.execute(ctx);
    expect(extractedDoc).toBe(pdfDoc);

    documentCommands.find((c) => c.id === "properties")!.execute(ctx);
    expect(propertiesDoc).toBe(pdfDoc);

    documentCommands.find((c) => c.id === "remove-from-library")!.execute(ctx);
    expect(removedIds).toEqual(["pdf-1"]);
  });
});
