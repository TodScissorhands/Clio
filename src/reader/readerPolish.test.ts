import { describe, expect, it } from "bun:test";
import type { ReaderSearchResult, ReaderTocItem } from "./types";

// --- Search Navigation Logic ---

export interface SearchMatchState {
  matches: number[]; // Page numbers or match indices
  currentIndex: number;
}

export function computeNextMatch(state: SearchMatchState): SearchMatchState {
  if (state.matches.length === 0) return state;
  const nextIndex = (state.currentIndex + 1) % state.matches.length;
  return { matches: state.matches, currentIndex: nextIndex };
}

export function computePrevMatch(state: SearchMatchState): SearchMatchState {
  if (state.matches.length === 0) return state;
  const prevIndex =
    state.currentIndex <= 0 ? state.matches.length - 1 : state.currentIndex - 1;
  return { matches: state.matches, currentIndex: prevIndex };
}

export function formatSearchLabel(
  count: number,
  currentIndex: number
): ReaderSearchResult {
  if (count === 0) {
    return { count: 0, label: "No matches found" };
  }
  return {
    count,
    currentIndex: currentIndex + 1,
    label: `${currentIndex + 1} of ${count}`,
  };
}

// --- TOC Resolution Logic ---

export type MockPdfOutlineNode = {
  title?: string;
  dest?: string | unknown[] | null;
  url?: string | null;
  items?: MockPdfOutlineNode[];
};

export type MockPageRef = { num: number; gen: number };

export interface MockPdfProxy {
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: MockPageRef): Promise<number>;
}

export async function resolveDestination(
  pdf: MockPdfProxy,
  destination: string | unknown[] | null | undefined
): Promise<number | null> {
  let resolved: string | unknown[] | null | undefined = destination;
  if (typeof destination === "string") {
    try {
      resolved = await pdf.getDestination(destination);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(resolved) || resolved.length === 0) return null;
  const target = resolved[0];
  if (typeof target === "number" && Number.isInteger(target)) return target + 1;
  if (!target || typeof target !== "object" || !("num" in target) || !("gen" in target)) {
    return null;
  }
  try {
    return (await pdf.getPageIndex(target as MockPageRef)) + 1;
  } catch {
    return null;
  }
}

export async function mapPdfOutline(
  pdf: MockPdfProxy,
  nodes: MockPdfOutlineNode[],
  destinations: Map<string, number>,
  prefix = "pdf"
): Promise<ReaderTocItem[]> {
  const mapped: ReaderTocItem[] = [];
  for (const [index, node] of nodes.entries()) {
    const id = `${prefix}-${index}`;
    const page = await resolveDestination(pdf, node.dest);
    if (page !== null) destinations.set(id, page);
    const children = Array.isArray(node.items)
      ? await mapPdfOutline(pdf, node.items, destinations, id)
      : [];
    mapped.push({
      id,
      label: typeof node.title === "string" && node.title.trim() ? node.title : "Untitled section",
      children,
    });
  }
  return mapped;
}

export function mapEpubTocItems(value: unknown, prefix = "toc"): ReaderTocItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    const label =
      typeof entry.label === "string"
        ? entry.label
        : typeof entry.title === "string"
        ? entry.title
        : "Untitled section";
    const href = typeof entry.href === "string" ? entry.href : undefined;
    const children = mapEpubTocItems(entry.subitems ?? entry.children, `${prefix}-${index}`);
    return [{ id: `${prefix}-${index}`, label, href, children }];
  });
}

// --- PDF HiDPI and Zoom Calculations ---

export function computeCanvasDimensions(
  logicalViewport: { width: number; height: number },
  scale: number,
  devicePixelRatio: number
) {
  const outputScale = Math.max(1, devicePixelRatio || 1);
  const scaledWidth = Math.ceil(logicalViewport.width * scale * outputScale);
  const scaledHeight = Math.ceil(logicalViewport.height * scale * outputScale);
  const cssWidth = Math.ceil(logicalViewport.width * scale);
  const cssHeight = Math.ceil(logicalViewport.height * scale);
  return {
    canvasWidth: scaledWidth,
    canvasHeight: scaledHeight,
    cssWidth: `${cssWidth}px`,
    cssHeight: `${cssHeight}px`,
    outputScale,
  };
}

