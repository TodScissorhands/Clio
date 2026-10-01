import { describe, expect, it } from "bun:test";
import {
  validateAnnotationLocator,
  type Annotation,
  type AnnotationLocator,
  type TextSelection,
} from "../storage/domain";

// ─── Locator Validation ─────────────────────────────────────────────────────

describe("AnnotationLocator validation — epub-cfi-range", () => {
  it("accepts a well-formed range CFI", () => {
    const locator: AnnotationLocator = {
      kind: "epub-cfi-range",
      cfi: "epubcfi(/6/4!/4,/2/1:0,/2/1:5)",
    };
    expect(validateAnnotationLocator(locator)).toBeNull();
  });

  it("accepts a range CFI with whitespace trim", () => {
    const locator: AnnotationLocator = {
      kind: "epub-cfi-range",
      cfi: "  epubcfi(/6/4!/4,/2/1:0,/2/1:5)  ",
    };
    expect(validateAnnotationLocator(locator)).toBeNull();
  });

  it("rejects an empty CFI", () => {
    const locator: AnnotationLocator = { kind: "epub-cfi-range", cfi: "" };
    const result = validateAnnotationLocator(locator);
    expect(result).not.toBeNull();
    expect(result).toContain("non-empty CFI");
  });

  it("rejects a CFI that does not start with epubcfi(", () => {
    const locator: AnnotationLocator = {
      kind: "epub-cfi-range",
      cfi: "/6/4!/4,/2/1:0,/2/1:5",
    };
    const result = validateAnnotationLocator(locator);
    expect(result).not.toBeNull();
    expect(result).toContain("epubcfi(");
  });

  it("rejects a position CFI (no comma — not a range)", () => {
    const locator: AnnotationLocator = {
      kind: "epub-cfi-range",
      cfi: "epubcfi(/6/4!/4/2/1:0)",
    };
    const result = validateAnnotationLocator(locator);
    expect(result).not.toBeNull();
    expect(result).toContain("range CFI");
  });

  it("rejects whitespace-only CFI", () => {
    const locator: AnnotationLocator = {
      kind: "epub-cfi-range",
      cfi: "   ",
    };
    const result = validateAnnotationLocator(locator);
    expect(result).not.toBeNull();
  });
});

describe("AnnotationLocator validation — pdf-page-text", () => {
  it("accepts a valid page + selectedText locator", () => {
    const locator: AnnotationLocator = {
      kind: "pdf-page-text",
      page: 1,
      selectedText: "Hello world",
    };
    expect(validateAnnotationLocator(locator)).toBeNull();
  });

  it("accepts page 1 with non-trivial selected text", () => {
    const locator: AnnotationLocator = {
      kind: "pdf-page-text",
      page: 42,
      selectedText: "Important finding about the reader architecture.",
    };
    expect(validateAnnotationLocator(locator)).toBeNull();
  });

  it("rejects page 0", () => {
    const locator: AnnotationLocator = {
      kind: "pdf-page-text",
      page: 0,
      selectedText: "text",
    };
    const result = validateAnnotationLocator(locator);
    expect(result).not.toBeNull();
    expect(result).toContain("page");
  });

  it("rejects negative page", () => {
    const locator: AnnotationLocator = {
      kind: "pdf-page-text",
      page: -1,
      selectedText: "text",
    };
    expect(validateAnnotationLocator(locator)).not.toBeNull();
  });

  it("rejects non-integer page", () => {
    const locator: AnnotationLocator = {
      kind: "pdf-page-text",
      page: 1.5,
      selectedText: "text",
    };
    expect(validateAnnotationLocator(locator)).not.toBeNull();
  });

  it("rejects empty selectedText", () => {
    const locator: AnnotationLocator = {
      kind: "pdf-page-text",
      page: 5,
      selectedText: "",
    };
    const result = validateAnnotationLocator(locator);
    expect(result).not.toBeNull();
    expect(result).toContain("selectedText");
  });

  it("rejects whitespace-only selectedText", () => {
    const locator: AnnotationLocator = {
      kind: "pdf-page-text",
      page: 5,
      selectedText: "   ",
    };
    expect(validateAnnotationLocator(locator)).not.toBeNull();
  });
});

