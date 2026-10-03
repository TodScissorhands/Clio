import { useState } from "react";
import type { StoredDocument } from "../storage/domain";
import { getDocumentDisplayTitle } from "../storage/domain";
import { formatReadingProgress } from "./libraryFilter";

export interface ContinueSectionProps {
  documents: StoredDocument[];
  recentDocuments?: StoredDocument[];
  onOpenDocument: (doc: StoredDocument) => void;
  onOpenContextMenu: (doc: StoredDocument, e: React.MouseEvent) => void;
  renderThumbnail: (doc: StoredDocument) => React.ReactNode;
}

export function ContinueSection({
  documents,
  recentDocuments = [],
  onOpenDocument,
  onOpenContextMenu,
  renderThumbnail,
}: ContinueSectionProps) {
  const [activeTab, setActiveTab] = useState<"continue" | "recent">("continue");
  const hasContinue = documents.length > 0;
  const hasRecent = recentDocuments.length > 0;

  if (!hasContinue && !hasRecent) {
    return null;
  }

  const effectiveTab = hasContinue ? activeTab : "recent";
  const activeDocs = effectiveTab === "continue" ? documents : recentDocuments;

  return (
    <section className="continue-section" aria-label="Reading shelves">
      <div className="section-header continue-header-tabs" role="tablist" aria-label="Reading history tabs">
        {hasContinue && (
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "continue"}
            className={`continue-tab-btn ${effectiveTab === "continue" ? "selected" : ""}`}
            onClick={() => setActiveTab("continue")}
          >
            Continue Reading
          </button>
        )}
        {hasRecent && (
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "recent"}
            className={`continue-tab-btn ${effectiveTab === "recent" ? "selected" : ""}`}
            onClick={() => setActiveTab("recent")}
          >
            Recently Read
          </button>
        )}
      </div>
      <div className="continue-grid" role="list">
        {activeDocs.map((doc) => {
          const displayTitle = getDocumentDisplayTitle(doc.record);
          const authors = doc.record.metadata?.authors?.filter(Boolean) ?? [];
          const authorStr = authors.length > 0 ? authors.join(", ") : null;
          const progressLabel = formatReadingProgress(doc.readingState ?? undefined);
          const formatStr = doc.record.format.toUpperCase();
          const metaLine = progressLabel ? `${formatStr} · ${progressLabel}` : formatStr;
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
              className="continue-card"
              role="listitem"
              onClick={() => onOpenDocument(doc)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenContextMenu(doc, e);
              }}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onOpenDocument(doc);
                }
              }}
              title={`Open ${displayTitle}`}
            >
              <div className="continue-thumbnail-wrap">
                {renderThumbnail(doc)}
                <button
                  type="button"
                  className="continue-ellipsis-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenContextMenu(doc, e);
                  }}
                  title="Document options"
                  aria-label={`Options for ${displayTitle}`}
                >
                  ⋯
                </button>
              </div>

              <div className="continue-meta">
                <strong className="continue-title" title={displayTitle}>
                  {displayTitle}
                </strong>
                {authorStr && (
                  <span className="continue-author" title={authorStr}>
                    {authorStr}
                  </span>
                )}
                <div className="continue-progress-row">
                  <span className="continue-progress-text">{metaLine}</span>
                  {progressPercent !== null && (
                    <div className="thin-progress-bar-bg" aria-hidden="true">
                      <div
                        className="thin-progress-bar-fill"
                        style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
