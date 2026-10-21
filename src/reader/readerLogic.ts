/**
 * Pure, side-effect-free logic extracted from ReaderShell for testability.
 *
 * Nothing in this module may import React, Tauri, or browser globals.
 */

import {
  DEFAULT_READER_DISPLAY_SETTINGS,
  type ReaderContentWidth,
  type ReaderDisplaySettings,
  type ReaderFontFamily,
  type ReaderLineHeight,
  type ReaderParagraphSpacing,
  type ReaderTheme,
  type ReaderZoomMode,
} from "./types";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Milliseconds of inactivity before the reader topbar auto-hides. */
export const TOPBAR_HIDE_DELAY = 2500;

export function shouldHideReaderControls(format: string | undefined, status: string): boolean {
  return format === "pdf" && status === "ready";
}

// ── Theme persistence helpers ─────────────────────────────────────────────────

/**
 * Parse a raw localStorage value into a valid ReaderTheme.
 * Returns "light" if the value is absent or unrecognised.
 */
export function parseReaderTheme(raw: string | null | undefined): ReaderTheme {
  if (raw === "light" || raw === "sepia" || raw === "dark") return raw;
  return "light";
}

export const READER_FONT_SIZES = [80, 90, 100, 110, 120, 130, 140] as const;

export function parseReaderDisplaySettings(raw: string | null | undefined): ReaderDisplaySettings {
  if (!raw) return DEFAULT_READER_DISPLAY_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<ReaderDisplaySettings>;
    return {
      fontFamily: ["book", "serif", "sans", "mono"].includes(value.fontFamily ?? "")
        ? value.fontFamily as ReaderFontFamily : "book",
      fontSize: READER_FONT_SIZES.includes(value.fontSize as (typeof READER_FONT_SIZES)[number])
        ? value.fontSize as number : 100,
      lineHeight: ["book", "1.4", "1.6", "1.8", "2"].includes(value.lineHeight ?? "")
        ? value.lineHeight as ReaderLineHeight : "book",
      paragraphSpacing: ["book", "0.5", "1", "1.5"].includes(value.paragraphSpacing ?? "")
        ? value.paragraphSpacing as ReaderParagraphSpacing : "book",
      contentWidth: ["narrow", "default", "wide"].includes(value.contentWidth ?? "")
        ? value.contentWidth as ReaderContentWidth : "default",
    };
  } catch {
    return DEFAULT_READER_DISPLAY_SETTINGS;
  }
}

export function nextReaderFontSize(current: number, direction: -1 | 1) {
  const currentIndex = READER_FONT_SIZES.indexOf(current as (typeof READER_FONT_SIZES)[number]);
  const baseIndex = currentIndex < 0 ? READER_FONT_SIZES.indexOf(100) : currentIndex;
  return READER_FONT_SIZES[Math.max(0, Math.min(READER_FONT_SIZES.length - 1, baseIndex + direction))]!;
}

export function readerContentWidth(width: ReaderContentWidth) {
  return { narrow: "560px", default: "720px", wide: "840px" }[width];
}
export function scaleReaderFontSize(basePixels: number, percentage: number) {
  return basePixels * percentage / 100;
}

export function readerTypographyCss(settings: ReaderDisplaySettings) {
  const families: Record<ReaderFontFamily, string | null> = {
    book: null,
    serif: "Georgia, Cambria, 'Times New Roman', serif",
    sans: "Arial, Helvetica, sans-serif",
    mono: "ui-monospace, 'SFMono-Regular', Consolas, monospace",
  };
  const declarations = [
    families[settings.fontFamily]
      ? `body, body * { font-family: ${families[settings.fontFamily]} !important; }`
      : "",
    settings.lineHeight === "book" ? "" : `body, body * { line-height: ${settings.lineHeight} !important; }`,
    settings.paragraphSpacing === "book"
      ? ""
      : `p { margin-block-end: ${settings.paragraphSpacing}em !important; }`,
  ].filter(Boolean);
  return declarations.join("\n");
}

export type ReaderZoomLimits = {
  min: number;
  max: number;
  step: number;
};

const PDF_ZOOM_LIMITS: ReaderZoomLimits = { min: 50, max: 250, step: 10 };
const REFLOWABLE_ZOOM_LIMITS: ReaderZoomLimits = { min: 70, max: 220, step: 15 };

/** Return only zoom controls implemented by the active reader engine. */
export function getReaderZoomLimits(format: string | undefined): ReaderZoomLimits | null {
  if (format === "pdf") return PDF_ZOOM_LIMITS;
  if (format === "txt" || format === "md") return REFLOWABLE_ZOOM_LIMITS;
  return null;
}


/** Parse a strictly positive, in-range PDF page number without clamping. */
export function parsePdfPageNumber(value: string, pageCount: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(pageCount) || pageCount < 1) return null;
  const page = Number(trimmed);
  return Number.isSafeInteger(page) && page >= 1 && page <= pageCount ? page : null;
}

/** Submit a validated PDF page through the reader's existing position boundary. */
export function submitPdfPageNavigation(
  value: string,
  pageCount: number,
  navigate: (position: { kind: "pdf-page"; page: number }) => void
): boolean {
  const page = parsePdfPageNumber(value, pageCount);
  if (page === null) return false;
  navigate({ kind: "pdf-page", page });
  return true;
}

export function pdfPageInputKeyAction(key: string): "submit" | "cancel" | null {
  if (key === "Enter") return "submit";
  if (key === "Escape") return "cancel";
  return null;
}

