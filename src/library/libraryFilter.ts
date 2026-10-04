import { getDocumentDisplayTitle, type Collection, type FormatId, type LibraryRoot, type ReadingState, type StoredDocument } from "../storage/domain";
import type { LibraryScope } from "../navigation/navigation";
export type FormatFilterOption = "all" | "pdf" | "epub" | "other";

export type SortOption =
  | "recent"
  | "name-asc"
  | "name-desc"
  | "author"
  | "added"
  | "size-desc"
  | "size-asc"
  | "format";

export function getDocumentMonogram(title: string, format: string): string {
  const initials = title
    .replace(/[^\p{L}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return initials || format.slice(0, 2).toUpperCase();
}

export function getScopeLabel(
  scope: LibraryScope,
  roots: LibraryRoot[],
  collections: Collection[] = []
): string {
  switch (scope.kind) {
    case "all":
      return "Entire Library";
    case "root": {
      const root = roots.find((r) => r.id === scope.rootId);
      return root?.label ?? "Folder";
    }
    case "folder": {
      const parts = scope.relativePath.split("/").filter(Boolean);
      return parts[parts.length - 1] ?? "Folder";
    }
    case "collection": {
      const col = collections.find((c) => c.id === scope.collectionId);
      return col ? col.name : "Collection";
    }
    case "search":
      return "Search";
  }
}

export type SearchableScope = Exclude<LibraryScope, { kind: "search" }>;

export interface SearchScopeOption {
  scope: SearchableScope;
  label: string;
}

export function getSearchScopeOptions(
  currentContext: LibraryScope | null,
  roots: LibraryRoot[],
  collections: Collection[] = []
): SearchScopeOption[] {
  const options: SearchScopeOption[] = [{ scope: { kind: "all" }, label: "Entire Library" }];

  if (
    currentContext &&
    (currentContext.kind === "root" ||
      currentContext.kind === "folder" ||
      currentContext.kind === "collection")
  ) {
    const contextLabel = getScopeLabel(currentContext, roots, collections);
    options.unshift({
      scope: currentContext,
      label: `${currentContext.kind === "collection" ? "Current Collection" : "Current Folder"} (${contextLabel})`,
    });
  }

  return options;
}

export function matchesSearch(document: StoredDocument, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  if (document.record.name.toLowerCase().includes(needle)) return true;

  if (document.record.metadata?.title?.toLowerCase().includes(needle)) return true;

  if (document.record.metadata?.authors?.some((a) => a.toLowerCase().includes(needle))) {
    return true;
  }

  if (document.record.metadata?.description?.toLowerCase().includes(needle)) return true;

  if (document.source.kind === "library") {
    return document.source.relativePath.toLowerCase().includes(needle);
  }

  return false;
}

export function matchesFormat(document: StoredDocument, filter: FormatFilterOption): boolean {
  const format: FormatId = document.record.format;
  switch (filter) {
    case "all":
      return true;
    case "pdf":
      return format === "pdf";
    case "epub":
      return format === "epub";
    case "other":
      return format !== "pdf" && format !== "epub";
  }
}

export function filterDocuments(
  documents: StoredDocument[],
  query: string,
  formatFilter: FormatFilterOption,
  selectedRootId: string | null,
  selectedCollectionId: string | null = null
): StoredDocument[] {
  return documents.filter((doc) => {
    if (selectedRootId !== null) {
      if (doc.source.kind !== "library" || doc.source.rootId !== selectedRootId) {
        return false;
      }
    }
    if (selectedCollectionId !== null) {
      if (!doc.record.collections || !doc.record.collections.includes(selectedCollectionId)) {
        return false;
      }
    }
    if (!matchesFormat(doc, formatFilter)) {
      return false;
    }
    if (!matchesSearch(doc, query)) {
      return false;
    }
    return true;
  });
}

export function isDescendantPath(filePath: string, folderPath: string): boolean {
  const normFile = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const normFolder = folderPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normFolder) return true;
  return normFile === normFolder || normFile.startsWith(normFolder + "/");
}

export function filterDocumentsByScope(
  documents: StoredDocument[],
  scope: LibraryScope,
  searchQuery = ""
): StoredDocument[] {
  return documents.filter((doc) => {
    switch (scope.kind) {
      case "all":
        break;
      case "root":
        if (doc.source.kind !== "library" || doc.source.rootId !== scope.rootId) {
          return false;
        }
        break;
      case "folder":
        if (
          doc.source.kind !== "library" ||
          doc.source.rootId !== scope.rootId ||
          !isDescendantPath(doc.source.relativePath, scope.relativePath)
        ) {
          return false;
        }
        break;
      case "collection":
        if (!doc.record.collections || !doc.record.collections.includes(scope.collectionId)) {
          return false;
        }
        break;
      case "search":
        if (!matchesSearch(doc, scope.query)) {
          return false;
        }
        break;
    }

    if (searchQuery.trim().length > 0 && !matchesSearch(doc, searchQuery)) {
      return false;
    }

    return true;
  });
}

export function isDocumentFinished(document: StoredDocument): boolean {
  const state = document.readingState;
  if (!state) return false;
  switch (state.position.kind) {
    case "pdf-page":
      return typeof state.position.progression === "number" && state.position.progression >= 1;
    case "epub-cfi":
      return typeof state.position.progression === "number" && state.position.progression >= 0.98;
    case "text-scroll":
      return state.position.progression >= 0.98;
  }
}

export function isDocumentStarted(document: StoredDocument): boolean {
  const state = document.readingState;
  if (!state || !state.lastOpenedAt) return false;
  switch (state.position.kind) {
    case "pdf-page":
      return state.position.page >= 1;
    case "epub-cfi":
      return Boolean(state.position.cfi || (state.position.progression && state.position.progression > 0));
    case "text-scroll":
      // Any opened text document is "started" — the lastOpenedAt guard above
      // ensures the user actually opened it. progression: 0 is valid (top of file).
      return true;
  }
}

/**
 * Continue Reading: documents with meaningful reading progress that are not finished. (OD-5)
 */
export function deriveContinueDocuments(
  documents: StoredDocument[],
  maxCount = 6
): StoredDocument[] {
  const inProgress = documents.filter((d) => {
    if (d.availability === "missing") return false;
    return isDocumentStarted(d) && !isDocumentFinished(d);
  });

  inProgress.sort((a, b) => {
    const timeA = a.readingState?.lastOpenedAt ?? "";
    const timeB = b.readingState?.lastOpenedAt ?? "";
    return timeB.localeCompare(timeA);
  });

  return inProgress.slice(0, maxCount);
}


export function sortDocuments(
  documents: StoredDocument[],
  sort: SortOption,
  readingStates?: Record<string, ReadingState>
): StoredDocument[] {
  const items = [...documents];
  return items.sort((a, b) => {
    const titleA = getDocumentDisplayTitle(a.record);
    const titleB = getDocumentDisplayTitle(b.record);
    switch (sort) {
      case "name-asc":
        return titleA.localeCompare(titleB, undefined, { sensitivity: "base" });
      case "name-desc":
        return titleB.localeCompare(titleA, undefined, { sensitivity: "base" });
      case "author": {
        const authorA = a.record.metadata?.authors.find((author) => author.trim())?.trim() ?? "";
        const authorB = b.record.metadata?.authors.find((author) => author.trim())?.trim() ?? "";
        // Keep documents without author metadata after identified authors.
        if (!authorA || !authorB) {
          if (!authorA && authorB) return 1;
          if (authorA && !authorB) return -1;
        }
        const cmp = authorA.localeCompare(authorB, undefined, { sensitivity: "base" });
        return cmp !== 0 ? cmp : titleA.localeCompare(titleB, undefined, { sensitivity: "base" });
      }
      case "added": {
        const addedA = a.record.firstSeenAt;
        const addedB = b.record.firstSeenAt;
        const cmp = addedB.localeCompare(addedA); // newest first
        return cmp !== 0 ? cmp : titleA.localeCompare(titleB, undefined, { sensitivity: "base" });
      }
      case "size-desc":
        return b.record.sizeBytes - a.record.sizeBytes;
      case "size-asc":
        return a.record.sizeBytes - b.record.sizeBytes;
      case "format": {
        const cmp = a.record.format.localeCompare(b.record.format);
        return cmp !== 0 ? cmp : titleA.localeCompare(titleB);
      }
      case "recent": {
        const timeA = readingStates?.[a.record.id]?.lastOpenedAt ?? a.readingState?.lastOpenedAt ?? a.record.updatedAt;
        const timeB = readingStates?.[b.record.id]?.lastOpenedAt ?? b.readingState?.lastOpenedAt ?? b.record.updatedAt;
        const cmp = timeB.localeCompare(timeA);
        return cmp !== 0 ? cmp : titleA.localeCompare(titleB, undefined, { sensitivity: "base" });
      }
    }
  });
}

export function formatReadingProgress(state?: ReadingState): string | null {
  if (!state) return null;
  if (state.position.kind === "pdf-page") {
    return `Page ${state.position.page}`;
  }
  if (state.position.kind === "epub-cfi") {
    if (typeof state.position.progression === "number" && Number.isFinite(state.position.progression)) {
      return `${Math.round(state.position.progression * 100)}%`;
    }
    return "Reading";
  }
  return null;
}

export function formatRelativeTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return "";
    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffDay === 0) {
      if (diffHour === 0) {
        if (diffMin <= 1) return "Just now";
        return `${diffMin}m ago`;
      }
      return `${diffHour}h ago`;
    }
    if (diffDay === 1) return "Yesterday";
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