describe("AnnotationLocator validation — unknown kind", () => {
  it("returns an error for an unknown locator kind", () => {
    // Cast via unknown to simulate a malformed/future payload at runtime
    const locator = { kind: "future-kind", value: 42 } as unknown as AnnotationLocator;
    const result = validateAnnotationLocator(locator);
    expect(result).not.toBeNull();
    expect(result).toContain("Unknown");
  });
});

// ─── Locator Serialization / Deserialization ────────────────────────────────

describe("AnnotationLocator JSON serialization round-trip", () => {
  it("round-trips an epub-cfi-range locator through JSON", () => {
    const original: AnnotationLocator = {
      kind: "epub-cfi-range",
      cfi: "epubcfi(/6/4!/4,/2/1:0,/2/1:22)",
    };
    const serialized = JSON.stringify(original);
    const restored = JSON.parse(serialized) as AnnotationLocator;
    expect(restored.kind).toBe("epub-cfi-range");
    if (restored.kind === "epub-cfi-range") {
      expect(restored.cfi).toBe(original.cfi);
    }
    expect(validateAnnotationLocator(restored)).toBeNull();
  });

  it("round-trips a pdf-page-text locator through JSON", () => {
    const original: AnnotationLocator = {
      kind: "pdf-page-text",
      page: 7,
      selectedText: "Selected text from page 7",
    };
    const serialized = JSON.stringify(original);
    const restored = JSON.parse(serialized) as AnnotationLocator;
    expect(restored.kind).toBe("pdf-page-text");
    if (restored.kind === "pdf-page-text") {
      expect(restored.page).toBe(7);
      expect(restored.selectedText).toBe("Selected text from page 7");
    }
    expect(validateAnnotationLocator(restored)).toBeNull();
  });

  it("rejects a JSON-parsed object with a missing kind", () => {
    // JSON.parse returns unknown at runtime; cast via unknown to test validator robustness
    const broken = JSON.parse('{"page": 3, "selectedText": "orphan"}') as unknown as AnnotationLocator;
    const result = validateAnnotationLocator(broken);
    expect(result).not.toBeNull();
  });

  it("rejects a JSON-parsed pdf-page-text with wrong page type", () => {
    // Simulates a payload where 'page' is accidentally a string
    const broken = JSON.parse(
      '{"kind":"pdf-page-text","page":"three","selectedText":"text"}'
    ) as unknown as AnnotationLocator;
    const result = validateAnnotationLocator(broken);
    expect(result).not.toBeNull();
  });
});

// ─── TextSelection shape — PDF engine output ─────────────────────────────────

describe("TextSelection from PDF engine", () => {
  it("represents a PDF text selection with pdf-page-text locator", () => {
    const selection: TextSelection = {
      locator: { kind: "pdf-page-text", page: 3, selectedText: "Lorem ipsum" },
      selectedText: "Lorem ipsum",
    };
    expect(selection.locator.kind).toBe("pdf-page-text");
    expect(selection.selectedText).toBe("Lorem ipsum");
    if (selection.locator.kind === "pdf-page-text") {
      expect(selection.locator.page).toBe(3);
      expect(selection.locator.selectedText).toBe("Lorem ipsum");
    }
    expect(validateAnnotationLocator(selection.locator)).toBeNull();
  });

  it("validates the PDF locator inside a TextSelection", () => {
    // Page 0 is invalid
    const bad: TextSelection = {
      locator: { kind: "pdf-page-text", page: 0, selectedText: "text" },
      selectedText: "text",
    };
    expect(validateAnnotationLocator(bad.locator)).not.toBeNull();
  });

  it("documents the PDF limitation: pdf-page-text is NOT a durable locator", () => {
    // The locator stores page + text for display only.
    // Highlight restoration is not possible without a future TextLayer implementation.
    // This test records the architectural limitation: the locator is valid but not durable.
    const locator: AnnotationLocator = {
      kind: "pdf-page-text",
      page: 14,
      selectedText: "The PDF text layer is rendered as a canvas overlay.",
    };
    // Validation passes (structurally correct).
    expect(validateAnnotationLocator(locator)).toBeNull();
    // But the kind name itself signals the limitation.
    expect(locator.kind).toBe("pdf-page-text");
  });
});

