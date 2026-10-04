import { useEffect, useRef, useState } from "react";
import type { Collection, LibraryRoot, StoredDocument } from "../storage/domain";
import type { LibraryScope } from "../navigation/navigation";
import { getSelectionCapabilities } from "../commands/selectionCommands";
import { getScopeLabel, getSearchScopeOptions, type SortOption } from "./libraryFilter";
import {
  CheckIcon,
  ChevronDownIcon,
  GridIcon,
  ListIcon,
  MoreHorizontalIcon,
  SearchIcon,
} from "./LibraryIcons";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Separator } from "../components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { SidebarTrigger } from "../components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

export interface LibraryToolbarProps {
  activeScope: LibraryScope;
  roots: LibraryRoot[];
  collections?: Collection[];
  searchQuery: string;
  onSearchChange: (query: string) => void;
  viewMode: "grid" | "list";
  onViewModeChange: (mode: "grid" | "list") => void;
  onSelectScope: (scope: LibraryScope) => void;
  sortBy?: SortOption;
  onSortChange?: (sort: SortOption) => void;
  selectedDocuments: StoredDocument[];
  onClearSelection: () => void;
  onOpenSelection: () => void;
  onAddToCollection: () => void;
  onConvertSelection: () => void;
  onExtractPagesSelection: () => void;
  onMergeSelection: () => void;
  onPropertiesSelection: () => void;
  onLocateSelection?: () => void;
  onRemoveSelection: () => void;
  onOpenAppMenu?: () => void;
}

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "name-asc", label: "Title (A → Z)" },
  { value: "name-desc", label: "Title (Z → A)" },
  { value: "author", label: "Author" },
  { value: "added", label: "Date Added" },
  { value: "format", label: "Format" },
];

const SORT_LABEL: Record<SortOption, string> = {
  recent: "Recent",
  "name-asc": "A → Z",
  "name-desc": "Z → A",
  author: "Author",
  added: "Added",
  format: "Format",
  "size-desc": "Size (Large)",
  "size-asc": "Size (Small)",
};

function scopeKey(scope: LibraryScope) {
  switch (scope.kind) {
    case "all":
      return "all";
    case "root":
      return `root:${scope.rootId}`;
    case "folder":
      return `folder:${scope.rootId}:${scope.relativePath}`;
    case "collection":
      return `collection:${scope.collectionId}`;
    case "search":
      return `search:${scope.query}`;
  }
}

