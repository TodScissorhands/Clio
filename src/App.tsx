import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ReaderShell } from "./reader/ReaderShell";
import type { ReaderDocument } from "./reader/types";
import {
  addDocumentToCollection,
  addLibraryRoot,
  createCollection,
  deleteCollection,
  getReadingState,
  listCollections,
  listLibraryDocuments,
  listLibraryRoots,
  openLibraryReaderDocument,
  openSelectedReaderDocument,
  removeDocumentFromCollection,
  removeLibraryRoot,
  renameCollection,
  scanLibraryRoot,
  TauriDocumentStorage,
  type LibraryScanResult,
} from "./storage/documentStorage";
import { isReaderFormat, type Collection, type LibraryRoot, type ReadingState, type StoredDocument } from "./storage/domain";
import { LibraryView } from "./library/LibraryView";
import { ConversionWorkspace } from "./tools/ConversionWorkspace";
import "./App.css";

type AppView = "library" | "reader" | "tools" | "settings";

const readerFileFilters = [{ name: "Readable documents", extensions: ["pdf", "epub"] }];
const storage = new TauriDocumentStorage();

function PlaceholderView({ title, description, action }: { title: string; description: string; action?: ReactNode }) {

  return (
    <section className="placeholder-view">
      <p className="eyebrow">Clio workspace</p>
      <h1>{title}</h1>
      <p>{description}</p>
      {action}
    </section>
  );
}

function scanMessage(result: LibraryScanResult): string {
  const summary = `Scanned ${result.scanned} file${result.scanned === 1 ? "" : "s"}; ${result.inserted} added, ${result.updated} updated, ${result.missing} missing.`;
  return result.errors.length ? `${summary} ${result.errors.join(" ")}` : summary;
}


