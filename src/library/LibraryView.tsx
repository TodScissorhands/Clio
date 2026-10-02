import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Collection, LibraryRoot, ReadingState, StoredDocument } from "../storage/domain";
import { formatBytes, getDocumentDisplayTitle, hasCapability } from "../storage/domain";
import { getDocumentThumbnail } from "../storage/documentStorage";
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
  collections?: Collection[];
  readingStates: Record<string, ReadingState>;
  selectedRootId: string | null;
  pending: boolean;
  pendingRootId: string | null;
  message: string;
  error: string;
  onAddRoot(): void;
  onSelectRoot(rootId: string | null): void;
  onCreateCollection?(name: string, description?: string): Promise<void>;
  onRenameCollection?(id: string, name: string): Promise<void>;
  onDeleteCollection?(id: string): Promise<void>;
  onAddDocToCollection?(collectionId: string, documentId: string): Promise<void>;
  onRemoveDocFromCollection?(collectionId: string, documentId: string): Promise<void>;
  onScan(rootId: string): void;
  onRemove(rootId: string): void;
  onOpen(document: StoredDocument): void;
  onConvert?(document: StoredDocument): void;
};

function DocThumbnail({
  documentId,
  format,
  title,
  hasThumbnail,
}: {
  documentId: string;
  format: string;
  title: string;
  hasThumbnail: boolean;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!hasThumbnail) return;
    let cancelled = false;
    getDocumentThumbnail(documentId)
      .then((url) => {
        if (!cancelled) {
          if (url) setDataUrl(url);
          else setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, hasThumbnail]);

  if (hasThumbnail && dataUrl && !failed) {
    return (
      <div className="doc-thumbnail-wrap">
        <img
          src={dataUrl}
          alt={`Cover for ${title}`}
          className="doc-cover-image"
          loading="lazy"
        />
      </div>
    );
  }

  const icon = format === "epub" ? "📖" : format === "pdf" ? "📄" : "📝";
  return (
    <div className={`doc-thumbnail-wrap placeholder format-${format}`} aria-hidden="true">
      <span className="thumb-placeholder-format">{format.toUpperCase()}</span>
      <span className="thumb-placeholder-icon">{icon}</span>
    </div>
  );
}

export function LibraryView({
  roots,
  documents,
  collections = [],
  readingStates,
  selectedRootId,
  pending,
  pendingRootId,
  message,
  error,
  onAddRoot,
  onSelectRoot,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
  onAddDocToCollection,
  onRemoveDocFromCollection,
  onScan,
  onRemove,
  onOpen,
  onConvert,
}: LibraryViewProps) {
  const searchInputId = useId();
  const sortSelectId = useId();

  const [searchQuery, setSearchQuery] = useState("");
  const [formatFilter, setFormatFilter] = useState<FormatFilterOption>("all");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Global search shortcut: "/" or "Ctrl/Cmd+K" focuses search input; "Escape" clears/blurs
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      const isInput = targetTag === "input" || targetTag === "textarea" || targetTag === "select";

      if (e.key === "Escape") {
        if (searchInputRef.current === document.activeElement) {
          setSearchQuery("");
          searchInputRef.current?.blur();
        }
        return;
      }

      if (isInput) return;

      if (e.key === "/" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Inline collection creation / rename state
  const [isCreatingCollection, setIsCreatingCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [renamingCollectionId, setRenamingCollectionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Validate active root selection against loaded roots
  const effectiveRootId = useMemo(() => {
    if (!selectedRootId) return null;
    return roots.some((r) => r.id === selectedRootId) ? selectedRootId : null;
  }, [roots, selectedRootId]);

  // Calculate format counts for filter chips within active scope
  const formatCounts = useMemo(() => {
    let scoped = documents;
    if (effectiveRootId) {
      scoped = scoped.filter(
        (d) => d.source.kind === "library" && d.source.rootId === effectiveRootId
      );
    }
    if (selectedCollectionId) {
      scoped = scoped.filter((d) => d.record.collections?.includes(selectedCollectionId));
    }
    let pdf = 0;
    let epub = 0;
    let other = 0;
    for (const doc of scoped) {
      if (doc.record.format === "pdf") pdf += 1;
      else if (doc.record.format === "epub") epub += 1;
      else other += 1;
    }
    return { all: scoped.length, pdf, epub, other };
  }, [documents, effectiveRootId, selectedCollectionId]);

  // Filter and sort visible documents
  const filteredDocuments = useMemo(() => {
    const matched = filterDocuments(
      documents,
      searchQuery,
      formatFilter,
      effectiveRootId,
      selectedCollectionId
    );
    return sortDocuments(matched, sortBy, readingStates);
  }, [
    documents,
    searchQuery,
    formatFilter,
    effectiveRootId,
    selectedCollectionId,
    sortBy,
    readingStates,
  ]);

  const selectedRoot = useMemo(() => {
    return effectiveRootId ? roots.find((r) => r.id === effectiveRootId) ?? null : null;
  }, [roots, effectiveRootId]);
  const selectedCollection = useMemo(() => {
    return selectedCollectionId
      ? collections.find((c) => c.id === selectedCollectionId) ?? null
      : null;
  }, [collections, selectedCollectionId]);

  const hasSearch = searchQuery.trim().length > 0;
  const hasFilter = formatFilter !== "all";

  async function handleSaveNewCollection(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newCollectionName.trim();
    if (!trimmed || !onCreateCollection) return;
    await onCreateCollection(trimmed);
    setNewCollectionName("");
    setIsCreatingCollection(false);
  }

  async function handleSaveRenameCollection(e: React.FormEvent, id: string) {
    e.preventDefault();
    const trimmed = renameValue.trim();
    if (!trimmed || !onRenameCollection) return;
    await onRenameCollection(id, trimmed);
    setRenamingCollectionId(null);
    setRenameValue("");
  }

  return (
    <section className="library-view" aria-label="Library">
      {/* Top Header */}
      <header className="library-header">
        <div className="library-header-main">
          <div className="library-title-row">
            <h1 className="library-title">Library</h1>
            <span
              className="library-count-badge"
              aria-label={`${documents.length} total documents`}
            >
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

      {/* Actionable Error Alert */}
      {error && (
        <div className="library-alert error" role="alert">
          <span className="library-alert-icon">⚠</span>
          <span className="library-alert-text">{error}</span>
        </div>
      )}

      {/* Main Two-Column Layout */}
      <div className="library-workspace">
        {/* Left Sidebar: Roots & Collections Navigation */}
        <aside className="library-sidebar" aria-label="Library navigation">
          {/* Directories Section */}
          <div className="sidebar-section-header">
            <span className="sidebar-heading">Directories</span>
            <span className="sidebar-count">{roots.length}</span>
          </div>

          <div className="roots-list" role="tablist" aria-orientation="vertical">
            <button
              type="button"
              role="tab"
              aria-selected={selectedRootId === null && selectedCollectionId === null}
              className={`root-nav-item ${
                selectedRootId === null && selectedCollectionId === null ? "active" : ""
              }`}
              onClick={() => {
                onSelectRoot(null);
                setSelectedCollectionId(null);
              }}
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
                    onClick={() => {
                      onSelectRoot(root.id);
                      setSelectedCollectionId(null);
                    }}
                    disabled={pending}
                    title={root.label}
                  >
                    <span className="root-folder-icon">📁</span>
                    <span className="root-label-text">{root.label}</span>
                    <span className="root-doc-count">{rootDocsCount}</span>
                  </button>

                  <div className="root-footer">
                    <span
                      className={`root-status-badge ${root.status}`}
                      title={`Status: ${root.status}`}
                    >
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
              <p>
                No directories added yet. Add a local folder to start indexing your books and
                papers.
              </p>
            </div>
          )}

          {/* Collections Section */}
          <div className="sidebar-section-header collections-header">
            <span className="sidebar-heading">Collections</span>
            <div className="sidebar-header-actions">
              <span className="sidebar-count">{collections.length}</span>
              {onCreateCollection && (
                <button
                  type="button"
                  className="icon-action-btn"
                  onClick={() => setIsCreatingCollection(true)}
                  title="Create new collection"
                  aria-label="Create new collection"
                >
                  +
                </button>
              )}
            </div>
          </div>

          {isCreatingCollection && (
            <form onSubmit={handleSaveNewCollection} className="collection-inline-form">
              <input
                type="text"
                autoFocus
                placeholder="Collection name…"
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                className="collection-inline-input"
              />
              <div className="collection-form-actions">
                <button type="submit" className="mini-save-btn">
                  Save
                </button>
                <button
                  type="button"
                  className="mini-cancel-btn"
                  onClick={() => {
                    setIsCreatingCollection(false);
                    setNewCollectionName("");
                  }}
                >
                  ✕
                </button>
              </div>
            </form>
          )}

          <div className="collections-list" role="tablist" aria-orientation="vertical">
            {collections.map((col) => {
              const isSelected = selectedCollectionId === col.id;
              const count = documents.filter((d) =>
                d.record.collections?.includes(col.id)
              ).length;
              const isRenaming = renamingCollectionId === col.id;

              if (isRenaming) {
                return (
                  <form
                    key={col.id}
                    onSubmit={(e) => void handleSaveRenameCollection(e, col.id)}
                    className="collection-inline-form"
                  >
                    <input
                      type="text"
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      className="collection-inline-input"
                    />
                    <div className="collection-form-actions">
                      <button type="submit" className="mini-save-btn">
                        Save
                      </button>
                      <button
                        type="button"
                        className="mini-cancel-btn"
                        onClick={() => setRenamingCollectionId(null)}
                      >
                        ✕
                      </button>
                    </div>
                  </form>
                );
              }

              return (
                <div
                  key={col.id}
                  className={`collection-nav-item ${isSelected ? "active" : ""}`}
                >
                  <button
                    type="button"
                    className="collection-select-btn"
                    onClick={() => {
                      setSelectedCollectionId(isSelected ? null : col.id);
                      onSelectRoot(null);
                    }}
                    title={col.name}
                  >
                    <span className="collection-icon">🏷</span>
                    <span className="collection-label-text">{col.name}</span>
                    <span className="collection-count">{count}</span>
                  </button>

                  <div className="collection-actions">
                    {onRenameCollection && (
                      <button
                        type="button"
                        className="collection-mini-btn"
                        onClick={() => {
                          setRenamingCollectionId(col.id);
                          setRenameValue(col.name);
                        }}
                        title={`Rename ${col.name}`}
                        aria-label={`Rename ${col.name}`}
                      >
                        ✎
                      </button>
                    )}
                    {onDeleteCollection && (
                      <button
                        type="button"
                        className="collection-mini-btn danger"
                        onClick={() => void onDeleteCollection(col.id)}
                        title={`Delete ${col.name}`}
                        aria-label={`Delete ${col.name}`}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {collections.length === 0 && !isCreatingCollection && (
            <div className="collections-empty-hint">
              <p>No collections yet. Group documents into custom shelves.</p>
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
                ref={searchInputRef}
                id={searchInputId}
                type="text"
                className="library-search-input"
                placeholder="Search by title, author, or path…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
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
                    setSearchQuery("");
                    searchInputRef.current?.focus();
                  }}
                  aria-label="Clear search query"
                  title="Clear search (Esc)"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Filter Chips & Sort Select */}
            <div className="library-filter-group">
              <div
                className="format-filter-chips"
                role="radiogroup"
                aria-label="Filter by document format"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={formatFilter === "all"}
                  className={`filter-chip ${formatFilter === "all" ? "selected" : ""}`}
                  onClick={() => setFormatFilter("all")}
                >
                  All <span className="chip-count">{formatCounts.all}</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={formatFilter === "pdf"}
                  className={`filter-chip ${formatFilter === "pdf" ? "selected" : ""}`}
                  onClick={() => setFormatFilter("pdf")}
                >
                  PDF <span className="chip-count">{formatCounts.pdf}</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={formatFilter === "epub"}
                  className={`filter-chip ${formatFilter === "epub" ? "selected" : ""}`}
                  onClick={() => setFormatFilter("epub")}
                >
                  EPUB <span className="chip-count">{formatCounts.epub}</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={formatFilter === "other"}
                  className={`filter-chip ${formatFilter === "other" ? "selected" : ""}`}
                  onClick={() => setFormatFilter("other")}
                >
                  Other <span className="chip-count">{formatCounts.other}</span>
                </button>
              </div>

              {/* Sort Dropdown */}
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
                  <option value="recent">Recently Opened</option>
                  <option value="name-asc">Title (A–Z)</option>
                  <option value="name-desc">Title (Z–A)</option>
                  <option value="size-desc">Size (Largest)</option>
                  <option value="size-asc">Size (Smallest)</option>
                  <option value="format">Format</option>
                </select>
              </div>
            </div>
          </div>

          {/* Active Scope / Filter Info & Status */}
          {(selectedRoot || selectedCollection || hasSearch || hasFilter || message) && (
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
                {selectedCollection && (
                  <span className="scope-pill collection-pill">
                    Collection: <strong>{selectedCollection.name}</strong>
                    <button
                      type="button"
                      className="pill-clear"
                      onClick={() => setSelectedCollectionId(null)}
                      title="Show all collections"
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
                {message && !error && (
                  <span className="scope-pill status-note-pill" title={message}>
                    {message}
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
                const readable = hasCapability(doc.record.format, "read");
                const convertible = hasCapability(doc.record.format, "convert");
                const isMissing = doc.availability === "missing";
                const canOpen = readable && !isMissing && !pending;
                const canConvert = !readable && convertible && !isMissing && !pending && Boolean(onConvert);
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

                const displayTitle = getDocumentDisplayTitle(doc.record);
                const authors = doc.record.metadata?.authors ?? [];
                const docColIds = doc.record.collections ?? [];
                const docCollections = collections.filter((c) => docColIds.includes(c.id));

                return (
                  <article
                    key={doc.record.id}
                    className={`doc-card ${isMissing ? "doc-missing" : ""} ${
                      readable ? "doc-readable" : "doc-unsupported"
                    }`}
                    role="listitem"
                  >
                    <div className="doc-card-body">
                      {/* Left: Cover thumbnail or format-colored placeholder */}
                      <DocThumbnail
                        documentId={doc.record.id}
                        format={doc.record.format}
                        title={displayTitle}
                        hasThumbnail={Boolean(doc.record.metadata?.thumbnailPath)}
                      />

                      {/* Right: Badges, Title, Authors, and Submeta */}
                      <div className="doc-content-wrap">
                        {/* Format Badge & Progress */}
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
                            <span
                              className="doc-missing-badge"
                              title="File not found in root directory"
                            >
                              Missing
                            </span>
                          )}
                        </div>

                        {/* Title & Metadata */}
                        <div className="doc-meta-wrap">
                          <h2 className="doc-title" title={displayTitle}>
                            {displayTitle}
                          </h2>

                          {authors.length > 0 && (
                            <p className="doc-authors" title={authors.join(", ")}>
                              by {authors.join(", ")}
                            </p>
                          )}

                          <div className="doc-submeta">
                            {directoryPrefix && (
                              <span
                                className="doc-folder-tag"
                                title={`In folder: ${directoryPrefix}`}
                              >
                                📁 {directoryPrefix}
                              </span>
                            )}
                            <span className="doc-size-tag">
                              {formatBytes(doc.record.sizeBytes)}
                            </span>
                            {lastOpenedText && (
                              <span
                                className="doc-opened-tag"
                                title={`Last read: ${readingState?.lastOpenedAt}`}
                              >
                                Opened {lastOpenedText}
                              </span>
                            )}
                          </div>

                          {/* Collection Tags on Card */}
                          {docCollections.length > 0 && (
                            <div className="doc-collections-row">
                              {docCollections.map((col) => (
                                <span
                                  key={col.id}
                                  className="doc-collection-tag"
                                  title={`Collection: ${col.name}`}
                                >
                                  🏷 {col.name}
                                  {onRemoveDocFromCollection && (
                                    <button
                                      type="button"
                                      className="collection-tag-remove"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void onRemoveDocFromCollection(col.id, doc.record.id);
                                      }}
                                      title={`Remove from ${col.name}`}
                                      aria-label={`Remove from ${col.name}`}
                                    >
                                      ✕
                                    </button>
                                  )}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Action Bar */}
                    <div className="doc-card-actions">
                      {/* Add to collection dropdown */}
                      {collections.length > 0 && onAddDocToCollection && (
                        <select
                          className="doc-add-collection-select"
                          value=""
                          onChange={(e) => {
                            const cid = e.target.value;
                            if (cid) void onAddDocToCollection(cid, doc.record.id);
                          }}
                          title="Add document to collection"
                          aria-label="Add document to collection"
                        >
                          <option value="" disabled>
                            + Collection
                          </option>
                          {collections
                            .filter((c) => !docColIds.includes(c.id))
                            .map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                        </select>
                      )}

                      {readable ? (
                        <button
                          type="button"
                          className={`doc-action-btn ${canOpen ? "openable" : ""}`}
                          onClick={() => onOpen(doc)}
                          disabled={!canOpen}
                        >
                          {isMissing ? "Missing" : progressText ? "Continue →" : "Open"}
                        </button>
                      ) : convertible ? (
                        <button
                          type="button"
                          className={`doc-action-btn convert-action ${canConvert ? "openable" : ""}`}
                          onClick={() => onConvert?.(doc)}
                          disabled={!canConvert}
                          title="Convert this document with local tools"
                        >
                          {isMissing ? "Missing" : "Convert →"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="doc-action-btn"
                          disabled
                        >
                          {isMissing ? "Missing" : "Unsupported"}
                        </button>
                      )}
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
                  <h3>No directories indexed</h3>
                  <p>Add a directory containing your documents to view them in your library.</p>
                  <button type="button" className="primary-button" onClick={onAddRoot}>
                    Add your first directory
                  </button>
                </div>
              ) : documents.length === 0 ? (
                <div className="empty-message-wrap">
                  <span className="empty-icon">📂</span>
                  <h3>No documents found</h3>
                  <p>The indexed directories do not contain any supported files.</p>
                </div>
              ) : (
                <div className="empty-message-wrap">
                  <span className="empty-icon">🔍</span>
                  <h3>No matching documents</h3>
                  <p>No documents matched the active query, format filter, or collection.</p>
                  <div className="empty-actions">
                    {hasSearch && (
                      <button
                        type="button"
                        className="quiet-button"
                        onClick={() => setSearchQuery("")}
                      >
                        Clear search
                      </button>
                    )}
                    {hasFilter && (
                      <button
                        type="button"
                        className="quiet-button"
                        onClick={() => setFormatFilter("all")}
                      >
                        Reset format filter
                      </button>
                    )}
                    {selectedCollection && (
                      <button
                        type="button"
                        className="quiet-button"
                        onClick={() => setSelectedCollectionId(null)}
                      >
                        Show all collections
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
