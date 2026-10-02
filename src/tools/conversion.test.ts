import { describe, expect, it } from "bun:test";
import {
  engineLabel,
  formatDetail,
  formatLabel,
  FORMAT_META,
  type ConversionCapability,
  type ConversionJob,
  type JobStatus,
  type OperationKind,
} from "./conversion";

describe("Conversion Capability Architecture — Domain Types & Helpers", () => {
  it("formats format labels and details consistently", () => {
    expect(formatLabel("pdf")).toBe("PDF");
    expect(formatLabel(".md")).toBe("Markdown");
    expect(formatLabel("EPUB")).toBe("EPUB");
    expect(formatLabel("xyz")).toBe("XYZ");

    expect(formatDetail("epub")).toBe("E-reader book");
    expect(formatDetail(".docx")).toBe("Word document");
    expect(formatDetail("unknown")).toBe("Document format");
  });

  it("maps engine labels accurately to human-readable names", () => {
    expect(engineLabel("poppler")).toBe("Poppler (pdftotext)");
    expect(engineLabel("pandoc")).toBe("Pandoc");
    expect(engineLabel("poppler-pandoc")).toBe("Poppler + Pandoc");
  });

  it("contains metadata for all core document formats", () => {
    const core = ["pdf", "epub", "docx", "odt", "html", "md", "txt"];
    for (const fmt of core) {
      expect(FORMAT_META[fmt]).toBeDefined();
      expect(FORMAT_META[fmt].label.length).toBeGreaterThan(0);
      expect(FORMAT_META[fmt].detail.length).toBeGreaterThan(0);
    }
  });

  it("models a planned conversion job with valid state transitions", () => {
    const plannedJob: ConversionJob = {
      id: "job-1",
      sourcePath: "/path/to/doc.pdf",
      sourceFormat: "pdf",
      targetFormat: "txt",
      outputPath: "/path/to/doc.txt",
      operation: "extract-text",
      engine: "poppler",
      status: "planned",
      error: null,
      createdAt: "2026-10-02T10:00:00Z",
      completedAt: null,
    };

    expect(plannedJob.status).toBe("planned" satisfies JobStatus);
    expect(plannedJob.operation).toBe("extract-text");
    expect(plannedJob.engine).toBe("poppler");

    // Transition to completed
    const completedJob: ConversionJob = {
      ...plannedJob,
      status: "completed",
      completedAt: "2026-10-02T10:00:02Z",
    };
    expect(completedJob.status).toBe("completed");
    expect(completedJob.completedAt).not.toBeNull();

    // Transition to failed
    const failedJob: ConversionJob = {
      ...plannedJob,
      status: "failed",
      error: "pdftotext execution failed",
      completedAt: "2026-10-02T10:00:01Z",
    };
    expect(failedJob.status).toBe("failed");
    expect(failedJob.error).toBe("pdftotext execution failed");
  });

  it("models conversion capabilities accurately without phantom all-to-all claims", () => {
    const pdfToTxtCapability: ConversionCapability = {
      sourceFormat: "pdf",
      targetFormat: "txt",
      operation: "extract-text",
      engine: "poppler",
      label: "Text Extraction (Poppler)",
      description: "Extract plain text content from PDF document",
    };

    expect(pdfToTxtCapability.operation).toBe("extract-text");
    expect(pdfToTxtCapability.engine).toBe("poppler");

    const mdToDocxCapability: ConversionCapability = {
      sourceFormat: "md",
      targetFormat: "docx",
      operation: "convert",
      engine: "pandoc",
      label: "Pandoc",
      description: "Convert md to docx format",
    };

    expect(mdToDocxCapability.operation).toBe("convert");
    expect(mdToDocxCapability.engine).toBe("pandoc");
  });

  it("models a multi-source PDF merge job with deterministic input ordering", () => {
    const mergeJob: ConversionJob = {
      id: "merge-job-1",
      sourcePath: "/docs/intro.pdf",
      sourcePaths: ["/docs/intro.pdf", "/docs/body.pdf", "/docs/appendix.pdf"],
      sourceFormat: "pdf",
      targetFormat: "pdf",
      outputPath: "/docs/final-merged.pdf",
      operation: "merge-pdf",
      engine: "poppler",
      status: "planned",
      error: null,
      createdAt: "2026-10-02T12:00:00Z",
      completedAt: null,
    };

    expect(mergeJob.operation).toBe("merge-pdf");
    expect(mergeJob.sourcePaths?.length).toBe(3);
    expect(mergeJob.sourcePaths?.[0]).toBe("/docs/intro.pdf");
    expect(mergeJob.sourcePaths?.[1]).toBe("/docs/body.pdf");
    expect(mergeJob.sourcePaths?.[2]).toBe("/docs/appendix.pdf");
    expect(mergeJob.outputPath).toBe("/docs/final-merged.pdf");
  });

  it("validates that merge requires at least 2 input files", () => {
    const validateInputs = (inputs: string[]): boolean => inputs.length >= 2;

    expect(validateInputs([])).toBe(false);
    expect(validateInputs(["/docs/single.pdf"])).toBe(false);
    expect(validateInputs(["/docs/first.pdf", "/docs/second.pdf"])).toBe(true);
    expect(validateInputs(["/docs/1.pdf", "/docs/2.pdf", "/docs/3.pdf"])).toBe(true);
  });

  it("supports reordering of inputs while preserving exact deterministic order", () => {
    const inputs = ["p1.pdf", "p2.pdf", "p3.pdf"];

    // Move index 2 up
    const moveUp = (arr: string[], index: number): string[] => {
      if (index <= 0) return arr;
      const next = [...arr];
      const temp = next[index - 1];
      next[index - 1] = next[index];
      next[index] = temp;
      return next;
    };

    const reordered = moveUp(inputs, 2);
    expect(reordered).toEqual(["p1.pdf", "p3.pdf", "p2.pdf"]);
  });
});