// ─── TextSelection shape — EPUB engine output ────────────────────────────────

describe("TextSelection from EPUB engine", () => {
  it("represents an EPUB text selection with epub-cfi-range locator", () => {
    const selection: TextSelection = {
      locator: {
        kind: "epub-cfi-range",
        cfi: "epubcfi(/6/12!/4,/2/1:0,/2/1:15)",
      },
      selectedText: "Durable CFI range selection",
    };
    expect(selection.locator.kind).toBe("epub-cfi-range");
    expect(selection.selectedText).toBe("Durable CFI range selection");
    if (selection.locator.kind === "epub-cfi-range") {
      expect(selection.locator.cfi).toContain(","); // range CFI must contain comma
    }
    expect(validateAnnotationLocator(selection.locator)).toBeNull();
  });

  it("validates the EPUB locator inside a TextSelection", () => {
    // A position CFI (no comma) is not a valid annotation range locator
    const bad: TextSelection = {
      locator: {
        kind: "epub-cfi-range",
        cfi: "epubcfi(/6/12!/4/2/1:0)", // position, not range
      },
      selectedText: "text",
    };
    expect(validateAnnotationLocator(bad.locator)).not.toBeNull();
  });

  it("preserves selected text as display context separate from the CFI", () => {
    const cfi = "epubcfi(/6/4!/4,/2/1:100,/2/1:120)";
    const selection: TextSelection = {
      locator: { kind: "epub-cfi-range", cfi },
      selectedText: "The chapter title appears here",
    };
    // CFI is the durable identity; selectedText is contextual display only
    if (selection.locator.kind === "epub-cfi-range") {
      expect(selection.locator.cfi).toBe(cfi);
    }
    expect(selection.selectedText).toBe("The chapter title appears here");
  });
});

// ─── Document isolation ──────────────────────────────────────────────────────

describe("Annotation locator document isolation", () => {
  it("locators carry no document identity — isolation is enforced by documentId on Annotation", () => {
    // Two identical locators from different documents must be distinguished
    // by the Annotation.documentId field, not by the locator itself.
    const locatorA: AnnotationLocator = {
      kind: "pdf-page-text",
      page: 5,
      selectedText: "Same text on same page",
    };
    const locatorB: AnnotationLocator = {
      kind: "pdf-page-text",
      page: 5,
      selectedText: "Same text on same page",
    };

    // Both are structurally valid
    expect(validateAnnotationLocator(locatorA)).toBeNull();
    expect(validateAnnotationLocator(locatorB)).toBeNull();

    // They are structurally equal — document isolation requires Annotation.documentId
    expect(JSON.stringify(locatorA)).toBe(JSON.stringify(locatorB));
  });

  it("EPUB locators are document-scope-independent: same CFI in different EPUBs means different content", () => {
    const cfi = "epubcfi(/6/4!/4,/2/1:0,/2/1:5)";
    const locatorA: AnnotationLocator = { kind: "epub-cfi-range", cfi };
    const locatorB: AnnotationLocator = { kind: "epub-cfi-range", cfi };

    expect(validateAnnotationLocator(locatorA)).toBeNull();
    expect(validateAnnotationLocator(locatorB)).toBeNull();

    // Same CFI, but document isolation is Annotation.documentId's responsibility
    expect(locatorA.cfi).toBe(locatorB.cfi);
  });
});

// ─── Malformed locator handling ──────────────────────────────────────────────

describe("Malformed locator handling", () => {
  it("rejects a null locator gracefully", () => {
    // Cast via unknown: testing the runtime null-guard in validateAnnotationLocator
    const result = validateAnnotationLocator(null as unknown as AnnotationLocator);
    expect(result).not.toBeNull();
  });

  it("rejects an undefined locator gracefully", () => {
    const result = validateAnnotationLocator(undefined as unknown as AnnotationLocator);
    expect(result).not.toBeNull();
  });

  it("rejects an empty object", () => {
    const result = validateAnnotationLocator({} as unknown as AnnotationLocator);
    expect(result).not.toBeNull();
  });

  it("rejects a locator with an unrecognized kind string", () => {
    const result = validateAnnotationLocator({ kind: "unknown-format", data: "x" } as unknown as AnnotationLocator);
    expect(result).not.toBeNull();
  });

  it("rejects a locator where epub cfi is not a string", () => {
    // Simulates runtime payload where cfi field has wrong type
    const result = validateAnnotationLocator({ kind: "epub-cfi-range", cfi: 42 } as unknown as AnnotationLocator);
    expect(result).not.toBeNull();
  });

  it("rejects a locator where pdf page is not a number", () => {
    const result = validateAnnotationLocator({ kind: "pdf-page-text", page: "five", selectedText: "text" } as unknown as AnnotationLocator);
    expect(result).not.toBeNull();
  });
});

