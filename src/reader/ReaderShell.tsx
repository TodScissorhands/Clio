import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createAnnotation,
  createBookmark,
  deleteAnnotation,
  deleteBookmark,
  getReadingState,
  listAnnotations,
  listBookmarks,
  setReadingState,
  updateAnnotation,
} from "../storage/documentStorage";
import { ReadingStateCoordinator } from "./readingState";
import { EpubEngine } from "./EpubEngine";
import { PdfEngine } from "./PdfEngine";
import { TextEngine } from "./TextEngine";
import { isSameReadingPosition } from "./types";
import type {
  Annotation,
  Bookmark,
  ReaderDocument,
  ReaderEngineComponent,
  ReaderEngineHandle,
  ReaderProgress,
  ReaderSearchResult,
  ReaderTheme,
  ReaderTocItem,
  ReadingPosition,
  TextSelection,
} from "./types";
import "./ReaderShell.css";

type ReaderShellProps = {
  document: ReaderDocument | null;
  onOpen(): void;
  openDisabled?: boolean;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TocList({ items, onSelect }: { items: ReaderTocItem[]; onSelect(item: ReaderTocItem): void }) {
  return (
    <ol className="reader-toc-list">
      {items.map((item) => (
        <li key={item.id}>
          <button onClick={() => onSelect(item)}>{item.label}</button>
          {item.children && item.children.length > 0 && <TocList items={item.children} onSelect={onSelect} />}
        </li>
      ))}
    </ol>
  );
}

export function ReaderShell({ document, onOpen, openDisabled = false }: ReaderShellProps) {
  const engineRef = useRef<ReaderEngineHandle | null>(null);
  const [theme, setTheme] = useState<ReaderTheme>("light");
  const [progress, setProgress] = useState<ReaderProgress>({ current: 1 });
  const [toc, setToc] = useState<ReaderTocItem[]>([]);
  const [initialPosition, setInitialPosition] = useState<ReadingPosition | undefined>(undefined);
  const [positionLoaded, setPositionLoaded] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState("Choose a PDF or EPUB to begin reading.");
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<ReaderSearchResult | null>(null);
  const [searchActiveQuery, setSearchActiveQuery] = useState("");
  const [searchPending, setSearchPending] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  const [annotationsLoading, setAnnotationsLoading] = useState(false);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState("");
  const [annotationNoteInput, setAnnotationNoteInput] = useState("");
  const [currentPosition, setCurrentPosition] = useState<ReadingPosition | undefined>(undefined);
  const [tocOpen, setTocOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [pendingTextSelection, setPendingTextSelection] = useState<TextSelection | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const coordinator = useMemo(
    () => new ReadingStateCoordinator({ getReadingState, setReadingState }),
    []
  );

  const onPositionChange = useCallback(
    (position: ReadingPosition) => {
      if (!document) return;
      setCurrentPosition(position);
      coordinator.recordPositionChange(document.record.id, position);
    },
    [coordinator, document]
  );

  const onProgress = useCallback((next: ReaderProgress) => setProgress(next), []);
  const onToc = useCallback((next: ReaderTocItem[]) => setToc(next), []);
  const onTextSelection = useCallback((selection: TextSelection) => {
    setPendingTextSelection(selection);
  }, []);

  const onState = useCallback((next: "loading" | "ready" | "error", message?: string) => {
    setStatus(next);
    setStatusMessage(message ?? "");
  }, []);
  useEffect(() => {
    const flushReadingState = () => {
      void coordinator.flush();
    };
    window.addEventListener("beforeunload", flushReadingState);
    window.addEventListener("pagehide", flushReadingState);
    return () => {
      window.removeEventListener("beforeunload", flushReadingState);
      window.removeEventListener("pagehide", flushReadingState);
      void coordinator.flush();
    };
  }, [coordinator]);

  useEffect(() => {
    if (!document) {
      void coordinator.flush();
      setInitialPosition(undefined);
      setPositionLoaded(false);
      setStatus("idle");
      setStatusMessage("Choose a PDF or EPUB to begin reading.");
      setProgress({ current: 1 });
      setToc([]);
      setQuery("");
      setSearchResult(null);
      setSearchActiveQuery("");
      setZoomPercent(100);
      setBookmarks([]);
      setBookmarksOpen(false);
      setAnnotations([]);
      setAnnotationsOpen(false);
      setAnnotationsLoading(false);
      setEditingAnnotationId(null);
      setEditingNoteText("");
      setAnnotationNoteInput("");
      setCurrentPosition(undefined);
      setTocOpen(false);
      setControlsVisible(true);
      setPendingTextSelection(null);
      return;
    }

    let cancelled = false;
    const docId = document.record.id;
    setStatus("loading");
    setStatusMessage("Restoring reading position…");
    setPositionLoaded(false);
    setProgress({ current: 1 });
    setToc([]);
    setQuery("");
    setSearchResult(null);
    setSearchActiveQuery("");
    setZoomPercent(100);
    setBookmarks([]);
    setBookmarksOpen(false);
    setAnnotations([]);
    setAnnotationsOpen(false);
    setAnnotationsLoading(false);
    setEditingAnnotationId(null);
    setEditingNoteText("");
    setAnnotationNoteInput("");
    setCurrentPosition(undefined);
    setTocOpen(false);
    setControlsVisible(true);
    setPendingTextSelection(null);

    coordinator.loadInitialPosition(docId).then((pos) => {
      if (cancelled) return;
      setInitialPosition(pos);
      if (pos) setCurrentPosition(pos);
      setPositionLoaded(true);
      setStatusMessage("Preparing reader…");
    });

    listBookmarks(docId)
      .then((list) => {
        if (cancelled) return;
        setBookmarks(list);
      })
      .catch(() => {
        if (cancelled) return;
        setBookmarks([]);
      });

    setAnnotationsLoading(true);
    listAnnotations(docId)
      .then((list) => {
        if (cancelled) return;
        setAnnotations(list);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setAnnotations([]);
        onState(
          "error",
          `Could not load annotations: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        if (!cancelled) setAnnotationsLoading(false);
      });

    return () => {
      cancelled = true;
      void coordinator.flush();
    };
  }, [coordinator, document]);
  const activeBookmark = useMemo(() => {
    return bookmarks.find((b) => isSameReadingPosition(b.position, currentPosition));
  }, [bookmarks, currentPosition]);

  const toggleBookmark = useCallback(async () => {
    if (!document || !currentPosition) return;
    const docId = document.record.id;
    if (activeBookmark) {
      try {
        await deleteBookmark(activeBookmark.id);
        setBookmarks((prev) => prev.filter((b) => b.id !== activeBookmark.id));
      } catch {}
    } else {
      try {
        const newBm = await createBookmark(docId, currentPosition);
        setBookmarks((prev) => [...prev, newBm]);
      } catch {}
    }
  }, [activeBookmark, currentPosition, document]);

  const removeBookmark = useCallback(async (bookmarkId: string) => {
    try {
      await deleteBookmark(bookmarkId);
      setBookmarks((prev) => prev.filter((b) => b.id !== bookmarkId));
    } catch {}
  }, []);

  const saveAnnotationFromSelection = useCallback(async () => {
    if (!document || !currentPosition || !pendingTextSelection) return;
    const docId = document.record.id;
    const { locator, selectedText } = pendingTextSelection;
    const note = annotationNoteInput.trim() ? annotationNoteInput.trim() : undefined;
    try {
      const newAnn = await createAnnotation(
        docId,
        "highlight",
        currentPosition,
        selectedText,
        note,
        locator
      );
      setAnnotations((prev) => [...prev, newAnn]);
      setPendingTextSelection(null);
      setAnnotationNoteInput("");
    } catch (error) {
      onState(
        "error",
        `Could not save annotation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, [annotationNoteInput, currentPosition, document, onState, pendingTextSelection]);

  const saveAnnotationNote = useCallback(async (annotationId: string) => {
    try {
      const updated = await updateAnnotation(
        annotationId,
        editingNoteText.trim() ? editingNoteText.trim() : undefined
      );
      setAnnotations((prev) => prev.map((a) => (a.id === annotationId ? updated : a)));
      setEditingAnnotationId(null);
      setEditingNoteText("");
    } catch (error) {
      onState(
        "error",
        `Could not update annotation note: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, [editingNoteText, onState]);

  const removeAnnotation = useCallback(async (annotationId: string) => {
    try {
      await deleteAnnotation(annotationId);
      setAnnotations((prev) => prev.filter((a) => a.id !== annotationId));
      if (editingAnnotationId === annotationId) {
        setEditingAnnotationId(null);
        setEditingNoteText("");
      }
    } catch (error) {
      onState(
        "error",
        `Could not delete annotation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, [editingAnnotationId, onState]);

  const clearSearch = useCallback(() => {
    setQuery("");
    setSearchResult(null);
    setSearchActiveQuery("");
    void engineRef.current?.clearSearch?.();
  }, []);

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed || !engineRef.current) return;
    setSearchPending(true);
    try {
      const result = await engineRef.current.search(trimmed);
      setSearchResult(result);
      setSearchActiveQuery(trimmed);
    } finally {
      setSearchPending(false);
    }
  }, [query]);

  const nextMatch = useCallback(async () => {
    if (!engineRef.current) return;
    setSearchPending(true);
    try {
      if (engineRef.current.nextSearchResult) {
        const result = await engineRef.current.nextSearchResult();
        setSearchResult(result);
      } else {
        await runSearch();
      }
    } finally {
      setSearchPending(false);
    }
  }, [runSearch]);

  const prevMatch = useCallback(async () => {
    if (!engineRef.current) return;
    setSearchPending(true);
    try {
      if (engineRef.current.previousSearchResult) {
        const result = await engineRef.current.previousSearchResult();
        setSearchResult(result);
      } else {
        await runSearch();
      }
    } finally {
      setSearchPending(false);
    }
  }, [runSearch]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!document) return;

      // Global Ctrl+F / Cmd+F to focus search
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setControlsVisible(true);
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      // Global Ctrl+B / Cmd+B to toggle bookmark
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        void toggleBookmark();
        return;
      }

      const isInput =
        event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

      if (event.key === "Escape") {
        if (editingAnnotationId) {
          setEditingAnnotationId(null);
          setEditingNoteText("");
          return;
        }
        if (pendingTextSelection) {
          setPendingTextSelection(null);
          setAnnotationNoteInput("");
          return;
        }
        if (bookmarksOpen) {
          setBookmarksOpen(false);
          return;
        }
        if (annotationsOpen) {
          setAnnotationsOpen(false);
          return;
        }
        if (tocOpen) {
          setTocOpen(false);
          return;
        }
        if (searchResult || query) {
          clearSearch();
          return;
        }
        setControlsVisible((visible) => !visible);
        return;
      }

      if (isInput) return;

      if (event.key === "ArrowLeft") void engineRef.current?.previous();
      if (event.key === "ArrowRight") void engineRef.current?.next();

      // PDF Zoom shortcuts
      if (document.record.format === "pdf") {
        if ((event.ctrlKey || event.metaKey) && (event.key === "=" || event.key === "+")) {
          event.preventDefault();
          void engineRef.current?.zoomIn();
          return;
        }
        if ((event.ctrlKey || event.metaKey) && (event.key === "-" || event.key === "_")) {
          event.preventDefault();
          void engineRef.current?.zoomOut();
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === "0") {
          event.preventDefault();
          void engineRef.current?.resetZoom?.();
          return;
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [annotationsOpen, bookmarksOpen, clearSearch, document, editingAnnotationId, pendingTextSelection, query, searchResult, tocOpen, toggleBookmark]);

  const Engine: ReaderEngineComponent | null =
    document?.record.format === "pdf"
      ? PdfEngine
      : document?.record.format === "epub"
      ? EpubEngine
      : document?.record.format === "txt" || document?.record.format === "md"
      ? TextEngine
      : null;
  const progressLabel = progress.total ? `${progress.current} / ${progress.total}` : progress.label ?? "Reading";

  return (
    <section className={`reader-shell theme-${theme} ${controlsVisible ? "controls-visible" : "controls-hidden"}`} aria-label="Reader" data-selection-active={pendingTextSelection ? "true" : undefined}>
      <header className="reader-header">
        <div className="reader-title-group">
          <span className="reader-kicker">Reader</span>
          <strong>{document?.record.name ?? "No document open"}</strong>
          {document && <span>{document.record.format.toUpperCase()} · {formatBytes(document.record.size)}</span>}
        </div>
        <div className="reader-header-actions">
          <button className="reader-secondary-button" onClick={onOpen} disabled={openDisabled}>Open document</button>
          <button className="reader-secondary-button reader-mobile-toggle" onClick={() => setControlsVisible((visible) => !visible)}>{controlsVisible ? "Hide controls" : "Show controls"}</button>
        </div>
      </header>

      <div className="reader-status" aria-live="polite">
        <span className={`reader-status-dot ${status}`} />
        <span>{statusMessage}</span>
      </div>

      {controlsVisible && (
        <div className="reader-toolbar">
          {/* Page Navigation Group */}
          <div className="reader-toolbar-group reader-nav-group">
            <button
              type="button"
              onClick={() => void engineRef.current?.previous()}
              disabled={!document}
              aria-label="Previous page"
              title="Previous page (←)"
            >
              ←
            </button>
            <span className="reader-progress" aria-label={`Reading progress: ${progressLabel}`}>
              {progressLabel}
            </span>
            <button
              type="button"
              onClick={() => void engineRef.current?.next()}
              disabled={!document}
              aria-label="Next page"
              title="Next page (→)"
            >
              →
            </button>
          </div>

          {/* PDF Zoom Controls */}
          {document?.record.format === "pdf" && (
            <div className="reader-toolbar-group reader-zoom-group" aria-label="Zoom controls">
              <button
                type="button"
                onClick={() => void engineRef.current?.zoomOut()}
                disabled={!document || zoomPercent <= 50}
                aria-label="Zoom out"
                title="Zoom out (Ctrl -)"
              >
                −
              </button>
              <button
                type="button"
                className="reader-zoom-reset"
                onClick={() => void engineRef.current?.resetZoom?.()}
                disabled={!document}
                aria-label="Reset zoom to 100%"
                title="Reset zoom to 100% (Ctrl 0)"
              >
                {zoomPercent}%
              </button>
              <button
                type="button"
                onClick={() => void engineRef.current?.zoomIn()}
                disabled={!document || zoomPercent >= 250}
                aria-label="Zoom in"
                title="Zoom in (Ctrl +)"
              >
                +
              </button>
            </div>
          )}

          {/* Search Controls */}
          <div className="reader-toolbar-group reader-search" role="search">
            <div className="reader-search-input-wrap">
              <input
                ref={searchInputId => { searchInputRef.current = searchInputId; }}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (!query.trim()) return;
                    if (searchResult && searchActiveQuery === query.trim()) {
                      if (e.shiftKey) void prevMatch();
                      else void nextMatch();
                    } else {
                      void runSearch();
                    }
                  }
                }}
                placeholder={`Search ${document?.record.format.toUpperCase() ?? "document"}…`}
                disabled={!document || searchPending}
                aria-label="Search within document"
              />
              {query && (
                <button
                  type="button"
                  className="reader-search-clear"
                  onClick={clearSearch}
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
            <button
              type="button"
              className="reader-search-btn"
              onClick={() => void runSearch()}
              disabled={!document || !query.trim() || searchPending}
            >
              {searchPending ? "…" : "Find"}
            </button>

            {/* Search Match Navigation */}
            {searchResult && searchResult.count > 0 && (
              <div className="reader-search-nav">
                <button
                  type="button"
                  className="reader-search-nav-btn"
                  onClick={() => void prevMatch()}
                  disabled={searchPending}
                  aria-label="Previous match"
                  title="Previous match (Shift Enter)"
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="reader-search-nav-btn"
                  onClick={() => void nextMatch()}
                  disabled={searchPending}
                  aria-label="Next match"
                  title="Next match (Enter)"
                >
                  ▼
                </button>
              </div>
            )}

            {searchResult && (
              <span className="reader-search-label" aria-live="polite">
                {searchResult.label}
              </span>
            )}
          </div>

          {/* View, Bookmarks & Theme Controls */}
          <div className="reader-toolbar-group reader-view-group">
            <button
              type="button"
              className={`reader-bookmark-btn ${activeBookmark ? "bookmarked" : ""}`}
              onClick={() => void toggleBookmark()}
              disabled={!document || !currentPosition}
              aria-label={activeBookmark ? "Remove bookmark" : "Add bookmark"}
              title={activeBookmark ? "Remove bookmark (Ctrl B)" : "Bookmark this page (Ctrl B)"}
            >
              <span className="bookmark-icon">{activeBookmark ? "★" : "☆"}</span>
              <span className="bookmark-label">{activeBookmark ? "Bookmarked" : "Bookmark"}</span>
            </button>
            {pendingTextSelection && (
              <div
                className="reader-toolbar-group reader-annotate-toolbar-group"
                role="group"
                aria-label="Add annotation"
              >
                <input
                  type="text"
                  className="reader-annotate-note-input"
                  value={annotationNoteInput}
                  onChange={(e) => setAnnotationNoteInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveAnnotationFromSelection();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setPendingTextSelection(null);
                      setAnnotationNoteInput("");
                    }
                  }}
                  placeholder="Note (optional)…"
                  aria-label="Annotation note"
                  autoFocus
                />
                <button
                  type="button"
                  className="reader-annotate-btn"
                  onClick={() => void saveAnnotationFromSelection()}
                  disabled={!document || !currentPosition}
                  aria-label="Save annotation"
                  title="Save annotation (Enter)"
                >
                  Save
                </button>
                <button
                  type="button"
                  className="reader-annotate-cancel-btn"
                  onClick={() => {
                    setPendingTextSelection(null);
                    setAnnotationNoteInput("");
                  }}
                  aria-label="Dismiss selection"
                  title="Dismiss selection (Esc)"
                >
                  ✕
                </button>
              </div>
            )}
            <button
              type="button"
              className={annotationsOpen ? "selected" : ""}
              onClick={() => {
                setAnnotationsOpen((open) => !open);
                if (!annotationsOpen) {
                  setBookmarksOpen(false);
                  setTocOpen(false);
                }
              }}
              disabled={!document}
              title="Annotations panel"
            >
              Notes{annotations.length > 0 ? ` (${annotations.length})` : ""}
            </button>
            <button
              type="button"
              className={bookmarksOpen ? "selected" : ""}
              onClick={() => {
                setBookmarksOpen((open) => !open);
                if (!bookmarksOpen) {
                  setTocOpen(false);
                  setAnnotationsOpen(false);
                }
              }}
              disabled={!document}
              title="Bookmarks panel"
            >
              Bookmarks{bookmarks.length > 0 ? ` (${bookmarks.length})` : ""}
            </button>
            <button
              type="button"
              className={tocOpen ? "selected" : ""}
              onClick={() => {
                setTocOpen((open) => !open);
                if (!tocOpen) {
                  setBookmarksOpen(false);
                  setAnnotationsOpen(false);
                }
              }}
              disabled={toc.length === 0}
              title={toc.length === 0 ? "No table of contents available" : "Table of contents"}
            >
              Contents
            </button>
            <button
              type="button"
              className={theme === "light" ? "selected" : ""}
              onClick={() => setTheme("light")}
              aria-label="Light theme"
            >
              Light
            </button>
            <button
              type="button"
              className={theme === "sepia" ? "selected" : ""}
              onClick={() => setTheme("sepia")}
              aria-label="Sepia theme"
            >
              Sepia
            </button>
            <button
              type="button"
              className={theme === "dark" ? "selected" : ""}
              onClick={() => setTheme("dark")}
              aria-label="Dark theme"
            >
              Dark
            </button>
          </div>
        </div>
      )}

      <div className="reader-main">
        <div className="reader-viewport">
        {Engine && document && positionLoaded ? (
          <Engine
            engineRef={engineRef}
            document={document}
            theme={theme}
            initialPosition={initialPosition}
            onProgress={onProgress}
            onPositionChange={onPositionChange}
            onZoomChange={setZoomPercent}
            onToc={onToc}
            onState={onState}
            onTextSelection={onTextSelection}
            annotations={annotations}
          />
        ) : (
            <div className="reader-empty">
              <span className="reader-empty-icon">◈</span>
              <h2>Your reading space is ready</h2>
              <p>Open a local PDF or EPUB. Clio keeps the file in its original location and reads it on this device.</p>
            <button className="reader-primary-button" onClick={onOpen} disabled={openDisabled}>Open PDF or EPUB</button>
            </div>
          )}
          {status === "loading" && <div className="reader-loading" role="status"><span className="reader-spinner" />Loading document</div>}
          {status === "error" && <div className="reader-error" role="alert">{statusMessage}</div>}
        </div>
        {tocOpen && <aside className="reader-toc" aria-label="Table of contents">
          <div className="reader-toc-heading"><strong>Contents</strong><button onClick={() => setTocOpen(false)} aria-label="Close contents">×</button></div>
          {toc.length ? <TocList items={toc} onSelect={(item) => void engineRef.current?.goToToc(item)} /> : <p>No table of contents available.</p>}
        </aside>}
        {bookmarksOpen && (
          <aside className="reader-toc reader-bookmarks-panel" aria-label="Bookmarks">
            <div className="reader-toc-heading">
              <strong>Bookmarks ({bookmarks.length})</strong>
              <button
                type="button"
                onClick={() => setBookmarksOpen(false)}
                aria-label="Close bookmarks"
              >
                ×
              </button>
            </div>
            {bookmarks.length > 0 ? (
              <ol className="reader-toc-list reader-bookmarks-list">
                {bookmarks.map((b) => (
                  <li key={b.id} className="reader-bookmark-item">
                    <button
                      type="button"
                      className="reader-bookmark-jump"
                      onClick={() => void engineRef.current?.goToPosition?.(b.position)}
                      title={`Go to ${b.title || "bookmark"}`}
                    >
                      <span className="bookmark-star">★</span>
                      <span className="bookmark-title-text">{b.title || "Bookmark"}</span>
                    </button>
                    <button
                      type="button"
                      className="reader-bookmark-delete"
                      onClick={() => void removeBookmark(b.id)}
                      aria-label={`Delete bookmark ${b.title || ""}`}
                      title="Delete bookmark"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="reader-bookmarks-empty">
                No bookmarks yet. Click Bookmark in the toolbar to save your current page.
              </p>
            )}
          </aside>
        )}
        {annotationsOpen && (
          <aside className="reader-toc reader-annotations-panel" aria-label="Annotations">
            <div className="reader-toc-heading">
              <strong>Annotations ({annotations.length})</strong>
              <button
                type="button"
                onClick={() => {
                  setAnnotationsOpen(false);
                  setEditingAnnotationId(null);
                }}
                aria-label="Close annotations"
              >
                ×
              </button>
            </div>
            {annotationsLoading ? (
              <div className="reader-annotations-loading">
                <span className="reader-spinner" /> Loading annotations…
              </div>
            ) : annotations.length > 0 ? (
              <ol className="reader-toc-list reader-annotations-list">
                {annotations.map((a) => {
                  const isActive = isSameReadingPosition(a.position, currentPosition);
                  const isEditing = editingAnnotationId === a.id;
                  return (
                    <li
                      key={a.id}
                      className={`reader-annotation-item ${isActive ? "active" : ""}`}
                    >
                      <div className="reader-annotation-main">
                        <button
                          type="button"
                          className="reader-annotation-jump"
                          onClick={() => void engineRef.current?.goToPosition?.(a.position)}
                          title="Jump to annotation"
                        >
                          <div>
                            <span className="annotation-kind-badge">{a.kind}</span>
                            {isActive && <span className="annotation-active-badge">current</span>}
                          </div>
                          {a.selectedText && (
                            <span className="annotation-quote">"{a.selectedText}"</span>
                          )}
                        </button>
                        <div className="reader-annotation-actions">
                          {!isEditing && (
                            <button
                              type="button"
                              className="reader-annotation-edit-btn"
                              onClick={() => {
                                setEditingAnnotationId(a.id);
                                setEditingNoteText(a.note || "");
                              }}
                              title={a.note ? "Edit note" : "Add note"}
                            >
                              ✎
                            </button>
                          )}
                          <button
                            type="button"
                            className="reader-annotation-delete"
                            onClick={() => void removeAnnotation(a.id)}
                            aria-label="Delete annotation"
                            title="Delete annotation"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      {isEditing ? (
                        <div className="reader-annotation-edit-wrap">
                          <textarea
                            className="reader-annotation-edit-input"
                            value={editingNoteText}
                            onChange={(e) => setEditingNoteText(e.target.value)}
                            placeholder="Add or edit note…"
                            rows={2}
                            autoFocus
                          />
                          <div className="reader-annotation-edit-btns">
                            <button
                              type="button"
                              className="reader-annotation-save-btn"
                              onClick={() => void saveAnnotationNote(a.id)}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className="reader-annotation-cancel-btn"
                              onClick={() => setEditingAnnotationId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        a.note && <p className="reader-annotation-note-text">{a.note}</p>
                      )}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="reader-annotations-empty">
                No annotations yet. Select text in the document to highlight and add notes.
              </p>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
