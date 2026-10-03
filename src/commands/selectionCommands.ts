/**
 * Pure, side-effect-free selection capability logic for Library contextual actions.
 *
 * No React, no Tauri, no browser globals — fully testable.
 *
 * The selection action model:
 *   - zero selected → no selection actions
 *   - one selected  → single-document actions (open, convert, extract, properties, reveal, remove)
 *   - two+ selected → batch actions (add to collection, merge PDFs if all PDF, remove)
 */

import { hasCapability } from "../storage/domain";
import { canMergeSelected } from "./documentCommands";
import type { StoredDocument } from "../storage/domain";

// ── Selection capability descriptor ──────────────────────────────────────────

export interface SelectionCapabilities {
  /** True when exactly one document is selected and it is openable. */
  canOpen: boolean;
  /** True when exactly one document is selected and has convert capability. */
  canConvert: boolean;
  /** True when exactly one PDF document is selected. */
  canExtractPages: boolean;
  /** True when exactly one document is selected (properties is always meaningful for a single doc). */
  canViewProperties: boolean;
  /** True when exactly one document is selected and its source is a library path. */
  canReveal: boolean;
  /** True when exactly one document is selected and it is currently missing. */
  canLocate: boolean;
  /** True when one or more documents are selected (always available for any selection). */
  canAddToCollection: boolean;
  /** True when 2+ selected documents are all present PDFs. */
  canMergePdfs: boolean;
  /** True when one or more documents are selected (removal is always available). */
  canRemove: boolean;
}

// ── Pure capability derivation ────────────────────────────────────────────────

/**
 * Derive what batch/contextual actions are available for a given selection.
 *
 * @param selection - The currently selected documents (may be empty).
 */
export function getSelectionCapabilities(selection: StoredDocument[]): SelectionCapabilities {
  const count = selection.length;
  const single = count === 1 ? selection[0] : null;

  return {
    canOpen:
      single !== null &&
      single.availability === "present" &&
      hasCapability(single.record.format, "read"),

    canConvert:
      single !== null &&
      single.availability === "present" &&
      hasCapability(single.record.format, "convert"),

    canExtractPages:
      single !== null &&
      single.availability === "present" &&
      single.record.format === "pdf",

    canViewProperties: single !== null,

    canReveal:
      single !== null &&
      single.source.kind === "library" &&
      single.availability === "present",

    canLocate: single !== null && single.availability === "missing",

    canAddToCollection: count > 0,

    canMergePdfs: canMergeSelected(selection),

    canRemove: count > 0,
  };
}

// ── Format availability helpers ───────────────────────────────────────────────

/**
 * Returns true when every document in the selection is a present PDF.
 * Re-exported from documentCommands for convenience; callers should prefer
 * `getSelectionCapabilities` unless they need only this predicate.
 */
export { canMergeSelected };
