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
import { isEditableTarget } from "../navigation/navigation";

export interface LibraryToolbarProps {
  activeScope: LibraryScope;
  roots: LibraryRoot[];
  collections?: Collection[];
  searchQuery: string;
  onSearchChange: (query: string) => void;
  focusSearchRequest?: number;
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
  focusSearchRequest = 0,
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
  const searchControlRef = useRef<HTMLDivElement | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(Boolean(searchQuery));
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [isScopePickerOpen, setIsScopePickerOpen] = useState(false);
  const lastContextScopeRef = useRef<LibraryScope | null>(null);

  useEffect(() => {
    if (activeScope.kind !== "all" && activeScope.kind !== "search") {
      lastContextScopeRef.current = activeScope;
    }
  }, [activeScope]);

  useEffect(() => {
    if (searchQuery) setIsSearchOpen(true);
    if (!searchQuery) setIsScopePickerOpen(false);
  }, [searchQuery]);

  useEffect(() => {
    if (!focusSearchRequest) return;
    setIsSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [focusSearchRequest]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (isScopePickerOpen) {
          event.preventDefault();
          setIsScopePickerOpen(false);
          searchInputRef.current?.focus();
          return;
        }
        if (document.querySelector('[role="dialog"], [role="menu"]')) return;
        if (event.target === searchInputRef.current) {
          event.preventDefault();
          if (searchQuery) {
            onSearchChange("");
          } else {
            searchInputRef.current?.blur();
            setIsSearchOpen(false);
          }
          return;
        }
        if (isSearchOpen && !searchQuery) {
          setIsSearchOpen(false);
          return;
        }
        if (selectedDocuments.length > 0) {
          event.preventDefault();
          onClearSelection();
        }
        return;
      }

      if (isEditableTarget(event.target) || document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (event.key === "/") {
        event.preventDefault();
        if (selectedDocuments.length > 0) onClearSelection();
        setIsSearchOpen(true);
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
      }
    }

    function handleOutsidePointer(event: PointerEvent) {
      if (
        isSearchOpen &&
        !searchQuery &&
        searchControlRef.current &&
        !searchControlRef.current.contains(event.target as Node)
      ) {
        setIsSearchOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handleOutsidePointer);
    };
  }, [isScopePickerOpen, isSearchOpen, onClearSelection, onSearchChange, searchQuery, selectedDocuments.length]);

  const capabilities = getSelectionCapabilities(selectedDocuments);
  if (selectedDocuments.length > 0) {
    const actionButton = "shrink-0";
    return (
      <header className="library-toolbar flex h-[46px] shrink-0 items-center gap-2 border-b border-border bg-background px-3" role="toolbar" aria-label="Selection actions">
        <span className="shrink-0 text-sm font-medium tabular-nums">
          {selectedDocuments.length} {selectedDocuments.length === 1 ? "document" : "documents"} selected
        </span>
        <Separator orientation="vertical" className="h-6" />
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
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
        <Button size="icon-sm" variant="ghost" onClick={() => { setRemoveConfirm(false); onClearSelection(); }} aria-label="Clear selection">×</Button>
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
    <header className="library-toolbar flex h-[46px] shrink-0 items-center gap-2 border-b border-border bg-background px-3" role="toolbar" aria-label="Library toolbar">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <SidebarTrigger className="size-9 shrink-0" aria-label="Toggle sidebar" />
        <div className="min-w-0">{renderScopeTitle()}</div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <div
          ref={searchControlRef}
          className={`library-search-control flex h-9 shrink-0 items-center rounded-md ${isSearchOpen ? "library-search-control-open gap-1 border border-border px-2" : "w-9 justify-center"}`}
        >
          {isSearchOpen ? (
            <>
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              {searchQuery && (
                <DropdownMenu open={isScopePickerOpen} onOpenChange={setIsScopePickerOpen}>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="secondary" className="h-7 max-w-36 shrink-0 gap-1 px-2 text-xs" aria-label={`Search scope: ${getScopeLabel(activeScope, roots, collections)}`}>
                      <span className="truncate">{getScopeLabel(activeScope, roots, collections)}</span>
                      <ChevronDownIcon className="size-3 shrink-0" aria-hidden="true" />
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
                className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 text-foreground shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
                placeholder={activeScope.kind === "all" ? "Search in Books..." : `Search in ${getScopeLabel(activeScope, roots, collections)}...`}
                value={searchQuery}
                onFocus={() => setIsSearchOpen(true)}
                onChange={(event) => onSearchChange(event.target.value)}
                aria-label="Search library"
              />
              {searchQuery && (
                <Button size="icon-xs" variant="ghost" className="shrink-0" onClick={() => { onSearchChange(""); searchInputRef.current?.focus(); }} aria-label="Clear search query">×</Button>
              )}
            </>
          ) : (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="size-9 shrink-0"
              onClick={() => {
                setIsSearchOpen(true);
                requestAnimationFrame(() => searchInputRef.current?.focus());
              }}
              aria-label="Search library"
              aria-keyshortcuts="/"
            >
              <SearchIcon className="size-4" aria-hidden="true" />
            </Button>
          )}
        </div>

        {onSortChange && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-9 shrink-0 px-2 text-xs" aria-label={`Sort documents: ${SORT_LABEL[sortBy] ?? "Recent"}`}>
                {SORT_LABEL[sortBy] ?? "Recent"}
                <ChevronDownIcon className="size-3 text-muted-foreground" aria-hidden="true" />
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

        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="size-9 shrink-0"
          aria-label={`Switch to ${viewMode === "grid" ? "list" : "grid"} view`}
          aria-pressed={viewMode === "grid"}
          aria-keyshortcuts="Control+Shift+G Meta+Shift+G"
          onClick={() => onViewModeChange(viewMode === "grid" ? "list" : "grid")}
        >
          {viewMode === "grid" ? <GridIcon className="size-4" /> : <ListIcon className="size-4" />}
        </Button>

        {onOpenAppMenu && (
          <Button size="icon-sm" variant="ghost" className="size-9 shrink-0" onClick={onOpenAppMenu} aria-label="App menu">
            <MoreHorizontalIcon className="size-4" />
          </Button>
        )}
      </div>
    </header>
  );
}
