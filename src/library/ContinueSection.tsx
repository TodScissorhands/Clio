import type { StoredDocument } from "../storage/domain";
import { formatReadingProgress } from "./libraryFilter";

export interface ContinueSectionProps {
  documents: StoredDocument[];
  onOpenDocument: (doc: StoredDocument) => void;
  onOpenContextMenu: (doc: StoredDocument, e: React.MouseEvent) => void;
  renderThumbnail: (doc: StoredDocument) => React.ReactNode;
}

export function ContinueSection({
  documents,
  onOpenDocument,
  onOpenContextMenu,
  renderThumbnail,
}: ContinueSectionProps) {
  if (documents.length === 0) {
    return null;
  }

  return (
    <section className="continue-section" aria-label="Continue reading">
      <div className="section-header">
        <h2 className="section-title">Continue</h2>
      </div>

      <div className="continue-grid" role="list">
        {documents.map((doc) => {
          const progressLabel = formatReadingProgress(doc.readingState ?? undefined);
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
              title={`Continue reading ${doc.record.name}`}
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
                  aria-label={`Options for ${doc.record.name}`}
                >
                  ⋯
                </button>
              </div>

              <div className="continue-meta">
                <strong className="continue-title">{doc.record.name}</strong>
                {progressLabel && (
                  <div className="continue-progress-row">
                    <span className="continue-progress-text">{progressLabel}</span>
                    {progressPercent !== null && (
                      <div className="thin-progress-bar-bg" aria-hidden="true">
                        <div
                          className="thin-progress-bar-fill"
                          style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