export function clampZoom(currentZoom: number, delta: number): number {
  const next = Number((currentZoom + delta).toFixed(2));
  return Math.max(0.5, Math.min(2.5, next));
}

// --- EPUB Progression Clamping ---

export function clampProgression(rawFraction: unknown): number | undefined {
  if (typeof rawFraction !== "number" || !Number.isFinite(rawFraction)) {
    return undefined;
  }
  return Math.max(0, Math.min(1, rawFraction));
}

// ======================== TESTS ========================

describe("Reader Search Navigation", () => {
  it("navigates next search match with wrap-around", () => {
    let state: SearchMatchState = { matches: [2, 5, 8], currentIndex: 0 };
    expect(state.matches[state.currentIndex]).toBe(2);

    state = computeNextMatch(state);
    expect(state.currentIndex).toBe(1);
    expect(state.matches[state.currentIndex]).toBe(5);

    state = computeNextMatch(state);
    expect(state.currentIndex).toBe(2);
    expect(state.matches[state.currentIndex]).toBe(8);

    // Wrap around to start
    state = computeNextMatch(state);
    expect(state.currentIndex).toBe(0);
    expect(state.matches[state.currentIndex]).toBe(2);
  });

  it("navigates previous search match with wrap-around", () => {
    let state: SearchMatchState = { matches: [1, 4, 9], currentIndex: 0 };

    // Wrap around backwards to end
    state = computePrevMatch(state);
    expect(state.currentIndex).toBe(2);
    expect(state.matches[state.currentIndex]).toBe(9);

    state = computePrevMatch(state);
    expect(state.currentIndex).toBe(1);
    expect(state.matches[state.currentIndex]).toBe(4);

    state = computePrevMatch(state);
    expect(state.currentIndex).toBe(0);
    expect(state.matches[state.currentIndex]).toBe(1);
  });

  it("formats search result labels accurately", () => {
    expect(formatSearchLabel(0, -1)).toEqual({ count: 0, label: "No matches found" });
    expect(formatSearchLabel(12, 0)).toEqual({ count: 12, currentIndex: 1, label: "1 of 12" });
    expect(formatSearchLabel(12, 11)).toEqual({ count: 12, currentIndex: 12, label: "12 of 12" });
  });
});

describe("PDF TOC and Destination Resolution", () => {
  const mockPdf: MockPdfProxy = {
    async getDestination(id: string) {
      if (id === "chapter-1") return [{ num: 10, gen: 0 }, { name: "Fit" }];
      if (id === "direct-page-num") return [4, { name: "XYZ" }];
      return null;
    },
    async getPageIndex(ref: MockPageRef) {
      if (ref.num === 10) return 9; // 0-based page index for page 10
      if (ref.num === 20) return 19;
      throw new Error("Page ref not found");
    },
  };

  it("resolves named and explicit destination page indices correctly", async () => {
    // Named destination resolving to a page ref
    const pageFromNamed = await resolveDestination(mockPdf, "chapter-1");
    expect(pageFromNamed).toBe(10); // 1-based page 10

    // Direct page number array
    const pageFromNum = await resolveDestination(mockPdf, "direct-page-num");
    expect(pageFromNum).toBe(5); // 1-based (4 + 1)

    // Direct object page ref
    const pageFromDirectRef = await resolveDestination(mockPdf, [{ num: 20, gen: 0 }]);
    expect(pageFromDirectRef).toBe(20); // 1-based (19 + 1)
  });

  it("safely ignores external URLs and invalid destinations without throwing", async () => {
    // External URL outline node (dest is null)
    expect(await resolveDestination(mockPdf, null)).toBeNull();
    expect(await resolveDestination(mockPdf, undefined)).toBeNull();

    // Unknown named destination
    expect(await resolveDestination(mockPdf, "non-existent-dest")).toBeNull();

    // Empty array
    expect(await resolveDestination(mockPdf, [])).toBeNull();
  });

  it("recursively maps nested outline nodes with fallback titles", async () => {
    const destinations = new Map<string, number>();
    const outlineNodes: MockPdfOutlineNode[] = [
      {
        title: "Introduction",
        dest: "chapter-1",
        items: [
          {
            title: "Background",
            dest: [{ num: 20, gen: 0 }],
          },
          {
            title: "", // Empty title fallback
            dest: null, // External / unresolvable
          },
        ],
      },
    ];

    const mapped = await mapPdfOutline(mockPdf, outlineNodes, destinations);
    expect(mapped.length).toBe(1);
    expect(mapped[0].label).toBe("Introduction");
    expect(destinations.get("pdf-0")).toBe(10);

    // Nested children
    expect(mapped[0].children?.length).toBe(2);
    expect(mapped[0].children?.[0].label).toBe("Background");
    expect(destinations.get("pdf-0-0")).toBe(20);

    // Empty title fallback and unresolved destination
    expect(mapped[0].children?.[1].label).toBe("Untitled section");
    expect(destinations.has("pdf-0-1")).toBe(false);
  });
});

