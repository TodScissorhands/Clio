import { useState } from "react";
import { getDocumentDisplayTitle, type StoredDocument } from "../storage/domain";
import { MoreHorizontalIcon } from "./LibraryIcons";
import { Button } from "../components/ui/button";

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

  if (!hasContinue && !hasRecent) return null;

  const effectiveTab = hasContinue ? activeTab : "recent";
  const activeDocuments = effectiveTab === "continue" ? documents : recentDocuments;

  return (
    <section aria-label="Reading shelves" className="border-b border-border pb-5">
      <div className="mb-3 flex items-center gap-1" role="tablist" aria-label="Reading history tabs">
        {hasContinue && (
          <Button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "continue"}
            variant={effectiveTab === "continue" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setActiveTab("continue")}
          >
            Continue Reading
          </Button>
        )}
        {hasRecent && (
          <Button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "recent"}
            variant={effectiveTab === "recent" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setActiveTab("recent")}
          >
            Recently Read
          </Button>
        )}
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-x-5 gap-y-4 max-sm:grid-cols-[repeat(auto-fill,minmax(105px,1fr))] max-sm:gap-x-4" role="list">
        {activeDocuments.map((doc) => {
          const displayTitle = getDocumentDisplayTitle(doc.record);
          const authors = doc.record.metadata?.authors?.filter(Boolean) ?? [];
          const author = authors.length > 0 ? authors.join(", ") : null;
          let progressPercent: number | null = null;
          const position = doc.readingState?.position;
          if (position?.kind === "text-scroll" || position?.kind === "epub-cfi") {
            progressPercent = typeof position.progression === "number" ? Math.round(position.progression * 100) : null;
          }

          return (
            <article
              key={doc.record.id}
              className="group min-w-0 cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              role="listitem"
              tabIndex={0}
              onClick={() => onOpenDocument(doc)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenContextMenu(doc, event);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onOpenDocument(doc);
                }
              }}
              title={`Open ${displayTitle}`}
            >
              <div className="relative aspect-[2/3] overflow-hidden bg-muted">
                {renderThumbnail(doc)}
                {progressPercent !== null && progressPercent > 0 && (
                  <div className="absolute inset-x-0 bottom-0 h-1 bg-background/60" aria-hidden="true" title={`${progressPercent}% completed`}>
                    <div className="h-full bg-foreground" style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }} />
                  </div>
                )}
                <Button
                  type="button"
                  size="icon-sm"
                  variant="secondary"
                  className="absolute bottom-2 right-2 bg-background/90 opacity-100 shadow-sm transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenContextMenu(doc, event);
                  }}
                  title="Document options"
                  aria-label={`Options for ${displayTitle}`}
                >
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </div>
              <div className="pt-2">
                <strong className="block truncate text-[13px] font-medium leading-5" title={displayTitle}>{displayTitle}</strong>
                {author && <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={author}>{author}</span>}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
