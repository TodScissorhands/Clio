import { useCallback, useEffect, useRef, useState } from "react";
import {
  addDocumentToCollection as addDocumentToCollectionCommand,
  addExternalDocumentToLibrary,
  addLibraryRoot,
  createCollection as createCollectionCommand,
  deleteCollection as deleteCollectionCommand,
  listCollections,
  listLibraryDocuments,
  listLibraryRoots,
  removeDocumentFromCollection as removeDocumentFromCollectionCommand,
  removeLibraryDocument,
  relinkLibraryDocument,
  renameCollection as renameCollectionCommand,
} from "../storage/documentStorage";
import type { Collection, LibraryRoot, StoredDocument } from "../storage/domain";
import type { LibraryCatalogLoadState } from "./libraryFilter";


export type LibraryCatalog = {
  roots: LibraryRoot[];
  documents: StoredDocument[];
  collections: Collection[];
  catalogLoadState: LibraryCatalogLoadState;
  retryCatalog: () => Promise<void>;
  refreshLibrary: (rootIds?: string[]) => Promise<void>;
  addRoot: (path: string) => Promise<LibraryRoot>;
  createCollection: (name: string) => Promise<Collection>;
  renameCollection: (id: string, name: string) => Promise<Collection>;
  deleteCollection: (id: string) => Promise<void>;
  addDocumentToCollection: (collectionId: string, documentId: string) => Promise<void>;
  removeDocumentFromCollection: (collectionId: string, documentId: string) => Promise<void>;
  removeDocument: (documentId: string) => Promise<void>;
  relinkDocument: (documentId: string, newPath: string) => Promise<StoredDocument>;
  addExternalDocument: (filePath: string) => Promise<StoredDocument>;
};

type UseLibraryCatalogOptions = {
  onError: (error: unknown) => void;
};

export function useLibraryCatalog({ onError }: UseLibraryCatalogOptions): LibraryCatalog {
  const mountedRef = useRef(false);
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);


  const [catalogLoadState, setCatalogLoadState] = useState<LibraryCatalogLoadState>("loading");

  const loadCatalog = useCallback(async (isCurrent: () => boolean = () => mountedRef.current) => {
    if (!isCurrent()) return;
    setCatalogLoadState("loading");
    try {
      const [nextRoots, nextDocuments, nextCollections] = await Promise.all([
        listLibraryRoots(),
        listLibraryDocuments(undefined, true),
        listCollections(),
      ]);
      if (!isCurrent()) return;
      setRoots(nextRoots);
      setDocuments(nextDocuments);
      setCollections(nextCollections);
      setCatalogLoadState("ready");
    } catch (error) {
      if (!isCurrent()) return;
      setCatalogLoadState("error");
      onError(error);
    }
  }, [onError]);

  const retryCatalog = useCallback(() => loadCatalog(), [loadCatalog]);

  const refreshLibrary = useCallback(async (rootIds?: string[]) => {
    if (!mountedRef.current) return;
    try {
      const [nextRoots, nextDocuments, nextCollections] = await Promise.all([
        listLibraryRoots(),
        rootIds?.length
          ? Promise.all(rootIds.map((rootId) => listLibraryDocuments(rootId, true))).then((byRoot) => byRoot.flat())
          : listLibraryDocuments(undefined, true),
        listCollections(),
      ]);
      if (!mountedRef.current) return;
      setRoots(nextRoots);
      if (rootIds?.length) {
        const updatedRootIds = new Set(rootIds);
        setDocuments((current) => [
          ...current.filter((document) => document.source.kind !== "library" || !updatedRootIds.has(document.source.rootId)),
          ...nextDocuments,
        ]);
      } else {
        setDocuments(nextDocuments);
      }
      setCollections(nextCollections);
    } catch (error) {
      if (!mountedRef.current) return;
      onError(error);
    }
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    void loadCatalog(() => !cancelled && mountedRef.current);
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [loadCatalog]);

  const addRoot = useCallback(async (path: string) => {
    const root = await addLibraryRoot(path);
    setRoots((current) => [...current.filter((item) => item.id !== root.id), root]);
    return root;
  }, []);

  const createCollection = useCallback(async (name: string) => {
    return createCollectionCommand(name);
  }, []);

  const renameCollection = useCallback(async (id: string, name: string) => {
    return renameCollectionCommand(id, name);
  }, []);

  const deleteCollection = useCallback(async (id: string) => {
    await deleteCollectionCommand(id);
  }, []);

  const addDocumentToCollection = useCallback(async (collectionId: string, documentId: string) => {
    await addDocumentToCollectionCommand(collectionId, documentId);
  }, []);

  const removeDocumentFromCollection = useCallback(async (collectionId: string, documentId: string) => {
    await removeDocumentFromCollectionCommand(collectionId, documentId);
  }, []);

  const removeDocument = useCallback(async (documentId: string) => {
    await removeLibraryDocument(documentId);
  }, []);

  const relinkDocument = useCallback(async (documentId: string, newPath: string) => {
    return relinkLibraryDocument(documentId, newPath);
  }, []);

  const addExternalDocument = useCallback(async (filePath: string) => {
    return addExternalDocumentToLibrary(filePath);
  }, []);

  return {
    roots,
    documents,
    collections,
    catalogLoadState,
    retryCatalog,
    refreshLibrary,
    addRoot,
    createCollection,
    renameCollection,
    deleteCollection,
    addDocumentToCollection,
    removeDocumentFromCollection,
    removeDocument,
    relinkDocument,
    addExternalDocument,
  };
}
