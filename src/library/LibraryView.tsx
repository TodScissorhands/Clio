import { useState, useMemo, useEffect, useCallback, type ReactNode } from "react";
import type { Collection, LibraryRoot, StoredDocument } from "../storage/domain";
import { getDocumentThumbnail } from "../storage/documentStorage";
import type { LibraryScope } from "../navigation/navigation";
import {
  deriveContinueDocuments,
  deriveRecentlyReadDocuments,
  filterDocumentsByScope,
  sortDocuments,
  type SortOption,
} from "./libraryFilter";
import { LibraryToolbar } from "./LibraryToolbar";
import { LibrarySidebar } from "./LibrarySidebar";
import { ContinueSection } from "./ContinueSection";
import { DocumentGrid } from "./DocumentGrid";
import { DocumentList } from "./DocumentList";
import { DocumentContextMenu } from "./DocumentContextMenu";
import { DocumentPropertiesModal } from "./DocumentPropertiesModal";
import { ConversionModal } from "./ConversionModal";
import { AddToCollectionModal } from "./AddToCollectionModal";
import type { CommandContext } from "../commands/documentCommands";

export interface LibraryViewProps {
  roots: LibraryRoot[];
  documents: StoredDocument[];
  collections: Collection[];
  activeScope: LibraryScope;
  onSelectScope: (scope: LibraryScope) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  viewMode: "grid" | "list";
  onViewModeChange: (mode: "grid" | "list") => void;
  selectedDocIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  sortBy: SortOption;
  onSortChange: (sort: SortOption) => void;
  pending: boolean;
  pendingRootId: string | null;
  message: string;
  error: string;
  onAddRoot: () => void;
  onScanRoot: (rootId: string) => void;
  onRemoveRoot: (rootId: string) => void;
  onCreateCollection: (name: string) => Promise<void>;
  onRenameCollection: (id: string, name: string) => Promise<void>;
  onDeleteCollection: (id: string) => Promise<void>;
  onAddDocToCollection: (collectionId: string, documentIds: string[]) => Promise<void>;
  onRemoveFromLibrary: (documentIds: string[]) => Promise<void>;
  onOpenDocument: (document: StoredDocument) => void;
  onRevealInFileManager: (document: StoredDocument) => Promise<void>;
  scrollAnchorId?: string | null;
  onUpdateScrollAnchor?: (anchorId: string | null) => void;
  onLocateDocument?: (document: StoredDocument) => Promise<void>;
  onOpenAppMenu?: () => void;
  onDismissMessage?: () => void;
  onDismissError?: () => void;
}

