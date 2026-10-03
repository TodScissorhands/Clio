import type { LibraryRoot, StoredDocument } from "../storage/domain";
import { getDocumentDisplayTitle } from "../storage/domain";
import { formatReadingProgress, formatRelativeTime, type SortOption } from "./libraryFilter";
import { CheckIcon, FileTextIcon, FolderIcon, MoreHorizontalIcon } from "./LibraryIcons";

export interface DocumentListProps {
  documents: StoredDocument[];
  roots: LibraryRoot[];
  selectedDocIds: Set<string>;
  sortBy: SortOption;
  onSortChange: (sort: SortOption) => void;
  onToggleSelect: (docId: string, isShift: boolean, isCmdCtrl: boolean) => void;
  onOpenDocument: (doc: StoredDocument) => void;
  onOpenContextMenu: (doc: StoredDocument, e: React.MouseEvent) => void;
  onToggleSelectAll?: () => void;
}

export function DocumentList({
  documents,
  roots,
  selectedDocIds,
  sortBy,
  onSortChange,
  onToggleSelect,
  onOpenDocument,
  onOpenContextMenu,
  onToggleSelectAll,
}: DocumentListProps) {
  const allSelected = documents.length > 0 && documents.every((d) => selectedDocIds.has(d.record.id));
  const someSelected = !allSelected && documents.some((d) => selectedDocIds.has(d.record.id));

  function renderSortIndicator(target: "name" | "author" | "format" | "recent" | "added") {
    if (target === "name") {
      if (sortBy === "name-asc") return <span className="th-sort-indicator active">↑</span>;
      if (sortBy === "name-desc") return <span className="th-sort-indicator active">↓</span>;
      return <span className="th-sort-indicator">↕</span>;
    }
    const isActive = sortBy === target;
    return (
      <span className={`th-sort-indicator ${isActive ? "active" : ""}`}>
        {isActive ? "↓" : "↕"}
      </span>
    );
  }
  function getRootLabel(rootId?: string): string {
    if (!rootId) return "—";
    const root = roots.find((r) => r.id === rootId);
    return root?.label ?? rootId;
  }

  function toggleSort(target: "name" | "format" | "recent" | "size" | "author" | "added") {
    if (target === "name") {
      onSortChange(sortBy === "name-asc" ? "name-desc" : "name-asc");
    } else if (target === "size") {
      onSortChange(sortBy === "size-desc" ? "size-asc" : "size-desc");
    } else if (target === "format") {
      onSortChange("format");
    } else if (target === "recent") {
      onSortChange("recent");
    } else if (target === "author") {
      onSortChange("author");
    } else if (target === "added") {
      onSortChange("added");
    }
  }

  return (
    <div className="document-list-container" role="region" aria-label="Documents list table">
      <table className="doc-list-table">
        <thead>
          <tr>
            <th className="th-checkbox" aria-label="Selection column">
              {onToggleSelectAll && documents.length > 0 && (
                <button
                  type="button"
                  className={`list-select-checkbox header-checkbox ${allSelected ? "checked" : someSelected ? "indeterminate" : ""}`}
                  onClick={onToggleSelectAll}
                  title={allSelected ? "Deselect all" : "Select all"}
                  aria-label={allSelected ? "Deselect all" : "Select all"}
                >
                  {allSelected ? <CheckIcon /> : someSelected ? <span className="indeterminate-dash">—</span> : null}
                </button>
              )}
            </th>
            <th className="th-sortable th-title" onClick={() => toggleSort("name")}>
              Title {renderSortIndicator("name")}
            </th>
            <th className="th-sortable th-author" onClick={() => toggleSort("author")}>
              Author {renderSortIndicator("author")}
            </th>
            <th className="th-sortable th-format" onClick={() => toggleSort("format")}>
              Format {renderSortIndicator("format")}
            </th>
            <th className="th-folder">Folder</th>
            <th className="th-sortable th-opened" onClick={() => toggleSort("recent")}>
              Last Opened {renderSortIndicator("recent")}
            </th>
            <th className="th-sortable th-added" onClick={() => toggleSort("added")}>
              Added {renderSortIndicator("added")}
            </th>
            <th className="th-progress">Progress</th>
            <th className="th-actions" aria-label="Actions column" />
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => {
            const isSelected = selectedDocIds.has(doc.record.id);
            const progressLabel = formatReadingProgress(doc.readingState ?? undefined);
            const rootLabel =
              doc.source.kind === "library" ? getRootLabel(doc.source.rootId) : "Direct";
            const lastOpened = doc.readingState?.lastOpenedAt
              ? formatRelativeTime(doc.readingState.lastOpenedAt)
              : "Never";
            const addedLabel = formatRelativeTime(doc.record.firstSeenAt);
            const authorLabel =
              doc.record.metadata?.authors && doc.record.metadata.authors.length > 0
                ? doc.record.metadata.authors.join(", ")
                : "—";

            return (
              <tr
                key={doc.record.id}
                id={`doc-row-${doc.record.id}`}
                className={`doc-list-row ${isSelected ? "selected" : ""}`}
                tabIndex={0}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey) {
                    e.preventDefault();
                    onToggleSelect(doc.record.id, false, true);
                  } else if (e.shiftKey) {
                    e.preventDefault();
                    onToggleSelect(doc.record.id, true, false);
                  } else {
                    onOpenDocument(doc);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onOpenDocument(doc);
                  } else if (e.key === " ") {
                    e.preventDefault();
                    onToggleSelect(doc.record.id, e.shiftKey, e.metaKey || e.ctrlKey);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenContextMenu(doc, e);
                }}
              >
                <td className="td-checkbox" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className={`list-select-checkbox ${isSelected ? "checked" : ""}`}
                    onClick={() => onToggleSelect(doc.record.id, false, true)}
                    title={isSelected ? "Deselect" : "Select"}
                    aria-label={`Select ${doc.record.name}`}
                  >
                    {isSelected ? <CheckIcon /> : null}
                  </button>
                </td>

                <td className="td-title">
                  <div className="title-cell">
                    <FileTextIcon className="row-file-icon" />
                    <div className="title-text-group">
                      <span className="doc-row-name" title={getDocumentDisplayTitle(doc.record)}>
                        {getDocumentDisplayTitle(doc.record)}
                      </span>
                      {getDocumentDisplayTitle(doc.record) !== doc.record.name && (
                        <span className="doc-row-filename" title={doc.record.name}>
                          {doc.record.name}
                        </span>
                      )}
                    </div>
                    {doc.availability === "missing" && (
                      <span className="doc-missing-pill">Missing</span>
                    )}
                  </div>
                </td>

                <td className="td-format">
                  <span className={`format-badge format-${doc.record.format}`}>
                    {doc.record.format.toUpperCase()}
                  </span>
                </td>

                <td className="td-author">
                  <span className="author-cell" title={authorLabel !== "—" ? authorLabel : undefined}>
                    {authorLabel}
                  </span>
                </td>

                <td className="td-folder">
                  <span className="folder-name-cell" title={doc.source.kind === "library" ? doc.source.relativePath : ""}>
                    <FolderIcon className="folder-cell-icon" />
                    <span>{rootLabel}</span>
                  </span>
                </td>

                <td className="td-opened">
                  <span className="opened-time-cell">{lastOpened}</span>
                </td>

                <td className="td-added">
                  <span className="added-time-cell">{addedLabel}</span>
                </td>

                <td className="td-progress">
                  <span className="progress-cell">{progressLabel ?? "—"}</span>
                </td>

                <td className="td-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="row-ellipsis-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenContextMenu(doc, e);
                    }}
                    title="Actions"
                    aria-label={`Actions for ${doc.record.name}`}
                  >
                    <MoreHorizontalIcon />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