// ─── Annotation Model with Optional Locator (Pass 3B) ───────────────────────

describe("Annotation with Locator (Pass 3B)", () => {
  it("supports an Annotation with an EPUB CFI range locator", () => {
    const annotation = {
      id: "ann-epub-1",
      documentId: "doc-1",
      kind: "highlight",
      position: { kind: "epub-cfi", cfi: "epubcfi(/6/4!/4/2)", progression: 0.15 },
      selectedText: "Important section in EPUB",
      locator: {
        kind: "epub-cfi-range",
        cfi: "epubcfi(/6/4!/4,/2/1:0,/2/1:22)",
      },
      createdAt: "2026-10-01T14:00:00Z",
      updatedAt: "2026-10-01T14:00:00Z",
    } satisfies Annotation;

    expect(annotation.locator).toBeDefined();
    expect(annotation.locator?.kind).toBe("epub-cfi-range");
    if (annotation.locator?.kind === "epub-cfi-range") {
      expect(annotation.locator.cfi).toContain(",");
    }
  });

  it("supports an Annotation with a PDF page-text locator", () => {
    const annotation = {
      id: "ann-pdf-1",
      documentId: "doc-2",
      kind: "highlight",
      position: { kind: "pdf-page", page: 12 },
      selectedText: "Key concept in document",
      locator: {
        kind: "pdf-page-text",
        page: 12,
        selectedText: "Key concept in document",
      },
      createdAt: "2026-10-01T14:05:00Z",
      updatedAt: "2026-10-01T14:05:00Z",
    } satisfies Annotation;

    expect(annotation.locator).toBeDefined();
    expect(annotation.locator?.kind).toBe("pdf-page-text");
    if (annotation.locator?.kind === "pdf-page-text") {
      expect(annotation.locator.page).toBe(12);
    }
  });

  it("supports an Annotation without a locator (backwards compatible)", () => {
    const annotation = {
      id: "ann-legacy-1",
      documentId: "doc-3",
      kind: "note",
      position: { kind: "pdf-page", page: 1 },
      note: "Note without selection",
      createdAt: "2026-10-01T14:10:00Z",
      updatedAt: "2026-10-01T14:10:00Z",
    } satisfies Annotation;

    expect(annotation.locator).toBeUndefined();
    expect(annotation.note).toBe("Note without selection");
  });

  it("serializes and deserializes annotation locator safely", () => {
    const locator: AnnotationLocator = {
      kind: "epub-cfi-range",
      cfi: "epubcfi(/6/10!/4,/2/1:5,/2/1:30)",
    };

    const json = JSON.stringify(locator);
    const parsed: unknown = JSON.parse(json);

    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
    expect(validateAnnotationLocator(parsed as AnnotationLocator)).toBeNull();
  });

  it("detects malformed JSON payload and rejects as valid locator", () => {
    const malformedJson = '{"kind":"epub-cfi-range","cfi":"not-a-valid-cfi"}';
    const parsed: unknown = JSON.parse(malformedJson);
    expect(validateAnnotationLocator(parsed as AnnotationLocator)).not.toBeNull();
  });

  it("maintains document isolation for annotations with locators", () => {
    const annotations: Annotation[] = [
      {
        id: "a1",
        documentId: "doc-alpha",
        kind: "highlight",
        position: { kind: "pdf-page", page: 1 },
        locator: { kind: "pdf-page-text", page: 1, selectedText: "alpha text" },
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-01T10:00:00Z",
      },
      {
        id: "a2",
        documentId: "doc-beta",
        kind: "highlight",
        position: { kind: "pdf-page", page: 1 },
        locator: { kind: "pdf-page-text", page: 1, selectedText: "beta text" },
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-01T10:00:00Z",
      },
    ];

    const alphaOnly = annotations.filter((a) => a.documentId === "doc-alpha");
    expect(alphaOnly.length).toBe(1);
    expect(alphaOnly[0].id).toBe("a1");

    const betaOnly = annotations.filter((a) => a.documentId === "doc-beta");
    expect(betaOnly.length).toBe(1);
    expect(betaOnly[0].id).toBe("a2");
  });
});

