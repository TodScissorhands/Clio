import { describe, expect, it } from "bun:test";
import type { ReadingState, StoredDocument } from "../storage/domain";
import {
  filterDocuments,
  formatReadingProgress,
  formatRelativeTime,
  matchesFormat,
  matchesSearch,
  sortDocuments,
  type FormatFilterOption,
  type SortOption,
} from "./libraryFilter";

const docPdf1: StoredDocument = {
  record: {
    id: "doc-1",
    name: "Rust Programming.pdf",
    format: "pdf",
    sizeBytes: 2048000,
    firstSeenAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-01T10:00:00Z",
  },
  source: {
    kind: "library",
    rootId: "root-1",
    relativePath: "Tech/Rust Programming.pdf",
  },
  availability: "present",
};

const docEpub1: StoredDocument = {
  record: {
    id: "doc-2",
    name: "Moby Dick.epub",
    format: "epub",
    sizeBytes: 1024000,
    firstSeenAt: "2026-09-10T10:00:00Z",
    updatedAt: "2026-09-10T10:00:00Z",
  },
  source: {
    kind: "library",
    rootId: "root-1",
    relativePath: "Classics/Moby Dick.epub",
  },
  availability: "present",
};

const docTxt1: StoredDocument = {
  record: {
    id: "doc-3",
    name: "Notes.txt",
    format: "txt",
    sizeBytes: 512,
    firstSeenAt: "2026-09-20T10:00:00Z",
    updatedAt: "2026-09-20T10:00:00Z",
  },
  source: {
    kind: "library",
    rootId: "root-2",
    relativePath: "Notes.txt",
  },
  availability: "missing",
};

const docDirectPdf: StoredDocument = {
  record: {
    id: "doc-4",
    name: "Direct Paper.pdf",
    format: "pdf",
    sizeBytes: 5000000,
    firstSeenAt: "2026-09-25T10:00:00Z",
    updatedAt: "2026-09-25T10:00:00Z",
  },
  source: {
    kind: "direct",
    locator: {
      kind: "desktop-token",
      value: "token-123",
      access: "session",
    },
  },
  availability: "present",
};

const sampleDocs: StoredDocument[] = [docPdf1, docEpub1, docTxt1, docDirectPdf];

describe("matchesSearch", () => {
  it("matches by document name case-insensitively", () => {
    expect(matchesSearch(docPdf1, "rust")).toBe(true);
    expect(matchesSearch(docPdf1, "PROGRAMMING")).toBe(true);
    expect(matchesSearch(docPdf1, "python")).toBe(false);
  });

  it("matches by relative path for library documents", () => {
    expect(matchesSearch(docEpub1, "classics")).toBe(true);
    expect(matchesSearch(docPdf1, "tech")).toBe(true);
    expect(matchesSearch(docDirectPdf, "classics")).toBe(false);
  });

  it("matches everything when query is empty or whitespace", () => {
    expect(matchesSearch(docPdf1, "")).toBe(true);
    expect(matchesSearch(docPdf1, "   ")).toBe(true);
  });
});

describe("matchesFormat", () => {
  it("matches all formats when filter is 'all'", () => {
    expect(matchesFormat(docPdf1, "all")).toBe(true);
    expect(matchesFormat(docEpub1, "all")).toBe(true);
    expect(matchesFormat(docTxt1, "all")).toBe(true);
  });

  it("matches pdf only for 'pdf'", () => {
    expect(matchesFormat(docPdf1, "pdf")).toBe(true);
    expect(matchesFormat(docEpub1, "pdf")).toBe(false);
    expect(matchesFormat(docTxt1, "pdf")).toBe(false);
  });

  it("matches epub only for 'epub'", () => {
    expect(matchesFormat(docEpub1, "epub")).toBe(true);
    expect(matchesFormat(docPdf1, "epub")).toBe(false);
  });

  it("matches other formats for 'other'", () => {
    expect(matchesFormat(docTxt1, "other")).toBe(true);
    expect(matchesFormat(docPdf1, "other")).toBe(false);
    expect(matchesFormat(docEpub1, "other")).toBe(false);
  });
});

