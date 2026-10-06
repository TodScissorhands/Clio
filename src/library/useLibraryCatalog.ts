import { useCallback, useEffect, useState } from "react";
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

export type LibraryCatalog = {
  roots: LibraryRoot[];
  documents: StoredDocument[];
  collections: Collection[];
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
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);

  const refreshLibrary = useCallback(async (rootIds?: string[]) => {
    try {
      const [nextRoots, nextDocuments, nextCollections] = await Promise.all([
        listLibraryRoots(),
        rootIds?.length
          ? Promise.all(rootIds.map((rootId) => listLibraryDocuments(rootId, true))).then((byRoot) => byRoot.flat())
          : listLibraryDocuments(undefined, true),
        listCollections(),
      ]);
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
      onError(error);
    }
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listLibraryRoots(), listLibraryDocuments(undefined, true), listCollections()])
      .then(([nextRoots, nextDocuments, nextCollections]) => {
        if (cancelled) return;
        setRoots(nextRoots);
        setDocuments(nextDocuments);
        setCollections(nextCollections);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [onError]);

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

