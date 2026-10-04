import type { ComponentType, RefObject } from "react";
import type { Annotation, ReadingPosition, TextSelection } from "../storage/domain";

export type {
  Annotation,
  AnnotationKind,
  AnnotationLocator,
  Bookmark,
  DocumentId,
  DocumentRecord,
  FormatId,
  LibraryRoot,
  ReadingPosition,
  ReadingState,
  SourceRef,
  StorageLocator,
  StoredDocument,
  TextSelection,
} from "../storage/domain";
export { isSameReadingPosition, validateAnnotationLocator } from "../storage/domain";

export type ReaderFormat = "pdf" | "epub" | "txt" | "md";
export type ReaderTheme = "light" | "sepia" | "dark";
export type ReaderFontFamily = "book" | "serif" | "sans" | "mono";
export type ReaderLineHeight = "book" | "1.4" | "1.6" | "1.8" | "2";
export type ReaderParagraphSpacing = "book" | "0.5" | "1" | "1.5";
export type ReaderContentWidth = "narrow" | "default" | "wide";

export type ReaderDisplaySettings = {
  fontFamily: ReaderFontFamily;
  fontSize: number;
  lineHeight: ReaderLineHeight;
  paragraphSpacing: ReaderParagraphSpacing;
  contentWidth: ReaderContentWidth;
};

export const DEFAULT_READER_DISPLAY_SETTINGS: ReaderDisplaySettings = {
  fontFamily: "book",
  fontSize: 100,
  lineHeight: "book",
  paragraphSpacing: "book",
  contentWidth: "default",
};



export type ReaderDocumentRecord = {
  id: string;
  name: string;
  format: ReaderFormat;
  size: number;
};

export type ReaderDocument = {
  record: ReaderDocumentRecord;
  bytes: Blob;
};

export type ReaderProgress = {
  current: number;
  total?: number;
  fraction?: number;
  label?: string;
};

export type ReaderTocItem = {
  id: string;
  label: string;
  href?: string;
  children?: ReaderTocItem[];
};

export type ReaderSearchResult = {
  count: number;
  currentIndex?: number;
  label: string;
};

export type ReaderEngineHandle = {
  previous(): void | Promise<void>;
  next(): void | Promise<void>;
  zoomIn(): void | Promise<void>;
  zoomOut(): void | Promise<void>;
  resetZoom?(): void | Promise<void>;
  search(query: string): Promise<ReaderSearchResult>;
  nextSearchResult?(): Promise<ReaderSearchResult>;
  previousSearchResult?(): Promise<ReaderSearchResult>;
  clearSearch?(): void | Promise<void>;
  goToToc(item: ReaderTocItem): void | Promise<void>;
  goToPosition?(position: ReadingPosition): void | Promise<void>;
};

export type ReaderEngineProps = {
  document: ReaderDocument;
  theme: ReaderTheme;
  displaySettings: ReaderDisplaySettings;
  onDisplayFontSizeChange?(direction: -1 | 0 | 1): void;
  initialPosition?: ReadingPosition;
  hostRef?: RefObject<HTMLDivElement | null>;
  onProgress(progress: ReaderProgress): void;
  onPositionChange?(position: ReadingPosition): void;
  onZoomChange?(zoomPercent: number): void;
  onToc(items: ReaderTocItem[]): void;
  onState(state: "loading" | "ready" | "error", message?: string): void;
  onTextSelection?(selection: TextSelection): void;
  annotations?: Annotation[];
};

export type ReaderEngineComponent = ComponentType<ReaderEngineProps & {
  engineRef: RefObject<ReaderEngineHandle | null>;
}>;