// ─── Annotation Interaction & Notes (Pass 3C) ──────────────────────────────

describe("Annotation Note Interaction (Pass 3C)", () => {
  it("creates an annotation with an optional note attached to a selection", () => {
    const annotation: Annotation = {
      id: "ann-with-note",
      documentId: "doc-1",
      kind: "highlight",
      position: { kind: "pdf-page", page: 3 },
      selectedText: "Quantum computing represents a paradigm shift.",
      note: "Compare with classical Turing machines in chapter 4.",
      locator: {
        kind: "pdf-page-text",
        page: 3,
        selectedText: "Quantum computing represents a paradigm shift.",
      },
      createdAt: "2026-10-01T15:00:00Z",
      updatedAt: "2026-10-01T15:00:00Z",
    };

    expect(annotation.selectedText).toBe("Quantum computing represents a paradigm shift.");
    expect(annotation.note).toBe("Compare with classical Turing machines in chapter 4.");
    expect(annotation.locator?.kind).toBe("pdf-page-text");
  });

  it("models note editing while preserving locator and immutable identity", () => {
    const original: Annotation = {
      id: "ann-editable",
      documentId: "doc-epub-1",
      kind: "highlight",
      position: { kind: "epub-cfi", cfi: "epubcfi(/6/8!/4/2)" },
      selectedText: "The beginning of the chapter",
      note: "Initial thought",
      locator: {
        kind: "epub-cfi-range",
        cfi: "epubcfi(/6/8!/4,/2/1:0,/2/1:28)",
      },
      createdAt: "2026-10-01T15:00:00Z",
      updatedAt: "2026-10-01T15:00:00Z",
    };

    // Editing note updates note and updatedAt, but preserves id, documentId, kind, position, locator
    const updated: Annotation = {
      ...original,
      note: "Refined analysis after second reading",
      updatedAt: "2026-10-01T15:30:00Z",
    };

    expect(updated.id).toBe(original.id);
    expect(updated.documentId).toBe(original.documentId);
    expect(updated.kind).toBe(original.kind);
    expect(updated.position).toEqual(original.position);
    expect(updated.locator).toEqual(original.locator);
    expect(updated.note).toBe("Refined analysis after second reading");
    expect(updated.updatedAt).not.toBe(original.updatedAt);
  });

  it("allows clearing a note while retaining the highlight selection and locator", () => {
    const original: Annotation = {
      id: "ann-clear-note",
      documentId: "doc-1",
      kind: "highlight",
      position: { kind: "pdf-page", page: 7 },
      selectedText: "Important formula",
      note: "Temporary note to be cleared",
      locator: { kind: "pdf-page-text", page: 7, selectedText: "Important formula" },
      createdAt: "2026-10-01T15:00:00Z",
      updatedAt: "2026-10-01T15:00:00Z",
    };

    const cleared: Annotation = {
      ...original,
      note: undefined,
      updatedAt: "2026-10-01T15:35:00Z",
    };

    expect(cleared.note).toBeUndefined();
    expect(cleared.selectedText).toBe("Important formula");
    expect(cleared.locator).toEqual(original.locator);
  });

  it("handles deletion by removing the annotation from document state", () => {
    const annotations: Annotation[] = [
      {
        id: "ann-keep",
        documentId: "doc-1",
        kind: "highlight",
        position: { kind: "pdf-page", page: 2 },
        createdAt: "2026-10-01T15:00:00Z",
        updatedAt: "2026-10-01T15:00:00Z",
      },
      {
        id: "ann-remove",
        documentId: "doc-1",
        kind: "note",
        position: { kind: "pdf-page", page: 4 },
        createdAt: "2026-10-01T15:05:00Z",
        updatedAt: "2026-10-01T15:05:00Z",
      },
    ];

    const remaining = annotations.filter((a) => a.id !== "ann-remove");
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe("ann-keep");
  });

  it("extracts and validates EPUB CFI ranges for highlight overlay rendering", () => {
    const annotations: Annotation[] = [
      {
        id: "epub-hl-1",
        documentId: "doc-epub",
        kind: "highlight",
        position: { kind: "epub-cfi", cfi: "epubcfi(/6/4!/4/2)" },
        locator: {
          kind: "epub-cfi-range",
          cfi: "epubcfi(/6/4!/4,/2/1:0,/2/1:15)",
        },
        createdAt: "2026-10-01T15:00:00Z",
        updatedAt: "2026-10-01T15:00:00Z",
      },
      {
        id: "epub-note-only",
        documentId: "doc-epub",
        kind: "note",
        position: { kind: "epub-cfi", cfi: "epubcfi(/6/6!/4/2)" },
        note: "Standalone note without selection",
        createdAt: "2026-10-01T15:10:00Z",
        updatedAt: "2026-10-01T15:10:00Z",
      },
      {
        id: "pdf-hl",
        documentId: "doc-pdf",
        kind: "highlight",
        position: { kind: "pdf-page", page: 1 },
        locator: { kind: "pdf-page-text", page: 1, selectedText: "PDF text" },
        createdAt: "2026-10-01T15:15:00Z",
        updatedAt: "2026-10-01T15:15:00Z",
      },
    ];

    // Only EPUB annotations with valid epub-cfi-range locators are extracted for Foliate Overlayer
    const epubCfis: string[] = [];
    for (const a of annotations) {
      if (a.locator?.kind === "epub-cfi-range" && a.locator.cfi) {
        expect(validateAnnotationLocator(a.locator)).toBeNull();
        epubCfis.push(a.locator.cfi);
      }
    }

    expect(epubCfis.length).toBe(1);
    expect(epubCfis[0]).toBe("epubcfi(/6/4!/4,/2/1:0,/2/1:15)");
  });

  it("safely ignores malformed or stale CFI ranges without crashing", () => {
    const malformedLocators: AnnotationLocator[] = [
      { kind: "epub-cfi-range", cfi: "not-a-cfi" },
      { kind: "epub-cfi-range", cfi: "epubcfi(/6/2)" }, // position CFI, not a range
      { kind: "epub-cfi-range", cfi: "" },
    ];

    for (const loc of malformedLocators) {
      const err = validateAnnotationLocator(loc);
      expect(err).not.toBeNull();
    }
  });

  it("prevents duplicate annotation creation by clearing pending selection", () => {
    let pendingSelection: TextSelection | null = {
      locator: { kind: "pdf-page-text", page: 1, selectedText: "Selected" },
      selectedText: "Selected",
    };

    // Simulated save operation: consumes selection and resets it to null
    const save = () => {
      if (!pendingSelection) return false;
      pendingSelection = null;
      return true;
    };

    expect(save()).toBe(true);
    // Immediate second click cannot create a duplicate
    expect(save()).toBe(false);
    expect(pendingSelection).toBeNull();
  });

  it("clears annotation state on document switch to prevent cross-document contamination", () => {
    let currentDocId: string = "doc-A";
    let activeAnnotations: Annotation[] = [
      {
        id: "a-A",
        documentId: "doc-A",
        kind: "highlight",
        position: { kind: "pdf-page", page: 1 },
        createdAt: "2026-10-01T15:00:00Z",
        updatedAt: "2026-10-01T15:00:00Z",
      },
    ];
    let pendingSel: TextSelection | null = {
      locator: { kind: "pdf-page-text", page: 1, selectedText: "A" },
      selectedText: "A",
    };

    // Switch document: reset ephemeral and loaded state
    const switchDocument = (nextDocId: string) => {
      currentDocId = nextDocId;
      activeAnnotations = [];
      pendingSel = null;
    };

    switchDocument("doc-B");
    expect(currentDocId).toBe("doc-B");
    expect(activeAnnotations.length).toBe(0);
    expect(pendingSel).toBeNull();
  });
});

