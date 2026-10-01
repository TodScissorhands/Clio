import { describe, expect, it } from "bun:test";
import {
  formatBytes,
  isReaderFormat,
  normalizeFormat,
  type DocumentId,
  type DocumentRecord,
  type FormatId,
  type LibraryRoot,
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
    expect(normalizeFormat(null)).toBe("" as FormatId);

    expect(isReaderFormat("pdf")).toBe(true);
    expect(isReaderFormat("epub")).toBe(true);
    expect(isReaderFormat("docx")).toBe(false);
    expect(isReaderFormat("txt")).toBe(false);
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
});
