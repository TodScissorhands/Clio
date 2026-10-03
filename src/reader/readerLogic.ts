/**
 * Pure, side-effect-free logic extracted from ReaderShell for testability.
 *
 * Nothing in this module may import React, Tauri, or browser globals.
 */

import type { ReaderTheme } from "./types";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Milliseconds of inactivity before the reader topbar auto-hides. */
export const TOPBAR_HIDE_DELAY = 2500;

// ── Theme persistence helpers ─────────────────────────────────────────────────

/**
 * Parse a raw localStorage value into a valid ReaderTheme.
 * Returns "light" if the value is absent or unrecognised.
 */
export function parseReaderTheme(raw: string | null | undefined): ReaderTheme {
  if (raw === "light" || raw === "sepia" || raw === "dark") return raw;
  return "light";
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
