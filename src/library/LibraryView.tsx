import { useId, useMemo, useState } from "react";
import type { LibraryRoot, ReadingState, StoredDocument } from "../storage/domain";
import { formatBytes, isReaderFormat } from "../storage/domain";
import {
  filterDocuments,
  formatReadingProgress,
  formatRelativeTime,
  sortDocuments,
  type FormatFilterOption,
  type SortOption,
} from "./libraryFilter";

export type LibraryViewProps = {
  roots: LibraryRoot[];
  documents: StoredDocument[];
  readingStates: Record<string, ReadingState>;
  selectedRootId: string | null;
  pending: boolean;
  pendingRootId: string | null;
  message: string;
  error: string;
  onAddRoot(): void;
  onSelectRoot(rootId: string | null): void;
  onScan(rootId: string): void;
  onRemove(rootId: string): void;
  onOpen(document: StoredDocument): void;
};

export function LibraryView({
  roots,
  documents,
  readingStates,
  selectedRootId,
  pending,
  pendingRootId,
  message,
  error,
  onAddRoot,
  onSelectRoot,
  onScan,
  onRemove,
  onOpen,
}: LibraryViewProps) {
  const searchInputId = useId();
  const sortSelectId = useId();

  const [searchQuery, setSearchQuery] = useState("");
  const [formatFilter, setFormatFilter] = useState<FormatFilterOption>("all");
  const [sortBy, setSortBy] = useState<SortOption>("recent");

  // Calculate format counts for filter chips
  const formatCounts = useMemo(() => {
    const scoped = selectedRootId
      ? documents.filter((d) => d.source.kind === "library" && d.source.rootId === selectedRootId)
      : documents;
    let pdf = 0;
    let epub = 0;
    let other = 0;
    for (const doc of scoped) {
      if (doc.record.format === "pdf") pdf += 1;
      else if (doc.record.format === "epub") epub += 1;
      else other += 1;
    }
    return { all: scoped.length, pdf, epub, other };
  }, [documents, selectedRootId]);

  // Filter and sort visible documents
  const filteredDocuments = useMemo(() => {
    const matched = filterDocuments(documents, searchQuery, formatFilter, selectedRootId);
    return sortDocuments(matched, sortBy, readingStates);
  }, [documents, searchQuery, formatFilter, selectedRootId, sortBy, readingStates]);

  const selectedRoot = useMemo(() => {
    return selectedRootId ? roots.find((r) => r.id === selectedRootId) ?? null : null;
  }, [roots, selectedRootId]);

  const hasSearch = searchQuery.trim().length > 0;
  const hasFilter = formatFilter !== "all";

  return (
    <section className="library-view" aria-label="Library">
      {/* Top Header */}
      <header className="library-header">
        <div className="library-header-main">
          <div className="library-title-row">
            <h1 className="library-title">Library</h1>
            <span className="library-count-badge" aria-label={`${documents.length} total documents`}>
              {documents.length} {documents.length === 1 ? "document" : "documents"}
            </span>
          </div>
          <p className="library-subtitle">
            Local documents stay in directories you control. Open any file to read offline.
          </p>
        </div>
        <div className="library-header-actions">
          <button
            type="button"
            className="primary-button library-add-button"
            onClick={onAddRoot}
            disabled={pending}
          >
            <span>+</span> Add directory
          </button>
        </div>
      </header>

      {/* Global Alerts / Messages */}
      {error && (
        <div className="library-alert error" role="alert">
          <span className="library-alert-icon">⚠</span>
          <span className="library-alert-text">{error}</span>
        </div>
      )}
      {message && (
        <div className="library-alert info" aria-live="polite">
          <span className="library-alert-icon">ℹ</span>
          <span className="library-alert-text">{message}</span>
        </div>
      )}

      {/* Main Two-Column Layout */}
      <div className="library-workspace">
        {/* Left Sidebar: Roots & Folders Navigation */}
        <aside className="library-sidebar" aria-label="Library directories">
          <div className="sidebar-section-header">
            <span className="sidebar-heading">Directories</span>
            <span className="sidebar-count">{roots.length}</span>
          </div>

          <div className="roots-list" role="tablist" aria-orientation="vertical">
            <button
              type="button"
              role="tab"
              aria-selected={selectedRootId === null}
              className={`root-nav-item ${selectedRootId === null ? "active" : ""}`}
              onClick={() => onSelectRoot(null)}
              disabled={pending}
            >
              <span className="root-nav-icon">◈</span>
              <span className="root-nav-label">All documents</span>
              <span className="root-nav-count">{documents.length}</span>
            </button>

            {roots.map((root) => {
              const rootDocsCount = documents.filter(
                (d) => d.source.kind === "library" && d.source.rootId === root.id
              ).length;
              const isSelected = selectedRootId === root.id;
              const isScanning = pendingRootId === root.id;

              return (
                <div
                  key={root.id}
                  className={`root-item-card ${isSelected ? "selected" : ""} ${root.status}`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    className="root-select-btn"
                    onClick={() => onSelectRoot(root.id)}
                    disabled={pending}
                    title={root.label}
                  >
                    <span className="root-folder-icon">📁</span>
                    <span className="root-label-text">{root.label}</span>
                    <span className="root-doc-count">{rootDocsCount}</span>
                  </button>

                  <div className="root-footer">
                    <span className={`root-status-badge ${root.status}`} title={`Status: ${root.status}`}>
                      {root.status}
                    </span>
                    <div className="root-quick-actions">
                      <button
                        type="button"
                        className="root-action-btn"
                        onClick={() => onScan(root.id)}
                        disabled={pending || root.status === "disabled"}
                        title={`Scan ${root.label}`}
                      >
                        {isScanning ? "Scanning…" : "Scan"}
                      </button>
                      <button
                        type="button"
                        className="root-action-btn danger"
                        onClick={() => onRemove(root.id)}
                        disabled={pending}
                        title={`Remove ${root.label} from library`}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {roots.length === 0 && (
            <div className="roots-empty-hint">
              <p>No directories added yet. Add a local folder to start indexing your books and papers.</p>
            </div>
          )}
        </aside>

        {/* Right Main Panel: Toolbar and Document Catalog */}
        <main className="library-catalog" aria-label="Document Catalog">
          {/* Controls Bar: Search, Format Filter, and Sort */}
          <div className="library-toolbar">
            {/* Search Input */}
            <div className="library-search-wrap">
              <label htmlFor={searchInputId} className="visually-hidden">
                Search documents
              </label>
              <span className="search-icon" aria-hidden="true">
                🔍
              </span>
              <input
                id={searchInputId}
                type="text"
                className="library-search-input"
                placeholder="Search by title or path…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setSearchQuery("");
                }}
              />
              {hasSearch && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Filter and Sort Group */}
            <div className="library-filter-group">
              {/* Format Filter Segmented Controls */}
              <div className="format-chips" role="radiogroup" aria-label="Filter by format">
                <button
                  type="button"
                  role="radio"
                  aria-checked={formatFilter === "all"}
                  className={`format-chip ${formatFilter === "all" ? "active" : ""}`}
                  onClick={() => setFormatFilter("all")}
                >
                  All ({formatCounts.all})
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={formatFilter === "pdf"}
                  className={`format-chip ${formatFilter === "pdf" ? "active" : ""}`}
                  onClick={() => setFormatFilter("pdf")}
                >
                  PDF ({formatCounts.pdf})
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={formatFilter === "epub"}
                  className={`format-chip ${formatFilter === "epub" ? "active" : ""}`}
                  onClick={() => setFormatFilter("epub")}
                >
                  EPUB ({formatCounts.epub})
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={formatFilter === "other"}
                  className={`format-chip ${formatFilter === "other" ? "active" : ""}`}
                  onClick={() => setFormatFilter("other")}
                >
                  Other ({formatCounts.other})
                </button>
              </div>

              {/* Sort Selector */}
              <div className="sort-selector">
                <label htmlFor={sortSelectId} className="sort-label">
                  Sort:
                </label>
                <select
                  id={sortSelectId}
                  className="sort-dropdown"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortOption)}
                >
                  <option value="recent">Recently opened</option>
                  <option value="name-asc">Name (A → Z)</option>
                  <option value="name-desc">Name (Z → A)</option>
                  <option value="size-desc">Size (Largest)</option>
                  <option value="size-asc">Size (Smallest)</option>
                  <option value="format">Format</option>
                </select>
              </div>
            </div>
          </div>

          {/* Active Scope / Filter Info */}
          {(selectedRoot || hasSearch || hasFilter) && (
            <div className="catalog-status-bar">
              <div className="scope-indicator">
                {selectedRoot && (
                  <span className="scope-pill">
                    Folder: <strong>{selectedRoot.label}</strong>
                    <button
                      type="button"
                      className="pill-clear"
                      onClick={() => onSelectRoot(null)}
                      title="Show all documents"
                    >
                      ✕
                    </button>
                  </span>
                )}
                {hasFilter && (
                  <span className="scope-pill">
                    Format: <strong>{formatFilter.toUpperCase()}</strong>
                    <button
                      type="button"
                      className="pill-clear"
                      onClick={() => setFormatFilter("all")}
                      title="Reset format filter"
                    >
                      ✕
                    </button>
                  </span>
                )}
                {hasSearch && (
                  <span className="scope-pill">
                    Query: <strong>"{searchQuery}"</strong>
                    <button
                      type="button"
                      className="pill-clear"
                      onClick={() => setSearchQuery("")}
                      title="Clear query"
                    >
                      ✕
                    </button>
                  </span>
                )}
              </div>
              <span className="results-count">
                Showing {filteredDocuments.length} of {documents.length}
              </span>
            </div>
          )}

          {/* Document Grid / List */}
          {filteredDocuments.length > 0 && (
            <div className="document-grid" role="list">
              {filteredDocuments.map((doc) => {
                const readable = isReaderFormat(doc.record.format);
                const isMissing = doc.availability === "missing";
                const canOpen = readable && !isMissing && !pending;

                const readingState = readingStates[doc.record.id];
                const progressText = formatReadingProgress(readingState);
                const relativePath =
                  doc.source.kind === "library" ? doc.source.relativePath : null;
                const directoryPrefix =
                  relativePath && relativePath.includes("/")
                    ? relativePath.slice(0, relativePath.lastIndexOf("/"))
                    : null;

                const lastOpenedText = readingState?.lastOpenedAt
                  ? formatRelativeTime(readingState.lastOpenedAt)
                  : null;

                return (
                  <article
                    key={doc.record.id}
                    className={`doc-card ${isMissing ? "doc-missing" : ""} ${
                      readable ? "doc-readable" : "doc-unsupported"
                    }`}
                    role="listitem"
                  >
                    <div className="doc-card-body">
                      {/* Format Badge / Icon */}
                      <div className="doc-badge-wrap">
                        <span className={`doc-format-badge format-${doc.record.format}`}>
                          {doc.record.format.toUpperCase()}
                        </span>
                        {progressText && (
                          <span className="doc-progress-chip" title="Reading progress">
                            {progressText}
                          </span>
                        )}
                        {isMissing && (
                          <span className="doc-missing-badge" title="File not found in root directory">
                            Missing
                          </span>
                        )}
                      </div>

                      {/* Title & Metadata */}
                      <div className="doc-meta-wrap">
                        <h2 className="doc-title" title={doc.record.name}>
                          {doc.record.name}
                        </h2>

                        <div className="doc-submeta">
                          {directoryPrefix && (
                            <span className="doc-folder-tag" title={`In folder: ${directoryPrefix}`}>
                              📁 {directoryPrefix}
                            </span>
                          )}
                          <span className="doc-size-tag">{formatBytes(doc.record.sizeBytes)}</span>
                          {lastOpenedText && (
                            <span className="doc-opened-tag" title={`Last read: ${readingState?.lastOpenedAt}`}>
                              Opened {lastOpenedText}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Action Button */}
                    <div className="doc-card-actions">
                      <button
                        type="button"
                        className={`doc-action-btn ${canOpen ? "openable" : ""}`}
                        onClick={() => onOpen(doc)}
                        disabled={!canOpen}
                      >
                        {isMissing
                          ? "Missing"
                          : !readable
                          ? "Unsupported"
                          : progressText
                          ? "Continue →"
                          : "Open"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {/* Empty States */}
          {filteredDocuments.length === 0 && (
            <div className="catalog-empty-state">
              {roots.length === 0 ? (
                <div className="empty-message-wrap">
                  <span className="empty-icon">📚</span>
                  <h2>No library directories configured</h2>
                  <p>
                    Add a folder from your filesystem to index your documents. Files remain in
                    their original location.
                  </p>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={onAddRoot}
                    disabled={pending}
                  >
                    Add directory
                  </button>
                </div>
              ) : documents.length === 0 ? (
                <div className="empty-message-wrap">
                  <span className="empty-icon">🔍</span>
                  <h2>No documents indexed yet</h2>
                  <p>
                    {selectedRoot
                      ? `"${selectedRoot.label}" has not been scanned yet or contains no supported files.`
                      : "Your library directories have not been scanned yet."}
                  </p>
                  {selectedRoot ? (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => onScan(selectedRoot.id)}
                      disabled={pending || selectedRoot.status === "disabled"}
                    >
                      {pendingRootId === selectedRoot.id ? "Scanning…" : `Scan "${selectedRoot.label}"`}
                    </button>
                  ) : (
                    roots[0] && (
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => onScan(roots[0].id)}
                        disabled={pending}
                      >
                        Scan library
                      </button>
                    )
                  )}
                </div>
              ) : hasSearch ? (
                <div className="empty-message-wrap">
                  <span className="empty-icon">🔎</span>
                  <h2>No matching documents</h2>
                  <p>
                    No documents matched <strong>"{searchQuery}"</strong>. Check for typos or
                    try a different keyword.
                  </p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setSearchQuery("")}
                  >
                    Clear search
                  </button>
                </div>
              ) : hasFilter ? (
                <div className="empty-message-wrap">
                  <span className="empty-icon">📄</span>
                  <h2>No {formatFilter.toUpperCase()} documents</h2>
                  <p>
                    There are no {formatFilter.toUpperCase()} files in the current view.
                  </p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setFormatFilter("all")}
                  >
                    Show all formats
                  </button>
                </div>
              ) : (
                <div className="empty-message-wrap">
                  <span className="empty-icon">📂</span>
                  <h2>No documents found</h2>
                  <p>No documents are available in this view.</p>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
