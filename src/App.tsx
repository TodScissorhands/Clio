import { useEffect, useState } from "react";
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

const readerFileFilters = [{ name: "Readable documents", extensions: ["pdf", "epub", "txt", "md", "markdown"] }];
const storage = new TauriDocumentStorage();

type AppTheme = "system" | "light" | "dark";

interface SettingsViewProps {
  appTheme: AppTheme;
  onThemeChange: (theme: AppTheme) => void;
  rootCount: number;
  docCount: number;
  collectionCount: number;
}

function SettingsView({
  appTheme,
  onThemeChange,
  rootCount,
  docCount,
  collectionCount,
}: SettingsViewProps) {
  return (
    <section className="settings-view" aria-label="Settings">
      <header className="settings-header">
        <h1>Settings</h1>
        <p>Preferences, local library overview, and keyboard navigation.</p>
      </header>

      <div className="settings-sections">
        {/* Appearance Section */}
        <div className="settings-section">
          <h2 className="settings-section-title">Appearance</h2>
          <p className="settings-section-desc">
            Choose how Clio looks on your device. Follow your system theme or explicitly lock to light or dark.
          </p>
          <div className="theme-switcher" role="radiogroup" aria-label="Application theme">
            <button
              type="button"
              className={`theme-btn ${appTheme === "system" ? "selected" : ""}`}
              onClick={() => onThemeChange("system")}
              role="radio"
              aria-checked={appTheme === "system"}
            >
              System
            </button>
            <button
              type="button"
              className={`theme-btn ${appTheme === "light" ? "selected" : ""}`}
              onClick={() => onThemeChange("light")}
              role="radio"
              aria-checked={appTheme === "light"}
            >
              Light
            </button>
            <button
              type="button"
              className={`theme-btn ${appTheme === "dark" ? "selected" : ""}`}
              onClick={() => onThemeChange("dark")}
              role="radio"
              aria-checked={appTheme === "dark"}
            >
              Dark
            </button>
          </div>
        </div>

        {/* Library & Storage Overview */}
        <div className="settings-section">
          <h2 className="settings-section-title">Local Library & Storage</h2>
          <p className="settings-section-desc">
            Files remain strictly in user-controlled filesystem directories without cloud sync or remote accounts.
          </p>
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-number">{rootCount}</div>
              <div className="stat-label">Indexed Directories</div>
            </div>
            <div className="stat-card">
              <div className="stat-number">{docCount}</div>
              <div className="stat-label">Discovered Files</div>
            </div>
            <div className="stat-card">
              <div className="stat-number">{collectionCount}</div>
              <div className="stat-label">Collections</div>
            </div>
          </div>
        </div>

        {/* Keyboard Shortcuts Reference */}
        <div className="settings-section">
          <h2 className="settings-section-title">Keyboard Navigation</h2>
          <p className="settings-section-desc">
            Clio provides quick keyboard shortcuts across the application for high-efficiency reading and browsing.
          </p>
          <table className="shortcut-table">
            <tbody>
              <tr>
                <td><kbd className="key-badge">/</kbd> or <kbd className="key-badge">Ctrl</kbd>+<kbd className="key-badge">K</kbd></td>
                <td>Focus library search</td>
              </tr>
              <tr>
                <td><kbd className="key-badge">Esc</kbd></td>
                <td>Clear search or close reader panel</td>
              </tr>
              <tr>
                <td><kbd className="key-badge">←</kbd> / <kbd className="key-badge">→</kbd> or <kbd className="key-badge">J</kbd> / <kbd className="key-badge">K</kbd></td>
                <td>Previous / Next page in reader</td>
              </tr>
              <tr>
                <td><kbd className="key-badge">Ctrl</kbd>+<kbd className="key-badge">+</kbd> / <kbd className="key-badge">Ctrl</kbd>+<kbd className="key-badge">-</kbd></td>
                <td>Zoom in / Zoom out (PDF)</td>
              </tr>
              <tr>
                <td><kbd className="key-badge">Ctrl</kbd>+<kbd className="key-badge">0</kbd></td>
                <td>Reset zoom to 100%</td>
              </tr>
              <tr>
                <td><kbd className="key-badge">Ctrl</kbd>+<kbd className="key-badge">B</kbd></td>
                <td>Toggle page bookmark</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* About Clio */}
        <div className="settings-section">
          <h2 className="settings-section-title">About Clio</h2>
          <p className="settings-section-desc">
            Clio is a local-first, offline-capable document library, reader, and conversion workbench.
            Native tools (Pandoc and Poppler) run locally without sending any data over the network.
          </p>
        </div>
      </div>
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
  const [conversionDocument, setConversionDocument] = useState<StoredDocument | null>(null);
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
            onConvert={(doc) => {
              setConversionDocument(doc);
              setView("tools");
            }}
          />
        )}
        {view === "reader" && <><div className="reader-open-error-wrap">{readerOpenError && <p className="reader-open-error" role="alert">{readerOpenError}</p>}</div><ReaderShell document={readerDocument} onOpen={() => void chooseReaderDocument()} openDisabled={libraryPending || readerPending} /></>}
        {view === "tools" && <ConversionWorkspace initialDocument={conversionDocument} />}
        {view === "settings" && (
          <SettingsView
            appTheme={appTheme}
            onThemeChange={handleThemeChange}
            rootCount={roots.length}
            docCount={documents.length}
            collectionCount={collections.length}
          />
        )}
      </main>
      <footer className="app-footer"><span>Clio · local document workbench</span><span>Files stay in directories you control</span></footer>
    </div>
  );
}

export default App;