function getDeterministicHue(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

function DocCoverThumbnail({
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

  // Deterministic typographic cover placeholder
  const hue = getDeterministicHue(title || documentId);
  const initials = title
    .replace(/[^\p{L}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div
      className={`doc-thumbnail-wrap placeholder typographic format-${format}`}
      style={{
        backgroundColor: `hsl(${hue}, 20%, 93%)`,
        borderColor: `hsl(${hue}, 25%, 82%)`,
      }}
      aria-hidden="true"
    >
      <div className="placeholder-top-bar">
        <span className="placeholder-format-tag">{format.toUpperCase()}</span>
      </div>
      <div className="placeholder-center-monogram" style={{ color: `hsl(${hue}, 35%, 35%)` }}>
        {initials || format.slice(0, 2).toUpperCase()}
      </div>
      <div className="placeholder-bottom-label" title={title}>
        {title.slice(0, 32)}
      </div>
    </div>
  );
}

export function LibraryView({
  roots,
  documents,
  collections,
  activeScope,
  onSelectScope,
  searchQuery,
  onSearchChange,
  viewMode,
  onViewModeChange,
  selectedDocIds,
  onSelectionChange,
  sortBy,
  onSortChange,
  pendingRootId: _pendingRootId,
  message,
  error,
  onAddRoot,
  onScanRoot,
  onRemoveRoot,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
  onAddDocToCollection,
  onRemoveFromLibrary,
  onOpenDocument,
  onRevealInFileManager,
  scrollAnchorId,
  onUpdateScrollAnchor,
  onLocateDocument,
  onOpenAppMenu,
  onDismissMessage,
  onDismissError,
}: LibraryViewProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [lastSelectedDocId, setLastSelectedDocId] = useState<string | null>(null);

  // Modals state
  const [propertiesDoc, setPropertiesDoc] = useState<StoredDocument | null>(null);
  const [conversionModal, setConversionModal] = useState<{
    mode: "convert" | "merge" | "extract";
    sourceDoc?: StoredDocument | null;
    mergeDocs?: StoredDocument[];
  } | null>(null);
  const [isAddToCollectionOpen, setIsAddToCollectionOpen] = useState(false);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    targetDoc: StoredDocument | null;
  } | null>(null);

  // Filter visible documents based on scope and search query
  const visibleDocuments = useMemo(() => {
    const scoped = filterDocumentsByScope(documents, activeScope, searchQuery);
    return sortDocuments(scoped, sortBy);
  }, [documents, activeScope, searchQuery, sortBy]);

  // Continue reading documents: max 6, most recently read first
  const continueDocuments = useMemo(() => {
    return deriveContinueDocuments(documents, 6);
  }, [documents]);

  // Recently read documents: max 6 (OD-5)
  const recentDocuments = useMemo(() => {
    return deriveRecentlyReadDocuments(documents, 6);
  }, [documents]);

  // Selected documents objects
  const selectedDocuments = useMemo(() => {
    return documents.filter((d) => selectedDocIds.has(d.record.id));
  }, [documents, selectedDocIds]);

  // Restore scroll position to anchor if provided
  useEffect(() => {
    if (!scrollAnchorId) return;
    const el =
      document.getElementById(`doc-card-${scrollAnchorId}`) ??
      document.getElementById(`doc-row-${scrollAnchorId}`);
    if (el) {
      el.scrollIntoView({ behavior: "auto", block: "nearest" });
    }
  }, [scrollAnchorId, visibleDocuments]);

  // Range and single selection handler
  const handleToggleSelect = useCallback(
    (docId: string, isShift: boolean, isCmdCtrl: boolean) => {
      const next = new Set(selectedDocIds);

      if (isShift && lastSelectedDocId) {
        const lastIdx = visibleDocuments.findIndex((d) => d.record.id === lastSelectedDocId);
        const currIdx = visibleDocuments.findIndex((d) => d.record.id === docId);
        if (lastIdx !== -1 && currIdx !== -1) {
          const start = Math.min(lastIdx, currIdx);
          const end = Math.max(lastIdx, currIdx);
          for (let i = start; i <= end; i++) {
            const id = visibleDocuments[i]?.record.id;
            if (id) next.add(id);
          }
          onSelectionChange(next);
          setLastSelectedDocId(docId);
          return;
        }
      }

      if (isCmdCtrl) {
        if (next.has(docId)) {
          next.delete(docId);
        } else {
          next.add(docId);
        }
      } else {
        // Plain toggle
        if (next.has(docId)) {
          next.delete(docId);
        } else {
          next.add(docId);
        }
      }

      onSelectionChange(next);
      setLastSelectedDocId(docId);
    },
    [lastSelectedDocId, onSelectionChange, selectedDocIds, visibleDocuments]
  );

  const handleClearSelection = useCallback(() => {
    onSelectionChange(new Set());
    setLastSelectedDocId(null);
  }, [onSelectionChange]);

  const handleOpenDoc = useCallback(
    (doc: StoredDocument) => {
      onUpdateScrollAnchor?.(doc.record.id);
      onOpenDocument(doc);
    },
    [onOpenDocument, onUpdateScrollAnchor]
  );

  const handleOpenContextMenu = useCallback((doc: StoredDocument, e: React.MouseEvent) => {
    // OD-6: Right-click on unselected document selects it; on selected operates on selection
    if (!selectedDocIds.has(doc.record.id)) {
      onSelectionChange(new Set([doc.record.id]));
      setLastSelectedDocId(doc.record.id);
    }
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      targetDoc: doc,
    });
  }, [onSelectionChange, selectedDocIds]);

  // Shared command context
  const commandContext: CommandContext = useMemo(
    () => ({
      documents,
      selectedDocuments,
      activeDocument: contextMenu?.targetDoc ?? null,
      collections,
      roots,
      onOpen: (doc) => handleOpenDoc(doc),
      onAddToCollection: async (colId, docIds) => {
        await onAddDocToCollection(colId, docIds);
      },
      onRemoveFromLibrary: async (docIds) => {
        await onRemoveFromLibrary(docIds);
        handleClearSelection();
      },
      onConvert: (doc) => {
        setConversionModal({ mode: "convert", sourceDoc: doc });
      },
      onMerge: (docs) => {
        setConversionModal({ mode: "merge", mergeDocs: docs });
      },
      onExtractPages: (doc) => {
        setConversionModal({ mode: "extract", sourceDoc: doc });
      },
      onProperties: (doc) => {
        setPropertiesDoc(doc);
      },
      onLocate: onLocateDocument
        ? async (doc) => {
            await onLocateDocument(doc);
          }
        : undefined,
      onRevealInFileManager: async (doc) => {
        await onRevealInFileManager(doc);
      },
    }),
    [
      documents,
      selectedDocuments,
      contextMenu?.targetDoc,
      collections,
      roots,
      handleOpenDoc,
      onAddDocToCollection,
      onRemoveFromLibrary,
      handleClearSelection,
      onRevealInFileManager,
    ]
  );

  function renderThumbnail(doc: StoredDocument): ReactNode {
    return (
      <DocCoverThumbnail
        documentId={doc.record.id}
        format={doc.record.format}
        title={doc.record.name}
        hasThumbnail={Boolean(doc.record.metadata?.thumbnailPath)}
      />
    );
  }

  return (
    <div className="library-shell" aria-label="Library">
      {/* Status Message Banner */}
      {message && (
        <div className="library-alert info" role="status">
          <span className="library-alert-icon">ℹ</span>
          <span className="library-alert-text">{message}</span>
          {onDismissMessage && (
            <button
              type="button"
              className="alert-dismiss-btn"
              onClick={onDismissMessage}
              aria-label="Dismiss message"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Actionable Error Alert Banner */}
      {error && (
        <div className="library-alert error" role="alert">
          <span className="library-alert-icon">⚠</span>
          <span className="library-alert-text">{error}</span>
          {onDismissError && (
            <button
              type="button"
              className="alert-dismiss-btn"
              onClick={onDismissError}
              aria-label="Dismiss error"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Single Contextual Toolbar Row */}
      <LibraryToolbar
        activeScope={activeScope}
        roots={roots}
        searchQuery={searchQuery}
        onSearchChange={onSearchChange}
        viewMode={viewMode}
        onViewModeChange={onViewModeChange}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        onSelectScope={onSelectScope}
        selectedDocuments={selectedDocuments}
        onClearSelection={handleClearSelection}
        onOpenSelection={() => {
          if (selectedDocuments.length === 1 && selectedDocuments[0]) {
            handleOpenDoc(selectedDocuments[0]);
          }
        }}
        onAddToCollection={() => setIsAddToCollectionOpen(true)}
        onConvertSelection={() => {
          if (selectedDocuments.length === 1) {
            setConversionModal({ mode: "convert", sourceDoc: selectedDocuments[0] });
          }
        }}
        onExtractPagesSelection={() => {
          if (selectedDocuments.length === 1) {
            setConversionModal({ mode: "extract", sourceDoc: selectedDocuments[0] });
          }
        }}
        onMergeSelection={() => {
          if (selectedDocuments.length >= 2) {
            setConversionModal({ mode: "merge", mergeDocs: selectedDocuments });
          }
        }}
        onPropertiesSelection={() => {
          if (selectedDocuments.length === 1 && selectedDocuments[0]) {
            setPropertiesDoc(selectedDocuments[0]);
          }
        }}
        onLocateSelection={() => {
          if (selectedDocuments.length === 1 && selectedDocuments[0] && onLocateDocument) {
            void onLocateDocument(selectedDocuments[0]);
          }
        }}
        onRemoveSelection={() => {
          const ids = selectedDocuments.map((d) => d.record.id);
          if (ids.length > 0) {
            void onRemoveFromLibrary(ids);
            handleClearSelection();
          }
        }}
        onOpenAppMenu={onOpenAppMenu}
      />

      {/* Main Two-Column Layout */}
      <div className="library-layout">
        <LibrarySidebar
          roots={roots}
          documents={documents}
          collections={collections}
          activeScope={activeScope}
          collapsed={sidebarCollapsed}
          onSelectScope={onSelectScope}
          onAddRoot={onAddRoot}
          onScanRoot={onScanRoot}
          onRemoveRoot={onRemoveRoot}
          onCreateCollection={onCreateCollection}
          onRenameCollection={onRenameCollection}
          onDeleteCollection={onDeleteCollection}
        />

        <main className="library-main-content">
          {/* Brand new empty library state */}
          {roots.length === 0 ? (
            <div className="library-empty-fresh-state">
              <span className="fresh-empty-icon">📁</span>
              <h2>Add a folder</h2>
              <p>Files stay where they are.</p>
              <button type="button" className="primary-button" onClick={onAddRoot}>
                Add a folder
              </button>
            </div>
          ) : (
            <>
              {/* 1. Continue Section (Top ~6 items with reading progress) */}
              {/* 1. Continue Section (Top ~6 items with reading progress, OD-5) */}
              <ContinueSection
                documents={continueDocuments}
                recentDocuments={recentDocuments}
                onOpenDocument={handleOpenDoc}
                onOpenContextMenu={handleOpenContextMenu}
                renderThumbnail={renderThumbnail}
              />

              {/* 2. Full Document Set for Current Scope */}
              <div className="library-document-section">
                {visibleDocuments.length > 0 ? (
                  viewMode === "grid" ? (
                    <DocumentGrid
                      documents={visibleDocuments}
                      selectedDocIds={selectedDocIds}
                      onToggleSelect={handleToggleSelect}
                      onOpenDocument={handleOpenDoc}
                      onOpenContextMenu={handleOpenContextMenu}
                      renderThumbnail={renderThumbnail}
                    />
                  ) : (
                    <DocumentList
                      documents={visibleDocuments}
                      roots={roots}
                      selectedDocIds={selectedDocIds}
                      sortBy={sortBy}
                      onSortChange={onSortChange}
                      onToggleSelect={handleToggleSelect}
                      onOpenDocument={handleOpenDoc}
                      onOpenContextMenu={handleOpenContextMenu}
                    />
                  )
                ) : (
                  <div className="library-scope-empty-state">
                    <p>No documents found in this view.</p>
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {/* Context Menu (Groups 1, 2, 3) */}
      {contextMenu && (
        <DocumentContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          targetDoc={contextMenu.targetDoc}
          selectedDocs={selectedDocuments}
          collections={collections}
          commandContext={commandContext}
          onClose={() => setContextMenu(null)}
          onCreateCollectionPrompt={() => setIsAddToCollectionOpen(true)}
        />
      )}

      {/* Document Properties Modal */}
      {propertiesDoc && (
        <DocumentPropertiesModal
          document={propertiesDoc}
          roots={roots}
          collections={collections}
          onLocate={onLocateDocument}
          onClose={() => setPropertiesDoc(null)}
        />
      )}

      {/* Contextual Conversion Modal */}
      {conversionModal && (
        <ConversionModal
          mode={conversionModal.mode}
          sourceDocument={conversionModal.sourceDoc}
          mergeDocuments={conversionModal.mergeDocs}
          onClose={() => setConversionModal(null)}
        />
      )}

      {/* Add To Collection Modal */}
      {isAddToCollectionOpen && (
        <AddToCollectionModal
          documentCount={selectedDocuments.length || (contextMenu?.targetDoc ? 1 : 0)}
          collections={collections}
          onAddToCollection={async (colId) => {
            const ids =
              selectedDocuments.length > 0
                ? selectedDocuments.map((d) => d.record.id)
                : contextMenu?.targetDoc
                ? [contextMenu.targetDoc.record.id]
                : [];
            if (ids.length > 0) {
              await onAddDocToCollection(colId, ids);
            }
          }}
          onCreateAndAddToCollection={async (name) => {
            await onCreateCollection(name);
          }}
          onClose={() => setIsAddToCollectionOpen(false)}
        />
      )}
    </div>
  );
}