describe("filterDocuments", () => {
  it("filters by root directory", () => {
    const root1Docs = filterDocuments(sampleDocs, "", "all", "root-1");
    expect(root1Docs.map((d) => d.record.id)).toEqual(["doc-1", "doc-2"]);

    const root2Docs = filterDocuments(sampleDocs, "", "all", "root-2");
    expect(root2Docs.map((d) => d.record.id)).toEqual(["doc-3"]);
  });

  it("combines root, format, and search query", () => {
    const result = filterDocuments(sampleDocs, "moby", "epub", "root-1");
    expect(result.length).toBe(1);
    expect(result[0].record.name).toBe("Moby Dick.epub");

    const noResult = filterDocuments(sampleDocs, "moby", "pdf", "root-1");
    expect(noResult.length).toBe(0);
  });
});

describe("sortDocuments", () => {
  it("sorts by name ascending and descending", () => {
    const asc = sortDocuments(sampleDocs, "name-asc");
    expect(asc.map((d) => d.record.name)).toEqual([
      "Direct Paper.pdf",
      "Moby Dick.epub",
      "Notes.txt",
      "Rust Programming.pdf",
    ]);

    const desc = sortDocuments(sampleDocs, "name-desc");
    expect(desc.map((d) => d.record.name)).toEqual([
      "Rust Programming.pdf",
      "Notes.txt",
      "Moby Dick.epub",
      "Direct Paper.pdf",
    ]);
  });

  it("sorts by size descending and ascending", () => {
    const desc = sortDocuments(sampleDocs, "size-desc");
    expect(desc.map((d) => d.record.id)).toEqual(["doc-4", "doc-1", "doc-2", "doc-3"]);

    const asc = sortDocuments(sampleDocs, "size-asc");
    expect(asc.map((d) => d.record.id)).toEqual(["doc-3", "doc-2", "doc-1", "doc-4"]);
  });

  it("sorts by recently opened when reading states exist", () => {
    const readingStates: Record<string, ReadingState> = {
      "doc-1": {
        documentId: "doc-1",
        position: { kind: "pdf-page", page: 12 },
        lastOpenedAt: "2026-10-01T15:00:00Z",
        updatedAt: "2026-10-01T15:00:00Z",
      },
      "doc-2": {
        documentId: "doc-2",
        position: { kind: "epub-cfi", cfi: "epubcfi(/6/2)", progression: 0.5 },
        lastOpenedAt: "2026-10-01T18:00:00Z",
        updatedAt: "2026-10-01T18:00:00Z",
      },
    };

    const sorted = sortDocuments(sampleDocs, "recent", readingStates);
    expect(sorted[0].record.id).toBe("doc-2"); // latest opened (18:00)
    expect(sorted[1].record.id).toBe("doc-1"); // 15:00
  });

  it("sorts by format alphabetically", () => {
    const sorted = sortDocuments(sampleDocs, "format");
    expect(sorted.map((d) => d.record.format)).toEqual(["epub", "pdf", "pdf", "txt"]);
  });
});

describe("formatReadingProgress", () => {
  it("formats PDF page progress", () => {
    const state: ReadingState = {
      documentId: "doc-1",
      position: { kind: "pdf-page", page: 42 },
      lastOpenedAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
    };
    expect(formatReadingProgress(state)).toBe("Page 42");
  });

  it("formats EPUB percentage progress", () => {
    const stateWithProg: ReadingState = {
      documentId: "doc-2",
      position: { kind: "epub-cfi", cfi: "cfi1", progression: 0.684 },
      lastOpenedAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
    };
    expect(formatReadingProgress(stateWithProg)).toBe("68%");

    const stateNoProg: ReadingState = {
      documentId: "doc-2",
      position: { kind: "epub-cfi", cfi: "cfi1" },
      lastOpenedAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
    };
    expect(formatReadingProgress(stateNoProg)).toBe("Reading");
  });

  it("returns null when state is missing", () => {
    expect(formatReadingProgress(undefined)).toBeNull();
  });
});