export function LibraryToolbar({
  activeScope,
  roots,
  collections = [],
  searchQuery,
  onSearchChange,
  viewMode,
  onViewModeChange,
  onSelectScope,
  sortBy = "recent",
  onSortChange,
  selectedDocuments,
  onClearSelection,
  onOpenSelection,
  onAddToCollection,
  onConvertSelection,
  onExtractPagesSelection,
  onMergeSelection,
  onPropertiesSelection,
  onLocateSelection,
  onRemoveSelection,
  onOpenAppMenu,
}: LibraryToolbarProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [isScopePickerOpen, setIsScopePickerOpen] = useState(false);
  const lastContextScopeRef = useRef<LibraryScope | null>(null);

  useEffect(() => {
    if (activeScope.kind !== "all" && activeScope.kind !== "search") {
      lastContextScopeRef.current = activeScope;
    }
  }, [activeScope]);

  useEffect(() => {
    if (!searchQuery) setIsScopePickerOpen(false);
  }, [searchQuery]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (isScopePickerOpen) {
          event.preventDefault();
          setIsScopePickerOpen(false);
          searchInputRef.current?.focus();
          return;
        }
        if (selectedDocuments.length > 0) {
          event.preventDefault();
          onClearSelection();
          return;
        }
        if (searchInputRef.current === document.activeElement) {
          event.preventDefault();
          onSearchChange("");
          searchInputRef.current?.blur();
        }
        return;
      }

      const targetTag = (event.target as HTMLElement)?.tagName?.toLowerCase();
      if (["input", "textarea", "select"].includes(targetTag)) return;
      if (event.key === "/" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k")) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isScopePickerOpen, onClearSelection, onSearchChange, selectedDocuments.length]);

  const capabilities = getSelectionCapabilities(selectedDocuments);
  if (selectedDocuments.length > 0) {
    const actionButton = "shrink-0";
    return (
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4" role="toolbar" aria-label="Selection actions">
        <span className="shrink-0 text-sm font-medium tabular-nums">
          {selectedDocuments.length} {selectedDocuments.length === 1 ? "document" : "documents"} selected
        </span>
        <Separator orientation="vertical" className="h-6" />
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
          {capabilities.canOpen && <Button size="sm" variant="outline" className={actionButton} onClick={() => { setRemoveConfirm(false); onOpenSelection(); }}>Open</Button>}
          <Button size="sm" variant="outline" className={actionButton} onClick={() => { setRemoveConfirm(false); onAddToCollection(); }}>Add to collection</Button>
          {capabilities.canConvert && <Button size="sm" variant="outline" className={actionButton} onClick={() => { setRemoveConfirm(false); onConvertSelection(); }}>Convert…</Button>}
          {capabilities.canExtractPages && <Button size="sm" variant="outline" className={actionButton} onClick={() => { setRemoveConfirm(false); onExtractPagesSelection(); }}>Extract pages…</Button>}
          {capabilities.canMergePdfs && <Button size="sm" variant="outline" className={actionButton} onClick={() => { setRemoveConfirm(false); onMergeSelection(); }}>Merge PDFs…</Button>}
          {capabilities.canViewProperties && <Button size="sm" variant="outline" className={actionButton} onClick={() => { setRemoveConfirm(false); onPropertiesSelection(); }}>Properties</Button>}
          {capabilities.canLocate && onLocateSelection && <Button size="sm" variant="outline" className={actionButton} onClick={() => { setRemoveConfirm(false); onLocateSelection(); }}>Locate file…</Button>}
          {removeConfirm ? (
            <div className="flex shrink-0 items-center gap-1">
              <span className="px-2 text-xs text-muted-foreground">Remove selected from library?</span>
              <Button size="sm" variant="destructive" onClick={() => { setRemoveConfirm(false); onRemoveSelection(); }}>Remove</Button>
              <Button size="sm" variant="ghost" onClick={() => setRemoveConfirm(false)}>Cancel</Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setRemoveConfirm(true)}>Remove from library</Button>
          )}
        </div>
        <Button size="icon-sm" variant="ghost" onClick={() => { setRemoveConfirm(false); onClearSelection(); }} aria-label="Clear selection" title="Clear selection (Esc)">×</Button>
      </header>
    );
  }

  function renderScopeTitle() {
    if (activeScope.kind === "all") return <h1 className="truncate text-sm font-semibold">All Documents</h1>;
    if (activeScope.kind === "collection") {
      const collection = collections.find((item) => item.id === activeScope.collectionId);
      return <h1 className="truncate text-sm font-semibold">{collection?.name ?? "Collection"}</h1>;
    }
    if (activeScope.kind === "search") return <h1 className="truncate text-sm font-semibold">Search: “{activeScope.query}”</h1>;
    if (activeScope.kind === "root") {
      const root = roots.find((item) => item.id === activeScope.rootId);
      return <h1 className="truncate text-sm font-semibold">{root?.label ?? "Folder"}</h1>;
    }

    const root = roots.find((item) => item.id === activeScope.rootId);
    const parts = activeScope.relativePath.split("/");
    return (
      <nav className="flex min-w-0 items-center gap-1 overflow-hidden text-sm" aria-label="Breadcrumb location">
        <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelectScope({ kind: "root", rootId: activeScope.rootId })}>{root?.label ?? "Folder"}</button>
        {parts.map((part, index) => {
          const subPath = parts.slice(0, index + 1).join("/");
          const isLast = index === parts.length - 1;
          return (
            <span key={subPath} className="flex min-w-0 items-center gap-1">
              <ChevronDownIcon className="size-3 -rotate-90 shrink-0 text-muted-foreground" aria-hidden="true" />
              {isLast ? <span className="truncate font-medium" aria-current="location">{part}</span> : (
                <button type="button" className="truncate text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelectScope({ kind: "folder", rootId: activeScope.rootId, relativePath: subPath })}>{part}</button>
              )}
            </span>
          );
        })}
      </nav>
    );
  }

  const scopeOptions = getSearchScopeOptions(lastContextScopeRef.current, roots, collections);
  const selectedScopeKey = scopeKey(activeScope);

  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-border bg-background px-4 py-2" role="toolbar" aria-label="Library toolbar">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="size-8 shrink-0" aria-label="Toggle sidebar" />
        <div className="min-w-0">{renderScopeTitle()}</div>
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-end gap-2 max-sm:basis-full max-sm:justify-start">
        <div className="flex h-9 min-w-[150px] max-w-md flex-1 items-center gap-1 rounded-md border border-input bg-background px-2 focus-within:ring-2 focus-within:ring-ring/50">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {searchQuery && (
            <DropdownMenu open={isScopePickerOpen} onOpenChange={setIsScopePickerOpen}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="secondary" className="h-7 max-w-36 shrink-0 gap-1 px-2 text-xs" aria-label={`Search scope: ${getScopeLabel(activeScope, roots, collections)}`}>
                  <span className="truncate">{getScopeLabel(activeScope, roots, collections)}</span>
                  <ChevronDownIcon className="size-3 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>Search scope</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup
                  value={selectedScopeKey}
                  onValueChange={(value) => {
                    const option = scopeOptions.find(({ scope }) => scopeKey(scope) === value);
                    if (option) onSelectScope(option.scope);
                  }}
                >
                  {scopeOptions.map(({ scope, label }) => (
                    <DropdownMenuRadioItem key={scopeKey(scope)} value={scopeKey(scope)}>
                      <span className="truncate">{label}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Input
            ref={searchInputRef}
            className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
            placeholder={activeScope.kind === "all" ? "Search library…" : `Search in ${getScopeLabel(activeScope, roots, collections)}…`}
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            aria-label="Search library"
          />
          {!searchQuery && <kbd className="shrink-0 rounded border border-border px-1.5 text-[10px] text-muted-foreground">/</kbd>}
          {searchQuery && <Button size="icon-xs" variant="ghost" className="shrink-0" onClick={() => { onSearchChange(""); searchInputRef.current?.focus(); }} aria-label="Clear search query" title="Clear search (Esc)">×</Button>}
        </div>

        {onSortChange && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="shrink-0 gap-2" aria-label={`Sort documents: ${SORT_LABEL[sortBy] ?? "Recent"}`}>
                <span className="text-muted-foreground">Sort:</span> {SORT_LABEL[sortBy] ?? "Recent"}
                <ChevronDownIcon className="size-3 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {SORT_OPTIONS.map(({ value, label }) => (
                <DropdownMenuItem key={value} onClick={() => onSortChange(value)}>
                  {label}
                  {sortBy === value && <CheckIcon className="ml-auto size-4" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <Separator orientation="vertical" className="h-6 max-sm:hidden" />
        <div className="flex shrink-0 items-center rounded-md border border-border p-0.5" role="radiogroup" aria-label="Presentation mode">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant={viewMode === "grid" ? "secondary" : "ghost"} onClick={() => onViewModeChange("grid")} role="radio" aria-checked={viewMode === "grid"} aria-label="Grid view">
                <GridIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Grid view</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant={viewMode === "list" ? "secondary" : "ghost"} onClick={() => onViewModeChange("list")} role="radio" aria-checked={viewMode === "list"} aria-label="List view">
                <ListIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>List view</TooltipContent>
          </Tooltip>
        </div>

        {onOpenAppMenu && (
          <Button size="icon-sm" variant="ghost" className="shrink-0" onClick={onOpenAppMenu} title="Clio menu" aria-label="App menu">
            <MoreHorizontalIcon className="size-4" />
          </Button>
        )}
      </div>
    </header>
  );
}
