import { describe, expect, it } from "bun:test";
import type { ReadingState, StoredDocument } from "../storage/domain";
import {
  deriveContinueDocuments,
  filterDocuments,
  formatReadingProgress,
  formatRelativeTime,
  isDocumentFinished,
  isDocumentStarted,
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

  it("matches by metadata title, authors, and description", () => {
    const docWithMeta: StoredDocument = {
      record: {
        id: "meta-1",
        name: "doc_12345.pdf",
        format: "pdf",
        sizeBytes: 1000,
        firstSeenAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-01T10:00:00Z",
        metadata: {
          title: "The Art of Computer Programming",
          authors: ["Donald Knuth", "Collaborator"],
          publisher: "Addison-Wesley",
          publishedDate: "1968",
          description: "Fundamental algorithms analysis.",
          language: "en",
          identifiers: ["isbn:0201896834"],
          provenance: "embedded",
        },
      },
      source: { kind: "library", rootId: "root-1", relativePath: "cs/doc_12345.pdf" },
      availability: "present",
    };

    // Match by metadata title
    expect(matchesSearch(docWithMeta, "computer programming")).toBe(true);
    // Match by author
    expect(matchesSearch(docWithMeta, "knuth")).toBe(true);
    expect(matchesSearch(docWithMeta, "collaborator")).toBe(true);
    // Match by description
    expect(matchesSearch(docWithMeta, "algorithms")).toBe(true);
    // Non-match
    expect(matchesSearch(docWithMeta, "calculus")).toBe(false);
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

  it("filters by collection ID", () => {
    const docCol1: StoredDocument = {
      ...docPdf1,
      record: { ...docPdf1.record, collections: ["col-fiction", "col-fav"] },
    };
    const docCol2: StoredDocument = {
      ...docEpub1,
      record: { ...docEpub1.record, collections: ["col-fiction"] },
    };
    const docCol3: StoredDocument = {
      ...docTxt1,
      record: { ...docTxt1.record, collections: [] },
    };
    const docs = [docCol1, docCol2, docCol3];

    // Filter by col-fiction -> returns docCol1 and docCol2
    const fictionDocs = filterDocuments(docs, "", "all", null, "col-fiction");
    expect(fictionDocs.map((d) => d.record.id)).toEqual(["doc-1", "doc-2"]);

    // Filter by col-fav -> returns only docCol1
    const favDocs = filterDocuments(docs, "", "all", null, "col-fav");
    expect(favDocs.map((d) => d.record.id)).toEqual(["doc-1"]);

    // Filter with null collection -> returns all
    const allDocs = filterDocuments(docs, "", "all", null, null);
    expect(allDocs.length).toBe(3);
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

  it("sorts by display title when metadata title is present", () => {
    const docA: StoredDocument = {
      ...docPdf1,
      record: {
        ...docPdf1.record,
        id: "a",
        name: "zzz_file.pdf",
        metadata: {
          title: "Alpha Book",
          authors: [],
          identifiers: [],
          provenance: "embedded",
        },
      },
    };
    const docB: StoredDocument = {
      ...docEpub1,
      record: {
        ...docEpub1.record,
        id: "b",
        name: "aaa_file.epub",
        metadata: {
          title: "Beta Book",
          authors: [],
          identifiers: [],
          provenance: "embedded",
        },
      },
    };
    const sorted = sortDocuments([docB, docA], "name-asc");
    // "Alpha Book" comes before "Beta Book" even though filename was "zzz_file.pdf"
    expect(sorted.map((d) => d.record.id)).toEqual(["a", "b"]);
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

describe("filterDocuments regression: selectedRootId scoping", () => {
  it("correctly scopes documents and preserves format counts under selectedRootId", () => {
    const rootDocs: StoredDocument[] = [
      {
        record: {
          id: "r1-doc1",
          name: "Guide.pdf",
          format: "pdf",
          sizeBytes: 1000,
          firstSeenAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
        },
        source: { kind: "library", rootId: "root-alpha", relativePath: "Guide.pdf" },
        availability: "present",
      },
      {
        record: {
          id: "r1-doc2",
          name: "Novel.epub",
          format: "epub",
          sizeBytes: 2000,
          firstSeenAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
        },
        source: { kind: "library", rootId: "root-alpha", relativePath: "Novel.epub" },
        availability: "present",
      },
      {
        record: {
          id: "r2-doc1",
          name: "Other.pdf",
          format: "pdf",
          sizeBytes: 1500,
          firstSeenAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
        },
        source: { kind: "library", rootId: "root-beta", relativePath: "Other.pdf" },
        availability: "present",
      },
    ];

    // When scoped to root-alpha
    const alphaDocs = filterDocuments(rootDocs, "", "all", "root-alpha");
    expect(alphaDocs.length).toBe(2);
    expect(alphaDocs.map((d) => d.record.id)).toEqual(["r1-doc1", "r1-doc2"]);

    // Format counts calculation inside root-alpha
    const scopedAlpha = rootDocs.filter(
      (d) => d.source.kind === "library" && d.source.rootId === "root-alpha"
    );
    expect(scopedAlpha.length).toBe(2);
    const pdfCount = scopedAlpha.filter((d) => d.record.format === "pdf").length;
    const epubCount = scopedAlpha.filter((d) => d.record.format === "epub").length;
    expect(pdfCount).toBe(1);
    expect(epubCount).toBe(1);

    // When scoped to root-beta
    const betaDocs = filterDocuments(rootDocs, "", "all", "root-beta");
    expect(betaDocs.length).toBe(1);
    expect(betaDocs[0].record.id).toBe("r2-doc1");
  });
});

describe("Continue Reading", () => {
  const docInProgressEpub: StoredDocument = {
    ...docEpub1,
    record: { ...docEpub1.record, id: "epub-in-progress" },
    readingState: {
      documentId: "epub-in-progress",
      position: { kind: "epub-cfi", cfi: "cfi/1", progression: 0.45 },
      lastOpenedAt: "2026-02-01T12:00:00Z",
      updatedAt: "2026-02-01T12:00:00Z",
    },
  };

  const docFinishedEpub: StoredDocument = {
    ...docEpub1,
    record: { ...docEpub1.record, id: "epub-finished" },
    readingState: {
      documentId: "epub-finished",
      position: { kind: "epub-cfi", cfi: "cfi/end", progression: 0.99 },
      lastOpenedAt: "2026-02-02T12:00:00Z",
      updatedAt: "2026-02-02T12:00:00Z",
    },
  };

  const docFinishedText: StoredDocument = {
    ...docTxt1,
    record: { ...docTxt1.record, id: "txt-finished" },
    availability: "present",
    readingState: {
      documentId: "txt-finished",
      position: { kind: "text-scroll", progression: 1.0 },
      lastOpenedAt: "2026-02-03T12:00:00Z",
      updatedAt: "2026-02-03T12:00:00Z",
    },
  };

  const docInProgressPdf: StoredDocument = {
    ...docPdf1,
    record: { ...docPdf1.record, id: "pdf-in-progress" },
    readingState: {
      documentId: "pdf-in-progress",
      position: { kind: "pdf-page", page: 4 },
      lastOpenedAt: "2026-02-04T12:00:00Z",
      updatedAt: "2026-02-04T12:00:00Z",
    },
  };

  const docFinishedPdf: StoredDocument = {
    ...docInProgressPdf,
    record: { ...docInProgressPdf.record, id: "pdf-finished" },
    readingState: {
      documentId: "pdf-finished",
      position: { kind: "pdf-page", page: 100, progression: 1 },
      lastOpenedAt: "2026-02-06T12:00:00Z",
      updatedAt: "2026-02-06T12:00:00Z",
    },
  };

  const docJustOpenedText: StoredDocument = {
    ...docTxt1,
    record: { ...docTxt1.record, id: "txt-just-opened" },
    availability: "present",
    readingState: {
      documentId: "txt-just-opened",
      position: { kind: "text-scroll", progression: 0 },
      lastOpenedAt: "2026-02-07T12:00:00Z",
      updatedAt: "2026-02-07T12:00:00Z",
    },
  };

  const docMissing: StoredDocument = {
    ...docPdf1,
    record: { ...docPdf1.record, id: "doc-missing" },
    availability: "missing",
    readingState: {
      documentId: "doc-missing",
      position: { kind: "pdf-page", page: 2 },
      lastOpenedAt: "2026-02-05T12:00:00Z",
      updatedAt: "2026-02-05T12:00:00Z",
    },
  };

  it("identifies finished documents correctly", () => {
    expect(isDocumentFinished(docFinishedEpub)).toBe(true);
    expect(isDocumentFinished(docFinishedText)).toBe(true);
    expect(isDocumentFinished(docFinishedPdf)).toBe(true);
    expect(
      isDocumentFinished({
        ...docInProgressPdf,
        readingState: {
          ...docInProgressPdf.readingState!,
          position: { kind: "pdf-page", page: 49, progression: 0.98 },
        },
      })
    ).toBe(false);
    expect(isDocumentFinished(docInProgressEpub)).toBe(false);
    expect(isDocumentFinished(docInProgressPdf)).toBe(false);
  });

  it("identifies opened and progressed documents as started", () => {
    expect(isDocumentStarted(docInProgressEpub)).toBe(true);
    expect(isDocumentStarted(docFinishedEpub)).toBe(true);
    expect(isDocumentStarted(docInProgressPdf)).toBe(true);
    expect(isDocumentStarted(docJustOpenedText)).toBe(true);
    expect(isDocumentStarted(docTxt1)).toBe(false); // no reading state
  });

  it("deriveContinueDocuments excludes finished and missing documents (OD-5)", () => {
    const all = [
      docInProgressEpub,
      docFinishedEpub,
      docFinishedText,
      docInProgressPdf,
      docFinishedPdf,
      docJustOpenedText,
      docMissing,
      docTxt1,
    ];
    const continueDocs = deriveContinueDocuments(all);

    const continueIds = continueDocs.map((d) => d.record.id);
    expect(continueIds).toContain("epub-in-progress");
    expect(continueIds).toContain("pdf-in-progress");
    expect(continueIds).toContain("txt-just-opened");
    expect(continueIds).not.toContain("epub-finished"); // finished leaves continue reading
    expect(continueIds).not.toContain("txt-finished"); // finished leaves continue reading
    expect(continueIds).not.toContain("pdf-finished");
    expect(continueIds).not.toContain("doc-missing"); // missing excluded
    expect(continueIds).not.toContain("txt-1"); // unstarted excluded
  });

});
