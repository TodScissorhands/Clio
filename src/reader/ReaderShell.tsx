import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  ReaderDisplaySettings,
  ReaderDocument,
  ReaderEngineComponent,
  ReaderEngineHandle,
  ReaderProgress,
  ReaderSearchResult,
  ReaderTheme,
  ReaderTocItem,
  ReadingPosition,
  TextSelection,
  ReaderZoomMode,
  PdfPageThumbnail,
} from "./types";
import { DEFAULT_READER_DISPLAY_SETTINGS } from "./types";
import { PdfPageThumbnails } from "./PdfPageThumbnails";
import "./ReaderShell.css";
import {
  getReaderZoomLimits,
  pdfPageInputKeyAction,
  nextReaderFontSize,
  parseReaderDisplaySettings,
  parseReaderTheme,
  READER_FONT_SIZES,
  resolveEscapeAction,
  isCurrentReaderOperation,
  shouldHideReaderControls,
  TOPBAR_HIDE_DELAY,
  submitPdfPageNavigation,
} from "./readerLogic";

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

function loadReaderDisplaySettings(): ReaderDisplaySettings {
  try {
    return parseReaderDisplaySettings(localStorage.getItem("clio-reader-display"));
  } catch {
    return DEFAULT_READER_DISPLAY_SETTINGS;
  }
}