/**
 * Compute PDF.js scale from its unscaled (rotation-aware) viewport and the
 * available content box. Fit Page can be below the manual zoom floor.
 */
export function calculatePdfFitScale(
  page: { width: number; height: number },
  available: { width: number; height: number },
  mode: Exclude<ReaderZoomMode, "manual">,
  limits: ReaderZoomLimits = PDF_ZOOM_LIMITS
): number | null {
  if (
    !Number.isFinite(page.width) || page.width <= 0 ||
    !Number.isFinite(page.height) || page.height <= 0 ||
    !Number.isFinite(available.width) || available.width <= 0 ||
    !Number.isFinite(available.height) || available.height <= 0
  ) return null;

  const fitWidth = available.width / page.width;
  const requested = mode === "fit-width"
    ? fitWidth
    : Math.min(fitWidth, available.height / page.height);
  const maximum = limits.max / 100;
  if (mode === "fit-page") return Math.min(requested, maximum);
  return Math.max(limits.min / 100, Math.min(requested, maximum));
}

export type PdfZoomState = {
  scale: number;
  mode: ReaderZoomMode;
};

export type PdfZoomAction =
  | { type: "fit"; mode: Exclude<ReaderZoomMode, "manual">; scale: number }
  | { type: "step"; direction: -1 | 1 }
  | { type: "reset" };

/** Keep PDF scale and active fit/manual mode in one transition source. */
export function transitionPdfZoomState(
  current: PdfZoomState,
  action: PdfZoomAction,
  limits: ReaderZoomLimits = PDF_ZOOM_LIMITS
): PdfZoomState {
  if (action.type === "fit") {
    return Number.isFinite(action.scale) && action.scale > 0
      ? { scale: action.scale, mode: action.mode }
      : current;
  }
  if (action.type === "reset") return { scale: 1, mode: "manual" };

  if (current.mode === "fit-page" && current.scale < limits.min / 100 && action.direction === -1) {
    return { scale: current.scale, mode: "manual" };
  }
  const next = Number((current.scale + action.direction * limits.step / 100).toFixed(2));
  return {
    scale: Math.max(limits.min / 100, Math.min(limits.max / 100, next)),
    mode: "manual",
  };
}

/** Calculate text-reader progress without treating a non-scrollable document as already finished. */
export function getTextReadingProgression(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  fallbackProgression = 0
): number {
  const maxScroll = scrollHeight - clientHeight;
  if (!Number.isFinite(maxScroll) || maxScroll <= 0) {
    return Number.isFinite(fallbackProgression)
      ? Math.max(0, Math.min(1, fallbackProgression))
      : 0;
  }
  const progression = scrollTop / maxScroll;
  return Number.isFinite(progression) ? Math.max(0, Math.min(1, progression)) : 0;
}

/** Reject async UI results after the reader document or request has changed. */
export function isCurrentReaderOperation(
  operationEpoch: number,
  currentEpoch: number,
  requestId?: number,
  currentRequestId?: number
): boolean {
  return operationEpoch === currentEpoch &&
    (requestId === undefined || requestId === currentRequestId);
}

// ── Escape dismissal ──────────────────────────────────────────────────────────

/**
 * Represents the transient UI state relevant to Escape handling.
 * All fields default to "inactive" / false / null.
 */
export interface EscapeReaderState {
  editingAnnotationId: string | null;
  isAddingNote?: boolean;
  pendingTextSelection: boolean;
  findOpen: boolean;
  navigatorOpen: boolean;
  displayOpen: boolean;
  docMenuOpen: boolean;
}

/**
 * Derive the action Escape should take given current reader state.
 *
 * Priority (highest → lowest):
 *   1. editingAnnotation   → "dismissAnnotationEdit"
 *   2. pendingTextSelection → "dismissTextSelection"
 *   3. findOpen            → "closeFind"
 *   4. navigatorOpen       → "closeNavigator"
 *   5. displayOpen         → "closeDisplay"
 *   6. docMenuOpen         → "closeDocMenu"
 *   7. (nothing else open) → "toggleTopbar"
 *
 * Escape never directly navigates back; that is handled by Alt+Left / Cmd+[.
 */
export type EscapeAction =
  | "dismissAnnotationEdit"
  | "dismissNoteEditor"
  | "dismissTextSelection"
  | "closeFind"
  | "closeNavigator"
  | "closeDisplay"
  | "closeDocMenu"
  | "toggleTopbar";

export function resolveEscapeAction(state: EscapeReaderState): EscapeAction {
  if (state.editingAnnotationId) return "dismissAnnotationEdit";
  if (state.isAddingNote) return "dismissNoteEditor";
  if (state.pendingTextSelection) return "dismissTextSelection";
  if (state.findOpen) return "closeFind";
  if (state.navigatorOpen) return "closeNavigator";
  if (state.displayOpen) return "closeDisplay";
  if (state.docMenuOpen) return "closeDocMenu";
  return "toggleTopbar";
}

// ── Find keyboard logic ───────────────────────────────────────────────────────

/**
 * Derive the action Enter/Shift+Enter should take when Find is open.
 */
export type FindEnterAction = "runSearch" | "nextMatch" | "prevMatch" | "noop";

export function resolveFindEnterAction(opts: {
  query: string;
  searchActiveQuery: string;
  hasResult: boolean;
  shiftKey: boolean;
}): FindEnterAction {
  const trimmed = opts.query.trim();
  if (!trimmed) return "noop";
  if (opts.hasResult && opts.searchActiveQuery === trimmed) {
    return opts.shiftKey ? "prevMatch" : "nextMatch";
  }
  return "runSearch";
}
