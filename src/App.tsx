import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ReaderShell } from "./reader/ReaderShell";
import type { ReaderDocument } from "./reader/types";
import {
  addDocumentToCollection,
  addLibraryRoot,
  createCollection,
  deleteCollection,
  getLibraryDocumentPath,
  listCollections,
  listLibraryDocuments,
  listLibraryRoots,
  openLibraryReaderDocument,
  openSelectedReaderDocument,
  removeLibraryDocument,
  removeLibraryRoot,
  renameCollection,
  scanLibraryRoot,
  TauriDocumentStorage,
  type LibraryScanResult,
} from "./storage/documentStorage";
import {
  isReaderFormat,
  type Collection,
  type LibraryRoot,
  type StoredDocument,
} from "./storage/domain";
import { LibraryView } from "./library/LibraryView";
import type {
  AppRoute,
  LibraryRestorationState,
  LibraryScope,
} from "./navigation/navigation";
import { DEFAULT_LIBRARY_SCOPE } from "./navigation/navigation";
import type { SortOption } from "./library/libraryFilter";
import "./App.css";

const readerFileFilters = [
  { name: "Readable documents", extensions: ["pdf", "epub", "txt", "md", "markdown"] },
];
const storage = new TauriDocumentStorage();

type AppTheme = "system" | "light" | "dark";

function scanMessage(result: LibraryScanResult): string {
  const summary = `Scanned ${result.scanned} file${result.scanned === 1 ? "" : "s"}; ${result.inserted} added, ${result.updated} updated, ${result.missing} missing.`;
  return result.errors.length ? `${summary} ${result.errors.join(" ")}` : summary;
}

