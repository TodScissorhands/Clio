import type { SortOption } from "../library/libraryFilter";

export type LibraryScope =
  | { kind: "all" }
  | { kind: "root"; rootId: string }
  | { kind: "folder"; rootId: string; relativePath: string }
  | { kind: "collection"; collectionId: string }
  | { kind: "search"; query: string };

export type AppRoute =
  | { kind: "library"; scope: LibraryScope }
  | { kind: "document"; documentId: string };

export interface LibraryRestorationState {
  scope: LibraryScope;
  viewMode: "grid" | "list";
  searchQuery: string;
  selectedDocIds: string[];
  scrollAnchorId: string | null;
  sortBy: SortOption;
}

export const DEFAULT_LIBRARY_SCOPE: LibraryScope = { kind: "all" };

export function isSameScope(a: LibraryScope, b: LibraryScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "all" && b.kind === "all") return true;
  if (a.kind === "root" && b.kind === "root") return a.rootId === b.rootId;
  if (a.kind === "folder" && b.kind === "folder") {
    return a.rootId === b.rootId && a.relativePath === b.relativePath;
  }
  if (a.kind === "collection" && b.kind === "collection") {
    return a.collectionId === b.collectionId;
  }
  if (a.kind === "search" && b.kind === "search") {
    return a.query === b.query;
  }
  return false;
}

export interface NavigationHistory {
  entries: LibraryRestorationState[];
  index: number;
}

export function createNavigationHistory(initial: LibraryRestorationState): NavigationHistory {
  return { entries: [initial], index: 0 };
}

function sameLocation(a: LibraryRestorationState, b: LibraryRestorationState): boolean {
  return isSameScope(a.scope, b.scope) && a.searchQuery === b.searchQuery;
}

export function pushNavigationHistory(
  history: NavigationHistory,
  next: LibraryRestorationState
): NavigationHistory {
  const entries = history.entries.slice(0, history.index + 1);
  const current = entries[entries.length - 1];
  if (current && sameLocation(current, next)) {
    entries[entries.length - 1] = next;
    return { entries, index: entries.length - 1 };
  }
  entries.push(next);
  return { entries, index: entries.length - 1 };
}

export function replaceCurrentNavigationEntry(
  history: NavigationHistory,
  next: LibraryRestorationState
): NavigationHistory {
  const entries = [...history.entries];
  entries[history.index] = next;
  return { entries, index: history.index };
}

export function moveNavigationHistory(
  history: NavigationHistory,
  direction: -1 | 1
): { history: NavigationHistory; state: LibraryRestorationState | null } {
  const index = history.index + direction;
  if (index < 0 || index >= history.entries.length) {
    return { history, state: null };
  }
  return {
    history: { entries: history.entries, index },
    state: history.entries[index] ?? null,
  };
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !== null
  );
}
