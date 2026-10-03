import { invoke } from "@tauri-apps/api/core";
import type { ReaderDocument, ReaderDocumentRecord } from "../reader/types";
import {
  isReaderFormat,
  normalizeFormat,
  validateAnnotationLocator,
  type Annotation,
  type AnnotationKind,
  type AnnotationLocator,
  type Bookmark,
  type Collection,
  type DocumentId,
  type DocumentMetadata,
  type DocumentRecord,
  type LibraryRoot,
  type ReadingPosition,
  type ReadingState,
  type SourceRef,
  type StorageLocator,
  type StoredDocument,
} from "./domain";

export type LibraryScanResult = {
  rootId: string;
  scanned: number;
  inserted: number;
  added: number;
  updated: number;
  missing: number;
  errors: string[];
};

type NativeScanError = {
  path?: string;
  message?: string;
};

type NativeScanResult = {
  rootId?: string;
  scanned?: number;
  inserted?: number;
  added?: number;
  updated?: number;
  missing?: number;
  errors?: Array<NativeScanError | string>;
};
type NativeRoot = {
  id: string;
  label: string;
  kind: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type NativeDocument = {
  id?: string;
  name?: string;
  format?: string;
  extension?: string;
  sizeBytes?: number;
  size?: number;
  firstSeenAt?: string;
  updatedAt?: string;
  source?: SourceRef;
  rootId?: string;
  relativePath?: string;
  availability?: string;
  record?: NativeDocument;
  metadata?: DocumentMetadata | null;
  collections?: string[];
  readingState?: ReadingState | null;
  reading_state?: ReadingState | null;
};
type NativeReaderOpen = {
  record: NativeDocument;
  source?: SourceRef;
  locator?: StorageLocator;
  token?: string;
  document?: NativeDocument;
};

export interface DocumentStorage {
  open(locator: StorageLocator): Promise<Blob>;
}

export class TauriDocumentStorage implements DocumentStorage {
  async open(locator: StorageLocator): Promise<Blob> {
    if (locator.kind !== "desktop-token") {
      throw new Error(`Storage source ${locator.kind} is not available on this platform yet.`);
    }

    const bytes = await invoke<number[]>("read_document_bytes", { token: locator.value });
    return new Blob([Uint8Array.from(bytes)]);
  }
}


function nativeRecord(native: NativeDocument, fallback?: NativeDocument): DocumentRecord {
  const value = native.record ?? native;
  const source = fallback ?? native;
  const timestamp = new Date().toISOString();
  return {
    id: value.id ?? source.id ?? crypto.randomUUID(),
    name: value.name ?? source.name ?? "Untitled document",
    format: normalizeFormat(value.format ?? value.extension ?? source.format ?? source.extension),
    sizeBytes: Number(value.sizeBytes ?? value.size ?? source.sizeBytes ?? source.size ?? 0),
    firstSeenAt: value.firstSeenAt ?? timestamp,
    updatedAt: value.updatedAt ?? timestamp,
    metadata: value.metadata ?? source.metadata ?? null,
    collections: value.collections ?? source.collections ?? [],
  };
}

function nativeSource(native: NativeDocument, fallbackRootId?: string): SourceRef {
  const source = (native.source ?? native.record?.source) as Record<string, unknown> | undefined;
  if (source?.kind === "library") {
    const rootId = (source.rootId ?? source.root_id ?? native.rootId ?? native.record?.rootId ?? fallbackRootId) as string | undefined;
    const relativePath = (source.relativePath ?? source.relative_path ?? native.relativePath ?? native.record?.relativePath) as string | undefined;
    if (rootId && relativePath) {
      return { kind: "library", rootId, relativePath };
    }
  }
  if (source?.kind === "direct" && source.locator) {
    return { kind: "direct", locator: source.locator as StorageLocator };
  }
  const rootId = (native.rootId ?? native.record?.rootId ?? fallbackRootId) as string | undefined;
  const relativePath = (native.relativePath ?? native.record?.relativePath) as string | undefined;
  if (!rootId || !relativePath) {
    throw new Error("Library document response did not include a safe library source.");
  }
  return { kind: "library", rootId, relativePath };
}
function normalizeRoot(native: NativeRoot): LibraryRoot {
  return {
    id: native.id,
    label: native.label,
    kind: "filesystem-directory",
    status: native.status === "missing" || native.status === "disabled" ? native.status : "active",
    createdAt: native.createdAt,
    updatedAt: native.updatedAt,
  };
}

function normalizeStoredDocument(native: NativeDocument, rootId?: string): StoredDocument {
  const readingState = (native.readingState ?? native.reading_state ?? null) as ReadingState | null;
  return {
    record: nativeRecord(native),
    source: nativeSource(native, rootId),
    availability: native.availability === "missing" ? "missing" : "present",
    readingState,
  };
}

function normalizeScanResult(value: NativeScanResult | null | undefined): LibraryScanResult {
  return {
    rootId: value?.rootId ?? "",
    scanned: Number(value?.scanned ?? 0),
    inserted: Number(value?.inserted ?? value?.added ?? 0),
    added: Number(value?.added ?? value?.inserted ?? 0),
    updated: Number(value?.updated ?? 0),
    missing: Number(value?.missing ?? 0),
    errors: Array.isArray(value?.errors)
      ? value.errors.map((error) =>
          typeof error === "string"
            ? error
            : error && typeof error === "object" && typeof error.message === "string"
              ? error.message
              : "A document could not be indexed."
        )
      : [],
  };
}

function readerLocator(opened: NativeReaderOpen): StorageLocator {
  if (opened.locator) return opened.locator;
  if (opened.token) return { kind: "desktop-token", value: opened.token, access: "session" };
  throw new Error("Reader response did not include an authorized storage locator.");
}

function readerDocument(record: DocumentRecord, locator: StorageLocator, storage: DocumentStorage): Promise<ReaderDocument> {
  const format = isReaderFormat(record.format) ? record.format : null;
  if (!format) {
    throw new Error(`Clio Reader cannot open .${record.format || "unknown"} files. Supported: PDF, EPUB, TXT, Markdown.`);
  }
  const readerRecord: ReaderDocumentRecord = {
    id: record.id,
    name: record.name,
    format,
    size: record.sizeBytes,
  };
  return storage.open(locator).then((bytes) => ({ record: readerRecord, bytes }));
}

export async function listLibraryRoots(): Promise<LibraryRoot[]> {
  const roots = await invoke<NativeRoot[]>("library_root_list");
  return roots.map(normalizeRoot);
}

export async function addLibraryRoot(path: string, label?: string): Promise<LibraryRoot> {
  const root = await invoke<NativeRoot>("library_root_add", { path, label: label ?? null });
  return normalizeRoot(root);
}

export async function removeLibraryRoot(rootId: string): Promise<void> {
  await invoke("library_root_remove", { rootId });
}

export async function scanLibraryRoot(rootId: string): Promise<LibraryScanResult> {
  const result = await invoke<NativeScanResult>("library_root_scan", { rootId });
  return normalizeScanResult(result);
}

export async function listLibraryDocuments(rootId?: string, includeMissing = true): Promise<StoredDocument[]> {
  const documents = await invoke<NativeDocument[]>("library_document_list", {
    rootId: rootId ?? null,
    includeMissing,
  });
  return documents.map((document) => normalizeStoredDocument(document, rootId));
}

export async function removeLibraryDocument(documentId: DocumentId): Promise<void> {
  await invoke("library_document_remove", { documentId });
}

export async function relinkLibraryDocument(documentId: DocumentId, newPath: string): Promise<StoredDocument> {
  const doc = await invoke<NativeDocument>("library_document_relink", { documentId, newPath });
  return normalizeStoredDocument(doc);
}

export async function addExternalDocumentToLibrary(filePath: string): Promise<StoredDocument> {
  const doc = await invoke<NativeDocument>("library_document_add_external", { filePath });
  return normalizeStoredDocument(doc);
}

export async function getLibraryDocumentPath(documentId: DocumentId): Promise<string> {
  return invoke<string>("library_document_path", { documentId });
}

export async function openLibraryReaderDocument(documentId: DocumentId, storage: DocumentStorage): Promise<ReaderDocument> {
  const authorization = await invoke<NativeReaderOpen>("library_document_open", { documentId });
  return readerDocument(nativeRecord(authorization.record), readerLocator(authorization), storage);
}

export async function openSelectedReaderDocument(path: string, storage: DocumentStorage): Promise<ReaderDocument> {
  const authorization = await invoke<NativeReaderOpen>("reader_open_selected", { path });
  return readerDocument(nativeRecord(authorization.record), readerLocator(authorization), storage);
}


export async function getReadingState(documentId: DocumentId): Promise<ReadingState | null> {
  return invoke<ReadingState | null>("reading_state_get", { documentId });
}

export async function setReadingState(state: ReadingState): Promise<void> {
  await invoke("reading_state_set", { state });
}

export async function listReadingStates(): Promise<ReadingState[]> {
  return invoke<ReadingState[]>("reading_state_list");
}

export async function createBookmark(
  documentId: DocumentId,
  position: ReadingPosition,
  title?: string
): Promise<Bookmark> {
  return invoke<Bookmark>("bookmark_create", {
    documentId,
    position,
    title: title ?? null,
  });
}

export async function listBookmarks(documentId: DocumentId): Promise<Bookmark[]> {
  return invoke<Bookmark[]>("bookmark_list", { documentId });
}

export async function deleteBookmark(bookmarkId: string): Promise<void> {
  await invoke("bookmark_delete", { bookmarkId });
}

type NativeAnnotationDto = {
  id: string;
  documentId: string;
  kind: string;
  position: ReadingPosition;
  selectedText?: string | null;
  note?: string | null;
  locator?: string | null;
  createdAt: string;
  updatedAt: string;
};

function deserializeAnnotation(native: NativeAnnotationDto): Annotation {
  let locator: AnnotationLocator | undefined;
  if (native.locator) {
    try {
      const parsed: unknown = JSON.parse(native.locator);
      if (
        parsed &&
        typeof parsed === "object" &&
        validateAnnotationLocator(parsed as AnnotationLocator) === null
      ) {
        locator = parsed as AnnotationLocator;
      }
    } catch {
      // Malformed persisted locator data must not silently become a valid locator
      locator = undefined;
    }
  }

  return {
    id: native.id,
    documentId: native.documentId,
    kind: native.kind as AnnotationKind,
    position: native.position,
    selectedText: native.selectedText ?? undefined,
    note: native.note ?? undefined,
    locator,
    createdAt: native.createdAt,
    updatedAt: native.updatedAt,
  };
}

export async function createAnnotation(
  documentId: DocumentId,
  kind: AnnotationKind,
  position: ReadingPosition,
  selectedText?: string,
  note?: string,
  locator?: AnnotationLocator
): Promise<Annotation> {
  const locatorJson = locator ? JSON.stringify(locator) : null;
  const native = await invoke<NativeAnnotationDto>("annotation_create", {
    documentId,
    kind,
    position,
    selectedText: selectedText ?? null,
    note: note ?? null,
    locator: locatorJson,
  });
  return deserializeAnnotation(native);
}
export async function updateAnnotation(
  annotationId: string,
  note?: string
): Promise<Annotation> {
  const native = await invoke<NativeAnnotationDto>("annotation_update", {
    annotationId,
    note: note ?? null,
  });
  return deserializeAnnotation(native);
}

export async function listAnnotations(documentId: DocumentId): Promise<Annotation[]> {
  const list = await invoke<NativeAnnotationDto[]>("annotation_list", { documentId });
  return list.map(deserializeAnnotation);
}

export async function deleteAnnotation(annotationId: string): Promise<void> {
  await invoke("annotation_delete", { annotationId });
}

export async function listCollections(): Promise<Collection[]> {
  return invoke<Collection[]>("library_collection_list");
}

export async function createCollection(name: string, description?: string): Promise<Collection> {
  return invoke<Collection>("library_collection_create", {
    name,
    description: description ?? null,
  });
}

export async function renameCollection(id: string, name: string): Promise<Collection> {
  return invoke<Collection>("library_collection_rename", { id, name });
}

export async function deleteCollection(id: string): Promise<void> {
  await invoke("library_collection_delete", { id });
}

export async function addDocumentToCollection(
  collectionId: string,
  documentId: string
): Promise<void> {
  await invoke("library_collection_add_document", { collectionId, documentId });
}

export async function removeDocumentFromCollection(
  collectionId: string,
  documentId: string
): Promise<void> {
  await invoke("library_collection_remove_document", { collectionId, documentId });
}

export async function listCollectionDocuments(collectionId: string): Promise<StoredDocument[]> {
  const documents = await invoke<NativeDocument[]>("library_collection_list_documents", {
    collectionId,
  });
  return documents.map((document) => normalizeStoredDocument(document));
}

export async function getDocumentThumbnail(documentId: string): Promise<string | null> {
  return invoke<string | null>("library_thumbnail_get", { documentId });
}
