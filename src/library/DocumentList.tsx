import type { LibraryRoot, StoredDocument } from "../storage/domain";
import { getDocumentDisplayTitle } from "../storage/domain";
import { formatReadingProgress, formatRelativeTime, type SortOption } from "./libraryFilter";
import { FileTextIcon, FolderIcon, MoreHorizontalIcon } from "./LibraryIcons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { Checkbox } from "../components/ui/checkbox";
import { Button } from "../components/ui/button";

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
  const allSelected = documents.length > 0 && documents.every((doc) => selectedDocIds.has(doc.record.id));
  const someSelected = !allSelected && documents.some((doc) => selectedDocIds.has(doc.record.id));

  function toggleSort(target: "name" | "format" | "recent" | "author" | "added") {
    if (target === "name") onSortChange(sortBy === "name-asc" ? "name-desc" : "name-asc");
    else if (target === "format") onSortChange("format");
    else if (target === "recent") onSortChange("recent");
    else if (target === "author") onSortChange("author");
    else onSortChange("added");
  }

  function sortMark(target: "name" | "author" | "format" | "recent" | "added") {
    if (target === "name") {
      if (sortBy === "name-asc") return "↑";
      if (sortBy === "name-desc") return "↓";
    } else if (sortBy === target) {
      return "↓";
    }
    return "↕";
  }

  function rootLabel(rootId?: string): string {
    if (!rootId) return "—";
    return roots.find((root) => root.id === rootId)?.label ?? rootId;
  }

  const sortableHeader = (label: string, target: "name" | "author" | "format" | "recent" | "added") => (
    <Button variant="ghost" size="sm" className="-ml-2 h-8 gap-1 px-2 font-medium" onClick={() => toggleSort(target)}>
      {label}<span className="text-muted-foreground" aria-hidden="true">{sortMark(target)}</span>
    </Button>
  );

  return (
    <div role="region" aria-label="Documents list table" className="w-full min-w-0">
      <Table className="table-fixed">
        <TableHeader className="bg-muted/50">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10 px-3">
              {onToggleSelectAll && documents.length > 0 && (
                <Checkbox
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={onToggleSelectAll}
                  aria-label={allSelected ? "Deselect all" : "Select all"}
                />
              )}
            </TableHead>
            <TableHead className="min-w-40">{sortableHeader("Title", "name")}</TableHead>
            <TableHead className="hidden sm:table-cell">{sortableHeader("Author", "author")}</TableHead>
            <TableHead className="w-24">{sortableHeader("Format", "format")}</TableHead>
            <TableHead className="hidden w-32 lg:table-cell">Folder</TableHead>
            <TableHead className="hidden w-32 2xl:table-cell">{sortableHeader("Last Opened", "recent")}</TableHead>
            <TableHead className="hidden w-28 2xl:table-cell">{sortableHeader("Added", "added")}</TableHead>
            <TableHead className="hidden w-24 2xl:table-cell">Progress</TableHead>
            <TableHead className="w-10 px-2" aria-label="Actions" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map((doc) => {
            const isSelected = selectedDocIds.has(doc.record.id);
            const title = getDocumentDisplayTitle(doc.record);
            const progress = formatReadingProgress(doc.readingState ?? undefined);
            const author = doc.record.metadata?.authors?.length ? doc.record.metadata.authors.join(", ") : "—";
            const folder = doc.source.kind === "library" ? rootLabel(doc.source.rootId) : "Direct";
            const lastOpened = doc.readingState?.lastOpenedAt ? formatRelativeTime(doc.readingState.lastOpenedAt) : "Never";
            const added = formatRelativeTime(doc.record.firstSeenAt);

            return (
              <TableRow
                key={doc.record.id}
                id={`doc-row-${doc.record.id}`}
                data-library-document-id={doc.record.id}
                data-library-navigable
                data-state={isSelected ? "selected" : undefined}
                tabIndex={0}
                className="library-document-item cursor-pointer outline-none"
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
                  if (event.target !== event.currentTarget) return;
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
                <TableCell className="w-10 px-3" onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    checked={isSelected}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleSelect(doc.record.id, event.shiftKey, true);
                    }}
                    aria-label={isSelected ? `Deselect ${title}` : `Select ${title}`}
                  />
                </TableCell>
                <TableCell className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{title}</span>
                    {doc.availability === "missing" && <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Missing</span>}
                  </div>
                </TableCell>
                <TableCell className="hidden max-w-48 truncate text-muted-foreground sm:table-cell">{author}</TableCell>
                <TableCell><span className="font-mono text-xs text-muted-foreground">{doc.record.format.toUpperCase()}</span></TableCell>
                <TableCell className="hidden max-w-32 truncate text-muted-foreground lg:table-cell">
                  <span className="flex items-center gap-1.5"><FolderIcon className="size-3.5 shrink-0" />{folder}</span>
                </TableCell>
                <TableCell className="hidden font-mono text-xs text-muted-foreground 2xl:table-cell">{lastOpened}</TableCell>
                <TableCell className="hidden font-mono text-xs text-muted-foreground 2xl:table-cell">{added}</TableCell>
                <TableCell className="hidden font-mono text-xs text-muted-foreground 2xl:table-cell">{progress ?? "—"}</TableCell>
                <TableCell className="w-10 px-2" onClick={(event) => event.stopPropagation()}>
                  <Button variant="ghost" size="icon-sm" onClick={(event) => { event.stopPropagation(); onOpenContextMenu(doc, event); }} aria-label={`Actions for ${title}`}>
                    <MoreHorizontalIcon className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