function saveReaderDisplaySettings(settings: ReaderDisplaySettings): void {
  try {
    localStorage.setItem("clio-reader-display", JSON.stringify(settings));
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
  onBack?: () => void | Promise<void>;
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
  const zoomLimits = getReaderZoomLimits(document?.record.format);
  const documentEpochRef = useRef(0);
  const searchRequestRef = useRef(0);
  const engineRef = useRef<ReaderEngineHandle | null>(null);
  const pageNumberInputRef = useRef<HTMLInputElement | null>(null);

  const [theme, setTheme] = useState<ReaderTheme>(loadReaderTheme);

  const applyTheme = useCallback((next: ReaderTheme) => {
    setTheme(next);
    saveReaderTheme(next);
  }, []);
  const [displaySettings, setDisplaySettings] = useState<ReaderDisplaySettings>(loadReaderDisplaySettings);

  const updateDisplaySetting = useCallback(<K extends keyof ReaderDisplaySettings,>(
    key: K,
    value: ReaderDisplaySettings[K],
  ) => {
    setDisplaySettings((current) => {
      const next = { ...current, [key]: value };
      saveReaderDisplaySettings(next);
      return next;
    });
  }, []);

  const changeReaderFontSize = useCallback((direction: -1 | 0 | 1) => {
    const next = direction === 0 ? 100 : nextReaderFontSize(displaySettings.fontSize, direction);
    updateDisplaySetting("fontSize", next);
  }, [displaySettings.fontSize, updateDisplaySetting]);

  // ── Reading position & progress ──────────────────────────────────────────────
  const [progress, setProgress] = useState<ReaderProgress>({ current: 1 });
  const [pageNumberInput, setPageNumberInput] = useState("1");
  const [pageNumberError, setPageNumberError] = useState("");
  const [toc, setToc] = useState<ReaderTocItem[]>([]);
  const [pageThumbnails, setPageThumbnails] = useState<readonly PdfPageThumbnail[]>([]);
  const [initialPosition, setInitialPosition] = useState<ReadingPosition | undefined>(undefined);
  const [positionLoaded, setPositionLoaded] = useState(false);
  const [currentPosition, setCurrentPosition] = useState<ReadingPosition | undefined>(undefined);

  // ── Engine state ─────────────────────────────────────────────────────────────
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [zoomPercent, setZoomPercent] = useState(100);
  const [zoomMode, setZoomMode] = useState<ReaderZoomMode>("manual");

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
  const topbarPointerRef = useRef(false);
  const topbarFocusRef = useRef(false);
  const topbarRef = useRef<HTMLDivElement | null>(null);
  const showControlsRef = useRef<HTMLButtonElement | null>(null);
  const navigatorTriggerRef = useRef<HTMLButtonElement | null>(null);

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

  const handleBack = useCallback(async () => {
    await coordinator.flush();
    await onBack?.();
  }, [coordinator, onBack]);

  // ── Callbacks forwarded to engines ──────────────────────────────────────────
  const onPositionChange = useCallback(
    (position: ReadingPosition) => {
      if (!document) return;
      setCurrentPosition(position);
      coordinator.recordPositionChange(document.record.id, position);
    },
    [coordinator, document]
  );

  const onProgress = useCallback((next: ReaderProgress) => {
    setProgress(next);
    if (
      next.label == null &&
      Number.isSafeInteger(next.current) &&
      Number.isSafeInteger(next.total) &&
      next.total! > 0
    ) {
      setPageNumberInput(String(next.current));
      setPageNumberError("");
    }
  }, []);
  const submitPageNumber = useCallback(() => {
    const submitted = submitPdfPageNavigation(
      pageNumberInput,
      progress.total ?? 0,
      (position) => void engineRef.current?.goToPosition?.(position)
    );
    if (!submitted) {
      setPageNumberError(
        progress.total
          ? `Enter a whole page number from 1 to ${progress.total}.`
          : "The PDF page count is not available yet."
      );
      return;
    }
    setPageNumberError("");
  }, [pageNumberInput, progress.total]);
  const cancelPageNumberEdit = useCallback(() => {
    setPageNumberInput(String(progress.current));
    setPageNumberError("");
    pageNumberInputRef.current?.blur();
  }, [progress.current]);
  const onToc = useCallback((next: ReaderTocItem[]) => setToc(next), []);
  const onPageThumbnails = useCallback((thumbnails: readonly PdfPageThumbnail[]) => setPageThumbnails(thumbnails), []);
  const setPageThumbnailDemand = useCallback((pages: readonly number[]) => engineRef.current?.setPageThumbnailDemand?.(pages), []);
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
      if (
        !topbarPointerRef.current &&
        !topbarFocusRef.current &&
        !navigatorOpen &&
        !displayOpen &&
        !docMenuOpen &&
        !findOpen &&
        !pendingTextSelection
      ) {
        setTopbarVisible(false);
      }
    }, TOPBAR_HIDE_DELAY) as unknown as number;
  }, [clearHideTimer, navigatorOpen, displayOpen, docMenuOpen, findOpen, pendingTextSelection]);

  const keepTopbarVisible = useCallback(() => {
    clearHideTimer();
    setTopbarVisible(true);
  }, [clearHideTimer]);

  // When a panel/popover is open, keep topbar visible
  useEffect(() => {
    if (navigatorOpen || displayOpen || docMenuOpen || findOpen || pendingTextSelection) {
      keepTopbarVisible();
    } else if (document?.record.format === "pdf" && status !== "ready") {
      keepTopbarVisible();
    } else if (document?.record.format === "pdf") {
      clearHideTimer();
      if (!topbarPointerRef.current && !topbarFocusRef.current) {
        setTopbarVisible(false);
      }
    } else {
      hideTimerRef.current = setTimeout(() => {
        setTopbarVisible(false);
        hideTimerRef.current = null;
      }, TOPBAR_HIDE_DELAY) as unknown as number;
    }
    return () => clearHideTimer();
  }, [
    navigatorOpen,
    displayOpen,
    docMenuOpen,
    findOpen,
    pendingTextSelection,
    document?.record.format,
    status,
    keepTopbarVisible,
    clearHideTimer,
  ]);

  useLayoutEffect(() => {
    if (
      !shouldHideReaderControls(document?.record.format, status) ||
      navigatorOpen ||
      displayOpen ||
      docMenuOpen ||
      findOpen ||
      pendingTextSelection ||
      topbarPointerRef.current ||
      topbarFocusRef.current
    ) return;
    clearHideTimer();
    setTopbarVisible(false);
  }, [
    document?.record.format,
    status,
    navigatorOpen,
    displayOpen,
    docMenuOpen,
    findOpen,
    pendingTextSelection,
    clearHideTimer,
  ]);

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
      setPageNumberInput("1");
      setPageNumberError("");
      setToc([]);
      setQuery("");
      setSearchResult(null);
      setSearchPending(false);
      setSearchActiveQuery("");
      setZoomPercent(100);
      setZoomMode("manual");
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

    const requestEpoch = ++documentEpochRef.current;
    searchRequestRef.current += 1;
    let cancelled = false;
    const docId = document.record.id;
    // Reset per-document transient state
    setStatus("loading");
    setStatusMessage("");
    setPositionLoaded(false);
    setProgress({ current: 1 });
    setPageNumberInput("1");
    setPageNumberError("");
    setToc([]);
    setQuery("");
    setSearchResult(null);
    setSearchActiveQuery("");
    setSearchPending(false);
    setZoomPercent(100);
    setZoomMode("manual");
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
      if (cancelled || !isCurrentReaderOperation(requestEpoch, documentEpochRef.current)) return;
      setInitialPosition(pos);
      if (pos) setCurrentPosition(pos);
      setPositionLoaded(true);
    });

    listBookmarks(docId)
      .then((list) => { if (!cancelled && isCurrentReaderOperation(requestEpoch, documentEpochRef.current)) setBookmarks(list); })
      .catch(() => { if (!cancelled && isCurrentReaderOperation(requestEpoch, documentEpochRef.current)) setBookmarks([]); });

    setAnnotationsLoading(true);
    listAnnotations(docId)
      .then((list) => {
        if (!cancelled && isCurrentReaderOperation(requestEpoch, documentEpochRef.current)) setAnnotations(list);
      })
      .catch((error: unknown) => {
        if (!cancelled && isCurrentReaderOperation(requestEpoch, documentEpochRef.current)) {
          setAnnotations([]);
          onState(
            "error",
            `Could not load annotations: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })
      .finally(() => {
        if (!cancelled && isCurrentReaderOperation(requestEpoch, documentEpochRef.current)) setAnnotationsLoading(false);
      });

    return () => {
      cancelled = true;
      if (isCurrentReaderOperation(requestEpoch, documentEpochRef.current)) documentEpochRef.current += 1;
      searchRequestRef.current += 1;
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
    const operationEpoch = documentEpochRef.current;
    if (activeBookmark) {
      try {
        await deleteBookmark(activeBookmark.id);
        if (isCurrentReaderOperation(operationEpoch, documentEpochRef.current)) {
          setBookmarks((prev) => prev.filter((b) => b.id !== activeBookmark.id));
        }
      } catch {}
    } else {
      try {
        const newBm = await createBookmark(docId, currentPosition);
        if (isCurrentReaderOperation(operationEpoch, documentEpochRef.current)) {
          setBookmarks((prev) => [...prev, newBm]);
        }
      } catch {}
    }
  }, [activeBookmark, currentPosition, document]);

  const removeBookmark = useCallback(async (bookmarkId: string) => {
    const operationEpoch = documentEpochRef.current;
    try {
      await deleteBookmark(bookmarkId);
      if (isCurrentReaderOperation(operationEpoch, documentEpochRef.current)) {
        setBookmarks((prev) => prev.filter((b) => b.id !== bookmarkId));
      }
    } catch {}
  }, []);

  // ── Annotations ────────────────────────────────────────────────────────────────
  const saveAnnotationFromSelection = useCallback(async () => {
    if (!document || !currentPosition || !pendingTextSelection) return;
    const docId = document.record.id;
    const operationEpoch = documentEpochRef.current;
    const { locator, selectedText } = pendingTextSelection;
    const note = annotationNoteInput.trim() ? annotationNoteInput.trim() : undefined;
    try {
      const newAnn = await createAnnotation(docId, "highlight", currentPosition, selectedText, note, locator);
      if (!isCurrentReaderOperation(operationEpoch, documentEpochRef.current)) return;
      setAnnotations((prev) => [...prev, newAnn]);
      setPendingTextSelection(null);
      setAnnotationNoteInput("");
    } catch (error) {
      if (isCurrentReaderOperation(operationEpoch, documentEpochRef.current)) {
        onState("error", `Could not save annotation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, [annotationNoteInput, currentPosition, document, onState, pendingTextSelection]);

  const handleQuickHighlight = useCallback(async () => {
    if (!document || !currentPosition || !pendingTextSelection) return;
    const docId = document.record.id;
    const operationEpoch = documentEpochRef.current;
    const { locator, selectedText } = pendingTextSelection;
    try {
      const newAnn = await createAnnotation(docId, "highlight", currentPosition, selectedText, undefined, locator);
      if (!isCurrentReaderOperation(operationEpoch, documentEpochRef.current)) return;
      setAnnotations((prev) => [...prev, newAnn]);
      setPendingTextSelection(null);
      setAnnotationNoteInput("");
      setIsAddingNote(false);
    } catch (error) {
      if (isCurrentReaderOperation(operationEpoch, documentEpochRef.current)) {
        onState("error", `Could not save highlight: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, [currentPosition, document, onState, pendingTextSelection]);

  const handleCopySelection = useCallback(async () => {
    if (!pendingTextSelection?.selectedText) return;
    const operationEpoch = documentEpochRef.current;
    try {
      await navigator.clipboard.writeText(pendingTextSelection.selectedText);
    } catch {
      // ignore clipboard error
    }
    if (!isCurrentReaderOperation(operationEpoch, documentEpochRef.current)) return;
    setPendingTextSelection(null);
    setAnnotationNoteInput("");
    setIsAddingNote(false);
  }, [pendingTextSelection]);

  const saveAnnotationNote = useCallback(async (annotationId: string) => {
    const operationEpoch = documentEpochRef.current;
    try {
      const updated = await updateAnnotation(annotationId, editingNoteText.trim() ? editingNoteText.trim() : undefined);
      if (!isCurrentReaderOperation(operationEpoch, documentEpochRef.current)) return;
      setAnnotations((prev) => prev.map((a) => (a.id === annotationId ? updated : a)));
      setEditingAnnotationId(null);
      setEditingNoteText("");
    } catch (error) {
      if (isCurrentReaderOperation(operationEpoch, documentEpochRef.current)) {
        onState("error", `Could not update annotation note: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, [editingNoteText, onState]);

  const removeAnnotation = useCallback(async (annotationId: string) => {
    const operationEpoch = documentEpochRef.current;
    try {
      await deleteAnnotation(annotationId);
      if (!isCurrentReaderOperation(operationEpoch, documentEpochRef.current)) return;
      setAnnotations((prev) => prev.filter((a) => a.id !== annotationId));
      if (editingAnnotationId === annotationId) {
        setEditingAnnotationId(null);
        setEditingNoteText("");
      }
    } catch (error) {
      if (isCurrentReaderOperation(operationEpoch, documentEpochRef.current)) {
        onState("error", `Could not delete annotation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, [editingAnnotationId, onState]);


  // ── Find (search) ─────────────────────────────────────────────────────────────

  const clearSearch = useCallback(() => {
    searchRequestRef.current += 1;
    setQuery("");
    setSearchResult(null);
    setSearchActiveQuery("");
    setSearchPending(false);
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
    const engine = engineRef.current;
    if (!trimmed || !engine) return;
    const requestId = ++searchRequestRef.current;
    const operationEpoch = documentEpochRef.current;
    setSearchPending(true);
    try {
      const result = await engine.search(trimmed);
      if (!isCurrentReaderOperation(operationEpoch, documentEpochRef.current, requestId, searchRequestRef.current)) return;
      setSearchResult(result);
      setSearchActiveQuery(trimmed);
    } finally {
      if (isCurrentReaderOperation(operationEpoch, documentEpochRef.current, requestId, searchRequestRef.current)) {
        setSearchPending(false);
      }
    }
  }, [query]);

  const nextMatch = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const requestId = ++searchRequestRef.current;
    const operationEpoch = documentEpochRef.current;
    setSearchPending(true);
    try {
      if (engine.nextSearchResult) {
        const result = await engine.nextSearchResult();
        if (isCurrentReaderOperation(operationEpoch, documentEpochRef.current, requestId, searchRequestRef.current)) {
          setSearchResult(result);
        }
      } else {
        await runSearch();
      }
    } finally {
      if (isCurrentReaderOperation(operationEpoch, documentEpochRef.current, requestId, searchRequestRef.current)) {
        setSearchPending(false);
      }
    }
  }, [runSearch]);

  const prevMatch = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const requestId = ++searchRequestRef.current;
    const operationEpoch = documentEpochRef.current;
    setSearchPending(true);
    try {
      if (engine.previousSearchResult) {
        const result = await engine.previousSearchResult();
        if (isCurrentReaderOperation(operationEpoch, documentEpochRef.current, requestId, searchRequestRef.current)) {
          setSearchResult(result);
        }
      } else {
        await runSearch();
      }
    } finally {
      if (isCurrentReaderOperation(operationEpoch, documentEpochRef.current, requestId, searchRequestRef.current)) {
        setSearchPending(false);
      }
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
    requestAnimationFrame(() => navigatorTriggerRef.current?.focus());
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
      if (event.target === pageNumberInputRef.current) return;
      // OD-14/15: Do not process reader navigation keys when a modal or overlay is open
      if (window.document.querySelector(".modal-backdrop, .conversion-overlay-backdrop, .context-menu-backdrop")) {
        return;
      }

      const isInput =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable);

      // Ctrl/Cmd+F → open Find (always, even in input if not already open)
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        revealTopbar();
        openFind();
        return;
      }

      // Alt+Left or Cmd+[ → flush reading state before returning to Library
      if (
        (event.altKey && event.key === "ArrowLeft") ||
        (event.metaKey && event.key === "[")
      ) {
        if (!isInput) {
          event.preventDefault();
          void handleBack();
          return;
        }
      }

      // Escape dismisses transient UI in one tested priority order; it never navigates.
      if (event.key === "Escape") {
        event.preventDefault();
        switch (resolveEscapeAction({
          editingAnnotationId,
          isAddingNote,
          pendingTextSelection: Boolean(pendingTextSelection),
          findOpen,
          navigatorOpen,
          displayOpen,
          docMenuOpen,
        })) {
          case "dismissAnnotationEdit":
            setEditingAnnotationId(null);
            setEditingNoteText("");
            break;
          case "dismissNoteEditor":
            setIsAddingNote(false);
            break;
          case "dismissTextSelection":
            setPendingTextSelection(null);
            setAnnotationNoteInput("");
            setIsAddingNote(false);
            break;
          case "closeFind":
            closeFind();
            break;
          case "closeNavigator":
            closeNavigator();
            break;
          case "closeDisplay":
            setDisplayOpen(false);
            break;
          case "closeDocMenu":
            setDocMenuOpen(false);
            setRemoveConfirm(false);
            break;
          case "toggleTopbar":
            if (topbarVisible) {
              if (topbarFocusRef.current && !shouldHideReaderControls(document?.record.format, status)) break;
              topbarPointerRef.current = false;
              topbarFocusRef.current = false;
              clearHideTimer();
              setTopbarVisible(false);
              if (shouldHideReaderControls(document?.record.format, status)) {
                requestAnimationFrame(() => showControlsRef.current?.focus());
              }
            } else {
              revealTopbar();
            }
            break;
        }
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

      if ((event.ctrlKey || event.metaKey) && (zoomLimits || document.record.format === "epub")) {
        if (event.key === "+" || event.key === "=" || event.key === "NumpadAdd") {
          event.preventDefault();
          if (document.record.format === "pdf") void engineRef.current?.zoomIn();
          else changeReaderFontSize(1);
          return;
        }
        if (event.key === "-" || event.key === "_" || event.key === "NumpadSubtract") {
          event.preventDefault();
          if (document.record.format === "pdf") void engineRef.current?.zoomOut();
          else changeReaderFontSize(-1);
          return;
        }
        if (event.key === "0" || event.key === "Numpad0") {
          event.preventDefault();
          if (document.record.format === "pdf") void engineRef.current?.resetZoom?.();
          else changeReaderFontSize(0);
          return;
        }
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    document,
    editingAnnotationId,
    isAddingNote,
    findOpen,
    navigatorOpen,
    displayOpen,
    docMenuOpen,
    pendingTextSelection,
    topbarVisible,
    query,
    searchResult,
    searchActiveQuery,
    handleBack,
    revealTopbar,
    openFind,
    closeFind,
    closeNavigator,
    clearHideTimer,
    toggleBookmark,
    nextMatch,
    prevMatch,
    runSearch,
    changeReaderFontSize,
    zoomLimits,
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
    if (document.record.format === "pdf") {
      if (status === "loading") return progress.label ?? "Loading PDF…";
      if (status !== "ready" || progress.total == null || progress.label != null) return null;
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

  const showReaderControls = useCallback(() => {
    revealTopbar();
    requestAnimationFrame(() => {
      topbarRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    });
  }, [revealTopbar]);

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <section
      className={`reader-shell theme-${theme}${topbarVisible ? " topbar-visible" : " topbar-hidden"}${navigatorOpen ? " navigator-open" : ""}${document?.record.format === "pdf" ? " pdf-reader" : ""}${displayOpen ? " display-open" : ""}`}
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
        ref={topbarRef}
        className="reader-topbar"
        onMouseEnter={() => {
          topbarPointerRef.current = true;
          keepTopbarVisible();
        }}
        onMouseLeave={() => {
          topbarPointerRef.current = false;
          if (!topbarFocusRef.current) revealTopbar();
        }}
        onFocusCapture={() => {
          topbarFocusRef.current = true;
          keepTopbarVisible();
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            topbarFocusRef.current = false;
            if (event.relatedTarget === showControlsRef.current) return;
            if (!topbarPointerRef.current) revealTopbar();
          }
        }}
        role="toolbar"
        aria-label="Reader controls"
      >
        {/* Left: Back */}
        <div className="reader-topbar-left">
          {onBack && (
            <button
              type="button"
              className="reader-topbar-btn reader-back-btn"
              onClick={() => void handleBack()}
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
          {document?.record.format === "pdf" &&
            status === "ready" &&
            progress.total != null &&
            progress.total > 0 &&
            progress.label == null && (
              <form
                className="reader-page-control"
                aria-label="PDF page navigation"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitPageNumber();
                }}
              >
                <label className="sr-only" htmlFor="reader-pdf-page-input">Go to PDF page</label>
                <input
                  ref={pageNumberInputRef}
                  id="reader-pdf-page-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={16}
                  value={pageNumberInput}
                  onChange={(event) => {
                    setPageNumberInput(event.target.value);
                    setPageNumberError("");
                  }}
                  onKeyDown={(event) => {
                    const action = pdfPageInputKeyAction(event.key);
                    if (action === "submit") {
                      event.preventDefault();
                      submitPageNumber();
                    } else if (action === "cancel") {
                      event.preventDefault();
                      event.stopPropagation();
                      cancelPageNumberEdit();
                    }
                  }}
                  aria-label={`PDF page number, currently ${progress.current} of ${progress.total}`}
                  aria-invalid={pageNumberError ? true : undefined}
                  aria-describedby="reader-pdf-page-total reader-pdf-page-error"
                  title={`Current page ${progress.current} of ${progress.total}`}
                />
                <span className="reader-page-total" id="reader-pdf-page-total">of {progress.total}</span>
                <button type="submit" className="reader-page-submit" aria-label="Go to page" title="Go to page">
                  Go
                </button>
                <span
                  className="reader-page-error"
                  id="reader-pdf-page-error"
                  role="status"
                  aria-live="polite"
                >
                  {pageNumberError}
                </span>
              </form>
            )}
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
              ref={navigatorTriggerRef}
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

      {document?.record.format === "pdf" && status === "ready" && !topbarVisible && (
        <button
          ref={showControlsRef}
          type="button"
          className="reader-controls-reveal"
          onClick={showReaderControls}
          aria-label="Show controls"
        >
          Show controls
        </button>
      )}

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
            {document.record.format !== "pdf" && (
              <>
                <div className="reader-popover-section-label">Typography</div>
                <label className="reader-setting-row">
                  <span>Font family</span>
                  <select
                    aria-label="Font family"
                    value={displaySettings.fontFamily}
                    onChange={(event) => updateDisplaySetting("fontFamily", event.target.value as ReaderDisplaySettings["fontFamily"])}
                  >
                    <option value="book">Document default</option>
                    <option value="serif">Serif</option>
                    <option value="sans">Sans serif</option>
                    <option value="mono">Monospace</option>
                  </select>
                </label>
                <label className="reader-setting-row">
                  <span>Font size</span>
                  <select
                    aria-label="Font size"
                    value={displaySettings.fontSize}
                    onChange={(event) => updateDisplaySetting("fontSize", Number(event.target.value))}
                  >
                    {READER_FONT_SIZES.map((size) => <option key={size} value={size}>{size}%</option>)}
                  </select>
                </label>
                <label className="reader-setting-row">
                  <span>Line height</span>
                  <select
                    aria-label="Line height"
                    value={displaySettings.lineHeight}
                    onChange={(event) => updateDisplaySetting("lineHeight", event.target.value as ReaderDisplaySettings["lineHeight"])}
                  >
                    <option value="book">Document default</option>
                    <option value="1.4">Compact</option>
                    <option value="1.6">Normal</option>
                    <option value="1.8">Relaxed</option>
                    <option value="2">Wide</option>
                  </select>
                </label>
                <label className="reader-setting-row">
                  <span>Paragraph spacing</span>
                  <select
                    aria-label="Paragraph spacing"
                    value={displaySettings.paragraphSpacing}
                    onChange={(event) => updateDisplaySetting("paragraphSpacing", event.target.value as ReaderDisplaySettings["paragraphSpacing"])}
                  >
                    <option value="book">Document default</option>
                    <option value="0.5">Compact</option>
                    <option value="1">Normal</option>
                    <option value="1.5">Relaxed</option>
                  </select>
                </label>
                <label className="reader-setting-row">
                  <span>Content width</span>
                  <select
                    aria-label="Content width"
                    value={displaySettings.contentWidth}
                    onChange={(event) => updateDisplaySetting("contentWidth", event.target.value as ReaderDisplaySettings["contentWidth"])}
                  >
                    <option value="narrow">Narrow</option>
                    <option value="default">Default</option>
                    <option value="wide">Wide</option>
                  </select>
                </label>
              </>
            )}

            {document.record.format === "pdf" && zoomLimits && (
              <>
                <div className="reader-popover-section-label">Zoom</div>
                <div className="reader-zoom-row">
                  <button
                    type="button"
                    className="reader-zoom-btn"
                    onClick={() => void engineRef.current?.zoomOut()}
                    disabled={zoomMode === "manual" && zoomPercent <= zoomLimits.min}
                    aria-label="Zoom out (Ctrl –)"
                    title="Zoom out (Ctrl –)"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    className="reader-zoom-reset-btn"
                    onClick={() => void engineRef.current?.resetZoom?.()}
                    aria-label="Reset zoom to 100 percent (Ctrl 0)"
                    title="Reset zoom (Ctrl 0)"
                  >
                    {zoomPercent}%
                  </button>
                  <button
                    type="button"
                    className="reader-zoom-btn"
                    onClick={() => void engineRef.current?.zoomIn()}
                    disabled={zoomMode === "manual" && zoomPercent >= zoomLimits.max}
                    aria-label="Zoom in (Ctrl +)"
                    title="Zoom in (Ctrl +)"
                  >
                    +
                  </button>
                </div>
                <div className="reader-zoom-fit-row" role="group" aria-label="PDF fit mode">
                  <button
                    type="button"
                    className={`reader-zoom-fit-btn${zoomMode === "fit-page" ? " active" : ""}`}
                    onClick={() => void engineRef.current?.fitPage?.()}
                    aria-pressed={zoomMode === "fit-page"}
                    disabled={status !== "ready"}
                  >
                    Fit page
                  </button>
                  <button
                    type="button"
                    className={`reader-zoom-fit-btn${zoomMode === "fit-width" ? " active" : ""}`}
                    onClick={() => void engineRef.current?.fitWidth?.()}
                    aria-pressed={zoomMode === "fit-width"}
                    disabled={status !== "ready"}
                  >
                    Fit width
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
                                void handleBack();
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

      <div className="reader-workspace">
      {/* ── Navigator overlay panel ───────────────────────────────────────────── */}
      {navigatorOpen && document && (
        <>
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
                <>
                  {document.record.format === "pdf" &&
                    status === "ready" &&
                    progress.label == null &&
                    progress.total != null &&
                    progress.total > 0 && (
                    <PdfPageThumbnails
                      totalPages={progress.total}
                      currentPage={progress.current}
                      thumbnails={pageThumbnails}
                      onDemand={setPageThumbnailDemand}
                      onSelect={(pageNumber) => {
                        void engineRef.current?.goToPosition?.({ kind: "pdf-page", page: pageNumber });
                        closeNavigator();
                      }}
                    />
                  )}
                  {hasToc ? (
                    <TocList items={toc} onSelect={(item) => {
                      void engineRef.current?.goToToc(item);
                      closeNavigator();
                    }} />
                  ) : document.record.format !== "pdf" ? (
                    <p className="reader-navigator-empty">No table of contents available.</p>
                  ) : null}
                </>
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
            displaySettings={displaySettings}
            onDisplayFontSizeChange={changeReaderFontSize}
            initialPosition={initialPosition}
            onProgress={onProgress}
            onPositionChange={onPositionChange}
            onZoomChange={setZoomPercent}
            onZoomModeChange={setZoomMode}
            onToc={onToc}
            onPageThumbnails={onPageThumbnails}
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
      </div>

      {/* ── Progress strip (bottom, quiet) ───────────────────────────────────── */}
      {document?.record.format === "pdf" && status === "ready" ? (
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {progress.total == null ? `Page ${progress.current}` : `Page ${progress.current} of ${progress.total}`}
        </div>
      ) : document ? (
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
      ) : null}
    </section>
  );
}
