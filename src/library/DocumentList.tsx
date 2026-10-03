import type { LibraryRoot, StoredDocument } from "../storage/domain";
import { getDocumentDisplayTitle } from "../storage/domain";
import { formatReadingProgress, formatRelativeTime, type SortOption } from "./libraryFilter";

export interface DocumentListProps {
  documents: StoredDocument[];
  roots: LibraryRoot[];
  selectedDocIds: Set<string>;
  sortBy: SortOption;
  onSortChange: (sort: SortOption) => void;
  onToggleSelect: (docId: string, isShift: boolean, isCmdCtrl: boolean) => void;
  onOpenDocument: (doc: StoredDocument) => void;
  onOpenContextMenu: (doc: StoredDocument, e: React.MouseEvent) => void;
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
}: DocumentListProps) {
  function getRootLabel(rootId?: string): string {
    if (!rootId) return "—";
    const root = roots.find((r) => r.id === rootId);
    return root?.label ?? rootId;
  }

  function toggleSort(target: "name" | "format" | "recent" | "size") {
    if (target === "name") {
      onSortChange(sortBy === "name-asc" ? "name-desc" : "name-asc");
    } else if (target === "size") {
      onSortChange(sortBy === "size-desc" ? "size-asc" : "size-desc");
    } else if (target === "format") {
      onSortChange("format");
    } else if (target === "recent") {
      onSortChange("recent");
    }
  }

  return (
    <div className="document-list-container" role="region" aria-label="Documents list table">
      <table className="doc-list-table">
        <thead>
          <tr>
            <th className="th-checkbox" aria-label="Selection column" />
            <th className="th-sortable th-title" onClick={() => toggleSort("name")}>
              Title {sortBy === "name-asc" ? "↑" : sortBy === "name-desc" ? "↓" : ""}
            </th>
            <th className="th-sortable th-format" onClick={() => toggleSort("format")}>
              Format {sortBy === "format" ? "↓" : ""}
            </th>
            <th className="th-folder">Folder</th>
            <th className="th-sortable th-opened" onClick={() => toggleSort("recent")}>
              Last Opened {sortBy === "recent" ? "↓" : ""}
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
                    {isSelected ? "✓" : ""}
                  </button>
                </td>

                <td className="td-title">
                  <div className="title-cell">
                    <span className="doc-row-name" title={getDocumentDisplayTitle(doc.record)}>
                      {getDocumentDisplayTitle(doc.record)}
                    </span>
                    {doc.record.metadata?.authors && doc.record.metadata.authors.length > 0 && (
                      <span className="doc-row-author" title={doc.record.metadata.authors.join(", ")}>
                        {doc.record.metadata.authors.join(", ")}
                      </span>
                    )}
                    {getDocumentDisplayTitle(doc.record) !== doc.record.name && (
                      <span className="doc-row-filename" title={doc.record.name}>
                        {doc.record.name}
                      </span>
                    )}
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

                <td className="td-folder">
                  <span className="folder-name-cell" title={doc.source.kind === "library" ? doc.source.relativePath : ""}>
                    {rootLabel}
                  </span>
                </td>

                <td className="td-opened">
                  <span className="opened-time-cell">{lastOpened}</span>
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
                    ⋯
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
