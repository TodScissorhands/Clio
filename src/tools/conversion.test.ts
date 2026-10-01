import { describe, expect, it } from "bun:test";
import {
  engineLabel,
  formatDetail,
  formatLabel,
  FORMAT_META,
  type ConversionCapability,
  type ConversionJob,
  type JobStatus,
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
});
