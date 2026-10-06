import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { ConversionWorkspace } from "./tools/ConversionWorkspace";
import { ReaderShell } from "./reader/ReaderShell";
import type { ReaderDocument } from "./reader/types";
import { UnsupportedFormatModal } from "./library/UnsupportedFormatModal";
import { MissingDocumentModal } from "./library/MissingDocumentModal";
import { KeyboardShortcutsModal } from "./library/KeyboardShortcutsModal";
import { AboutClioModal } from "./library/AboutClioModal";
import { QuickOpenDialog } from "./library/QuickOpenDialog";
import {
  getLibraryDocumentPath,
  openLibraryReaderDocument,
  openSelectedReaderDocument,
  removeLibraryRoot,
  scanLibraryFolder,
  scanLibraryRoot,
  TauriDocumentStorage,
  type LibraryScanResult,
} from "./storage/documentStorage";
import { isReaderFormat, type StoredDocument } from "./storage/domain";
import { useLibraryCatalog } from "./library/useLibraryCatalog";
import { LibraryView } from "./library/LibraryView";
import type {
  AppRoute,
  LibraryRestorationState,
  LibraryScope,
} from "./navigation/navigation";
import { DEFAULT_LIBRARY_SCOPE } from "./navigation/navigation";
import {
  createNavigationHistory,
  isEditableTarget,
  moveNavigationHistory,
  pushNavigationHistory,
  replaceCurrentNavigationEntry,
} from "./navigation/navigation";
import { findSpatialNeighbor } from "./navigation/libraryKeyboard";
import type { SortOption } from "./library/libraryFilter";
import "./App.css";

const readerFileFilters = [
  { name: "Readable documents", extensions: ["pdf", "epub", "txt", "md", "markdown"] },
];

interface LibraryNavigationTiming {
  key: string;
  startedAt: number;
  dispatchAt: number;
  resolutionMs: number;
}
const storage = new TauriDocumentStorage();

type AppTheme = "system" | "light" | "dark";

function scanMessage(result: LibraryScanResult): string {
  const summary = `Scanned ${result.scanned} file${result.scanned === 1 ? "" : "s"}; ${result.inserted} added, ${result.updated} updated, ${result.missing} missing.`;
  return result.errors.length ? `${summary} ${result.errors.join(" ")}` : summary;
}

