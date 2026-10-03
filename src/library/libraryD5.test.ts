/**
 * D5 Product & Visual Refinement Tests
 *
 * Covers production logic used by the search scope picker and document covers.
 */

import { describe, expect, it } from "bun:test";
import type { Collection, LibraryRoot, StoredDocument } from "../storage/domain";
import { getDocumentDisplayTitle } from "../storage/domain";
import { getDocumentMonogram, getScopeLabel, getSearchScopeOptions } from "./libraryFilter";

const roots: LibraryRoot[] = [
  {
    id: "root-physics",
    label: "Physics Papers",
    kind: "filesystem-directory",
    status: "ready",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

const collections: Collection[] = [
  {
    id: "col-classics",
    name: "Sci-Fi Classics",
    description: "Favorite sci-fi books",
    documentCount: 5,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

describe("D5: search scope picker logic", () => {
  it("labels folder, collection, and whole-library scopes from domain data", () => {
    expect(getScopeLabel({ kind: "root", rootId: "root-physics" }, roots, collections)).toBe(
      "Physics Papers"
    );
    expect(
      getScopeLabel(
        { kind: "folder", rootId: "root-physics", relativePath: "Quantum/Electrodynamics" },
        roots,
        collections
      )
    ).toBe("Electrodynamics");
    expect(
      getScopeLabel({ kind: "collection", collectionId: "col-classics" }, roots, collections)
    ).toBe("Sci-Fi Classics");
    expect(getScopeLabel({ kind: "all" }, roots, collections)).toBe("Entire Library");
  });

  it("offers the current collection and Entire Library as the only applicable scopes", () => {
    const options = getSearchScopeOptions(
      { kind: "collection", collectionId: "col-classics" },
      roots,
      collections
    );

    expect(options).toEqual([
      {
        scope: { kind: "collection", collectionId: "col-classics" },
        label: "Current Collection (Sci-Fi Classics)",
      },
      { scope: { kind: "all" }, label: "Entire Library" },
    ]);
  });

  it("offers the current folder and Entire Library for a folder context", () => {
    const options = getSearchScopeOptions(
      { kind: "folder", rootId: "root-physics", relativePath: "Quantum" },
      roots,
      collections
    );
    expect(options.map((option) => option.label)).toEqual([
      "Current Folder (Quantum)",
      "Entire Library",
    ]);
  });

  it("ignores search and whole-library contexts without duplicating options", () => {
    expect(getSearchScopeOptions({ kind: "search", query: "x" }, roots, collections)).toEqual([
      { scope: { kind: "all" }, label: "Entire Library" },
    ]);
    expect(getSearchScopeOptions({ kind: "all" }, roots, collections)).toEqual([
      { scope: { kind: "all" }, label: "Entire Library" },
    ]);
  });
});

describe("D5: document cover fallback", () => {
  it("uses initials from real document titles and falls back to format", () => {
    expect(getDocumentMonogram("A Bottomless Grave", "epub")).toBe("AB");
    expect(getDocumentMonogram("Neuromancer", "epub")).toBe("N");
    expect(getDocumentMonogram("12345", "pdf")).toBe("PD");
  });

  it("uses embedded title and author without fabricating metadata", () => {
    const doc: StoredDocument = {
      record: {
        id: "d1",
        name: "dune_final.epub",
        format: "epub",
        sizeBytes: 400000,
        firstSeenAt: "",
        updatedAt: "",
        metadata: { title: "Dune", authors: ["Frank Herbert"], provenance: "embedded" },
      },
      source: { kind: "library", rootId: "r1", relativePath: "dune_final.epub" },
      availability: "present",
    };
    expect(getDocumentDisplayTitle(doc.record)).toBe("Dune");
    expect(doc.record.metadata?.authors).toEqual(["Frank Herbert"]);
    expect(getDocumentDisplayTitle({ ...doc.record, metadata: undefined })).toBe("dune_final.epub");
  });
});
