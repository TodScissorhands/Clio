import { useEffect, useRef, useState } from "react";
import type { LibraryRoot, StoredDocument } from "../storage/domain";
import type { LibraryScope } from "../navigation/navigation";
import { getSelectionCapabilities } from "../commands/selectionCommands";

export interface LibraryToolbarProps {
  activeScope: LibraryScope;
  roots: LibraryRoot[];
  searchQuery: string;
  onSearchChange: (query: string) => void;
  viewMode: "grid" | "list";
  onViewModeChange: (mode: "grid" | "list") => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onSelectScope: (scope: LibraryScope) => void;
  // Selection
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

function getScopeLabel(scope: LibraryScope, roots: LibraryRoot[]): string {
  switch (scope.kind) {
    case "all":
      return "Entire Library";
    case "root": {
      const root = roots.find((r) => r.id === scope.rootId);
      return root?.label ?? "Folder";
    }
    case "folder": {
      const parts = scope.relativePath.split("/").filter(Boolean);
      return parts[parts.length - 1] ?? "Folder";
    }
    case "collection":
      return "Current Collection";
    case "search":
      return "Search";
  }
}
export function LibraryToolbar({
  activeScope,
  roots,
  searchQuery,
  onSearchChange,
  viewMode,
  onViewModeChange,
  sidebarCollapsed,
  onToggleSidebar,
  onSelectScope,
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

  // Global search shortcut: "/" or "Ctrl/Cmd+K" focuses search input; "Escape" clears selection or search
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (selectedDocuments.length > 0) {
          e.preventDefault();
          onClearSelection();
          return;
        }
        if (searchInputRef.current === document.activeElement) {
          e.preventDefault();
          onSearchChange("");
          searchInputRef.current?.blur();
        }
        return;
      }

      const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      const isInput = targetTag === "input" || targetTag === "textarea" || targetTag === "select";
      if (isInput) return;

      if (e.key === "/" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClearSelection, onSearchChange, selectedDocuments.length]);

  const isSelectionMode = selectedDocuments.length > 0;
  const caps = getSelectionCapabilities(selectedDocuments);
  if (isSelectionMode) {
    return (
      <header className="library-toolbar selection-action-bar" role="toolbar" aria-label="Selection actions">
        <div className="selection-count-group">
          <span className="selection-count-badge">
            {selectedDocuments.length} {selectedDocuments.length === 1 ? "document" : "documents"} selected
          </span>
        </div>

        <div className="selection-actions-group">
          {caps.canOpen && (
            <button
              type="button"
              className="action-bar-btn"
              onClick={() => { setRemoveConfirm(false); onOpenSelection(); }}
              title="Open selected document"
            >
              Open
            </button>
          )}

          <button
            type="button"
            className="action-bar-btn"
            onClick={() => { setRemoveConfirm(false); onAddToCollection(); }}
            title="Add selected documents to a collection"
          >
            Add to collection
          </button>

          {caps.canConvert && (
            <button
              type="button"
              className="action-bar-btn"
              onClick={() => { setRemoveConfirm(false); onConvertSelection(); }}
              title="Convert selected document"
            >
              Convert…
            </button>
          )}

          {caps.canExtractPages && (
            <button
              type="button"
              className="action-bar-btn"
              onClick={() => { setRemoveConfirm(false); onExtractPagesSelection(); }}
              title="Extract pages from selected PDF"
            >
              Extract pages…
            </button>
          )}

          {caps.canMergePdfs && (
            <button
              type="button"
              className="action-bar-btn"
              onClick={() => { setRemoveConfirm(false); onMergeSelection(); }}
              title="Merge selected PDFs into one document"
            >
              Merge PDFs…
            </button>
          )}

          {caps.canViewProperties && (
            <button
              type="button"
              className="action-bar-btn"
              onClick={() => { setRemoveConfirm(false); onPropertiesSelection(); }}
              title="Document properties"
            >
              Properties
            </button>
          )}

          {caps.canLocate && onLocateSelection && (
            <button
              type="button"
              className="action-bar-btn"
              onClick={() => { setRemoveConfirm(false); onLocateSelection(); }}
              title="Locate moved or renamed file"
            >
              Locate file…
            </button>
          )}

          {removeConfirm ? (
            <span className="selection-remove-confirm">
              <span className="confirm-label">Remove {selectedDocuments.length === 1 ? "this document" : `${selectedDocuments.length} documents`}?</span>
              <button
                type="button"
                className="action-bar-btn danger"
                onClick={() => { setRemoveConfirm(false); onRemoveSelection(); }}
                title="Confirm removal from library catalog (file is NOT deleted)"
              >
                Remove
              </button>
              <button
                type="button"
                className="action-bar-btn"
                onClick={() => setRemoveConfirm(false)}
                title="Cancel"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="action-bar-btn danger"
              onClick={() => setRemoveConfirm(true)}
              title="Remove selected documents from library catalog (does not delete files)"
            >
              Remove from library
            </button>
          )}

          <button
            type="button"
            className="action-bar-close-btn"
            onClick={() => { setRemoveConfirm(false); onClearSelection(); }}
            title="Clear selection (Esc)"
            aria-label="Clear selection"
          >
            ✕
          </button>
        </div>
      </header>
    );
  }

