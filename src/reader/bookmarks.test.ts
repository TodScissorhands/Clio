import { describe, expect, it } from "bun:test";
import {
  isSameReadingPosition,
  type Annotation,
  type AnnotationKind,
  type Bookmark,
  type ReadingPosition,
} from "../storage/domain";

describe("Bookmark Domain and Location Matching", () => {
  it("matches identical PDF page positions correctly", () => {
    const posA: ReadingPosition = { kind: "pdf-page", page: 12 };
    const posB: ReadingPosition = { kind: "pdf-page", page: 12 };
    const posDiff: ReadingPosition = { kind: "pdf-page", page: 13 };

    expect(isSameReadingPosition(posA, posB)).toBe(true);
    expect(isSameReadingPosition(posA, posDiff)).toBe(false);
  });

  it("matches identical EPUB CFI positions correctly", () => {
    const posA: ReadingPosition = { kind: "epub-cfi", cfi: "epubcfi(/6/4[chap01]!/4/2)", progression: 0.25 };
    const posB: ReadingPosition = { kind: "epub-cfi", cfi: "epubcfi(/6/4[chap01]!/4/2)", progression: 0.28 };
    const posDiff: ReadingPosition = { kind: "epub-cfi", cfi: "epubcfi(/6/6[chap02]!/4/2)", progression: 0.25 };

    // Same CFI matches regardless of minor progression diff
    expect(isSameReadingPosition(posA, posB)).toBe(true);
    expect(isSameReadingPosition(posA, posDiff)).toBe(false);
  });

  it("never matches different position kinds or undefined positions", () => {
    const pdfPos: ReadingPosition = { kind: "pdf-page", page: 1 };
    const epubPos: ReadingPosition = { kind: "epub-cfi", cfi: "epubcfi(/6/2)" };

    expect(isSameReadingPosition(pdfPos, epubPos)).toBe(false);
    expect(isSameReadingPosition(pdfPos, undefined)).toBe(false);
    expect(isSameReadingPosition(undefined, epubPos)).toBe(false);
    expect(isSameReadingPosition(undefined, undefined)).toBe(false);
  });

  it("identifies whether the current position is bookmarked", () => {
    const bookmarks: Bookmark[] = [
      {
        id: "bm-1",
        documentId: "doc-1",
        position: { kind: "pdf-page", page: 5 },
        title: "Page 5",
        createdAt: "2026-10-01T12:00:00Z",
        updatedAt: "2026-10-01T12:00:00Z",
      },
      {
        id: "bm-2",
        documentId: "doc-1",
        position: { kind: "pdf-page", page: 20 },
        title: "Page 20",
        createdAt: "2026-10-01T12:10:00Z",
        updatedAt: "2026-10-01T12:10:00Z",
      },
    ];

    const currentAt5: ReadingPosition = { kind: "pdf-page", page: 5 };
    const active = bookmarks.find((b) => isSameReadingPosition(b.position, currentAt5));
    expect(active).toBeDefined();
    expect(active?.id).toBe("bm-1");

    const currentAt6: ReadingPosition = { kind: "pdf-page", page: 6 };
    const notActive = bookmarks.find((b) => isSameReadingPosition(b.position, currentAt6));
    expect(notActive).toBeUndefined();
  });
});

describe("Document Isolation for Bookmarks", () => {
  it("strictly isolates bookmarks across different documents", () => {
    const allBookmarks: Bookmark[] = [
      {
        id: "bm-docA-1",
        documentId: "doc-A",
        position: { kind: "pdf-page", page: 3 },
        title: "Doc A - Page 3",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-01T10:00:00Z",
      },
      {
        id: "bm-docB-1",
        documentId: "doc-B",
        position: { kind: "pdf-page", page: 3 }, // Same page number in different document
        title: "Doc B - Page 3",
        createdAt: "2026-10-01T10:05:00Z",
        updatedAt: "2026-10-01T10:05:00Z",
      },
    ];

    const docABookmarks = allBookmarks.filter((b) => b.documentId === "doc-A");
    expect(docABookmarks.length).toBe(1);
    expect(docABookmarks[0].id).toBe("bm-docA-1");

    const docBBookmarks = allBookmarks.filter((b) => b.documentId === "doc-B");
    expect(docBBookmarks.length).toBe(1);
    expect(docBBookmarks[0].id).toBe("bm-docB-1");
  });
});

describe("Annotation Domain Model Foundation", () => {
  it("structures highlight and note annotations with valid positions", () => {
    const highlight: Annotation = {
      id: "ann-1",
      documentId: "doc-1",
      kind: "highlight",
      position: { kind: "pdf-page", page: 4 },
      selectedText: "Important finding about Clio reader",
      createdAt: "2026-10-01T12:00:00Z",
      updatedAt: "2026-10-01T12:00:00Z",
    };

    expect(highlight.kind).toBe("highlight");
    expect(highlight.position.kind).toBe("pdf-page");
    expect(highlight.selectedText).toBe("Important finding about Clio reader");
    expect(highlight.note).toBeUndefined();

    const note: Annotation = {
      id: "ann-2",
      documentId: "doc-2",
      kind: "note",
      position: { kind: "epub-cfi", cfi: "epubcfi(/6/12!/4)", progression: 0.65 },
      note: "Review this chapter before next milestone",
      createdAt: "2026-10-01T12:05:00Z",
      updatedAt: "2026-10-01T12:05:00Z",
    };

    expect(note.kind).toBe("note");
    expect(note.position.kind).toBe("epub-cfi");
    expect(note.note).toBe("Review this chapter before next milestone");
  });
});