function App() {
  const [view, setView] = useState<AppView>("library");
  const [readerDocument, setReaderDocument] = useState<ReaderDocument | null>(null);
  const [readerOpenError, setReaderOpenError] = useState("");
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  const [readingStates, setReadingStates] = useState<Record<string, ReadingState>>({});
  const [libraryMessage, setLibraryMessage] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const [libraryPending, setLibraryPending] = useState(false);
  const [readerPending, setReaderPending] = useState(false);
  const [pendingRootId, setPendingRootId] = useState<string | null>(null);
  async function loadReadingStatesForDocs(docs: StoredDocument[]) {
    const entries = await Promise.all(
      docs.map(async (doc) => {
        try {
          const state = await getReadingState(doc.record.id);
          return state ? ([doc.record.id, state] as const) : null;
        } catch {
          return null;
        }
      })
    );
    const map: Record<string, ReadingState> = {};
    for (const entry of entries) {
      if (entry) map[entry[0]] = entry[1];
    }
    setReadingStates(map);
  }

  async function refreshLibrary(rootId = selectedRootId) {
    const [nextRoots, nextDocuments, nextCollections] = await Promise.all([
      listLibraryRoots(),
      listLibraryDocuments(rootId ?? undefined, true),
      listCollections(),
    ]);
    setRoots(nextRoots);
    setDocuments(nextDocuments);
    setCollections(nextCollections);
    void loadReadingStatesForDocs(nextDocuments);
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([listLibraryRoots(), listLibraryDocuments(undefined, true), listCollections()])
      .then(([nextRoots, nextDocuments, nextCollections]) => {
        if (cancelled) return;
        setRoots(nextRoots);
        setDocuments(nextDocuments);
        setCollections(nextCollections);
        void loadReadingStatesForDocs(nextDocuments);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLibraryError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (view === "library") {
      void refreshLibrary();
    }
  }, [view]);

  async function handleCreateCollection(name: string, description?: string) {
    try {
      await createCollection(name, description);
      await refreshLibrary();
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRenameCollection(id: string, name: string) {
    try {
      await renameCollection(id, name);
      await refreshLibrary();
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDeleteCollection(id: string) {
    try {
      await deleteCollection(id);
      await refreshLibrary();
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAddDocToCollection(collectionId: string, documentId: string) {
    try {
      await addDocumentToCollection(collectionId, documentId);
      await refreshLibrary();
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRemoveDocFromCollection(collectionId: string, documentId: string) {
    try {
      await removeDocumentFromCollection(collectionId, documentId);
      await refreshLibrary();
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    }
  }

  async function chooseReaderDocument() {
    if (libraryPending || readerPending) return;
    setReaderOpenError("");
    const path = await open({ multiple: false, directory: false, filters: readerFileFilters });
    if (!path || Array.isArray(path)) return;

    setReaderPending(true);
    try {
      const nextDocument = await openSelectedReaderDocument(path, storage);
      setReaderDocument(nextDocument);
      setView("reader");
    } catch (error) {
      setReaderOpenError(error instanceof Error ? error.message : String(error));
      setView("reader");
    } finally {
      setReaderPending(false);
    }
  }

  async function addRoot() {
    setLibraryError("");
    const path = await open({ multiple: false, directory: true });
    if (!path || Array.isArray(path)) return;
    setLibraryPending(true);
    try {
      const root = await addLibraryRoot(path);
      setRoots((current) => [...current.filter((item) => item.id !== root.id), root]);
      setSelectedRootId(root.id);
      const nextDocs = await listLibraryDocuments(root.id, true);
      setDocuments(nextDocs);
      void loadReadingStatesForDocs(nextDocs);
      setLibraryMessage(`Added “${root.label}”. Scan it when you are ready.`);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      setLibraryPending(false);
    }
  }

  async function selectRoot(rootId: string | null) {
    setSelectedRootId(rootId);
    setLibraryError("");
    setLibraryPending(true);
    try {
      const nextDocs = await listLibraryDocuments(rootId ?? undefined, true);
      setDocuments(nextDocs);
      void loadReadingStatesForDocs(nextDocs);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      setLibraryPending(false);
    }
  }

  async function scanRoot(rootId: string) {
    setLibraryError("");
    setLibraryMessage("Scanning directory…");
    setLibraryPending(true);
    setPendingRootId(rootId);
    try {
      const result = await scanLibraryRoot(rootId);
      await refreshLibrary(rootId === selectedRootId ? rootId : selectedRootId);
      setLibraryMessage(scanMessage(result));
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingRootId(null);
      setLibraryPending(false);
    }
  }

  async function removeRoot(rootId: string) {
    setLibraryError("");
    setLibraryPending(true);
    try {
      await removeLibraryRoot(rootId);
      const nextSelection = selectedRootId === rootId ? null : selectedRootId;
      setSelectedRootId(nextSelection);
      await refreshLibrary(nextSelection);
      setLibraryMessage("Library directory removed.");
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      setLibraryPending(false);
    }
  }

  async function openLibraryDocument(document: StoredDocument) {
    setReaderOpenError("");
    setLibraryError("");
    if (document.availability !== "present") {
      setReaderOpenError("This document is missing from its library directory.");
      setView("reader");
      return;
    }
    if (!isReaderFormat(document.record.format)) {
      setReaderOpenError(`Clio Reader cannot open .${document.record.format || "unknown"} files. PDF and EPUB are supported.`);
      setView("reader");
      return;
    }
    setLibraryPending(true);
    try {
      setReaderDocument(await openLibraryReaderDocument(document.record.id, storage));
      setView("reader");
    } catch (error) {
      setReaderOpenError(error instanceof Error ? error.message : String(error));
      setView("reader");
    } finally {
      setLibraryPending(false);
    }
  }

  return (
    <div className="app-frame">
      <header className="app-topbar">
        <button className="app-brand" onClick={() => setView("library")} aria-label="Open Clio library"><span className="brand-mark">C</span><span>Clio</span></button>
        <nav className="primary-nav" aria-label="Primary navigation">
          <button className={view === "library" ? "active" : ""} onClick={() => setView("library")}>Library</button>
          <button className={view === "reader" ? "active" : ""} onClick={() => setView("reader")}>Reader</button>
          <button className={view === "tools" ? "active" : ""} onClick={() => setView("tools")}>Tools</button>
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>Settings</button>
        </nav>
        <div className="topbar-note"><span className="status-dot" />Local-first</div>
      </header>

      <main className="app-content">
        {view === "library" && (
          <LibraryView
            roots={roots}
            documents={documents}
            collections={collections}
            readingStates={readingStates}
            selectedRootId={selectedRootId}
            pending={libraryPending}
            pendingRootId={pendingRootId}
            message={libraryMessage}
            error={libraryError}
            onAddRoot={() => void addRoot()}
            onSelectRoot={(rootId) => void selectRoot(rootId)}
            onCreateCollection={handleCreateCollection}
            onRenameCollection={handleRenameCollection}
            onDeleteCollection={handleDeleteCollection}
            onAddDocToCollection={handleAddDocToCollection}
            onRemoveDocFromCollection={handleRemoveDocFromCollection}
            onScan={(rootId) => void scanRoot(rootId)}
            onRemove={(rootId) => void removeRoot(rootId)}
            onOpen={(document) => void openLibraryDocument(document)}
          />
        )}
        {view === "reader" && <><div className="reader-open-error-wrap">{readerOpenError && <p className="reader-open-error" role="alert">{readerOpenError}</p>}</div><ReaderShell document={readerDocument} onOpen={() => void chooseReaderDocument()} openDisabled={libraryPending || readerPending} /></>}
        {view === "tools" && <ConversionWorkspace />}
        {view === "settings" && <PlaceholderView title="Settings will stay local." description="Reader preferences, storage permissions, and application behavior will live here as Clio grows." />}
      </main>
      <footer className="app-footer"><span>Clio · local document workbench</span><span>Files stay in directories you control</span></footer>
    </div>
  );
}

export default App;