  // Normal Library Toolbar
  function renderBreadcrumbOrTitle() {
    if (activeScope.kind === "all") {
      return <h1 className="scope-title">All</h1>;
    }
    if (activeScope.kind === "collection") {
      return <h1 className="scope-title">Collection</h1>;
    }
    if (activeScope.kind === "search") {
      return <h1 className="scope-title">Search: “{activeScope.query}”</h1>;
    }
    if (activeScope.kind === "root") {
      const root = roots.find((r) => r.id === activeScope.rootId);
      return <h1 className="scope-title">{root?.label ?? "Folder"}</h1>;
    }
    if (activeScope.kind === "folder") {
      const root = roots.find((r) => r.id === activeScope.rootId);
      const rootLabel = root?.label ?? "Folder";
      const parts = activeScope.relativePath.split("/");

      return (
        <nav className="library-breadcrumb" aria-label="Breadcrumb location">
          <button
            type="button"
            className="breadcrumb-segment-btn"
            onClick={() => onSelectScope({ kind: "root", rootId: activeScope.rootId })}
          >
            {rootLabel}
          </button>
          {parts.map((part, index) => {
            const isLast = index === parts.length - 1;
            const subPath = parts.slice(0, index + 1).join("/");
            return (
              <span key={subPath} className="breadcrumb-wrapper">
                <span className="breadcrumb-separator" aria-hidden="true">
                  ›
                </span>
                {isLast ? (
                  <span className="breadcrumb-current" aria-current="location">
                    {part}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="breadcrumb-segment-btn"
                    onClick={() =>
                      onSelectScope({
                        kind: "folder",
                        rootId: activeScope.rootId,
                        relativePath: subPath,
                      })
                    }
                  >
                    {part}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
      );
    }
    return <h1 className="scope-title">Library</h1>;
  }

  return (
    <header className="library-toolbar" role="toolbar" aria-label="Library toolbar">
      <div className="toolbar-left-group">
        <button
          type="button"
          className={`sidebar-toggle-btn ${sidebarCollapsed ? "collapsed" : ""}`}
          onClick={onToggleSidebar}
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          ☰
        </button>
        <div className="toolbar-scope-display">{renderBreadcrumbOrTitle()}</div>
      </div>

      <div className="toolbar-right-group">
        <div className="toolbar-search-wrap">
          <span className="search-icon" aria-hidden="true">
            🔍
          </span>
          <input
            ref={searchInputRef}
            type="text"
            className="toolbar-search-input"
            placeholder={activeScope.kind === "all" ? "Search library…" : `Search in ${getScopeLabel(activeScope, roots)}…`}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            aria-label="Search library"
          />
          {activeScope.kind !== "all" && searchQuery && (
            <button
              type="button"
              className="search-scope-pill"
              onClick={() => onSelectScope({ kind: "all" })}
              title={`Searching in ${getScopeLabel(activeScope, roots)}. Click to search Entire Library.`}
            >
              <span>Scope: {getScopeLabel(activeScope, roots)}</span>
              <span className="scope-all-action">✕ All</span>
            </button>
          )}
          {!searchQuery && (
            <kbd className="search-shortcut-hint" aria-hidden="true" title="Press / to search">
              /
            </kbd>
          )}
          {searchQuery && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => {
                onSearchChange("");
                searchInputRef.current?.focus();
              }}
              aria-label="Clear search query"
              title="Clear search (Esc)"
            >
              ✕
            </button>
          )}
        </div>

        <div className="view-mode-toggle-group" role="radiogroup" aria-label="Presentation mode">
          <button
            type="button"
            role="radio"
            aria-checked={viewMode === "grid"}
            className={`view-mode-btn ${viewMode === "grid" ? "selected" : ""}`}
            onClick={() => onViewModeChange("grid")}
            title="Grid view"
            aria-label="Grid view"
          >
            ⊞
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={viewMode === "list"}
            className={`view-mode-btn ${viewMode === "list" ? "selected" : ""}`}
            onClick={() => onViewModeChange("list")}
            title="List view"
            aria-label="List view"
          >
            ☰
          </button>
        </div>

        {onOpenAppMenu && (
          <button
            type="button"
            className="app-menu-btn"
            onClick={onOpenAppMenu}
            title="Clio menu"
            aria-label="App menu"
          >
            ⋯
          </button>
        )}
      </div>
    </header>
  );
}
