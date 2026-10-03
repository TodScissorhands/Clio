import type { StoredDocument } from "../storage/domain";
import { getDocumentDisplayTitle } from "../storage/domain";
import { CheckIcon, MoreHorizontalIcon } from "./LibraryIcons";

export interface DocumentGridProps {
  documents: StoredDocument[];
  selectedDocIds: Set<string>;
  onToggleSelect: (docId: string, isShift: boolean, isCmdCtrl: boolean) => void;
  onOpenDocument: (doc: StoredDocument) => void;
  onOpenContextMenu: (doc: StoredDocument, e: React.MouseEvent) => void;
  renderThumbnail: (doc: StoredDocument) => React.ReactNode;
}

export function DocumentGrid({
  documents,
  selectedDocIds,
  onToggleSelect,
  onOpenDocument,
  onOpenContextMenu,
  renderThumbnail,
}: DocumentGridProps) {
  return (
    <div className="document-grid" role="list" aria-label="Documents">
      {documents.map((doc) => {
        const isSelected = selectedDocIds.has(doc.record.id);
        const displayTitle = getDocumentDisplayTitle(doc.record);
        const authors = doc.record.metadata?.authors?.filter(Boolean) ?? [];
        const authorStr = authors.length > 0 ? authors.join(", ") : null;
        let progressPercent: number | null = null;
        if (doc.readingState?.position) {
          const pos = doc.readingState.position;
          if (pos.kind === "text-scroll") {
            progressPercent = Math.round(pos.progression * 100);
          } else if (pos.kind === "epub-cfi" && typeof pos.progression === "number") {
            progressPercent = Math.round(pos.progression * 100);
          }
        }

        return (
          <article
            key={doc.record.id}
            id={`doc-card-${doc.record.id}`}
            className={`doc-grid-card ${isSelected ? "selected" : ""}`}
            role="listitem"
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
            {/* Thumbnail wrap */}
            <div className="doc-grid-cover-wrap">
              {renderThumbnail(doc)}

              {/* Checkbox (revealed on hover/focus, or always visible when selected) */}
              <button
                type="button"
                className={`grid-select-checkbox ${isSelected ? "checked" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelect(doc.record.id, e.shiftKey, true);
                }}
                title={isSelected ? "Deselect document" : "Select document"}
                aria-label={isSelected ? "Deselect document" : "Select document"}
              >
                {isSelected && <CheckIcon />}
              </button>

              {/* Reading progress: discreet bar at bottom of cover only when relevant */}
              {progressPercent !== null && progressPercent > 0 && (
                <div
                  className="book-cover-progress"
                  aria-hidden="true"
                  title={`${progressPercent}% completed`}
                >
                  <div
                    className="book-cover-progress-bar"
                    style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
                  />
                </div>
              )}

              {/* Document Ellipsis menu button at bottom-right of cover */}
              <button
                type="button"
                className="grid-ellipsis-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenContextMenu(doc, e);
                }}
                title="Document actions"
                aria-label={`Actions for ${doc.record.name}`}
              >
                <MoreHorizontalIcon />
              </button>
            </div>

            {/* Document Info */}
            <div className="doc-grid-info">
              <strong className="doc-grid-title" title={displayTitle}>
                {displayTitle}
              </strong>
              {authorStr && (
                <span className="doc-grid-author" title={authorStr}>
                  {authorStr}
                </span>
              )}
              {doc.availability === "missing" && (
                <div className="doc-grid-status-line">
                  <span className="doc-missing-pill">Missing</span>
                </div>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
