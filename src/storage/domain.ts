export type DocumentId = string;

export type FormatId =
  | "pdf"
  | "epub"
  | "docx"
  | "odt"
  | "rtf"
  | "html"
  | "md"
  | "txt";

export type StorageLocator = {
  kind: "desktop-token" | "android-content-uri" | "ios-security-scoped" | "managed-copy";
  value: string;
  access: "session" | "persistent";
};

export type SourceRef =
  | { kind: "library"; rootId: string; relativePath: string }
  | { kind: "direct"; locator: StorageLocator };

export type MetadataProvenance = "embedded" | "fallback";

export type DocumentMetadata = {
  title?: string | null;
  authors: string[];
  publisher?: string | null;
  publishedDate?: string | null;
  description?: string | null;
  language?: string | null;
  identifiers: string[];
  provenance: MetadataProvenance;
  thumbnailPath?: string | null;
};

export type CollectionId = string;

export type Collection = {
  id: CollectionId;
  name: string;
  description?: string | null;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type DocumentRecord = {
  id: DocumentId;
  name: string;
  format: FormatId;
  sizeBytes: number;
  firstSeenAt: string;
  updatedAt: string;
  metadata?: DocumentMetadata | null;
  collections?: string[];
};

export function getDocumentDisplayTitle(record: DocumentRecord): string {
  if (record.metadata?.title && record.metadata.title.trim().length > 0) {
    return record.metadata.title.trim();
  }
  return record.name;
}

export type StoredDocument = {
  record: DocumentRecord;
  source: SourceRef;
  availability: "present" | "missing";
  readingState?: ReadingState | null;
};

export type LibraryRoot = {
  id: string;
  label: string;
  kind: "filesystem-directory";
  status: "active" | "missing" | "disabled";
  createdAt: string;
  updatedAt: string;
};

export type ReadingPosition =
  | { kind: "pdf-page"; page: number; progression?: number }
  | { kind: "epub-cfi"; cfi: string; progression?: number }
  | { kind: "text-scroll"; progression: number };
export type ReadingState = {
  documentId: DocumentId;
  position: ReadingPosition;
  lastOpenedAt: string;
  updatedAt: string;
};

export type Bookmark = {
  id: string;
  documentId: DocumentId;
  position: ReadingPosition;
  title?: string;
  createdAt: string;
  updatedAt: string;
};

export type AnnotationKind = "highlight" | "note";

export type Annotation = {
  id: string;
  documentId: DocumentId;
  kind: AnnotationKind;
  position: ReadingPosition;
  selectedText?: string;
  note?: string;
  locator?: AnnotationLocator;
  createdAt: string;
  updatedAt: string;
};

/**
 * A durable range locator for an annotation.
 *
 * epub-cfi-range: A CFI range string produced by foliate-js getCFI(index, Range).
 *   Format: epubcfi(/6/4!/4,/2/1:0,/2/1:5)  — start and end offsets encoded.
 *   Fits in the existing `cfi` column; stored verbatim.
 *
 * pdf-page-text: Page number + selected text only.
 *   NOTE: This is NOT a durable locator. The PDF text layer (DOM overlay) is
 *   not yet implemented. Page + selectedText is stored for display purposes
 *   only. Highlight restoration is not possible until TextLayer rendering is
 *   added in a future milestone.
 */
export type AnnotationLocator =
  | {
      kind: "epub-cfi-range";
      /** Full CFI range string, e.g. epubcfi(/6/4!/4,/2/1:0,/2/1:5) */
      cfi: string;
    }
  | {
      kind: "pdf-page-text";
      /** 1-based page number where the selection occurred */
      page: number;
      /**
       * Selected text for display only. NOT a durable locator.
       * Highlight restoration requires a future TextLayer implementation.
       */
      selectedText: string;
    };

/** Validates an AnnotationLocator and returns an error string or null. */
export function validateAnnotationLocator(locator: AnnotationLocator): string | null {
  // Runtime guard: tolerate bad inputs from JSON.parse or untrusted sources.
  if (locator == null || typeof locator !== "object") return "Annotation locator must be an object.";
  if (locator.kind === "epub-cfi-range") {
    const cfi = typeof locator.cfi === "string" ? locator.cfi.trim() : "";
    if (!cfi) return "EPUB annotation locator requires a non-empty CFI.";
    if (!cfi.startsWith("epubcfi(") || !cfi.endsWith(")")) {
      return "EPUB annotation locator CFI must be wrapped in epubcfi(...).";
    }
    const inner = cfi.slice("epubcfi(".length, -1);
    const [start, end] = inner.split(",", 2);
    if (!start?.trim() || !end?.trim()) {
      return "EPUB annotation locator CFI must be a range CFI (epubcfi with start,end).";
    }
    return null;
  }
  if (locator.kind === "pdf-page-text") {
    if (!Number.isInteger(locator.page) || locator.page < 1) return "PDF annotation locator page must be an integer >= 1.";
    if (!locator.selectedText || !locator.selectedText.trim()) return "PDF annotation locator requires non-empty selectedText.";
    return null;
  }
  return "Unknown annotation locator kind.";
}

/**
 * Format-neutral text selection emitted by a reader engine after the user
 * selects text. Engines translate their native selection mechanisms into this
 * type and call onTextSelection. No DOM objects, Blob URLs, or iframe
 * references cross this boundary.
 *
 * selectedText is non-empty user-visible text (display/fallback only).
 * locator is the durable (or best-available) range representation.
 */
export type TextSelection = {
  locator: AnnotationLocator;
  selectedText: string;
};

export function isSameReadingPosition(a?: ReadingPosition, b?: ReadingPosition): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "pdf-page" && b.kind === "pdf-page") {
    return a.page === b.page;
  }
  if (a.kind === "epub-cfi" && b.kind === "epub-cfi") {
    return a.cfi === b.cfi;
  }
  if (a.kind === "text-scroll" && b.kind === "text-scroll") {
    return Math.abs(a.progression - b.progression) < 0.02;
  }
  return false;
}

