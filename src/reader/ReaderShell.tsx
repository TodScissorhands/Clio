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
import {
  documentCommands,
  type CommandContext,
} from "../commands/documentCommands";
import { getDocumentDisplayTitle, hasCapability } from "../storage/domain";
import type {
  Collection,
  StoredDocument,
} from "../storage/domain";
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
import { parseReaderTheme, TOPBAR_HIDE_DELAY } from "./readerLogic";

// ── Persistence helpers (browser-side wrappers around pure parseReaderTheme) ──

function loadReaderTheme(): ReaderTheme {
  try {
    return parseReaderTheme(localStorage.getItem("clio-reader-theme"));
  } catch {
    return "light";
  }
}

function saveReaderTheme(theme: ReaderTheme): void {
  try {
    localStorage.setItem("clio-reader-theme", theme);
  } catch {
    // ignore
  }
}

// ── Props ──────────────────────────────────────────────────────────────────────

export type ReaderShellProps = {
  document: ReaderDocument | null;
  /** The matching StoredDocument from the library catalog (for command context). */
  storedDocument?: StoredDocument | null;
  collections?: Collection[];
  onBack?: () => void;
  onOpen?: () => void;
  openDisabled?: boolean;
  onRemoveFromLibrary?: (docIds: string[]) => Promise<void>;
  onRevealInFileManager?: (doc: StoredDocument) => Promise<void>;
  onConvert?: (doc: StoredDocument) => void;
  onExtractPages?: (doc: StoredDocument) => void;
  onAddToLibrary?: () => Promise<void>;
};

// ── Navigator panel tab type ───────────────────────────────────────────────────

type NavigatorTab = "contents" | "bookmarks" | "notes";

// ── TocList component (unchanged from D1) ─────────────────────────────────────

function TocList({ items, onSelect }: { items: ReaderTocItem[]; onSelect(item: ReaderTocItem): void }) {
  return (
    <ol className="reader-toc-list">
      {items.map((item) => (
        <li key={item.id}>
          <button type="button" onClick={() => onSelect(item)}>
            {item.label}
          </button>
          {item.children && item.children.length > 0 && (
            <TocList items={item.children} onSelect={onSelect} />
          )}
        </li>
      ))}
    </ol>
  );
}

// ── Topbar hide delay imported from readerLogic (TOPBAR_HIDE_DELAY) ──────────

// ── Main component ─────────────────────────────────────────────────────────────

