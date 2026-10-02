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
