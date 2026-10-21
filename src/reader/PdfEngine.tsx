import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type {
  ReaderEngineHandle,
  ReaderEngineProps,
  ReaderSearchResult,
  ReaderTocItem,
  ReaderZoomMode,
  TextSelection,
} from "./types";
import {
  calculatePdfFitScale,
  getReaderZoomLimits,
  transitionPdfZoomState,
  type PdfZoomState,
} from "./readerLogic";
import {
  PDF_THUMBNAIL_HEIGHT,
  PDF_THUMBNAIL_WIDTH,
  PdfThumbnailScheduler,
} from "./pdfThumbnailScheduler";
import { cancelPdfRenderTask, runPdfRenderTask } from "./pdfRenderLifecycle";

const PDF_ZOOM_LIMITS = getReaderZoomLimits("pdf")!;

GlobalWorkerOptions.workerSrc = pdfWorker;

type PdfOutlineNode = {
  title?: string;
  dest?: string | unknown[] | null;
  url?: string | null;
  items?: PdfOutlineNode[];
};
type PdfPageRef = {
  num: number;
  gen: number;
};

function pageText(page: PDFPageProxy) {
  return page.getTextContent().then((content) => content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
}

function getPdfContentBox(element: HTMLElement) {
  const style = globalThis.getComputedStyle(element);
  const paddingX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  const paddingY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  return {
    width: Math.max(0, element.clientWidth - (Number.isFinite(paddingX) ? paddingX : 0)),
    height: Math.max(0, element.clientHeight - (Number.isFinite(paddingY) ? paddingY : 0)),
  };
}

async function resolveDestination(pdf: PDFDocumentProxy, destination: string | unknown[] | null | undefined) {
  let resolved: string | unknown[] | null | undefined = destination;
  if (typeof destination === "string") {
    try {
      resolved = await pdf.getDestination(destination);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(resolved) || resolved.length === 0) return null;
  const target = resolved[0];
  if (typeof target === "number" && Number.isInteger(target)) return target + 1;
  if (!target || typeof target !== "object" || !("num" in target) || !("gen" in target)) return null;
  try {
    return (await pdf.getPageIndex(target as PdfPageRef)) + 1;
  } catch {
    return null;
  }
}

async function mapOutline(pdf: PDFDocumentProxy, nodes: PdfOutlineNode[], destinations: Map<string, number>, prefix = "pdf"): Promise<ReaderTocItem[]> {
  const mapped: ReaderTocItem[] = [];
  for (const [index, node] of nodes.entries()) {
    const id = `${prefix}-${index}`;
    const page = await resolveDestination(pdf, node.dest);
    if (page !== null) destinations.set(id, page);
    const children = Array.isArray(node.items) ? await mapOutline(pdf, node.items, destinations, id) : [];
    mapped.push({
      id,
      label: typeof node.title === "string" && node.title.trim() ? node.title : "Untitled section",
      children,
    });
  }
  return mapped;
}

export function PdfEngine({
  document,
  engineRef,
  initialPosition,
  onProgress,
  onPositionChange,
  onZoomChange,
  onZoomModeChange,
  onToc,
  onState,
  onTextSelection,
  onPageThumbnails,
}: ReaderEngineProps & { engineRef: React.RefObject<ReaderEngineHandle | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const tocDestinationsRef = useRef<Map<string, number>>(new Map());
  const loadTokenRef = useRef(0);
  const pageSequenceRef = useRef(0);
  const pageRef = useRef(1);
  const renderedPageRef = useRef<number | null>(null);
  const zoomStateRef = useRef<PdfZoomState>({ scale: 1, mode: "manual" });
  const [page, setPage] = useState(1);
  const [text, setText] = useState("");
  const searchMatchesRef = useRef<number[]>([]);
  const currentMatchIdxRef = useRef<number>(-1);
  const searchTokenRef = useRef(0);
  const onPageThumbnailsRef = useRef(onPageThumbnails);
  onPageThumbnailsRef.current = onPageThumbnails;
  const thumbnailSchedulerRef = useRef<PdfThumbnailScheduler | null>(null);
  if (!thumbnailSchedulerRef.current) {
    thumbnailSchedulerRef.current = new PdfThumbnailScheduler(async (pageNumber, signal) => {
      const pdf = pdfRef.current;
      const token = loadTokenRef.current;
      if (!pdf) throw new Error("PDF is not available.");
      const pdfPage = await pdf.getPage(pageNumber);
      if (signal.aborted || token !== loadTokenRef.current || pdf !== pdfRef.current) throw new Error("Thumbnail cancelled.");
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(PDF_THUMBNAIL_WIDTH / base.width, PDF_THUMBNAIL_HEIGHT / base.height);
      const viewport = pdfPage.getViewport({ scale });
      const canvas = globalThis.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not create thumbnail canvas.");
      const task = pdfPage.render({ canvas, canvasContext: context, viewport });
      const cancel = () => task.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await task.promise;
        if (signal.aborted || token !== loadTokenRef.current || pdf !== pdfRef.current) throw new Error("Thumbnail cancelled.");
        return canvas.toDataURL("image/jpeg", 0.65);
      } finally {
        signal.removeEventListener("abort", cancel);
        canvas.width = 0;
        canvas.height = 0;
      }
    }, (thumbnails) => onPageThumbnailsRef.current?.(thumbnails));
  }
  const thumbnailScheduler = thumbnailSchedulerRef.current;
  const updateZoomState = useCallback((next: PdfZoomState) => {
    zoomStateRef.current = next;
    onZoomChange?.(Math.round(next.scale * 100));
    onZoomModeChange?.(next.mode);
  }, [onZoomChange, onZoomModeChange]);
  const cancelRenderTask = useCallback(() => cancelPdfRenderTask(renderTaskRef), []);

  const disposePdf = useCallback(async () => {
    const renderSettled = cancelRenderTask();
    const loadingTask = loadingTaskRef.current;
    const pdf = pdfRef.current;
    loadingTaskRef.current = null;
    pdfRef.current = null;
    if (renderSettled) await renderSettled;
    if (loadingTask) {
      await loadingTask.destroy().catch(() => undefined);
    } else if (pdf) {
      await pdf.cleanup().catch(() => undefined);
    }
  }, [cancelRenderTask]);

  const renderPage = useCallback(async (pdf: PDFDocumentProxy, pageNumber: number, scale: number, token: number, sequence: number) => {
    const canvas = canvasRef.current;
    const active = () => token === loadTokenRef.current && sequence === pageSequenceRef.current;
    if (!canvas || !active()) return false;

    const renderSettled = cancelRenderTask();
    if (renderSettled) await renderSettled;
    if (!active()) return false;
    const pdfPage = await pdf.getPage(pageNumber);
    if (!active()) return false;
    const outputScale = Math.max(1, globalThis.devicePixelRatio || 1);
    const logicalViewport = pdfPage.getViewport({ scale });
    const scaledViewport = pdfPage.getViewport({ scale: scale * outputScale });
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create a PDF canvas context.");
    canvas.width = Math.ceil(scaledViewport.width);
    canvas.height = Math.ceil(scaledViewport.height);
    canvas.style.width = `${Math.ceil(logicalViewport.width)}px`;
    canvas.style.height = `${Math.ceil(logicalViewport.height)}px`;
    const renderTask = pdfPage.render({
      canvas,
      canvasContext: context,
      viewport: scaledViewport,
    });
    return runPdfRenderTask(renderTaskRef, renderTask, active);
  }, [cancelRenderTask]);

  const loadPage = useCallback(async (pdf: PDFDocumentProxy, nextPage: number, token: number) => {
    if (token !== loadTokenRef.current) return false;
    const sequence = ++pageSequenceRef.current;
    const active = () => token === loadTokenRef.current && sequence === pageSequenceRef.current;
    if (!active()) return false;
    pageRef.current = nextPage;
    setPage(nextPage);
    const pdfPage = await pdf.getPage(nextPage);
    if (!active()) return false;
    const nextText = await pageText(pdfPage);
    if (!active()) return false;
    setText(nextText);

    let renderScale = zoomStateRef.current.scale;
    const mode = zoomStateRef.current.mode;
    if (mode !== "manual") {
      const container = canvasRef.current?.parentElement;
      if (container) {
        const baseViewport = pdfPage.getViewport({ scale: 1 });
        const fitScale = calculatePdfFitScale(
          { width: baseViewport.width, height: baseViewport.height },
          getPdfContentBox(container),
          mode,
          PDF_ZOOM_LIMITS
        );
        if (fitScale !== null) {
          const nextZoomState = transitionPdfZoomState(
            zoomStateRef.current,
            { type: "fit", mode, scale: fitScale },
            PDF_ZOOM_LIMITS
          );
          renderScale = nextZoomState.scale;
          updateZoomState(nextZoomState);
        }
      }
    }

    if (!await renderPage(pdf, nextPage, renderScale, token, sequence)) return false;
    if (!active()) return false;
    renderedPageRef.current = nextPage;
    onProgress({ current: nextPage, total: pdf.numPages, fraction: nextPage / pdf.numPages });
    onPositionChange?.({
      kind: "pdf-page",
      page: nextPage,
      progression: nextPage / pdf.numPages,
    });
    return true;
  }, [onPositionChange, onProgress, renderPage, updateZoomState]);

  useEffect(() => {
    const token = ++loadTokenRef.current;
    thumbnailScheduler.setDocument();
    onPageThumbnailsRef.current?.([]);
    ++pageSequenceRef.current;
    let cancelled = false;
    const active = () => !cancelled && token === loadTokenRef.current;
    onState("loading", "Loading PDF…");
    onToc([]);
    tocDestinationsRef.current.clear();
    setText("");
    pageRef.current = 1;
    renderedPageRef.current = null;
    setPage(1);
    updateZoomState(transitionPdfZoomState(zoomStateRef.current, { type: "reset" }, PDF_ZOOM_LIMITS));
    searchMatchesRef.current = [];
    currentMatchIdxRef.current = -1;
    searchTokenRef.current += 1;
    void disposePdf();

    const load = async () => {
      const bytes = await document.bytes.arrayBuffer();
      if (!active()) return;
      const loadingTask = getDocument({ data: bytes });
      loadingTaskRef.current = loadingTask;
      loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
        if (active() && total > 0) onProgress({ current: loaded, total, fraction: loaded / total, label: "Loading PDF…" });
      };
      const pdf = await loadingTask.promise;
      if (!active()) {
        if (loadingTaskRef.current === loadingTask) {
          loadingTaskRef.current = null;
          await loadingTask.destroy().catch(() => undefined);
        }
        return;
      }
      pdfRef.current = pdf;
      try {
        const outline = await pdf.getOutline();
        if (outline) {
          const destinations = new Map<string, number>();
          const mapped = await mapOutline(pdf, outline as PdfOutlineNode[], destinations);
          if (active()) {
            tocDestinationsRef.current = destinations;
            onToc(mapped);
          }
        }
      } catch {
        if (active()) onToc([]);
      }
      const startPage =
        initialPosition?.kind === "pdf-page" &&
        Number.isInteger(initialPosition.page) &&
        initialPosition.page >= 1 &&
        initialPosition.page <= pdf.numPages
          ? initialPosition.page
          : 1;
      if (await loadPage(pdf, startPage, token) && active()) onState("ready", `PDF.js loaded ${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}.`);
    };

    void load().catch((error: unknown) => {
      if (active()) onState("error", error instanceof Error ? error.message : String(error));
    });

    return () => {
      cancelled = true;
      ++loadTokenRef.current;
      ++pageSequenceRef.current;
      searchTokenRef.current += 1;
      thumbnailScheduler.cancelAll();
      void disposePdf();
    };
  }, [document, disposePdf, initialPosition, loadPage, onProgress, onState, onToc, updateZoomState, thumbnailScheduler]);


  const applyFitMode = useCallback(async (requestedMode?: Exclude<ReaderZoomMode, "manual">) => {
    const mode = requestedMode ?? zoomStateRef.current.mode;
    if (mode === "manual") return;
    if (requestedMode) {
      updateZoomState({ ...zoomStateRef.current, mode: requestedMode });
    }
    const pdf = pdfRef.current;
    const container = canvasRef.current?.parentElement;
    if (!pdf || !container) return;

    const token = loadTokenRef.current;
    const pageNumber = pageRef.current;
    const sequence = ++pageSequenceRef.current;
    const active = () =>
      token === loadTokenRef.current &&
      sequence === pageSequenceRef.current &&
      pageNumber === pageRef.current &&
      mode === zoomStateRef.current.mode;
    const pdfPage = await pdf.getPage(pageNumber);
    if (!active()) return;
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    const fitScale = calculatePdfFitScale(
      { width: baseViewport.width, height: baseViewport.height },
      getPdfContentBox(container),
      mode,
      PDF_ZOOM_LIMITS
    );
    if (fitScale === null) return;
    const nextZoomState = transitionPdfZoomState(
      zoomStateRef.current,
      { type: "fit", mode, scale: fitScale },
      PDF_ZOOM_LIMITS
    );
    updateZoomState(nextZoomState);
    if (!await renderPage(pdf, pageNumber, nextZoomState.scale, token, sequence) || !active()) return;
    if (renderedPageRef.current !== pageNumber) {
      renderedPageRef.current = pageNumber;
      onProgress({ current: pageNumber, total: pdf.numPages, fraction: pageNumber / pdf.numPages });
      onPositionChange?.({
        kind: "pdf-page",
        page: pageNumber,
        progression: pageNumber / pdf.numPages,
      });
    }
  }, [onPositionChange, onProgress, renderPage, updateZoomState]);

  useEffect(() => {
    const container = canvasRef.current?.parentElement;
    if (!container || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    let previousWidth = -1;
    let previousHeight = -1;
    const observer = new ResizeObserver(() => {
      const available = getPdfContentBox(container);
      if (available.width === previousWidth && available.height === previousHeight) return;
      previousWidth = available.width;
      previousHeight = available.height;
      if (zoomStateRef.current.mode === "manual" || frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (zoomStateRef.current.mode !== "manual") void applyFitMode();
      });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [applyFitMode]);

  useImperativeHandle(engineRef, () => ({
    previous: async () => {
      const pdf = pdfRef.current;
      const token = loadTokenRef.current;
      if (!pdf || pageRef.current <= 1) return;
      await loadPage(pdf, pageRef.current - 1, token);
    },
    next: async () => {
      const pdf = pdfRef.current;
      const token = loadTokenRef.current;
      if (!pdf || pageRef.current >= pdf.numPages) return;
      await loadPage(pdf, pageRef.current + 1, token);
    },
    zoomOut: async () => {
      const pdf = pdfRef.current;
      const nextState = transitionPdfZoomState(
        zoomStateRef.current,
        { type: "step", direction: -1 },
        PDF_ZOOM_LIMITS
      );
      updateZoomState(nextState);
      const token = loadTokenRef.current;
      const sequence = ++pageSequenceRef.current;
      if (pdf) await renderPage(pdf, pageRef.current, nextState.scale, token, sequence);
    },
    zoomIn: async () => {
      const pdf = pdfRef.current;
      const nextState = transitionPdfZoomState(
        zoomStateRef.current,
        { type: "step", direction: 1 },
        PDF_ZOOM_LIMITS
      );
      updateZoomState(nextState);
      const token = loadTokenRef.current;
      const sequence = ++pageSequenceRef.current;
      if (pdf) await renderPage(pdf, pageRef.current, nextState.scale, token, sequence);
    },
    resetZoom: async () => {
      const pdf = pdfRef.current;
      const nextState = transitionPdfZoomState(zoomStateRef.current, { type: "reset" }, PDF_ZOOM_LIMITS);
      updateZoomState(nextState);
      const token = loadTokenRef.current;
      const sequence = ++pageSequenceRef.current;
      if (pdf) await renderPage(pdf, pageRef.current, nextState.scale, token, sequence);
    },
    fitPage: () => applyFitMode("fit-page"),
    fitWidth: () => applyFitMode("fit-width"),
    search: async (query: string): Promise<ReaderSearchResult> => {
      const pdf = pdfRef.current;
      const token = loadTokenRef.current;
      const needle = query.trim().toLocaleLowerCase();
      if (!pdf || !needle) {
        searchMatchesRef.current = [];
        currentMatchIdxRef.current = -1;
        return { count: 0, label: "Enter a search term." };
      }

      const searchToken = ++searchTokenRef.current;
      const matches: number[] = [];
      for (let index = 1; index <= pdf.numPages; index += 1) {
        if (searchToken !== searchTokenRef.current || token !== loadTokenRef.current) {
          return { count: 0, label: "Search cancelled." };
        }
        const pdfPage = await pdf.getPage(index);
        if (searchToken !== searchTokenRef.current || token !== loadTokenRef.current) {
          return { count: 0, label: "Search cancelled." };
        }
        const haystack = (await pageText(pdfPage)).toLocaleLowerCase();
        let offset = haystack.indexOf(needle);
        while (offset >= 0) {
          matches.push(index);
          offset = haystack.indexOf(needle, offset + Math.max(needle.length, 1));
        }
      }
      if (searchToken !== searchTokenRef.current || token !== loadTokenRef.current) {
        return { count: 0, label: "Search cancelled." };
      }

      searchMatchesRef.current = matches;
      if (matches.length === 0) {
        currentMatchIdxRef.current = -1;
        return { count: 0, currentIndex: 0, label: "No matches found" };
      }

      let matchIndex = matches.findIndex((pageNum) => pageNum >= pageRef.current);
      if (matchIndex === -1) matchIndex = 0;
      currentMatchIdxRef.current = matchIndex;
      const targetPage = matches[matchIndex];
      if (targetPage !== pageRef.current && token === loadTokenRef.current) {
        await loadPage(pdf, targetPage, token);
      }
      return {
        count: matches.length,
        currentIndex: matchIndex + 1,
        label: `${matchIndex + 1} of ${matches.length}`,
      };
    },
    nextSearchResult: async (): Promise<ReaderSearchResult> => {
      const pdf = pdfRef.current;
      const token = loadTokenRef.current;
      const matches = searchMatchesRef.current;
      if (!pdf || matches.length === 0) {
        return { count: 0, label: "No search active" };
      }
      let nextIndex = currentMatchIdxRef.current + 1;
      if (nextIndex >= matches.length) nextIndex = 0;
      currentMatchIdxRef.current = nextIndex;
      const targetPage = matches[nextIndex];
      if (targetPage !== pageRef.current && token === loadTokenRef.current) {
        await loadPage(pdf, targetPage, token);
      }
      return {
        count: matches.length,
        currentIndex: nextIndex + 1,
        label: `${nextIndex + 1} of ${matches.length}`,
      };
    },
    previousSearchResult: async (): Promise<ReaderSearchResult> => {
      const pdf = pdfRef.current;
      const token = loadTokenRef.current;
      const matches = searchMatchesRef.current;
      if (!pdf || matches.length === 0) {
        return { count: 0, label: "No search active" };
      }
      let prevIndex = currentMatchIdxRef.current - 1;
      if (prevIndex < 0) prevIndex = matches.length - 1;
      currentMatchIdxRef.current = prevIndex;
      const targetPage = matches[prevIndex];
      if (targetPage !== pageRef.current && token === loadTokenRef.current) {
        await loadPage(pdf, targetPage, token);
      }
      return {
        count: matches.length,
        currentIndex: prevIndex + 1,
        label: `${prevIndex + 1} of ${matches.length}`,
      };
    },
    clearSearch: async () => {
      searchTokenRef.current += 1;
      searchMatchesRef.current = [];
      currentMatchIdxRef.current = -1;
    },
    goToToc: async (item: ReaderTocItem) => {
      const pdf = pdfRef.current;
      const destination = tocDestinationsRef.current.get(item.id);
      const token = loadTokenRef.current;
      if (pdf && destination !== undefined) await loadPage(pdf, destination, token);
    },
    goToPosition: async (pos) => {
      const pdf = pdfRef.current;
      const token = loadTokenRef.current;
      if (pdf && pos.kind === "pdf-page" && pos.page >= 1 && pos.page <= pdf.numPages) {
        await loadPage(pdf, pos.page, token);
      }
    },
    setPageThumbnailDemand: (pages) => thumbnailScheduler.setDemand(pages),
  }), [applyFitMode, engineRef, loadPage, renderPage, updateZoomState]);

  return (
    <div
      className="pdf-engine"
      onPointerUp={() => {
        // PDF text selection foundation: captures text selected from the
        // reader-text-preview overlay. This is NOT a durable locator —
        // the PDF.js TextLayer (DOM text overlay) is not yet implemented.
        // page + selectedText is stored for display only; highlight
        // restoration requires a future TextLayer milestone.
        if (!onTextSelection) return;
        const sel = globalThis.window?.getSelection?.();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const selectedText = sel.toString().trim();
        if (!selectedText) return;
        const selection: TextSelection = {
          locator: { kind: "pdf-page-text", page, selectedText },
          selectedText,
        };
        onTextSelection(selection);
      }}
    >
      <canvas ref={canvasRef} aria-label={`PDF page ${page}`} />
      {text && <p className="reader-text-preview">{text.slice(0, 500)}{text.length > 500 ? "…" : ""}</p>}
    </div>
  );
}