/** Format values are normalized once, at the native DTO boundary. */
export function normalizeFormat(value: unknown): FormatId {
  const normalized = typeof value === "string" ? value.toLowerCase().replace(/^\./, "").trim() : "";
  if (normalized === "htm") return "html";
  if (normalized === "markdown") return "md";
  return normalized as FormatId;
}

export function isReaderFormat(format: FormatId): format is "pdf" | "epub" | "txt" | "md" {
  return format === "pdf" || format === "epub" || format === "txt" || format === "md";
}

export type DocumentCapability =
  | "read"
  | "search"
  | "toc"
  | "textSelection"
  | "annotations"
  | "bookmarks"
  | "thumbnail"
  | "metadata"
  | "convert"
  | "extractText";

export const FORMAT_CAPABILITIES: Record<FormatId, readonly DocumentCapability[]> = {
  pdf: [
    "read",
    "search",
    "toc",
    "textSelection",
    "annotations",
    "bookmarks",
    "thumbnail",
    "metadata",
    "convert",
    "extractText",
  ],
  epub: [
    "read",
    "search",
    "toc",
    "textSelection",
    "annotations",
    "bookmarks",
    "thumbnail",
    "metadata",
    "convert",
  ],
  txt: ["read", "search", "textSelection", "bookmarks", "metadata", "convert"],
  md: ["read", "search", "toc", "textSelection", "bookmarks", "metadata", "convert"],
  docx: ["metadata", "thumbnail", "convert"],
  odt: ["metadata", "thumbnail", "convert"],
  rtf: ["metadata", "convert"],
  html: ["metadata", "convert"],
};

export function hasCapability(format: FormatId, capability: DocumentCapability): boolean {
  return FORMAT_CAPABILITIES[format]?.includes(capability) ?? false;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
