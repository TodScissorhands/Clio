import { describe, expect, it } from "bun:test";
import {
  formatBytes,
  getDocumentDisplayTitle,
  hasCapability,
  isReaderFormat,
  isSameReadingPosition,
  normalizeFormat,
  type Collection,
  type DocumentId,
  type DocumentMetadata,
  type DocumentRecord,
  type FormatId,
  type LibraryRoot,
  type ReadingPosition,
  type ReadingState,
  type SourceRef,
  type StorageLocator,
  type StoredDocument,
} from "./domain";

describe("Storage domain contracts", () => {
  it("normalizes format strings and identifies reader formats", () => {
    expect(normalizeFormat(".PDF")).toBe("pdf");
    expect(normalizeFormat(".epub")).toBe("epub");
    expect(normalizeFormat("DOCX")).toBe("docx");
    expect(normalizeFormat(".htm")).toBe("html");
    expect(normalizeFormat("htm")).toBe("html");
    expect(normalizeFormat("markdown")).toBe("md");
    expect(normalizeFormat(".MARKDOWN")).toBe("md");
    expect(normalizeFormat(null)).toBe("" as FormatId);
    expect(isReaderFormat("pdf")).toBe(true);
    expect(isReaderFormat("epub")).toBe(true);
    expect(isReaderFormat("txt")).toBe(true);
    expect(isReaderFormat("md")).toBe(true);
    expect(isReaderFormat("docx")).toBe(false);
    expect(isReaderFormat("html")).toBe(false);
  });

  it("formats byte sizes cleanly", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1024 * 1024 * 5 + 512 * 1024)).toBe("5.5 MB");
  });

  it("models DocumentRecord identity independently of raw path", () => {
    const documentId: DocumentId = "550e8400-e29b-41d4-a716-446655440000";
    const record: DocumentRecord = {
      id: documentId,
      name: "War and Peace.epub",
      format: "epub",
      sizeBytes: 3145728,
      firstSeenAt: "2026-10-01T12:00:00Z",
      updatedAt: "2026-10-01T12:00:00Z",
    };

    expect(record.id).not.toContain("/");
    expect(record.id).not.toContain("\\");
    expect(record.id).toBe(documentId);
    expect(record.name).toBe("War and Peace.epub");
  });

  it("models SourceRef as distinct library or direct locator reference", () => {
    const librarySource: SourceRef = {
      kind: "library",
      rootId: "root-uuid-1",
      relativePath: "Classics/war_and_peace.epub",
    };
    expect(librarySource.kind).toBe("library");
    expect(librarySource.rootId).toBe("root-uuid-1");
    expect(librarySource.relativePath).toBe("Classics/war_and_peace.epub");

    const directLocator: StorageLocator = {
      kind: "desktop-token",
      value: "ephemeral-token-abc",
      access: "session",
    };
    const directSource: SourceRef = {
      kind: "direct",
      locator: directLocator,
    };
    expect(directSource.kind).toBe("direct");
    expect(directSource.locator.kind).toBe("desktop-token");
    expect(directSource.locator.value).toBe("ephemeral-token-abc");
  });

  it("composes StoredDocument with availability state", () => {
    const stored: StoredDocument = {
      record: {
        id: "doc-uuid-1",
        name: "test.pdf",
        format: "pdf",
        sizeBytes: 1024,
        firstSeenAt: "2026-10-01T12:00:00Z",
        updatedAt: "2026-10-01T12:00:00Z",
      },
      source: {
        kind: "library",
        rootId: "root-1",
        relativePath: "test.pdf",
      },
      availability: "present",
    };
    expect(stored.availability).toBe("present");
    expect(stored.record.format).toBe("pdf");
  });

  it("models ReadingState for PDF and EPUB", () => {
    const pdfState: ReadingState = {
      documentId: "doc-uuid-1",
      position: { kind: "pdf-page", page: 12 },
      lastOpenedAt: "2026-10-01T14:00:00Z",
      updatedAt: "2026-10-01T14:00:00Z",
    };
    expect(pdfState.position.kind).toBe("pdf-page");
    if (pdfState.position.kind === "pdf-page") {
      expect(pdfState.position.page).toBe(12);
    }

    const epubState: ReadingState = {
      documentId: "doc-uuid-2",
      position: { kind: "epub-cfi", cfi: "epubcfi(/6/4[chap01]!/4/2/10)", progression: 0.45 },
      lastOpenedAt: "2026-10-01T14:05:00Z",
      updatedAt: "2026-10-01T14:05:00Z",
    };
    expect(epubState.position.kind).toBe("epub-cfi");
    if (epubState.position.kind === "epub-cfi") {
      expect(epubState.position.cfi).toContain("chap01");
      expect(epubState.position.progression).toBe(0.45);
    }
  });

  it("models LibraryRoot with status", () => {
    const root: LibraryRoot = {
      id: "root-uuid-1",
      label: "Books",
      kind: "filesystem-directory",
      status: "active",
      createdAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
    };
    expect(root.kind).toBe("filesystem-directory");
    expect(root.status).toBe("active");
  });

  it("models DocumentMetadata with title, authors, and provenance", () => {
    const meta: DocumentMetadata = {
      title: "Moby Dick",
      authors: ["Herman Melville"],
      publisher: "Harper & Brothers",
      publishedDate: "1851-10-18",
      description: "A quest for a white whale.",
      language: "en",
      identifiers: ["urn:isbn:9780142437247"],
      provenance: "embedded",
      thumbnailPath: "doc-1.png",
    };
    expect(meta.title).toBe("Moby Dick");
    expect(meta.authors).toEqual(["Herman Melville"]);
    expect(meta.provenance).toBe("embedded");
    expect(meta.thumbnailPath).toBe("doc-1.png");
  });

  it("derives display title with metadata title or falls back to record name", () => {
    const docWithTitle: DocumentRecord = {
      id: "doc-1",
      name: "raw_filename_1234.pdf",
      format: "pdf",
      sizeBytes: 1024,
      firstSeenAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
      metadata: {
        title: "Clean Book Title",
        authors: ["Author Name"],
        identifiers: [],
        provenance: "embedded",
      },
    };
    expect(getDocumentDisplayTitle(docWithTitle)).toBe("Clean Book Title");

    const docNoTitle: DocumentRecord = {
      id: "doc-2",
      name: "raw_filename_5678.pdf",
      format: "pdf",
      sizeBytes: 1024,
      firstSeenAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
      metadata: {
        title: null,
        authors: [],
        identifiers: [],
        provenance: "fallback",
      },
    };
    expect(getDocumentDisplayTitle(docNoTitle)).toBe("raw_filename_5678.pdf");

    const docWhitespaceTitle: DocumentRecord = {
      ...docNoTitle,
      metadata: {
        title: "   ",
        authors: [],
        identifiers: [],
        provenance: "fallback",
      },
    };
    expect(getDocumentDisplayTitle(docWhitespaceTitle)).toBe("raw_filename_5678.pdf");
  });

  it("models user-defined Collections and document membership", () => {
    const col: Collection = {
      id: "col-fiction-1",
      name: "Fiction",
      description: "Novels and stories",
      documentCount: 3,
      createdAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
    };
    expect(col.name).toBe("Fiction");
    expect(col.documentCount).toBe(3);

    const docInCols: DocumentRecord = {
      id: "doc-3",
      name: "novel.epub",
      format: "epub",
      sizeBytes: 2048,
      firstSeenAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
      collections: ["col-fiction-1", "col-favorites"],
    };
    expect(docInCols.collections?.length).toBe(2);
    expect(docInCols.collections?.includes("col-fiction-1")).toBe(true);
  });

  it("models ReadingPosition with text-scroll progression and matches positions", () => {
    const pos1: ReadingPosition = { kind: "text-scroll", progression: 0.45 };
    const pos2: ReadingPosition = { kind: "text-scroll", progression: 0.455 }; // diff < 0.02
    const pos3: ReadingPosition = { kind: "text-scroll", progression: 0.80 }; // diff > 0.02

    expect(isSameReadingPosition(pos1, pos2)).toBe(true);
    expect(isSameReadingPosition(pos1, pos3)).toBe(false);
    expect(isSameReadingPosition(pos1, { kind: "pdf-page", page: 1 })).toBe(false);
  });

  it("reports accurate format capabilities across all recognized document types", () => {
    // PDF: rich reader + tools + text extraction
    expect(hasCapability("pdf", "read")).toBe(true);
    expect(hasCapability("pdf", "search")).toBe(true);
    expect(hasCapability("pdf", "toc")).toBe(true);
    expect(hasCapability("pdf", "thumbnail")).toBe(true);
    expect(hasCapability("pdf", "convert")).toBe(true);
    expect(hasCapability("pdf", "extractText")).toBe(true);

    // EPUB: rich reader + tools
    expect(hasCapability("epub", "read")).toBe(true);
    expect(hasCapability("epub", "search")).toBe(true);
    expect(hasCapability("epub", "toc")).toBe(true);
    expect(hasCapability("epub", "thumbnail")).toBe(true);
    expect(hasCapability("epub", "convert")).toBe(true);
    expect(hasCapability("epub", "extractText")).toBe(false);

    // TXT: lightweight reading + conversion, no TOC or thumbnail
    expect(hasCapability("txt", "read")).toBe(true);
    expect(hasCapability("txt", "search")).toBe(true);
    expect(hasCapability("txt", "toc")).toBe(false);
    expect(hasCapability("txt", "thumbnail")).toBe(false);
    expect(hasCapability("txt", "convert")).toBe(true);

    // Markdown: lightweight reading with TOC + conversion
    expect(hasCapability("md", "read")).toBe(true);
    expect(hasCapability("md", "search")).toBe(true);
    expect(hasCapability("md", "toc")).toBe(true);
    expect(hasCapability("md", "convert")).toBe(true);

    // DOCX: not natively readable, convertible, thumbnail capable
    expect(hasCapability("docx", "read")).toBe(false);
    expect(hasCapability("docx", "convert")).toBe(true);
    expect(hasCapability("docx", "metadata")).toBe(true);
    expect(hasCapability("docx", "thumbnail")).toBe(true);

    // ODT: not natively readable, convertible, thumbnail capable
    expect(hasCapability("odt", "read")).toBe(false);
    expect(hasCapability("odt", "convert")).toBe(true);
    expect(hasCapability("odt", "metadata")).toBe(true);
    expect(hasCapability("odt", "thumbnail")).toBe(true);

    // RTF: not natively readable, convertible, metadata capable
    expect(hasCapability("rtf", "read")).toBe(false);
    expect(hasCapability("rtf", "convert")).toBe(true);
    expect(hasCapability("rtf", "metadata")).toBe(true);
    expect(hasCapability("rtf", "thumbnail")).toBe(false);

    // HTML: not natively readable without sandbox, convertible, metadata capable
    expect(hasCapability("html", "read")).toBe(false);
    expect(hasCapability("html", "convert")).toBe(true);
    expect(hasCapability("html", "metadata")).toBe(true);
  });
});
