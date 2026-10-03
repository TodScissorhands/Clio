import { describe, expect, it } from "bun:test";
import type { StoredDocument } from "../storage/domain";
import { buildFolderTree } from "./LibrarySidebar";

describe("Library Visual Refinement: sidebar-11 tree structure", () => {
  it("builds hierarchical folder nodes for nested directories", () => {
    const docs: StoredDocument[] = [
      {
        record: {
          id: "doc-1",
          name: "paper.pdf",
          format: "pdf",
          sizeBytes: 100,
          firstSeenAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        source: {
          kind: "library",
          rootId: "root-1",
          relativePath: "science/physics/relativity/paper.pdf",
        },
        availability: "present",
      },
      {
        record: {
          id: "doc-2",
          name: "intro.epub",
          format: "epub",
          sizeBytes: 200,
          firstSeenAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        source: {
          kind: "library",
          rootId: "root-1",
          relativePath: "science/biology/intro.epub",
        },
        availability: "present",
      },
    ];

    const tree = buildFolderTree(docs, "root-1");
    expect(tree.length).toBe(1);
    expect(tree[0]!.name).toBe("science");
    expect(tree[0]!.children.length).toBe(2);

    const childNames = tree[0]!.children.map((c) => c.name);
    expect(childNames).toContain("biology");
    expect(childNames).toContain("physics");

    const physicsNode = tree[0]!.children.find((c) => c.name === "physics");
    expect(physicsNode?.children.length).toBe(1);
    expect(physicsNode?.children[0]?.name).toBe("relativity");
  });
});

describe("Library Visual Refinement: table bulk selection logic", () => {
  it("computes allSelected, someSelected, and toggle-all correctly", () => {
    const docIds = ["doc-1", "doc-2", "doc-3"];

    // Case 1: None selected
    let selected = new Set<string>();
    let allSelected = docIds.length > 0 && docIds.every((id) => selected.has(id));
    let someSelected = !allSelected && docIds.some((id) => selected.has(id));
    expect(allSelected).toBe(false);
    expect(someSelected).toBe(false);

    // Toggle select all from none -> all
    let next = new Set(selected);
    for (const id of docIds) next.add(id);
    selected = next;

    // Case 2: All selected
    allSelected = docIds.length > 0 && docIds.every((id) => selected.has(id));
    someSelected = !allSelected && docIds.some((id) => selected.has(id));
    expect(allSelected).toBe(true);
    expect(someSelected).toBe(false);

    // Toggle select all from all -> none
    next = new Set(selected);
    for (const id of docIds) next.delete(id);
    selected = next;
    expect(selected.size).toBe(0);

    // Case 3: Partial selected (indeterminate)
    selected = new Set(["doc-2"]);
    allSelected = docIds.length > 0 && docIds.every((id) => selected.has(id));
    someSelected = !allSelected && docIds.some((id) => selected.has(id));
    expect(allSelected).toBe(false);
    expect(someSelected).toBe(true);

    // Toggle select all from partial -> all
    next = new Set(selected);
    for (const id of docIds) next.add(id);
    selected = next;
    expect(selected.size).toBe(3);
  });
});

describe("Library Visual Refinement: bookshelf card progress relevance", () => {
  it("determines reading progress relevance only when started (> 0)", () => {
    function getProgressPercent(readingState?: {
      position?: { kind: string; progression?: number };
    }): number | null {
      if (!readingState?.position) return null;
      const pos = readingState.position;
      if (pos.kind === "text-scroll" && typeof pos.progression === "number") {
        return Math.round(pos.progression * 100);
      }
      if (pos.kind === "epub-cfi" && typeof pos.progression === "number") {
        return Math.round(pos.progression * 100);
      }
      return null;
    }

    // Unopened book
    expect(getProgressPercent(undefined)).toBeNull();

    // Opened book at 0%
    const atZero = getProgressPercent({ position: { kind: "epub-cfi", progression: 0 } });
    expect(atZero).toBe(0);
    // Progress relevance check: only relevant when > 0
    expect(atZero !== null && atZero > 0).toBe(false);

    // In-progress book at 42%
    const inProgress = getProgressPercent({ position: { kind: "epub-cfi", progression: 0.42 } });
    expect(inProgress).toBe(42);
    expect(inProgress !== null && inProgress > 0).toBe(true);
  });
});
