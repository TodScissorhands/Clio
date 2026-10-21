import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PdfPageThumbnail } from "./types";
import { getPdfThumbnailPresentation, getThumbnailDemand } from "./pdfThumbnailScheduler";

const ROW_HEIGHT = 84;
const OVERSCAN = 2;

export function PdfPageThumbnails({
  totalPages,
  currentPage,
  thumbnails,
  onDemand,
  onSelect,
}: {
  totalPages: number;
  currentPage: number;
  thumbnails: readonly PdfPageThumbnail[];
  onDemand(pages: readonly number[]): void;
  onSelect(page: number): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [windowState, setWindowState] = useState({ start: 0, end: 8 });
  const byPage = useMemo(() => new Map(thumbnails.map((thumbnail) => [thumbnail.page, thumbnail])), [thumbnails]);

  const updateWindow = useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    const start = Math.max(0, Math.floor(element.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visible = Math.ceil(element.clientHeight / ROW_HEIGHT);
    const end = Math.min(totalPages, start + visible + OVERSCAN * 2);
    setWindowState((current) => current.start === start && current.end === end ? current : { start, end });
  }, [totalPages]);

  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element || currentPage < 1) return;
    const top = (currentPage - 1) * ROW_HEIGHT;
    if (top < element.scrollTop || top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - element.clientHeight / 2);
    }
    updateWindow();
  }, [currentPage, updateWindow]);

  const visiblePages = useMemo(
    () => Array.from({ length: Math.max(0, Math.min(totalPages, windowState.end) - windowState.start) }, (_, index) => windowState.start + index + 1),
    [windowState, totalPages],
  );
  useEffect(() => {
    onDemand(getThumbnailDemand(visiblePages, currentPage, totalPages));
  }, [visiblePages, currentPage, totalPages, onDemand]);
  useEffect(() => () => onDemand([]), [onDemand]);
  useEffect(() => {
    const element = listRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateWindow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateWindow]);

  return (
    <div
      ref={listRef}
      className="reader-pdf-pages"
      role="list"
      aria-label="PDF pages"
      onScroll={updateWindow}
    >
      <div className="reader-pdf-pages-spacer" style={{ height: totalPages * ROW_HEIGHT }}>
        {visiblePages.map((page) => {
          const thumbnail = byPage.get(page);
          const presentation = getPdfThumbnailPresentation(page, currentPage, thumbnail?.error === true);
          return (
            <div key={page} role="listitem" aria-posinset={page} aria-setsize={totalPages} style={{ top: (page - 1) * ROW_HEIGHT, height: ROW_HEIGHT }}>
              <button
                type="button"
                className={`reader-pdf-page${presentation.current ? " current" : ""}`}
                aria-label={presentation.ariaLabel}
                aria-current={presentation.ariaCurrent}
                onClick={() => onSelect(page)}
              >
                <span className="reader-pdf-thumbnail" aria-hidden="true">
                  {thumbnail?.dataUrl ? <img src={thumbnail.dataUrl} alt="" /> : thumbnail?.error ? <span className="reader-pdf-thumbnail-error">Preview unavailable</span> : <span className="reader-pdf-thumbnail-loading">Loading…</span>}
                </span>
                <span className="reader-pdf-page-number">{page}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
