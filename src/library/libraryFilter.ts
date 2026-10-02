import { getDocumentDisplayTitle, type FormatId, type ReadingState, type StoredDocument } from "../storage/domain";
export type FormatFilterOption = "all" | "pdf" | "epub" | "other";

export type SortOption =
  | "recent"
  | "name-asc"
  | "name-desc"
  | "size-desc"
  | "size-asc"
  | "format";

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
      case "size-desc":
        return b.record.sizeBytes - a.record.sizeBytes;
      case "size-asc":
        return a.record.sizeBytes - b.record.sizeBytes;
      case "format": {
        const cmp = a.record.format.localeCompare(b.record.format);
        return cmp !== 0 ? cmp : titleA.localeCompare(titleB);
      }
      case "recent": {
        const timeA = readingStates?.[a.record.id]?.lastOpenedAt ?? a.record.updatedAt;
        const timeB = readingStates?.[b.record.id]?.lastOpenedAt ?? b.record.updatedAt;
        const cmp = timeB.localeCompare(timeA);
        return cmp !== 0 ? cmp : titleA.localeCompare(titleB);
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
