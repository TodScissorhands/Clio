/**
 * D3 Selection Commands Tests
 *
 * Tests for:
 * - getSelectionCapabilities with zero, one, and multiple selected documents
 * - Capability filtering by format and availability
 * - Merge PDF eligibility (all PDFs, mixed, missing docs)
 * - Extract pages PDF-only constraint
 * - Add to collection always available when something is selected
 * - Remove always available when something is selected
 * - Properties only for single doc
 * - Open only for single readable present doc
 * - canMergeSelected re-export
 */

import { describe, expect, it } from "bun:test";
import { getSelectionCapabilities, canMergeSelected } from "./selectionCommands";
import type { StoredDocument } from "../storage/domain";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeDoc(id: string, format: string, availability: "present" | "missing" = "present"): StoredDocument {
  return {
    record: {
      id,
      name: `${id}.${format}`,
      format: format as StoredDocument["record"]["format"],
      sizeBytes: 1000,
      firstSeenAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    source: { kind: "library", rootId: "r1", relativePath: `${id}.${format}` },
    availability,
  };
}

const pdf1 = makeDoc("pdf-1", "pdf");
const pdf2 = makeDoc("pdf-2", "pdf");
const pdf3 = makeDoc("pdf-3", "pdf");
const epub1 = makeDoc("epub-1", "epub");
const txt1 = makeDoc("txt-1", "txt");
const docx1 = makeDoc("docx-1", "docx");
const missingPdf = makeDoc("missing-pdf", "pdf", "missing");

// ── Empty selection ───────────────────────────────────────────────────────────

describe("getSelectionCapabilities — empty selection", () => {
  const caps = getSelectionCapabilities([]);

  it("canOpen is false", () => expect(caps.canOpen).toBe(false));
  it("canConvert is false", () => expect(caps.canConvert).toBe(false));
  it("canExtractPages is false", () => expect(caps.canExtractPages).toBe(false));
  it("canViewProperties is false", () => expect(caps.canViewProperties).toBe(false));
  it("canReveal is false", () => expect(caps.canReveal).toBe(false));
  it("canAddToCollection is false", () => expect(caps.canAddToCollection).toBe(false));
  it("canMergePdfs is false", () => expect(caps.canMergePdfs).toBe(false));
  it("canRemove is false", () => expect(caps.canRemove).toBe(false));
});

// ── Single PDF ────────────────────────────────────────────────────────────────

describe("getSelectionCapabilities — single present PDF", () => {
  const caps = getSelectionCapabilities([pdf1]);

  it("canOpen is true (PDF is readable)", () => expect(caps.canOpen).toBe(true));
  it("canConvert is true (PDF has convert capability)", () => expect(caps.canConvert).toBe(true));
  it("canExtractPages is true (PDF only)", () => expect(caps.canExtractPages).toBe(true));
  it("canViewProperties is true", () => expect(caps.canViewProperties).toBe(true));
  it("canReveal is true (library source)", () => expect(caps.canReveal).toBe(true));
  it("canAddToCollection is true", () => expect(caps.canAddToCollection).toBe(true));
  it("canMergePdfs is false (requires ≥ 2)", () => expect(caps.canMergePdfs).toBe(false));
  it("canRemove is true", () => expect(caps.canRemove).toBe(true));
});

// ── Single EPUB ───────────────────────────────────────────────────────────────

describe("getSelectionCapabilities — single present EPUB", () => {
  const caps = getSelectionCapabilities([epub1]);

  it("canOpen is true (EPUB is readable)", () => expect(caps.canOpen).toBe(true));
  it("canConvert is true (EPUB has convert capability)", () => expect(caps.canConvert).toBe(true));
  it("canExtractPages is false (PDF only)", () => expect(caps.canExtractPages).toBe(false));
  it("canViewProperties is true", () => expect(caps.canViewProperties).toBe(true));
  it("canMergePdfs is false", () => expect(caps.canMergePdfs).toBe(false));
});

// ── Single TXT ────────────────────────────────────────────────────────────────

describe("getSelectionCapabilities — single TXT", () => {
  const caps = getSelectionCapabilities([txt1]);

  it("canOpen is true (TXT is readable)", () => expect(caps.canOpen).toBe(true));
  it("canConvert is true", () => expect(caps.canConvert).toBe(true));
  it("canExtractPages is false", () => expect(caps.canExtractPages).toBe(false));
});

// ── Single DOCX (non-readable) ────────────────────────────────────────────────

describe("getSelectionCapabilities — single DOCX (not directly readable)", () => {
  const caps = getSelectionCapabilities([docx1]);

  it("canOpen is false (DOCX not in FORMAT_CAPABILITIES read set)", () => expect(caps.canOpen).toBe(false));
  it("canConvert is true (DOCX supports convert)", () => expect(caps.canConvert).toBe(true));
  it("canExtractPages is false", () => expect(caps.canExtractPages).toBe(false));
  it("canViewProperties is true (properties always available for single doc)", () => expect(caps.canViewProperties).toBe(true));
  it("canAddToCollection is true", () => expect(caps.canAddToCollection).toBe(true));
  it("canRemove is true", () => expect(caps.canRemove).toBe(true));
});

// ── Single missing PDF ────────────────────────────────────────────────────────

describe("getSelectionCapabilities — single missing PDF", () => {
  const caps = getSelectionCapabilities([missingPdf]);

  it("canOpen is false (missing document)", () => expect(caps.canOpen).toBe(false));
  it("canConvert is false (missing)", () => expect(caps.canConvert).toBe(false));
  it("canExtractPages is false (missing)", () => expect(caps.canExtractPages).toBe(false));
  it("canViewProperties is true (properties shows catalog metadata even for missing)", () => expect(caps.canViewProperties).toBe(true));
  it("canRemove is true (can remove missing docs from catalog)", () => expect(caps.canRemove).toBe(true));
});

// ── Two PDFs ──────────────────────────────────────────────────────────────────

describe("getSelectionCapabilities — two present PDFs", () => {
  const caps = getSelectionCapabilities([pdf1, pdf2]);

  it("canOpen is false (multi-selection)", () => expect(caps.canOpen).toBe(false));
  it("canConvert is false (multi-selection, no single target)", () => expect(caps.canConvert).toBe(false));
  it("canExtractPages is false (multi-selection)", () => expect(caps.canExtractPages).toBe(false));
  it("canViewProperties is false (multi-selection)", () => expect(caps.canViewProperties).toBe(false));
  it("canMergePdfs is true (2+ present PDFs)", () => expect(caps.canMergePdfs).toBe(true));
  it("canAddToCollection is true", () => expect(caps.canAddToCollection).toBe(true));
  it("canRemove is true", () => expect(caps.canRemove).toBe(true));
});

// ── Three PDFs ────────────────────────────────────────────────────────────────

describe("getSelectionCapabilities — three PDFs", () => {
  const caps = getSelectionCapabilities([pdf1, pdf2, pdf3]);
  it("canMergePdfs is true (3 present PDFs)", () => expect(caps.canMergePdfs).toBe(true));
});

// ── Mixed formats ─────────────────────────────────────────────────────────────

describe("getSelectionCapabilities — mixed PDF + EPUB", () => {
  const caps = getSelectionCapabilities([pdf1, epub1]);

  it("canMergePdfs is false (not all PDFs)", () => expect(caps.canMergePdfs).toBe(false));
  it("canAddToCollection is true", () => expect(caps.canAddToCollection).toBe(true));
  it("canRemove is true", () => expect(caps.canRemove).toBe(true));
  it("canOpen is false (multi-selection)", () => expect(caps.canOpen).toBe(false));
  it("canViewProperties is false (multi-selection)", () => expect(caps.canViewProperties).toBe(false));
});

// ── PDF + missing PDF ─────────────────────────────────────────────────────────

describe("getSelectionCapabilities — one present PDF + one missing PDF", () => {
  const caps = getSelectionCapabilities([pdf1, missingPdf]);

  it("canMergePdfs is false (missing doc blocks merge)", () => expect(caps.canMergePdfs).toBe(false));
  it("canRemove is true", () => expect(caps.canRemove).toBe(true));
});

// ── canMergeSelected boundary cases ──────────────────────────────────────────

describe("canMergeSelected", () => {
  it("returns false for empty array", () => expect(canMergeSelected([])).toBe(false));
  it("returns false for single PDF", () => expect(canMergeSelected([pdf1])).toBe(false));
  it("returns true for two present PDFs", () => expect(canMergeSelected([pdf1, pdf2])).toBe(true));
  it("returns true for three present PDFs", () => expect(canMergeSelected([pdf1, pdf2, pdf3])).toBe(true));
  it("returns false when any doc is non-PDF", () => expect(canMergeSelected([pdf1, epub1])).toBe(false));
  it("returns false when any doc is missing", () => expect(canMergeSelected([pdf1, missingPdf])).toBe(false));
  it("returns false for two missing PDFs", () => expect(canMergeSelected([missingPdf, { ...missingPdf, record: { ...missingPdf.record, id: "m2" } }])).toBe(false));
});

// ── canReveal source-kind check ───────────────────────────────────────────────

describe("getSelectionCapabilities — canReveal source kind", () => {
  it("is true for library source", () => {
    const caps = getSelectionCapabilities([pdf1]); // pdf1 has source.kind === "library"
    expect(caps.canReveal).toBe(true);
  });

  it("is false for direct (non-library) source", () => {
    const directDoc: StoredDocument = {
      ...pdf1,
      record: { ...pdf1.record, id: "direct-pdf" },
      source: { kind: "direct", locator: { kind: "path", path: "/tmp/doc.pdf" } as never },
    };
    const caps = getSelectionCapabilities([directDoc]);
    expect(caps.canReveal).toBe(false);
  });
});