describe("PDF Page Extraction — Types & Validation Logic", () => {
  it("accepts extract-pages as a valid OperationKind", () => {
    const op: OperationKind = "extract-pages";
    expect(op).toBe("extract-pages");
  });

  it("models an extract-pages job with pageSelection", () => {
    const job: ConversionJob = {
      id: "extract-1",
      sourcePath: "/docs/book.pdf",
      sourcePaths: ["/docs/book.pdf"],
      sourceFormat: "pdf",
      targetFormat: "pdf",
      outputPath: "/docs/book-extracted.pdf",
      operation: "extract-pages",
      engine: "poppler",
      status: "planned",
      error: null,
      createdAt: "2026-10-02T14:00:00Z",
      completedAt: null,
      pageSelection: [1, 3, 5],
    };

    expect(job.operation).toBe("extract-pages");
    expect(job.pageSelection).toEqual([1, 3, 5]);
    expect(job.sourceFormat).toBe("pdf");
    expect(job.targetFormat).toBe("pdf");
    expect(job.status).toBe("planned" satisfies JobStatus);
  });

  it("allows pageSelection to be absent (null/undefined) for non-extract jobs", () => {
    const job: ConversionJob = {
      id: "convert-1",
      sourcePath: "/docs/book.pdf",
      sourceFormat: "pdf",
      targetFormat: "txt",
      outputPath: "/docs/book.txt",
      operation: "extract-text",
      engine: "poppler",
      status: "planned",
      error: null,
      createdAt: "2026-10-02T14:00:00Z",
      completedAt: null,
    };

    expect(job.pageSelection).toBeUndefined();
  });

  it("extract-pages capability has correct shape", () => {
    const cap: ConversionCapability = {
      sourceFormat: "pdf",
      targetFormat: "pdf",
      operation: "extract-pages",
      engine: "poppler",
      label: "PDF Page Extraction (Poppler)",
      description: "Extract page range or selection into a new PDF",
    };

    expect(cap.operation).toBe("extract-pages");
    expect(cap.sourceFormat).toBe(cap.targetFormat); // pdf → pdf
  });

  it("validates page-selection input patterns purely in frontend logic", () => {
    // Mirrors parse_page_selection contract, testable without backend
    function validateRangeString(input: string): { valid: boolean; reason?: string } {
      const trimmed = input.trim();
      if (!trimmed) return { valid: false, reason: "Empty input" };
      const parts = trimmed.split(",");
      for (const raw of parts) {
        const part = raw.trim();
        if (!part) return { valid: false, reason: "Consecutive or trailing comma" };
        if (part.includes("-")) {
          if (part.startsWith("-") || part.endsWith("-"))
            return { valid: false, reason: "Leading/trailing dash" };
          const [a, b] = part.split("-").map(Number);
          if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0)
            return { valid: false, reason: "Non-positive page number" };
          if (a > b) return { valid: false, reason: "Start > end in range" };
        } else {
          const n = Number(part);
          if (!Number.isInteger(n) || n <= 0)
            return { valid: false, reason: "Non-positive or non-integer page" };
        }
      }
      return { valid: true };
    }

    // Valid inputs
    expect(validateRangeString("1").valid).toBe(true);
    expect(validateRangeString("1-3").valid).toBe(true);
    expect(validateRangeString("1-3,7,10-12").valid).toBe(true);
    expect(validateRangeString("5,2,8").valid).toBe(true);
    expect(validateRangeString(" 1-3 , 5 ").valid).toBe(true);

    // Invalid inputs
    expect(validateRangeString("").valid).toBe(false);
    expect(validateRangeString("  ").valid).toBe(false);
    expect(validateRangeString("0").valid).toBe(false);
    expect(validateRangeString("-1").valid).toBe(false);
    expect(validateRangeString("1,").valid).toBe(false);
    expect(validateRangeString(",1").valid).toBe(false);
    expect(validateRangeString("5-3").valid).toBe(false); // reversed range
    expect(validateRangeString("1-").valid).toBe(false);
    expect(validateRangeString("abc").valid).toBe(false);
  });
});