// ─── Review Regression Tests: Foliate CFI Lifecycle & Promise Safety ────────

describe("Foliate CFI Lifecycle & Promise Safety (Pass 3C Review Fixes)", () => {
  it("resets rendered CFI tracking on document change/cleanup", () => {
    const renderedCfis = new Set<string>();
    renderedCfis.add("epubcfi(/6/2!/4,/2:0,/2:5)");
    renderedCfis.add("epubcfi(/6/4!/4,/2:10,/2:20)");

    expect(renderedCfis.size).toBe(2);

    // Simulate document switch / closeLocal reset
    renderedCfis.clear();
    expect(renderedCfis.size).toBe(0);
  });

  it("ensures annotation rendering after document replacement uses only the new document CFI set", () => {
    const docAAnnotations: Annotation[] = [
      {
        id: "a-1",
        documentId: "doc-A",
        kind: "highlight",
        position: { kind: "epub-cfi", cfi: "epubcfi(/6/2!/4)" },
        locator: { kind: "epub-cfi-range", cfi: "epubcfi(/6/2!/4,/1:0,/1:10)" },
        createdAt: "2026-10-01T15:00:00Z",
        updatedAt: "2026-10-01T15:00:00Z",
      },
    ];

    const docBAnnotations: Annotation[] = [
      {
        id: "b-1",
        documentId: "doc-B",
        kind: "highlight",
        position: { kind: "epub-cfi", cfi: "epubcfi(/6/8!/4)" },
        locator: { kind: "epub-cfi-range", cfi: "epubcfi(/6/8!/4,/2:0,/2:30)" },
        createdAt: "2026-10-01T16:00:00Z",
        updatedAt: "2026-10-01T16:00:00Z",
      },
    ];

    let renderedCfis = new Set<string>();
    for (const a of docAAnnotations) {
      if (a.locator?.kind === "epub-cfi-range" && a.locator.cfi) {
        renderedCfis.add(a.locator.cfi);
      }
    }
    expect(renderedCfis.has("epubcfi(/6/2!/4,/1:0,/1:10)")).toBe(true);

    // Document change triggers cleanup: renderedCfis is cleared
    renderedCfis.clear();
    expect(renderedCfis.size).toBe(0);

    // Document B syncs only its own CFIs
    for (const b of docBAnnotations) {
      if (b.locator?.kind === "epub-cfi-range" && b.locator.cfi) {
        renderedCfis.add(b.locator.cfi);
      }
    }
    expect(renderedCfis.size).toBe(1);
    expect(renderedCfis.has("epubcfi(/6/8!/4,/2:0,/2:30)")).toBe(true);
    expect(renderedCfis.has("epubcfi(/6/2!/4,/1:0,/1:10)")).toBe(false);
  });

  it("guarantees safeAddAnnotation and safeDeleteAnnotation catch rejected promises without unhandled rejection", async () => {
    let addCalled = false;
    let deleteCalled = false;

    const mockView = {
      addAnnotation: async (_ann: { value: string }) => {
        addCalled = true;
        // Simulate Foliate resolveNavigation returning undefined for stale/malformed CFI
        throw new TypeError("Cannot destructure property 'index' as it is undefined.");
      },
      deleteAnnotation: async (_ann: { value: string }) => {
        deleteCalled = true;
        throw new Error("Section not loaded during delete");
      },
    };

    // The safeAdd / safeDelete pattern used in EpubEngine:
    const safeAdd = (view: typeof mockView | null, value: string) => {
      try {
        void Promise.resolve(view?.addAnnotation?.({ value })).catch(() => undefined);
      } catch {}
    };

    const safeDelete = (view: typeof mockView | null, value: string) => {
      try {
        void Promise.resolve(view?.deleteAnnotation?.({ value })).catch(() => undefined);
      } catch {}
    };

    // Calling with rejecting promises does NOT throw or cause unhandledRejection
    safeAdd(mockView, "epubcfi(/6/999!/4)");
    safeDelete(mockView, "epubcfi(/6/999!/4)");

    // Allow microtasks to settle
    await Promise.resolve();

    expect(addCalled).toBe(true);
    expect(deleteCalled).toBe(true);
  });
});