function App() {
  // Navigation Route & History Stack
  const [route, setRoute] = useState<AppRoute>({
    kind: "library",
    scope: DEFAULT_LIBRARY_SCOPE,
  });
  const [historyStack, setHistoryStack] = useState<LibraryRestorationState[]>([]);

  // Active Reader Document
  const [readerDocument, setReaderDocument] = useState<ReaderDocument | null>(null);
  const [readerOpenError, setReaderOpenError] = useState("");

  // Library State
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [libraryScope, setLibraryScope] = useState<LibraryScope>(DEFAULT_LIBRARY_SCOPE);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [scrollAnchorId, setScrollAnchorId] = useState<string | null>(null);

  // Status & Diagnostics
  const [libraryMessage, setLibraryMessage] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const [libraryPending, setLibraryPending] = useState(false);
  const [readerPending, setReaderPending] = useState(false);
  const [pendingRootId, setPendingRootId] = useState<string | null>(null);

  // App Theme & App Menu
  const [appTheme, setAppTheme] = useState<AppTheme>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("clio-app-theme");
        if (saved === "light" || saved === "dark" || saved === "system") {
          return saved;
        }
      } catch {
        // ignore
      }
    }
    return "system";
  });

  const [isAppMenuOpen, setIsAppMenuOpen] = useState(false);

  function handleThemeChange(nextTheme: AppTheme) {
    setAppTheme(nextTheme);
    try {
      localStorage.setItem("clio-app-theme", nextTheme);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    const root = document.documentElement;
    if (appTheme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", appTheme);
    }
  }, [appTheme]);

  // Load Library Data
  async function refreshLibrary(rootId?: string | null) {
    try {
      const [nextRoots, nextDocuments, nextCollections] = await Promise.all([
        listLibraryRoots(),
        listLibraryDocuments(rootId ?? undefined, true),
        listCollections(),
      ]);
      setRoots(nextRoots);
      setDocuments(nextDocuments);
      setCollections(nextCollections);
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    }
  }

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
        if (!cancelled) setLibraryError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Collection CRUD
  async function handleCreateCollection(name: string) {
    try {
      await createCollection(name);
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
      if (libraryScope.kind === "collection" && libraryScope.collectionId === id) {
        setLibraryScope({ kind: "all" });
      }
      await refreshLibrary();
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAddDocToCollection(collectionId: string, documentIds: string[]) {
    try {
      for (const docId of documentIds) {
        await addDocumentToCollection(collectionId, docId);
      }
      await refreshLibrary();
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRemoveFromLibrary(documentIds: string[]) {
    try {
      for (const id of documentIds) {
        await removeLibraryDocument(id);
      }
      await refreshLibrary();
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRevealInFileManager(doc: StoredDocument) {
    try {
      const path = await getLibraryDocumentPath(doc.record.id);
      await revealItemInDir(path);
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    }
  }

  // Root Directory Operations
  async function addRoot() {
    setLibraryError("");
    const path = await open({ multiple: false, directory: true });
    if (!path || Array.isArray(path)) return;
    setLibraryPending(true);
    try {
      const root = await addLibraryRoot(path);
      setRoots((current) => [...current.filter((item) => item.id !== root.id), root]);
      setLibraryScope({ kind: "root", rootId: root.id });
      await refreshLibrary();
      setLibraryMessage(`Added “${root.label}”. Scan it when you are ready.`);
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
      await refreshLibrary();
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
      if (
        (libraryScope.kind === "root" && libraryScope.rootId === rootId) ||
        (libraryScope.kind === "folder" && libraryScope.rootId === rootId)
      ) {
        setLibraryScope({ kind: "all" });
      }
      await refreshLibrary();
      setLibraryMessage("Library directory removed.");
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      setLibraryPending(false);
    }
  }

  // Document Navigation: Open & Back
  async function handleOpenDocument(doc: StoredDocument) {
    if (doc.availability !== "present") {
      setLibraryError("This document is missing from its library directory.");
      return;
    }
    if (!isReaderFormat(doc.record.format)) {
      setLibraryError(
        `Clio Reader cannot open .${doc.record.format || "unknown"} files directly. Use Convert to read in Clio.`
      );
      return;
    }

    // Save current library restoration state
    const restorationState: LibraryRestorationState = {
      scope: libraryScope,
      viewMode,
      searchQuery,
      selectedDocIds: Array.from(selectedDocIds),
      scrollAnchorId: doc.record.id,
      sortBy,
    };
    setHistoryStack((prev) => [...prev, restorationState]);
    setScrollAnchorId(doc.record.id);

    setLibraryPending(true);
    setReaderOpenError("");
    try {
      const nextDoc = await openLibraryReaderDocument(doc.record.id, storage);
      setReaderDocument(nextDoc);
      setRoute({ kind: "document", documentId: doc.record.id });
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    } finally {
      setLibraryPending(false);
    }
  }

  async function handleBackFromReader() {
    const previousState = historyStack[historyStack.length - 1];
    if (previousState) {
      setLibraryScope(previousState.scope);
      setViewMode(previousState.viewMode);
      setSearchQuery(previousState.searchQuery);
      setSelectedDocIds(new Set(previousState.selectedDocIds));
      setSortBy(previousState.sortBy);
      setScrollAnchorId(previousState.scrollAnchorId);
      setHistoryStack((prev) => prev.slice(0, -1));
      setRoute({ kind: "library", scope: previousState.scope });
    } else {
      setRoute({ kind: "library", scope: DEFAULT_LIBRARY_SCOPE });
    }

    // Refresh library so any flushed reading state is immediately reflected in Continue
    await refreshLibrary();
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
      setRoute({ kind: "document", documentId: nextDocument.record.id });
    } catch (error) {
      setReaderOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setReaderPending(false);
    }
  }

  return (
    <div className="app-frame clio-app">
      {route.kind === "library" ? (
        <LibraryView
          roots={roots}
          documents={documents}
          collections={collections}
          activeScope={libraryScope}
          onSelectScope={setLibraryScope}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          selectedDocIds={selectedDocIds}
          onSelectionChange={setSelectedDocIds}
          sortBy={sortBy}
          onSortChange={setSortBy}
          pending={libraryPending}
          pendingRootId={pendingRootId}
          message={libraryMessage}
          error={libraryError}
          onAddRoot={() => void addRoot()}
          onScanRoot={(rootId) => void scanRoot(rootId)}
          onRemoveRoot={(rootId) => void removeRoot(rootId)}
          onCreateCollection={handleCreateCollection}
          onRenameCollection={handleRenameCollection}
          onDeleteCollection={handleDeleteCollection}
          onAddDocToCollection={handleAddDocToCollection}
          onRemoveFromLibrary={handleRemoveFromLibrary}
          onOpenDocument={(doc) => void handleOpenDocument(doc)}
          onRevealInFileManager={handleRevealInFileManager}
          scrollAnchorId={scrollAnchorId}
          onUpdateScrollAnchor={setScrollAnchorId}
        />
      ) : (
        <div className="document-reading-surface">
          {readerOpenError && (
            <div className="reader-open-error-wrap">
              <p className="reader-open-error" role="alert">
                {readerOpenError}
              </p>
            </div>
          )}
          <ReaderShell
            document={readerDocument}
            onBack={() => void handleBackFromReader()}
            onOpen={() => void chooseReaderDocument()}
            openDisabled={libraryPending || readerPending}
          />
        </div>
      )}

      {/* App Menu Modal / Popover */}
      {isAppMenuOpen && (
        <div
          className="context-menu-backdrop"
          onClick={() => setIsAppMenuOpen(false)}
          onContextMenu={(e) => {
            e.preventDefault();
            setIsAppMenuOpen(false);
          }}
        >
          <div
            className="app-menu-popover"
            onClick={(e) => e.stopPropagation()}
            role="menu"
            aria-label="Application options"
          >
            <div className="app-menu-header">
              <strong>Clio</strong>
            </div>

            <div className="app-menu-section">
              <span className="app-menu-label">Appearance</span>
              <div className="theme-switcher mini" role="radiogroup" aria-label="Theme">
                <button
                  type="button"
                  className={`theme-btn ${appTheme === "system" ? "selected" : ""}`}
                  onClick={() => handleThemeChange("system")}
                >
                  System
                </button>
                <button
                  type="button"
                  className={`theme-btn ${appTheme === "light" ? "selected" : ""}`}
                  onClick={() => handleThemeChange("light")}
                >
                  Light
                </button>
                <button
                  type="button"
                  className={`theme-btn ${appTheme === "dark" ? "selected" : ""}`}
                  onClick={() => handleThemeChange("dark")}
                >
                  Dark
                </button>
              </div>
            </div>

            <div className="app-menu-divider" role="separator" />

            <button
              type="button"
              className="context-menu-item"
              onClick={() => {
                setIsAppMenuOpen(false);
                void chooseReaderDocument();
              }}
            >
              Open external document…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
