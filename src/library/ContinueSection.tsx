import { getDocumentDisplayTitle, type StoredDocument } from "../storage/domain";
import { Button } from "../components/ui/button";
import { MoreHorizontalIcon } from "./LibraryIcons";

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
  if (documents.length === 0) return null;

  return (
    <section aria-label="Continue Reading" className="mb-5 border-b border-border pb-3">
      <h2 className="mb-2 text-sm font-semibold">Continue Reading</h2>
      <div className="flex gap-2 overflow-x-auto pb-2" role="list">
        {documents.map((doc) => {
          const displayTitle = getDocumentDisplayTitle(doc.record);
          const authors = doc.record.metadata?.authors?.filter(Boolean) ?? [];
          const author = authors.length > 0 ? authors.join(", ") : null;
          const position = doc.readingState?.position;
          const progression =
            position && "progression" in position ? position.progression : undefined;
          const progressPercent =
            typeof progression === "number" && Number.isFinite(progression)
              ? Math.min(100, Math.max(0, Math.round(progression * 100)))
              : null;
          const locationLabel =
            position?.kind === "pdf-page"
              ? `Page ${position.page}${progressPercent !== null ? ` · ${progressPercent}%` : ""}`
              : progressPercent !== null
                ? `${progressPercent}% through`
                : "Saved position";

          return (
            <article
              key={doc.record.id}
              className="flex w-60 shrink-0 items-center gap-2 rounded-md border border-border bg-card p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              role="listitem"
              tabIndex={0}
              onClick={() => onOpenDocument(doc)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenContextMenu(doc, event);
              }}
              onKeyDown={(event) => {
                if (event.target === event.currentTarget && event.key === "Enter") {
                  event.preventDefault();
                  onOpenDocument(doc);
                }
              }}
            >
              <div className="h-12 w-8 shrink-0 overflow-hidden rounded-sm bg-muted">
                {renderThumbnail(doc)}
              </div>
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-xs font-medium" title={displayTitle}>{displayTitle}</strong>
                {author && <span className="block truncate text-[11px] text-muted-foreground" title={author}>{author}</span>}
                <span className="mt-0.5 block text-[11px] text-muted-foreground">{locationLabel}</span>
                {progressPercent !== null && (
                  <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <div className="h-full bg-primary" style={{ width: `${progressPercent}%` }} />
                  </div>
                )}
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 px-2 text-xs"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenDocument(doc);
                }}
                aria-label={`Resume ${displayTitle} at ${locationLabel}`}
              >
                Resume
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="shrink-0"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenContextMenu(doc, event);
                }}
                aria-label={`Options for ${displayTitle}`}
              >
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
