import { invoke } from "@tauri-apps/api/core";

export type OperationKind = "convert" | "extract-text" | "merge-pdf" | "extract-pages";

export type ConversionEngine = "poppler" | "pandoc" | "poppler-pandoc";

export type ConversionCapability = {
  sourceFormat: string;
  targetFormat: string;
  operation: OperationKind;
  engine: ConversionEngine;
  label: string;
  description: string;
};

export type JobStatus = "planned" | "running" | "completed" | "failed";

export type ConversionJob = {
  id: string;
  sourcePath: string;
  sourcePaths?: string[];
  sourceFormat: string;
  targetFormat: string;
  outputPath: string;
  operation: OperationKind;
  engine: ConversionEngine;
  status: JobStatus;
  error?: string | null;
  createdAt: string;
  completedAt?: string | null;
  pageSelection?: number[] | null;
};

export type ConversionResult = {
  outputPath: string;
  engine: string;
};

export const FORMAT_META: Record<string, { label: string; detail: string }> = {
  pdf: { label: "PDF", detail: "Portable document" },
  epub: { label: "EPUB", detail: "E-reader book" },
  docx: { label: "DOCX", detail: "Word document" },
  odt: { label: "ODT", detail: "OpenDocument text" },
  html: { label: "HTML", detail: "Web page" },
  md: { label: "Markdown", detail: "Plain text markup" },
  txt: { label: "Plain text", detail: "Clean plain text" },
};

export const ENGINE_LABELS: Record<ConversionEngine, string> = {
  poppler: "Poppler (pdftotext)",
  pandoc: "Pandoc",
  "poppler-pandoc": "Poppler + Pandoc",
};

export function formatLabel(format: string): string {
  const norm = format.toLowerCase().replace(/^\./, "");
  return FORMAT_META[norm]?.label ?? norm.toUpperCase();
}

export function formatDetail(format: string): string {
  const norm = format.toLowerCase().replace(/^\./, "");
  return FORMAT_META[norm]?.detail ?? "Document format";
}

export function engineLabel(engine: ConversionEngine): string {
  return ENGINE_LABELS[engine] ?? engine;
}

export async function listConversionCapabilities(
  sourceFormat?: string
): Promise<ConversionCapability[]> {
  return invoke<ConversionCapability[]>("conversion_capabilities", {
    sourceFormat: sourceFormat ? sourceFormat.toLowerCase().replace(/^\./, "") : null,
  });
}

export async function planConversionJob(
  sourcePath: string,
  targetFormat: string,
  outputPath?: string
): Promise<ConversionJob> {
  return invoke<ConversionJob>("conversion_plan_job", {
    sourcePath,
    targetFormat: targetFormat.toLowerCase().replace(/^\./, ""),
    outputPath: outputPath ?? null,
  });
}

export async function planMergeJob(
  sourcePaths: string[],
  outputPath?: string
): Promise<ConversionJob> {
  return invoke<ConversionJob>("conversion_plan_merge_job", {
    sourcePaths,
    outputPath: outputPath ?? null,
  });
}

export async function executeConversionJob(job: ConversionJob): Promise<ConversionJob> {
  return invoke<ConversionJob>("conversion_execute_job", { job });
}

export async function getPdfPageCount(sourcePath: string): Promise<number> {
  return invoke<number>("conversion_pdf_page_count", { sourcePath });
}

export async function parsePagesFromRange(
  sourcePath: string,
  rangeString: string
): Promise<number[]> {
  return invoke<number[]>("conversion_parse_page_selection", {
    sourcePath,
    rangeString,
  });
}

export async function planExtractPagesJob(
  sourcePath: string,
  pageSelection: number[],
  outputPath?: string
): Promise<ConversionJob> {
  return invoke<ConversionJob>("conversion_plan_extract_pages_job", {
    sourcePath,
    pageSelection,
    outputPath: outputPath ?? null,
  });
}

export async function convertDocument(
  inputPath: string,
  outputPath: string,
  outputFormat: string
): Promise<ConversionResult> {
  return invoke<ConversionResult>("convert_document", {
    inputPath,
    outputPath,
    outputFormat: outputFormat.toLowerCase().replace(/^\./, ""),
  });
}