function App() {
  // Navigation Route and session history (Library locations only).
  const [route, setRoute] = useState<AppRoute>({
    kind: "library",
    scope: DEFAULT_LIBRARY_SCOPE,
  });
  const [navigationHistory, setNavigationHistory] = useState(() => createNavigationHistory({
    scope: DEFAULT_LIBRARY_SCOPE,
    viewMode: "grid",
    searchQuery: "",
    selectedDocIds: [],
    scrollAnchorId: null,
    sortBy: "recent",
  }));
  const searchQueryRef = useRef("");
  const searchEditSessionRef = useRef(false);

  // Active Reader Document
  const [readerDocument, setReaderDocument] = useState<ReaderDocument | null>(null);
  const [readerOpenError, setReaderOpenError] = useState("");
  /** Contextual conversion/extraction triggered from the reader. */
  const [conversionTarget, setConversionTarget] = useState<{
    doc: StoredDocument;
    mode: "convert" | "extract";
  } | null>(null);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [externalPath, setExternalPath] = useState<string | null>(null);

  const [unsupportedDoc, setUnsupportedDoc] = useState<StoredDocument | null>(null);
  const [missingDoc, setMissingDoc] = useState<StoredDocument | null>(null);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isQuickOpen, setIsQuickOpen] = useState(false);
  const [openToolsRequest, setOpenToolsRequest] = useState(0);
  const [focusSearchRequest, setFocusSearchRequest] = useState(0);
  // Library catalog data and IPC operations live behind the library feature boundary.
  const [libraryScope, setLibraryScope] = useState<LibraryScope>(DEFAULT_LIBRARY_SCOPE);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [scrollAnchorId, setScrollAnchorId] = useState<string | null>(null);
  const libraryNavigationTimingRef = useRef<LibraryNavigationTiming | null>(null);

  // Status & Diagnostics
  const [libraryMessage, setLibraryMessage] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const handleCatalogError = useCallback((error: unknown) => {
    setLibraryError(error instanceof Error ? error.message : String(error));
  }, []);
  const {
    roots,
    documents,
    collections,
    refreshLibrary,
    addRoot: addLibraryRootToCatalog,
    createCollection,
    renameCollection,
    deleteCollection,
    addDocumentToCollection,
    removeDocumentFromCollection,
    removeDocument: removeLibraryDocumentFromCatalog,
    relinkDocument,
    addExternalDocument: addExternalDocumentToCatalog,
  } = useLibraryCatalog({ onError: handleCatalogError });
  const [libraryPending, setLibraryPending] = useState(false);
  const [readerPending, setReaderPending] = useState(false);
  const [pendingRootId, setPendingRootId] = useState<string | null>(null);

  // Keep Library feedback transient without moving its content.
  useEffect(() => {
    if (!libraryMessage && !libraryError) return;
    const timer = setTimeout(() => {
      setLibraryMessage("");
      setLibraryError("");
    }, libraryError ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [libraryMessage, libraryError]);

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

  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);

  function captureLibraryState(overrides: Partial<LibraryRestorationState> = {}): LibraryRestorationState {
    return {
      scope: libraryScope,
      viewMode,
      searchQuery,
      selectedDocIds: Array.from(selectedDocIds),
      scrollAnchorId,
      sortBy,
      ...overrides,
    };
  }

  function pushLibraryLocation(next: LibraryRestorationState) {
    setNavigationHistory((history) => pushNavigationHistory(history, next));
  }

  function replaceLibraryLocation(next: LibraryRestorationState) {
    setNavigationHistory((history) => replaceCurrentNavigationEntry(history, next));
  }

  function applyLibraryState(next: LibraryRestorationState) {
    setLibraryScope(next.scope);
    setViewMode(next.viewMode);
    setSearchQuery(next.searchQuery);
    searchQueryRef.current = next.searchQuery;
    searchEditSessionRef.current = false;
    setSelectedDocIds(new Set(next.selectedDocIds));
    setSortBy(next.sortBy);
    setScrollAnchorId(next.scrollAnchorId);
    setRoute({ kind: "library", scope: next.scope });
  }

  function handleLibraryScopeSelect(scope: LibraryScope) {
    const next = captureLibraryState({ scope });
    pushLibraryLocation(next);
    setLibraryScope(scope);
    setRoute({ kind: "library", scope });
  }

  function handleSearchQueryChange(query: string) {
    const previous = searchQueryRef.current;
    searchQueryRef.current = query;
    setSearchQuery(query);
    const next = captureLibraryState({ searchQuery: query });
    if (!previous && query) {
      pushLibraryLocation(next);
      searchEditSessionRef.current = true;
    } else if (previous && query && searchEditSessionRef.current) {
      replaceLibraryLocation(next);
    } else if (previous && query) {
      pushLibraryLocation(next);
      searchEditSessionRef.current = true;
    } else if (previous && !query) {
      pushLibraryLocation(next);
      searchEditSessionRef.current = false;
    }
  }

  function handleViewModeChange(next: "grid" | "list") {
    setViewMode(next);
    replaceLibraryLocation(captureLibraryState({ viewMode: next }));
  }

  function handleSortChange(next: SortOption) {
    setSortBy(next);
    replaceLibraryLocation(captureLibraryState({ sortBy: next }));
  }


  function handleSelectionChange(ids: Set<string>) {
    setSelectedDocIds(ids);
    replaceLibraryLocation(captureLibraryState({ selectedDocIds: Array.from(ids) }));
  }
  function moveLibraryHistory(direction: -1 | 1, key = direction < 0 ? "Alt+Left" : "Alt+Right") {
    const startedAt = performance.now();
    const latest = replaceCurrentNavigationEntry(navigationHistory, captureLibraryState());
    const moved = moveNavigationHistory(latest, direction);
    const dispatchAt = performance.now();
    if (!moved.state) return;
    libraryNavigationTimingRef.current = {
      key,
      startedAt,
      dispatchAt,
      resolutionMs: dispatchAt - startedAt,
    };
    setNavigationHistory(moved.history);
    applyLibraryState(moved.state);
  }

  useLayoutEffect(() => {
    const timing = libraryNavigationTimingRef.current;
    if (!timing) return;
    libraryNavigationTimingRef.current = null;
    const committedAt = performance.now();
    requestAnimationFrame(() => {
      const visibleAt = performance.now();
      if (import.meta.env.DEV) {
        console.debug("[library-navigation-timing]", {
          key: timing.key,
          resolutionMs: timing.resolutionMs,
          stateDispatchMs: timing.dispatchAt - timing.startedAt,
          reactCommitMs: committedAt - timing.dispatchAt,
          nextFrameMs: visibleAt - committedAt,
          keydownToNextFrameMs: visibleAt - timing.startedAt,
        });
      }
    });
  }, [libraryScope, route, searchQuery, sortBy, viewMode, selectedDocIds]);

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

  async function handleCreateAndAddToCollection(name: string, documentIds: string[]) {
    try {
      const col = await createCollection(name);
      for (const docId of documentIds) {
        await addDocumentToCollection(col.id, docId);
      }
      await refreshLibrary();
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRemoveDocFromCollection(collectionId: string, documentIds: string[]) {
    try {
      for (const docId of documentIds) {
        await removeDocumentFromCollection(collectionId, docId);
      }
      await refreshLibrary();
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRemoveFromLibrary(documentIds: string[]) {
    try {
      for (const id of documentIds) {
        await removeLibraryDocumentFromCatalog(id);
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
      const root = await addLibraryRootToCatalog(path);
      handleLibraryScopeSelect({ kind: "root", rootId: root.id });
      setPendingRootId(root.id);
      setLibraryMessage(`Scanning “${root.label}”…`);
      const result = await scanLibraryRoot(root.id);
      await refreshLibrary();
      setLibraryMessage(`Added “${root.label}”. ${scanMessage(result)}`);
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingRootId(null);
      setLibraryPending(false);
    }
  }

  async function scanRoot(rootId: string, relativePath?: string) {
    setLibraryError("");
    setLibraryMessage(relativePath ? "Scanning folder…" : "Scanning directory…");
    setLibraryPending(true);
    setPendingRootId(rootId);
    try {
      const result = relativePath
        ? await scanLibraryFolder(rootId, relativePath)
        : await scanLibraryRoot(rootId);
      await refreshLibrary([rootId]);
      setLibraryMessage(scanMessage(result));
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingRootId(null);
      setLibraryPending(false);
    }
  }

  async function rescanCurrentScope() {
    if (libraryPending) return;
    const scopedRootId = libraryScope.kind === "root" || libraryScope.kind === "folder"
      ? libraryScope.rootId
      : null;
    const relativePath = libraryScope.kind === "folder" ? libraryScope.relativePath : undefined;
    const rootIds = scopedRootId ? [scopedRootId] : roots.map((root) => root.id);
    if (rootIds.length === 0) {
      setLibraryMessage("Add a folder to the Library before rescanning.");
      return;
    }
    setLibraryError("");
    setLibraryMessage("Rescanning current Library scope…");
    setLibraryPending(true);
    const results: LibraryScanResult[] = [];
    try {
      for (const rootId of rootIds) {
        setPendingRootId(rootId);
        results.push(
          relativePath && rootId === scopedRootId
            ? await scanLibraryFolder(rootId, relativePath)
            : await scanLibraryRoot(rootId)
        );
      }
      await refreshLibrary(scopedRootId ? [scopedRootId] : undefined);
      setLibraryMessage(results.map(scanMessage).join(" "));
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
        handleLibraryScopeSelect({ kind: "all" });
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
      setMissingDoc(doc);
      return;
    }
    if (!isReaderFormat(doc.record.format)) {
      setUnsupportedDoc(doc);
      return;
    }

    const restorationState = captureLibraryState({ scrollAnchorId: doc.record.id });
    replaceLibraryLocation(restorationState);
    setScrollAnchorId(doc.record.id);

    setLibraryPending(true);
    setReaderOpenError("");
    try {
      const nextDoc = await openLibraryReaderDocument(doc.record.id, storage);
      setReaderDocument(nextDoc);
      setActiveDocumentId(doc.record.id);
      setRoute({ kind: "document", documentId: doc.record.id });
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    } finally {
      setLibraryPending(false);
    }
  }

  async function handleBackFromReader() {
    const previousState = navigationHistory.entries[navigationHistory.index] ?? {
      scope: DEFAULT_LIBRARY_SCOPE,
      viewMode: "grid" as const,
      searchQuery: "",
      selectedDocIds: [],
      scrollAnchorId: null,
      sortBy: "recent" as const,
    };
    applyLibraryState(previousState);
    setReaderDocument(null);
    setActiveDocumentId(null);
    setExternalPath(null);

    const rootId = previousState.scope.kind === "root" || previousState.scope.kind === "folder"
      ? previousState.scope.rootId
      : null;
    await refreshLibrary(rootId ? [rootId] : undefined);
  }

  async function handleLocateDocument(doc: StoredDocument) {
    const ext = doc.record.format;
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: `${ext.toUpperCase()} document`, extensions: [ext] }],
    });
    if (!path || Array.isArray(path)) return;
    try {
      await relinkDocument(doc.record.id, path);
      setMissingDoc(null);
      await refreshLibrary();
      setLibraryMessage(`Relinked “${doc.record.name}”.`);
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleOpenExternally(doc: StoredDocument) {
    try {
      const path = await getLibraryDocumentPath(doc.record.id);
      await openPath(path);
      setUnsupportedDoc(null);
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
      setActiveDocumentId(nextDocument.record.id);
      setRoute({ kind: "document", documentId: nextDocument.record.id });
      setExternalPath(path as string);
    } catch (error) {
      setReaderOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setReaderPending(false);
    }
  }

  useEffect(() => {
    let awaitingSecondG = false;
    let gTimer: number | undefined;

    function onGlobalKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || route.kind !== "library" || isEditableTarget(event.target) ||
          document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (isQuickOpen || isAppMenuOpen || isShortcutsOpen || missingDoc || unsupportedDoc) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        moveLibraryHistory(-1);
        return;
      }
      if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        moveLibraryHistory(1);
        return;
      }
      if (modifier && event.shiftKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        handleViewModeChange(viewMode === "grid" ? "list" : "grid");
        return;
      }
      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsQuickOpen(true);
        return;
      }
      if (modifier && event.key.toLowerCase() === "r") {
        event.preventDefault();
        void rescanCurrentScope();
        return;
      }

      if (event.key === "Escape") {
        if (selectedDocIds.size) {
          event.preventDefault();
          handleSelectionChange(new Set());
        } else if (searchQuery) {
          event.preventDefault();
          handleSearchQueryChange("");
          searchEditSessionRef.current = false;
        }
        return;
      }

      const items = Array.from(document.querySelectorAll<HTMLElement>("[data-library-navigable]"));
      if (modifier && event.key.toLowerCase() === "a") {
        if (!items.length) return;
        event.preventDefault();
        const visibleIds = items
          .map((item) => item.dataset.libraryDocumentId)
          .filter((id): id is string => Boolean(id));
        const allSelected = visibleIds.every((id) => selectedDocIds.has(id));
        const next = new Set(selectedDocIds);
        for (const id of visibleIds) {
          if (allSelected) next.delete(id);
          else next.add(id);
        }
        handleSelectionChange(next);
        return;
      }

      const target = event.target instanceof HTMLElement ? event.target : null;
      const focusedItem = target?.closest<HTMLElement>("[data-library-navigable]") ?? null;
      const focusedIndex = focusedItem ? items.indexOf(focusedItem) : -1;
      const focusItem = (index: number) => {
        const item = items[index];
        if (!item) return;
        item.focus();
        item.scrollIntoView({ block: "nearest", inline: "nearest" });
      };

      if (
        event.key === "G" ||
        (event.shiftKey && event.key.toLowerCase() === "g" && !modifier && !event.altKey)
      ) {
        awaitingSecondG = false;
        clearTimeout(gTimer);
        if (items.length) {
          event.preventDefault();
          focusItem(items.length - 1);
        }
        return;
      }
      if (event.key.toLowerCase() === "g" && !modifier && !event.altKey) {
        if (awaitingSecondG) {
          event.preventDefault();
          awaitingSecondG = false;
          clearTimeout(gTimer);
          if (items.length) focusItem(0);
        } else {
          awaitingSecondG = true;
          gTimer = window.setTimeout(() => {
            awaitingSecondG = false;
          }, 600);
        }
        return;
      }
      if (event.key.toLowerCase() !== "g") {
        awaitingSecondG = false;
        clearTimeout(gTimer);
      }
      if (event.key === "Enter" && target?.closest("button, [role=checkbox], a")) return;
      if (event.key === "Enter") {
        const id = focusedItem?.dataset.libraryDocumentId;
        const doc = id ? documents.find((item) => item.record.id === id) : undefined;
        if (doc) {
          event.preventDefault();
          void handleOpenDocument(doc);
        }
        return;
      }
      if (event.key === "Backspace") {
        if (libraryScope.kind === "folder") {
          event.preventDefault();
          const parentPath = libraryScope.relativePath.split("/").slice(0, -1).join("/");
          handleLibraryScopeSelect(parentPath
            ? { kind: "folder", rootId: libraryScope.rootId, relativePath: parentPath }
            : { kind: "root", rootId: libraryScope.rootId });
        } else if (libraryScope.kind !== "all") {
          event.preventDefault();
          handleLibraryScopeSelect({ kind: "all" });
        }
        return;
      }
      if (!["h", "j", "k", "l"].includes(event.key) || !items.length) return;
      const key = event.key;
      if (viewMode === "list" && key === "h") {
        if (libraryScope.kind === "folder") {
          event.preventDefault();
          const parentPath = libraryScope.relativePath.split("/").slice(0, -1).join("/");
          handleLibraryScopeSelect(parentPath
            ? { kind: "folder", rootId: libraryScope.rootId, relativePath: parentPath }
            : { kind: "root", rootId: libraryScope.rootId });
        } else if (libraryScope.kind !== "all") {
          event.preventDefault();
          handleLibraryScopeSelect({ kind: "all" });
        }
        return;
      }
      if (viewMode === "list" && key === "l") {
        const id = focusedItem?.dataset.libraryDocumentId;
        const doc = id ? documents.find((item) => item.record.id === id) : undefined;
        if (doc) {
          event.preventDefault();
          void handleOpenDocument(doc);
        }
        return;
      }
      const direction = key === "h" ? "left" : key === "l" ? "right" : key === "k" ? "up" : "down";
      const nextIndex = focusedIndex < 0
        ? 0
        : viewMode === "grid"
          ? findSpatialNeighbor(items.map((item) => {
              const rect = item.getBoundingClientRect();
              return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
            }), focusedIndex, direction)
          : Math.max(0, Math.min(items.length - 1, focusedIndex + (key === "j" ? 1 : key === "k" ? -1 : 0)));
      if (nextIndex !== focusedIndex || focusedIndex < 0) {
        event.preventDefault();
        focusItem(nextIndex);
      }
    }

    window.addEventListener("keydown", onGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", onGlobalKeyDown);
      clearTimeout(gTimer);
    };
  }, [route, isQuickOpen, isAppMenuOpen, isShortcutsOpen, missingDoc, unsupportedDoc, selectedDocIds, searchQuery, libraryScope, viewMode, navigationHistory, documents]);
  return (
    <div className="app-frame clio-app">
      {route.kind === "library" ? (
        <LibraryView
          roots={roots}
          documents={documents}
          collections={collections}
          activeScope={libraryScope}
          onSelectScope={handleLibraryScopeSelect}
          searchQuery={searchQuery}
          onSearchChange={handleSearchQueryChange}
          viewMode={viewMode}
          onViewModeChange={handleViewModeChange}
          selectedDocIds={selectedDocIds}
          onSelectionChange={handleSelectionChange}
          sortBy={sortBy}
          onSortChange={handleSortChange}
          pending={libraryPending}
          pendingRootId={pendingRootId}
          message={libraryMessage}
          error={libraryError}
          onAddRoot={() => void addRoot()}
          onScanRoot={(rootId, relativePath) => void scanRoot(rootId, relativePath)}
          onRemoveRoot={(rootId) => void removeRoot(rootId)}
          onCreateCollection={handleCreateCollection}
          onCreateAndAddToCollection={handleCreateAndAddToCollection}
          onRenameCollection={handleRenameCollection}
          onDeleteCollection={handleDeleteCollection}
          onAddDocToCollection={handleAddDocToCollection}
          onRemoveDocFromCollection={handleRemoveDocFromCollection}
          onRemoveFromLibrary={handleRemoveFromLibrary}
          onOpenDocument={(doc) => void handleOpenDocument(doc)}
          onRevealInFileManager={handleRevealInFileManager}
          scrollAnchorId={scrollAnchorId}
          onUpdateScrollAnchor={setScrollAnchorId}
          onLocateDocument={handleLocateDocument}
          onOpenExternally={handleOpenExternally}
          onOpenAppMenu={() => setIsAppMenuOpen(true)}
          onOpenFile={() => void chooseReaderDocument()}
          onDismissMessage={() => setLibraryMessage("")}
          onDismissError={() => setLibraryError("")}
          focusSearchRequest={focusSearchRequest}
          openToolsRequest={openToolsRequest}
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
            storedDocument={activeDocumentId ? (documents.find((d) => d.record.id === activeDocumentId) ?? null) : null}
            collections={collections}
            onBack={() => void handleBackFromReader()}
            onOpen={() => void chooseReaderDocument()}
            openDisabled={libraryPending || readerPending}
            onRemoveFromLibrary={handleRemoveFromLibrary}
            onRevealInFileManager={handleRevealInFileManager}
            onConvert={(doc) => {
              setConversionTarget({ doc, mode: "convert" });
            }}
            onExtractPages={(doc) => {
              setConversionTarget({ doc, mode: "extract" });
            }}
            onAddToLibrary={async () => {
              if (!externalPath) return;
              try {
                const added = await addExternalDocumentToCatalog(externalPath);
                setActiveDocumentId(added.record.id);
                setExternalPath(null);
                await refreshLibrary();
                setLibraryMessage(`Added “${added.record.name}” to Library.`);
              } catch (err) {
                setLibraryError(err instanceof Error ? err.message : String(err));
              }
            }}
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
            <button
              type="button"
              className="context-menu-item"
              onClick={() => {
                setIsAppMenuOpen(false);
                setIsShortcutsOpen(true);
              }}
            >
              Keyboard shortcuts
            </button>
            <button
              type="button"
              className="context-menu-item"
              onClick={() => {
                setIsAppMenuOpen(false);
                setOpenToolsRequest((request) => request + 1);
              }}
            >
              Document tools…
            </button>

            <button
              type="button"
              className="context-menu-item"
              onClick={() => {
                setIsAppMenuOpen(false);
                setIsAboutOpen(true);
              }}
            >
              About Clio
            </button>
          </div>
        </div>
      )}

      {/* Contextual conversion/extraction overlay — opened from reader document menu */}
      {conversionTarget && (
        <div className="conversion-overlay-backdrop" role="dialog" aria-modal="true" aria-label="Convert document">
          <div className="conversion-overlay-panel">
            <ConversionWorkspace
              initialDocument={conversionTarget.doc}
              initialMode={conversionTarget.mode === "extract" ? "extract" : "convert"}
              onClose={() => {
                setConversionTarget(null);
                void refreshLibrary();
              }}
            />
          </div>
        </div>
      )}

      {/* Non-readable format contextual choice modal (OD-4) */}
      {unsupportedDoc && (
        <UnsupportedFormatModal
          document={unsupportedDoc}
          onOpenExternally={() => handleOpenExternally(unsupportedDoc)}
          onConvertAndRead={() => {
            const target = unsupportedDoc;
            setUnsupportedDoc(null);
            setConversionTarget({ doc: target, mode: "convert" });
          }}
          onClose={() => setUnsupportedDoc(null)}
        />
      )}

      {/* Missing document prompt modal (OD-2) */}
      {missingDoc && (
        <MissingDocumentModal
          document={missingDoc}
          onLocate={() => void handleLocateDocument(missingDoc)}
          onRemove={async () => {
            const id = missingDoc.record.id;
            setMissingDoc(null);
            await handleRemoveFromLibrary([id]);
          }}
          onClose={() => setMissingDoc(null)}
        />
      )}

      {isQuickOpen && (
        <QuickOpenDialog
          documents={documents}
          onClose={() => setIsQuickOpen(false)}
          onOpenDocument={(doc) => {
            setIsQuickOpen(false);
            void handleOpenDocument(doc);
          }}
          onSearchLibrary={() => {
            setIsQuickOpen(false);
            setFocusSearchRequest((request) => request + 1);
          }}
          onToggleLayout={() => {
            setIsQuickOpen(false);
            handleViewModeChange(viewMode === "grid" ? "list" : "grid");
          }}
          onRescan={() => {
            setIsQuickOpen(false);
            void rescanCurrentScope();
          }}
          onGoToLibrary={() => setIsQuickOpen(false)}
          onOpenTools={() => {
            setIsQuickOpen(false);
            setOpenToolsRequest((request) => request + 1);
          }}
          onOpenShortcuts={() => {
            setIsQuickOpen(false);
            setIsShortcutsOpen(true);
          }}
        />
      )}

      {/* Keyboard Shortcuts Reference Modal (OD-7) */}
      {isShortcutsOpen && (
        <KeyboardShortcutsModal onClose={() => setIsShortcutsOpen(false)} />
      )}

      {/* About Clio Modal (OD-7) */}
      {isAboutOpen && (
        <AboutClioModal onClose={() => setIsAboutOpen(false)} />
      )}
    </div>
  );
}

export default App;