describe("EPUB TOC Mapping", () => {
  it("recursively maps nested Foliate TOC structures", () => {
    const foliateToc = [
      {
        label: "Part I: Foundations",
        href: "part1.xhtml",
        subitems: [
          {
            title: "Chapter 1",
            href: "chap1.xhtml",
          },
        ],
      },
      {
        // Malformed item
        label: 123 as unknown as string,
        children: [
          {
            title: "Subsection A",
            href: "sub_a.xhtml",
          },
        ],
      },
    ];

    const mapped = mapEpubTocItems(foliateToc);
    expect(mapped.length).toBe(2);
    expect(mapped[0].label).toBe("Part I: Foundations");
    expect(mapped[0].href).toBe("part1.xhtml");
    expect(mapped[0].children?.length).toBe(1);
    expect(mapped[0].children?.[0].label).toBe("Chapter 1");
    expect(mapped[0].children?.[0].href).toBe("chap1.xhtml");

    // Fallback for non-string label
    expect(mapped[1].label).toBe("Untitled section");
    expect(mapped[1].children?.[0].label).toBe("Subsection A");
  });
});

describe("PDF HiDPI Dimensions and Zoom Clamping", () => {
  it("calculates crisp backing dimensions scaled by devicePixelRatio while preserving logical CSS dimensions", () => {
    const logical = { width: 600, height: 800 };
    const dpr2 = computeCanvasDimensions(logical, 1.0, 2.0);

    // Canvas backing buffer is 2x resolution
    expect(dpr2.canvasWidth).toBe(1200);
    expect(dpr2.canvasHeight).toBe(1600);

    // CSS size matches logical viewport
    expect(dpr2.cssWidth).toBe("600px");
    expect(dpr2.cssHeight).toBe("800px");

    // Zoomed at 1.5x on 2.5 DPR
    const zoomed = computeCanvasDimensions(logical, 1.5, 2.5);
    expect(zoomed.canvasWidth).toBe(Math.ceil(600 * 1.5 * 2.5));
    expect(zoomed.canvasHeight).toBe(Math.ceil(800 * 1.5 * 2.5));
    expect(zoomed.cssWidth).toBe(`${600 * 1.5}px`);
    expect(zoomed.cssHeight).toBe(`${800 * 1.5}px`);
  });

  it("clamps zoom within [0.5, 2.5] bounds", () => {
    expect(clampZoom(1.0, 0.1)).toBe(1.1);
    expect(clampZoom(2.4, 0.2)).toBe(2.5); // Upper bound
    expect(clampZoom(2.5, 0.5)).toBe(2.5);
    expect(clampZoom(0.6, -0.2)).toBe(0.5); // Lower bound
    expect(clampZoom(0.5, -0.5)).toBe(0.5);
  });
});

describe("EPUB Progression Clamping", () => {
  it("clamps progression strictly to [0.0, 1.0]", () => {
    expect(clampProgression(0.45)).toBe(0.45);
    expect(clampProgression(0.0)).toBe(0.0);
    expect(clampProgression(1.0)).toBe(1.0);
    expect(clampProgression(-0.1)).toBe(0.0);
    expect(clampProgression(1.2)).toBe(1.0);
  });

  it("safely handles non-finite and invalid progression values", () => {
    expect(clampProgression(NaN)).toBeUndefined();
    expect(clampProgression(Infinity)).toBeUndefined();
    expect(clampProgression(-Infinity)).toBeUndefined();
    expect(clampProgression(null)).toBeUndefined();
    expect(clampProgression("0.5")).toBeUndefined();
  });
});
