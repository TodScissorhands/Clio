import { describe, expect, it } from "bun:test";
import {
  DEFAULT_LIBRARY_SCOPE,
  isSameScope,
  type AppRoute,
  type LibraryRestorationState,
  type LibraryScope,
} from "./navigation";
import {
  deriveContinueDocuments,
  filterDocumentsByScope,
  isDescendantPath,
} from "../library/libraryFilter";
import type { StoredDocument } from "../storage/domain";

describe("Navigation & Library Scope Model", () => {
  it("compares library scopes accurately with isSameScope", () => {
    expect(isSameScope({ kind: "all" }, { kind: "all" })).toBe(true);
    expect(isSameScope({ kind: "all" }, { kind: "root", rootId: "r1" })).toBe(false);

    expect(isSameScope({ kind: "root", rootId: "r1" }, { kind: "root", rootId: "r1" })).toBe(true);
    expect(isSameScope({ kind: "root", rootId: "r1" }, { kind: "root", rootId: "r2" })).toBe(false);

    expect(
      isSameScope(
        { kind: "folder", rootId: "r1", relativePath: "a/b" },
        { kind: "folder", rootId: "r1", relativePath: "a/b" }
      )
    ).toBe(true);
    expect(
      isSameScope(
        { kind: "folder", rootId: "r1", relativePath: "a/b" },
        { kind: "folder", rootId: "r1", relativePath: "a/c" }
      )
    ).toBe(false);

    expect(
      isSameScope(
        { kind: "collection", collectionId: "c1" },
        { kind: "collection", collectionId: "c1" }
      )
    ).toBe(true);
    expect(
      isSameScope(
        { kind: "collection", collectionId: "c1" },
        { kind: "collection", collectionId: "c2" }
      )
    ).toBe(false);

    expect(isSameScope({ kind: "search", query: "test" }, { kind: "search", query: "test" })).toBe(true);
    expect(isSameScope({ kind: "search", query: "test" }, { kind: "search", query: "other" })).toBe(false);
  });

  it("checks descendant path matching with isDescendantPath", () => {
    expect(isDescendantPath("novel.epub", "")).toBe(true);
    expect(isDescendantPath("Fiction/novel.epub", "Fiction")).toBe(true);
    expect(isDescendantPath("Fiction/Sci-Fi/novel.epub", "Fiction")).toBe(true);
    expect(isDescendantPath("Fiction/Sci-Fi/novel.epub", "Fiction/Sci-Fi")).toBe(true);
    expect(isDescendantPath("NonFiction/essay.txt", "Fiction")).toBe(false);
    expect(isDescendantPath("FictionExtra/story.pdf", "Fiction")).toBe(false); // prefix boundary check
  });

  const sampleDocs: StoredDocument[] = [
    {
      record: {
        id: "d1",
        name: "Intro.pdf",
        format: "pdf",
        sizeBytes: 100,
        firstSeenAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
        collections: ["col-work"],
      },
      source: { kind: "library", rootId: "root-1", relativePath: "Intro.pdf" },
      availability: "present",
      readingState: {
        documentId: "d1",
        position: { kind: "pdf-page", page: 12 },
        lastOpenedAt: "2026-10-03T10:00:00Z",
        updatedAt: "2026-10-03T10:00:00Z",
      },
    },
    {
      record: {
        id: "d2",
        name: "Story.epub",
        format: "epub",
        sizeBytes: 200,
        firstSeenAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
        collections: ["col-reading"],
      },
      source: { kind: "library", rootId: "root-1", relativePath: "Fiction/Story.epub" },
      availability: "present",
      readingState: {
        documentId: "d2",
        position: { kind: "epub-cfi", cfi: "/6/2", progression: 0.45 },
        lastOpenedAt: "2026-10-03T12:00:00Z",
        updatedAt: "2026-10-03T12:00:00Z",
      },
    },
    {
      record: {
        id: "d3",
        name: "Cyber.epub",
        format: "epub",
        sizeBytes: 300,
        firstSeenAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
        collections: ["col-reading"],
      },
      source: { kind: "library", rootId: "root-1", relativePath: "Fiction/Sci-Fi/Cyber.epub" },
      availability: "present",
    },
    {
      record: {
        id: "d4",
        name: "Report.docx",
        format: "docx",
        sizeBytes: 400,
        firstSeenAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      },
      source: { kind: "library", rootId: "root-2", relativePath: "Report.docx" },
      availability: "present",
    },
    {
      record: {
        id: "d5",
        name: "Notes.txt",
        format: "txt",
        sizeBytes: 50,
        firstSeenAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      },
      source: { kind: "library", rootId: "root-2", relativePath: "Notes.txt" },
      availability: "present",
      readingState: {
        documentId: "d5",
        position: { kind: "text-scroll", progression: 0.8 },
        lastOpenedAt: "2026-10-03T11:00:00Z",
        updatedAt: "2026-10-03T11:00:00Z",
      },
    },
  ];

  it("filters documents by scope properly", () => {
    // All
    expect(filterDocumentsByScope(sampleDocs, { kind: "all" }).length).toBe(5);

    // Root-1
    const root1 = filterDocumentsByScope(sampleDocs, { kind: "root", rootId: "root-1" });
    expect(root1.map((d) => d.record.id)).toEqual(["d1", "d2", "d3"]);

    // Root-2
    const root2 = filterDocumentsByScope(sampleDocs, { kind: "root", rootId: "root-2" });
    expect(root2.map((d) => d.record.id)).toEqual(["d4", "d5"]);

    // Folder recursive descendant scoping: "Fiction" contains Story.epub and Sci-Fi/Cyber.epub
    const fiction = filterDocumentsByScope(sampleDocs, {
      kind: "folder",
      rootId: "root-1",
      relativePath: "Fiction",
    });
    expect(fiction.map((d) => d.record.id)).toEqual(["d2", "d3"]);

    // Subfolder: "Fiction/Sci-Fi" contains only Cyber.epub
    const scifi = filterDocumentsByScope(sampleDocs, {
      kind: "folder",
      rootId: "root-1",
      relativePath: "Fiction/Sci-Fi",
    });
    expect(scifi.map((d) => d.record.id)).toEqual(["d3"]);

    // Collection scope
    const work = filterDocumentsByScope(sampleDocs, { kind: "collection", collectionId: "col-work" });
    expect(work.map((d) => d.record.id)).toEqual(["d1"]);

    const reading = filterDocumentsByScope(sampleDocs, {
      kind: "collection",
      collectionId: "col-reading",
    });
    expect(reading.map((d) => d.record.id)).toEqual(["d2", "d3"]);

    // Search scope
    const search = filterDocumentsByScope(sampleDocs, { kind: "search", query: "cyber" });
    expect(search.map((d) => d.record.id)).toEqual(["d3"]);
  });

  it("derives continue documents ordered by most recently opened", () => {
    const continueDocs = deriveContinueDocuments(sampleDocs, 6);
    // d2 (12:00) > d5 (11:00) > d1 (10:00)
    // d3 and d4 have no reading state, so they are excluded!
    expect(continueDocs.length).toBe(3);
    expect(continueDocs.map((d) => d.record.id)).toEqual(["d2", "d5", "d1"]);
  });

  it("caps continue documents to maxCount", () => {
    const continueDocs = deriveContinueDocuments(sampleDocs, 2);
    expect(continueDocs.length).toBe(2);
    expect(continueDocs.map((d) => d.record.id)).toEqual(["d2", "d5"]);
  });

  it("models route and restoration state correctly", () => {
    const initialRoute: AppRoute = { kind: "library", scope: DEFAULT_LIBRARY_SCOPE };
    expect(initialRoute.kind).toBe("library");

    const state: LibraryRestorationState = {
      scope: { kind: "folder", rootId: "root-1", relativePath: "Fiction" },
      viewMode: "list",
      searchQuery: "novel",
      selectedDocIds: ["d2"],
      scrollAnchorId: "d2",
      sortBy: "name-asc",
    };

    const docRoute: AppRoute = { kind: "document", documentId: "d2" };
    expect(docRoute.kind).toBe("document");
    expect(state.scrollAnchorId).toBe("d2");
  });
});
