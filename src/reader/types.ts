import type { ComponentType, RefObject } from "react";
import type { ReadingPosition, TextSelection } from "../storage/domain";

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

export type ReaderFormat = "pdf" | "epub";
export type ReaderTheme = "light" | "sepia" | "dark";

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
  initialPosition?: ReadingPosition;
  hostRef?: RefObject<HTMLDivElement | null>;
  onProgress(progress: ReaderProgress): void;
  onPositionChange?(position: ReadingPosition): void;
  onZoomChange?(zoomPercent: number): void;
  onToc(items: ReaderTocItem[]): void;
  onState(state: "loading" | "ready" | "error", message?: string): void;
  onTextSelection?(selection: TextSelection): void;
};

export type ReaderEngineComponent = ComponentType<ReaderEngineProps & {
  engineRef: RefObject<ReaderEngineHandle | null>;
}>;