export function ReaderShell({
  document,
  storedDocument = null,
  collections = [],
  onBack,
  onOpen,
  openDisabled = false,
  onRemoveFromLibrary,
  onRevealInFileManager,
  onConvert,
  onExtractPages,
  onAddToLibrary,
}: ReaderShellProps) {
  const engineRef = useRef<ReaderEngineHandle | null>(null);

  // ── Reader display preferences (persisted) ───────────────────────────────────
  const [theme, setTheme] = useState<ReaderTheme>(loadReaderTheme);

  const applyTheme = useCallback((next: ReaderTheme) => {
    setTheme(next);
    saveReaderTheme(next);
  }, []);

  // ── Reading position & progress ──────────────────────────────────────────────
  const [progress, setProgress] = useState<ReaderProgress>({ current: 1 });
  const [toc, setToc] = useState<ReaderTocItem[]>([]);
  const [initialPosition, setInitialPosition] = useState<ReadingPosition | undefined>(undefined);
  const [positionLoaded, setPositionLoaded] = useState(false);
  const [currentPosition, setCurrentPosition] = useState<ReadingPosition | undefined>(undefined);

  // ── Engine state ─────────────────────────────────────────────────────────────
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [zoomPercent, setZoomPercent] = useState(100);

  // ── Search (Find) ────────────────────────────────────────────────────────────
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<ReaderSearchResult | null>(null);
  const [searchActiveQuery, setSearchActiveQuery] = useState("");
  const [searchPending, setSearchPending] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // ── Bookmarks & annotations ──────────────────────────────────────────────────
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationsLoading, setAnnotationsLoading] = useState(false);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState("");
  const [annotationNoteInput, setAnnotationNoteInput] = useState("");
  const [pendingTextSelection, setPendingTextSelection] = useState<TextSelection | null>(null);
  const [isAddingNote, setIsAddingNote] = useState(false);

  // ── Transient chrome visibility ──────────────────────────────────────────────
  const [topbarVisible, setTopbarVisible] = useState(true);
  const hideTimerRef = useRef<number | null>(null);

  // ── Navigator panel ──────────────────────────────────────────────────────────
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [navigatorTab, setNavigatorTab] = useState<NavigatorTab>("contents");

  // ── Display popover ──────────────────────────────────────────────────────────
  const [displayOpen, setDisplayOpen] = useState(false);

  // ── Document menu ────────────────────────────────────────────────────────────
  const [docMenuOpen, setDocMenuOpen] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);

  // ── ReadingState coordinator ─────────────────────────────────────────────────
  const coordinator = useMemo(
    () => new ReadingStateCoordinator({ getReadingState, setReadingState }),
    []
  );

  // ── Callbacks forwarded to engines ──────────────────────────────────────────
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
    // Reveal topbar so annotation toolbar is visible
    revealTopbar();
  }, []); // revealTopbar defined below; safe because both are stable refs

  const onState = useCallback((next: "loading" | "ready" | "error", message?: string) => {
    setStatus(next);
    setStatusMessage(message ?? "");
  }, []);

  // ── Topbar reveal / hide ──────────────────────────────────────────────────────

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);


  const revealTopbar = useCallback(() => {
    setTopbarVisible(true);
    clearHideTimer();
    hideTimerRef.current = setTimeout(() => {
      setTopbarVisible(false);
      hideTimerRef.current = null;
    }, TOPBAR_HIDE_DELAY) as unknown as number;
  }, [clearHideTimer]);

  const keepTopbarVisible = useCallback(() => {
    clearHideTimer();
    setTopbarVisible(true);
  }, [clearHideTimer]);

  // When a panel/popover is open, keep topbar visible
  useEffect(() => {
    if (navigatorOpen || displayOpen || docMenuOpen || findOpen || pendingTextSelection) {
      keepTopbarVisible();
    } else {
      // Start hide timer when all panels closed
      hideTimerRef.current = setTimeout(() => {
        setTopbarVisible(false);
        hideTimerRef.current = null;
      }, TOPBAR_HIDE_DELAY) as unknown as number;
    }
    return () => clearHideTimer();
  }, [navigatorOpen, displayOpen, docMenuOpen, findOpen, pendingTextSelection, keepTopbarVisible, clearHideTimer]);

  // ── Flush reading state on unload ─────────────────────────────────────────────
  useEffect(() => {
    const flush = () => { void coordinator.flush(); };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      void coordinator.flush();
    };
  }, [coordinator]);

  // ── Document change — reset all state ─────────────────────────────────────────
  useEffect(() => {
    clearHideTimer();
    if (!document) {
      void coordinator.flush();
      setInitialPosition(undefined);
      setPositionLoaded(false);
      setStatus("idle");
      setStatusMessage("");
      setProgress({ current: 1 });
      setToc([]);
      setQuery("");
      setSearchResult(null);
      setSearchActiveQuery("");
      setZoomPercent(100);
      setBookmarks([]);
      setAnnotations([]);
      setAnnotationsLoading(false);
      setEditingAnnotationId(null);
      setEditingNoteText("");
      setAnnotationNoteInput("");
      setCurrentPosition(undefined);
      setFindOpen(false);
      setNavigatorOpen(false);
      setDisplayOpen(false);
      setDocMenuOpen(false);
      setRemoveConfirm(false);
      setPendingTextSelection(null);
      setIsAddingNote(false);
      setTopbarVisible(true);
      return;
    }

    let cancelled = false;
    const docId = document.record.id;
    // Reset per-document transient state
    setStatus("loading");
    setStatusMessage("");
    setPositionLoaded(false);
    setProgress({ current: 1 });
    setToc([]);
    setQuery("");
    setSearchResult(null);
    setSearchActiveQuery("");
    setZoomPercent(100);
    setBookmarks([]);
    setAnnotations([]);
    setAnnotationsLoading(false);
    setEditingAnnotationId(null);
    setEditingNoteText("");
    setAnnotationNoteInput("");
    setCurrentPosition(undefined);
    // Close all panels on document switch (no state leak)
    setFindOpen(false);
    setNavigatorOpen(false);
    setDisplayOpen(false);
    setDocMenuOpen(false);
    setRemoveConfirm(false);
    setPendingTextSelection(null);
    setIsAddingNote(false);
    setTopbarVisible(true);

    coordinator.loadInitialPosition(docId).then((pos) => {
      if (cancelled) return;
      setInitialPosition(pos);
      if (pos) setCurrentPosition(pos);
      setPositionLoaded(true);
    });

    listBookmarks(docId)
      .then((list) => { if (!cancelled) setBookmarks(list); })
      .catch(() => { if (!cancelled) setBookmarks([]); });

    setAnnotationsLoading(true);
    listAnnotations(docId)
      .then((list) => { if (!cancelled) setAnnotations(list); })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAnnotations([]);
          onState(
            "error",
            `Could not load annotations: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })
      .finally(() => { if (!cancelled) setAnnotationsLoading(false); });

    return () => {
      cancelled = true;
      void coordinator.flush();
    };
  }, [coordinator, document, onState, clearHideTimer]);

  // ── Active bookmark ───────────────────────────────────────────────────────────
  const activeBookmark = useMemo(() => {
    return bookmarks.find((b) => isSameReadingPosition(b.position, currentPosition));
  }, [bookmarks, currentPosition]);

  // ── Bookmark toggle ───────────────────────────────────────────────────────────
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

  // ── Annotations ────────────────────────────────────────────────────────────────
  const saveAnnotationFromSelection = useCallback(async () => {
    if (!document || !currentPosition || !pendingTextSelection) return;
    const docId = document.record.id;
    const { locator, selectedText } = pendingTextSelection;
    const note = annotationNoteInput.trim() ? annotationNoteInput.trim() : undefined;
    try {
      const newAnn = await createAnnotation(docId, "highlight", currentPosition, selectedText, note, locator);
      setAnnotations((prev) => [...prev, newAnn]);
      setPendingTextSelection(null);
      setAnnotationNoteInput("");
    } catch (error) {
      onState("error", `Could not save annotation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [annotationNoteInput, currentPosition, document, onState, pendingTextSelection]);

  const handleQuickHighlight = useCallback(async () => {
    if (!document || !currentPosition || !pendingTextSelection) return;
    const docId = document.record.id;
    const { locator, selectedText } = pendingTextSelection;
    try {
      const newAnn = await createAnnotation(docId, "highlight", currentPosition, selectedText, undefined, locator);
      setAnnotations((prev) => [...prev, newAnn]);
      setPendingTextSelection(null);
      setAnnotationNoteInput("");
      setIsAddingNote(false);
    } catch (error) {
      onState("error", `Could not save highlight: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [currentPosition, document, onState, pendingTextSelection]);

  const handleCopySelection = useCallback(async () => {
    if (!pendingTextSelection?.selectedText) return;
    try {
      await navigator.clipboard.writeText(pendingTextSelection.selectedText);
    } catch {
      // ignore clipboard error
    }
    setPendingTextSelection(null);
    setAnnotationNoteInput("");
    setIsAddingNote(false);
  }, [pendingTextSelection]);

  const saveAnnotationNote = useCallback(async (annotationId: string) => {
    try {
      const updated = await updateAnnotation(annotationId, editingNoteText.trim() ? editingNoteText.trim() : undefined);
      setAnnotations((prev) => prev.map((a) => (a.id === annotationId ? updated : a)));
      setEditingAnnotationId(null);
      setEditingNoteText("");
    } catch (error) {
      onState("error", `Could not update annotation note: ${error instanceof Error ? error.message : String(error)}`);
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
      onState("error", `Could not delete annotation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [editingAnnotationId, onState]);

  // ── Find (search) ─────────────────────────────────────────────────────────────

  const clearSearch = useCallback(() => {
    setQuery("");
    setSearchResult(null);
    setSearchActiveQuery("");
    void engineRef.current?.clearSearch?.();
  }, []);

  const openFind = useCallback(() => {
    setFindOpen(true);
    keepTopbarVisible();
    // Focus happens in effect below when findOpen becomes true
  }, [keepTopbarVisible]);

  const closeFind = useCallback(() => {
    clearSearch();
    setFindOpen(false);
  }, [clearSearch]);

  useEffect(() => {
    if (findOpen) {
      // Small delay to let the element render
      const id = setTimeout(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }, 30);
      return () => clearTimeout(id);
    }
  }, [findOpen]);

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

  // ── Navigator panel ───────────────────────────────────────────────────────────

  const openNavigator = useCallback((tab?: NavigatorTab) => {
    if (tab) setNavigatorTab(tab);
    setNavigatorOpen(true);
    setDisplayOpen(false);
    setDocMenuOpen(false);
  }, []);

  const closeNavigator = useCallback(() => {
    setNavigatorOpen(false);
  }, []);

  // ── Display popover ───────────────────────────────────────────────────────────

  const toggleDisplay = useCallback(() => {
    setDisplayOpen((open) => {
      if (!open) {
        setDocMenuOpen(false);
        setNavigatorOpen(false);
      }
      return !open;
    });
  }, []);

  // ── Document menu ─────────────────────────────────────────────────────────────

  const toggleDocMenu = useCallback(() => {
    setDocMenuOpen((open) => {
      if (!open) {
        setDisplayOpen(false);
        setRemoveConfirm(false);
      }
      return !open;
    });
  }, []);

  // Build command context for document menu
  const commandCtx: CommandContext | null = useMemo(() => {
    if (!storedDocument) return null;
    return {
      documents: storedDocument ? [storedDocument] : [],
      selectedDocuments: [],
      activeDocument: storedDocument,
      collections,
      roots: [],
      onOpen: () => {},
      onAddToCollection: async () => {},
      onRemoveFromLibrary: onRemoveFromLibrary ?? (async () => {}),
      onConvert: onConvert ?? (() => {}),
      onMerge: () => {},
      onExtractPages: onExtractPages ?? (() => {}),
      onProperties: () => {},
      onRevealInFileManager: onRevealInFileManager ?? (async () => {}),
    };
  }, [storedDocument, collections, onRemoveFromLibrary, onConvert, onExtractPages, onRevealInFileManager]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!document) return;
      // OD-14/15: Do not process reader navigation keys when a modal or overlay is open
      if (window.document.querySelector(".modal-backdrop, .conversion-overlay-backdrop, .context-menu-backdrop")) {
        return;
      }

      const isInput =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement;

      // Ctrl/Cmd+F → open Find (always, even in input if not already open)
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        revealTopbar();
        openFind();
        return;
      }

      // Alt+Left or Cmd+[ → back to Library
      if (
        (event.altKey && event.key === "ArrowLeft") ||
        (event.metaKey && event.key === "[")
      ) {
        if (!isInput) {
          event.preventDefault();
          onBack?.();
          return;
        }
      }

      // Escape: dismiss transient UI layers (NOT navigation)
      if (event.key === "Escape") {
        if (editingAnnotationId) {
          setEditingAnnotationId(null);
          setEditingNoteText("");
          return;
        }
        if (isAddingNote) {
          setIsAddingNote(false);
          return;
        }
        if (pendingTextSelection) {
          setPendingTextSelection(null);
          setAnnotationNoteInput("");
          setIsAddingNote(false);
          return;
        }
        if (findOpen) {
          closeFind();
          return;
        }
        if (navigatorOpen) {
          setNavigatorOpen(false);
          return;
        }
        if (displayOpen) {
          setDisplayOpen(false);
          return;
        }
        if (docMenuOpen) {
          setDocMenuOpen(false);
          setRemoveConfirm(false);
          return;
        }
        // Toggle topbar reveal if nothing else to dismiss
        setTopbarVisible((v) => !v);
        return;
      }

      if (isInput) return;

      // Enter/Shift+Enter for search navigation when Find is open
      if (findOpen && event.key === "Enter") {
        event.preventDefault();
        if (!query.trim()) return;
        if (searchResult && searchActiveQuery === query.trim()) {
          if (event.shiftKey) void prevMatch();
          else void nextMatch();
        } else {
          void runSearch();
        }
        return;
      }

      // Ctrl/Cmd+B → toggle bookmark
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        void toggleBookmark();
        return;
      }

      // Page navigation
      if (event.key === "ArrowLeft") void engineRef.current?.previous();
      if (event.key === "ArrowRight") void engineRef.current?.next();

      // PDF zoom
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
  }, [
    document,
    editingAnnotationId,
    findOpen,
    navigatorOpen,
    displayOpen,
    docMenuOpen,
    pendingTextSelection,
    query,
    searchResult,
    searchActiveQuery,
    onBack,
    revealTopbar,
    openFind,
    closeFind,
    toggleBookmark,
    nextMatch,
    prevMatch,
    runSearch,
  ]);

  // ── Engine selection ──────────────────────────────────────────────────────────
  const Engine: ReaderEngineComponent | null =
    document?.record.format === "pdf"
      ? PdfEngine
      : document?.record.format === "epub"
      ? EpubEngine
      : document?.record.format === "txt" || document?.record.format === "md"
      ? TextEngine
      : null;

  // ── Capabilities (derived from format, before engine mounts) ─────────────────
  const canZoom = document?.record.format === "pdf";
  const canHighlight = document
    ? hasCapability(document.record.format, "textSelection")
    : false;
  const hasSearch = document
    ? hasCapability(document.record.format, "search")
    : false;
  const hasToc = toc.length > 0;
  const canBookmark = hasCapability(document?.record.format ?? "txt", "bookmarks");

  // ── Progress label ────────────────────────────────────────────────────────────
  const progressLabel = (() => {
    if (!document) return null;
    if (document.record.format === "pdf" && progress.total) {
      return `${progress.current} / ${progress.total}`;
    }
    if (progress.fraction != null) {
      return `${Math.round(progress.fraction * 100)}%`;
    }
    return progress.label ?? null;
  })();

  const progressFraction = (() => {
    if (progress.fraction != null) return progress.fraction;
    if (progress.total && progress.total > 0) return (progress.current - 1) / progress.total;
    return null;
  })();

  // ── Document display title ────────────────────────────────────────────────────
  const docTitle = document
    ? (storedDocument ? getDocumentDisplayTitle(storedDocument.record) : document.record.name)
    : null;

  // ── Mouse reveal zone handler ─────────────────────────────────────────────────
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // Reveal on proximity to top 60px
    if (e.clientY < 60) {
      revealTopbar();
    }
  }, [revealTopbar]);

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <section
      className={`reader-shell theme-${theme}${topbarVisible ? " topbar-visible" : " topbar-hidden"}${navigatorOpen ? " navigator-open" : ""}`}
      aria-label="Document reader"
      data-selection-active={pendingTextSelection ? "true" : undefined}
      onMouseMove={handleMouseMove}
    >
      {/* ── Pointer reveal zone (invisible strip) ──────────────────────────────── */}
      <div
        className="reader-reveal-zone"
        aria-hidden="true"
        onMouseEnter={revealTopbar}
        onClick={revealTopbar}
        onTouchStart={revealTopbar}
      />

      {/* ── Compact top bar (transient overlay) ──────────────────────────────────*/}
      <div
        className="reader-topbar"
        onMouseEnter={keepTopbarVisible}
        role="toolbar"
        aria-label="Reader controls"
      >
        {/* Left: Back */}
        <div className="reader-topbar-left">
          {onBack && (
            <button
              type="button"
              className="reader-topbar-btn reader-back-btn"
              onClick={onBack}
              title="Back to Library (Alt+Left)"
              aria-label="Back to Library"
            >
              ‹ Library
            </button>
          )}
        </div>

        {/* Center: Title */}
        <div className="reader-topbar-title" title={docTitle ?? undefined}>
          {docTitle ?? ""}
        </div>

        {/* Right: controls */}
        <div className="reader-topbar-right">
          {/* Bookmark toggle */}
          {canBookmark && document && (
            <button
              type="button"
              className={`reader-topbar-btn reader-topbar-icon-btn${activeBookmark ? " active" : ""}`}
              onClick={() => void toggleBookmark()}
              disabled={!currentPosition}
              title={activeBookmark ? "Remove bookmark (Ctrl B)" : "Bookmark this page (Ctrl B)"}
              aria-label={activeBookmark ? "Remove bookmark" : "Bookmark"}
            >
              {activeBookmark ? "★" : "☆"}
            </button>
          )}

          {/* Find */}
          {hasSearch && document && (
            <button
              type="button"
              className={`reader-topbar-btn${findOpen ? " active" : ""}`}
              onClick={() => (findOpen ? closeFind() : openFind())}
              title="Find (Ctrl F)"
              aria-label="Find"
              aria-pressed={findOpen}
            >
              Find
            </button>
          )}

          {/* Navigator */}
          {document && (
            <button
              type="button"
              className={`reader-topbar-btn${navigatorOpen ? " active" : ""}`}
              onClick={() => (navigatorOpen ? closeNavigator() : openNavigator())}
              title="Navigator — Contents, Bookmarks, Notes"
              aria-label="Navigator"
              aria-pressed={navigatorOpen}
            >
              Navigator
            </button>
          )}

          {/* Display */}
          {document && (
            <button
              type="button"
              className={`reader-topbar-btn${displayOpen ? " active" : ""}`}
              onClick={toggleDisplay}
              title="Display settings"
              aria-label="Display"
              aria-pressed={displayOpen}
            >
              Display
            </button>
          )}

          {/* Document menu */}
          {document && (storedDocument || onAddToLibrary) && (
            <button
              type="button"
              className={`reader-topbar-btn reader-topbar-icon-btn${docMenuOpen ? " active" : ""}`}
              onClick={toggleDocMenu}
              title="Document menu"
              aria-label="Document menu"
              aria-haspopup="menu"
              aria-expanded={docMenuOpen}
            >
              ⋯
            </button>
          )}
        </div>
      </div>

      {/* ── Display popover ────────────────────────────────────────────────────── */}
      {displayOpen && document && (
        <>
          <div
            className="reader-popover-backdrop"
            onClick={() => setDisplayOpen(false)}
            aria-hidden="true"
          />
          <div
            className="reader-display-popover"
            role="dialog"
            aria-label="Display settings"
            onMouseEnter={keepTopbarVisible}
          >
            <div className="reader-popover-section-label">Theme</div>
            <div className="reader-theme-group" role="radiogroup" aria-label="Reader theme">
              {(["light", "sepia", "dark"] as ReaderTheme[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`reader-theme-btn${theme === t ? " selected" : ""}`}
                  onClick={() => applyTheme(t)}
                  aria-pressed={theme === t}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            {canZoom && (
              <>
                <div className="reader-popover-section-label">Zoom</div>
                <div className="reader-zoom-row">
                  <button
                    type="button"
                    className="reader-zoom-btn"
                    onClick={() => void engineRef.current?.zoomOut()}
                    disabled={zoomPercent <= 50}
                    aria-label="Zoom out (Ctrl –)"
                    title="Zoom out (Ctrl –)"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    className="reader-zoom-reset-btn"
                    onClick={() => void engineRef.current?.resetZoom?.()}
                    title="Reset zoom (Ctrl 0)"
                  >
                    {zoomPercent}%
                  </button>
                  <button
                    type="button"
                    className="reader-zoom-btn"
                    onClick={() => void engineRef.current?.zoomIn()}
                    disabled={zoomPercent >= 250}
                    aria-label="Zoom in (Ctrl +)"
                    title="Zoom in (Ctrl +)"
                  >
                    +
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* ── Document menu popover ─────────────────────────────────────────────── */}
      {docMenuOpen && document && (
        <>
          <div
            className="reader-popover-backdrop"
            onClick={() => { setDocMenuOpen(false); setRemoveConfirm(false); }}
            aria-hidden="true"
          />
          <div
            className="reader-doc-menu"
            role="menu"
            aria-label="Document actions"
            onMouseEnter={keepTopbarVisible}
          >
            {!storedDocument && onAddToLibrary && (
              <button
                type="button"
                role="menuitem"
                className="reader-menu-item"
                onClick={() => {
                  setDocMenuOpen(false);
                  void onAddToLibrary();
                }}
              >
                Add to library
              </button>
            )}
            {storedDocument && commandCtx && documentCommands
              .filter((cmd) => cmd.id !== "open" && cmd.id !== "add-to-collection")
              .map((cmd, i, arr) => {
                const available = cmd.isAvailable(commandCtx);
                const prevCmd = arr[i - 1];
                const showDivider = i > 0 && prevCmd && prevCmd.group !== cmd.group;

                if (cmd.id === "remove-from-library") {
                  return (
                    <div key={cmd.id}>
                      {showDivider && <div className="reader-menu-divider" role="separator" />}
                      {removeConfirm ? (
                        <div className="reader-menu-confirm">
                          <span>Remove from library?</span>
                          <div className="reader-menu-confirm-btns">
                            <button
                              type="button"
                              className="reader-menu-confirm-yes"
                              onClick={() => {
                                void onRemoveFromLibrary?.([storedDocument.record.id]);
                                setDocMenuOpen(false);
                                setRemoveConfirm(false);
                                onBack?.();
                              }}
                            >
                              Remove
                            </button>
                            <button
                              type="button"
                              className="reader-menu-confirm-no"
                              onClick={() => setRemoveConfirm(false)}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          role="menuitem"
                          className={`reader-menu-item danger${!available ? " disabled" : ""}`}
                          disabled={!available}
                          onClick={() => setRemoveConfirm(true)}
                        >
                          {cmd.label}
                        </button>
                      )}
                    </div>
                  );
                }

                return (
                  <div key={cmd.id}>
                    {showDivider && <div className="reader-menu-divider" role="separator" />}
                    <button
                      type="button"
                      role="menuitem"
                      className={`reader-menu-item${!available ? " disabled" : ""}`}
                      disabled={!available}
                      onClick={() => {
                        setDocMenuOpen(false);
                        void cmd.execute(commandCtx);
                      }}
                    >
                      {cmd.label}
                    </button>
                  </div>
                );
              })}
          </div>
        </>
      )}

      {/* ── Navigator overlay panel ───────────────────────────────────────────── */}
      {navigatorOpen && document && (
        <>
          <div
            className="reader-navigator-backdrop"
            onClick={closeNavigator}
            aria-hidden="true"
          />
          <aside
            className="reader-navigator"
            aria-label="Navigator"
          >
            <div className="reader-navigator-header">
              <div className="reader-navigator-tabs" role="tablist">
                {(["contents", "bookmarks", "notes"] as NavigatorTab[]).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    className={`reader-nav-tab${navigatorTab === tab ? " active" : ""}`}
                    aria-selected={navigatorTab === tab}
                    onClick={() => setNavigatorTab(tab)}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                    {tab === "bookmarks" && bookmarks.length > 0 && ` (${bookmarks.length})`}
                    {tab === "notes" && annotations.length > 0 && ` (${annotations.length})`}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="reader-navigator-close"
                onClick={closeNavigator}
                aria-label="Close navigator"
              >
                ✕
              </button>
            </div>

            <div className="reader-navigator-body" role="tabpanel">
              {/* Contents tab */}
              {navigatorTab === "contents" && (
                hasToc ? (
                  <TocList items={toc} onSelect={(item) => {
                    void engineRef.current?.goToToc(item);
                    closeNavigator();
                  }} />
                ) : (
                  <p className="reader-navigator-empty">No table of contents available.</p>
                )
              )}

              {/* Bookmarks tab */}
              {navigatorTab === "bookmarks" && (
                <>
                  {canBookmark && currentPosition && (
                    <button
                      type="button"
                      className={`reader-nav-bookmark-toggle${activeBookmark ? " bookmarked" : ""}`}
                      onClick={() => void toggleBookmark()}
                    >
                      {activeBookmark ? "★ Remove bookmark" : "☆ Bookmark this position"}
                    </button>
                  )}
                  {bookmarks.length > 0 ? (
                    <ol className="reader-toc-list reader-bookmarks-list">
                      {bookmarks.map((b) => (
                        <li key={b.id} className="reader-bookmark-item">
                          <button
                            type="button"
                            className="reader-bookmark-jump"
                            onClick={() => {
                              void engineRef.current?.goToPosition?.(b.position);
                              closeNavigator();
                            }}
                            title={`Go to ${b.title || "bookmark"}`}
                          >
                            <span className="bookmark-star">★</span>
                            <span className="bookmark-title-text">{b.title || "Bookmark"}</span>
                          </button>
                          <button
                            type="button"
                            className="reader-bookmark-delete"
                            onClick={() => void removeBookmark(b.id)}
                            aria-label="Delete bookmark"
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="reader-navigator-empty">
                      No bookmarks yet.{canBookmark ? " Bookmark a position using the button above or the ☆ in the toolbar." : ""}
                    </p>
                  )}
                </>
              )}

              {/* Notes tab */}
              {navigatorTab === "notes" && (
                annotationsLoading ? (
                  <div className="reader-annotations-loading">
                    <span className="reader-spinner" /> Loading notes…
                  </div>
                ) : annotations.length > 0 ? (
                  <ol className="reader-toc-list reader-annotations-list">
                    {annotations.map((a) => {
                      const isActive = isSameReadingPosition(a.position, currentPosition);
                      const isEditing = editingAnnotationId === a.id;
                      return (
                        <li key={a.id} className={`reader-annotation-item${isActive ? " active" : ""}`}>
                          <div className="reader-annotation-main">
                            <button
                              type="button"
                              className="reader-annotation-jump"
                              onClick={() => {
                                void engineRef.current?.goToPosition?.(a.position);
                                closeNavigator();
                              }}
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
                                <button type="button" className="reader-annotation-save-btn" onClick={() => void saveAnnotationNote(a.id)}>Save</button>
                                <button type="button" className="reader-annotation-cancel-btn" onClick={() => setEditingAnnotationId(null)}>Cancel</button>
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
                  <p className="reader-navigator-empty">
                    {canHighlight
                      ? "No notes yet. Select text in the document to highlight and add notes."
                      : "Annotations are not supported for this format."}
                  </p>
                )
              )}
            </div>
          </aside>
        </>
      )}

      {/* ── Find bar (floating overlay, no layout shift) ─────────────────────── */}
      {findOpen && document && (
        <div
          className="reader-find-bar"
          role="search"
          aria-label="Find in document"
          onMouseEnter={keepTopbarVisible}
        >
          <div className="reader-find-input-wrap">
            <input
              ref={searchInputRef}
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
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeFind();
                }
              }}
              placeholder={`Find in ${document.record.format.toUpperCase()}…`}
              disabled={searchPending}
              aria-label="Find in document"
            />
            {query && (
              <button
                type="button"
                className="reader-find-clear"
                onClick={clearSearch}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            className="reader-find-btn"
            onClick={() => void runSearch()}
            disabled={!query.trim() || searchPending}
          >
            {searchPending ? "…" : "Find"}
          </button>
          {searchResult && searchResult.count > 0 && (
            <>
              <button
                type="button"
                className="reader-find-nav-btn"
                onClick={() => void prevMatch()}
                disabled={searchPending}
                aria-label="Previous match"
                title="Previous (Shift Enter)"
              >
                ▲
              </button>
              <button
                type="button"
                className="reader-find-nav-btn"
                onClick={() => void nextMatch()}
                disabled={searchPending}
                aria-label="Next match"
                title="Next (Enter)"
              >
                ▼
              </button>
            </>
          )}
          {searchResult && (
            <span className="reader-find-label" aria-live="polite">
              {searchResult.label}
            </span>
          )}
          <button
            type="button"
            className="reader-find-close"
            onClick={closeFind}
            aria-label="Close find"
            title="Close (Escape)"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Annotation toolbar (contextual, shown on text selection, OD-12) ──── */}
      {pendingTextSelection && (
        <div className="reader-annotate-bar" role="group" aria-label="Selection actions">
          {!isAddingNote ? (
            <div className="reader-selection-action-row">
              <button
                type="button"
                className="reader-annotate-action-btn highlight-btn"
                onClick={() => void handleQuickHighlight()}
                disabled={!document || !currentPosition}
                title="Highlight selected text"
              >
                Highlight
              </button>
              <button
                type="button"
                className="reader-annotate-action-btn note-btn"
                onClick={() => setIsAddingNote(true)}
                disabled={!document || !currentPosition}
                title="Add note to selection"
              >
                Add note
              </button>
              <button
                type="button"
                className="reader-annotate-action-btn copy-btn"
                onClick={() => void handleCopySelection()}
                title="Copy selected text"
              >
                Copy
              </button>
              <button
                type="button"
                className="reader-annotate-dismiss-btn"
                onClick={() => {
                  setPendingTextSelection(null);
                  setAnnotationNoteInput("");
                  setIsAddingNote(false);
                }}
                title="Dismiss (Escape)"
                aria-label="Dismiss selection"
              >
                ✕
              </button>
            </div>
          ) : (
            <div className="reader-note-editor-row">
              <input
                type="text"
                className="reader-annotate-note-input"
                value={annotationNoteInput}
                onChange={(e) => setAnnotationNoteInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveAnnotationFromSelection();
                    setIsAddingNote(false);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setIsAddingNote(false);
                  }
                }}
                placeholder="Type note…"
                autoFocus
              />
              <button
                type="button"
                className="reader-annotate-save-btn"
                onClick={() => {
                  void saveAnnotationFromSelection();
                  setIsAddingNote(false);
                }}
                disabled={!document || !currentPosition}
              >
                Save
              </button>
              <button
                type="button"
                className="reader-annotate-dismiss-btn"
                onClick={() => setIsAddingNote(false)}
                title="Cancel note"
                aria-label="Cancel note"
              >
                ✕
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Document viewport (primary, fills remaining space) ──────────────── */}
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
            onTextSelection={canHighlight ? onTextSelection : undefined}
            annotations={annotations}
          />
        ) : document && !positionLoaded ? (
          // Show nothing while waiting for position — engine not yet mounted
          null
        ) : (
          <div className="reader-empty">
            <span className="reader-empty-icon">◈</span>
            <p>Open a document from your library to begin reading.</p>
            {onOpen && (
              <button className="reader-primary-button" onClick={onOpen} disabled={openDisabled}>
                Open document…
              </button>
            )}
          </div>
        )}

        {/* Quiet loading indicator (only shown >300ms after mount) */}
        {status === "loading" && positionLoaded === false && (
          <div className="reader-loading-indicator" role="status" aria-live="polite">
            <span className="reader-spinner" />
          </div>
        )}

        {/* Error in document surface */}
        {status === "error" && (
          <div className="reader-error-toast" role="alert">
            {statusMessage}
          </div>
        )}
      </div>

      {/* ── Progress strip (bottom, quiet) ───────────────────────────────────── */}
      {document && (
        <div className="reader-progress-strip" aria-label={`Reading progress: ${progressLabel ?? ""}`}>
          {progressFraction != null && (
            <div
              className="reader-progress-bar"
              style={{ width: `${Math.min(progressFraction * 100, 100)}%` }}
              aria-hidden="true"
            />
          )}
          {progressLabel && (
            <span className="reader-progress-label">{progressLabel}</span>
          )}
        </div>
      )}
    </section>
  );
}
