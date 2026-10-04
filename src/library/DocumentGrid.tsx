import type { StoredDocument } from "../storage/domain";
import { getDocumentDisplayTitle } from "../storage/domain";
import { Checkbox } from "../components/ui/checkbox";
import { MoreHorizontalIcon } from "./LibraryIcons";
import { Button } from "../components/ui/button";

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
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-6 gap-y-7 max-sm:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] max-sm:gap-x-4 max-sm:gap-y-6" role="list" aria-label="Documents">
      {documents.map((doc) => {
        const isSelected = selectedDocIds.has(doc.record.id);
        const displayTitle = getDocumentDisplayTitle(doc.record);
        const authors = doc.record.metadata?.authors?.filter(Boolean) ?? [];
        const authorStr = authors.length > 0 ? authors.join(", ") : null;
        let progressPercent: number | null = null;
        if (doc.readingState?.position) {
          const position = doc.readingState.position;
          if (position.kind === "text-scroll") {
            progressPercent = Math.round(position.progression * 100);
          } else if (position.kind === "epub-cfi" && typeof position.progression === "number") {
            progressPercent = Math.round(position.progression * 100);
          }
        }

        return (
          <article
            key={doc.record.id}
            id={`doc-card-${doc.record.id}`}
            className="group min-w-0 cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            data-selected={isSelected || undefined}
            role="listitem"
            tabIndex={0}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey) {
                event.preventDefault();
                onToggleSelect(doc.record.id, false, true);
              } else if (event.shiftKey) {
                event.preventDefault();
                onToggleSelect(doc.record.id, true, false);
              } else {
                onOpenDocument(doc);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onOpenDocument(doc);
              } else if (event.key === " ") {
                event.preventDefault();
                onToggleSelect(doc.record.id, event.shiftKey, event.metaKey || event.ctrlKey);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenContextMenu(doc, event);
            }}
          >
            <div className="relative aspect-[2/3] overflow-hidden bg-muted">
              {renderThumbnail(doc)}

              <div
                className={`absolute left-2 top-2 z-10 transition-opacity ${isSelected ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"}`}
                onClick={(event) => event.stopPropagation()}
              >
                <Checkbox
                  checked={isSelected}
                  onClick={(event) => onToggleSelect(doc.record.id, event.shiftKey, true)}
                  aria-label={isSelected ? `Deselect ${displayTitle}` : `Select ${displayTitle}`}
                  title={isSelected ? "Deselect document" : "Select document"}
                  className="border-foreground/60 bg-background/90 shadow-sm"
                />
              </div>

              <span className={`absolute right-2 top-2 rounded bg-background/90 px-1.5 py-0.5 font-mono text-[10px] font-medium text-foreground transition-opacity ${isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}>
                {doc.record.format.toUpperCase()}
              </span>

              {progressPercent !== null && progressPercent > 0 && (
                <div className="absolute inset-x-0 bottom-0 h-1 bg-background/60" aria-hidden="true" title={`${progressPercent}% completed`}>
                  <div className="h-full bg-foreground" style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }} />
                </div>
              )}

              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                className={`absolute bottom-2 right-2 z-10 bg-background/90 shadow-sm transition-opacity ${isSelected ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenContextMenu(doc, event);
                }}
                title="Document actions"
                aria-label={`Actions for ${displayTitle}`}
              >
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </div>

            <div className="pt-2">
              <strong className="block truncate text-[13px] font-medium leading-5" title={displayTitle}>{displayTitle}</strong>
              {authorStr && <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={authorStr}>{authorStr}</span>}
              {doc.availability === "missing" && <span className="mt-1 block text-xs text-muted-foreground">Missing</span>}
            </div>
          </article>
        );
      })}
    </div>
  );
}
