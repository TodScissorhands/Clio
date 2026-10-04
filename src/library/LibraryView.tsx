import { useState, useMemo, useEffect, useCallback, useRef, type ReactNode } from "react";
import { getDocumentDisplayTitle, type Collection, type LibraryRoot, type StoredDocument } from "../storage/domain";
import { getDocumentThumbnail } from "../storage/documentStorage";
import type { LibraryScope } from "../navigation/navigation";
import {
  deriveContinueDocuments,
  filterDocumentsByScope,
  getDocumentMonogram,
  sortDocuments,
  type SortOption,
} from "./libraryFilter";
import { LibraryToolbar } from "./LibraryToolbar";
import { LibrarySidebar } from "./LibrarySidebar";
import { SidebarInset, SidebarProvider } from "../components/ui/sidebar";
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
  onScanRoot: (rootId: string, relativePath?: string) => void;
  onRemoveRoot: (rootId: string) => void;
  onCreateCollection: (name: string) => Promise<void>;
  onCreateAndAddToCollection: (name: string, documentIds: string[]) => Promise<void>;
  onRenameCollection: (id: string, name: string) => Promise<void>;
  onDeleteCollection: (id: string) => Promise<void>;
  onAddDocToCollection: (collectionId: string, documentIds: string[]) => Promise<void>;
  onRemoveDocFromCollection: (collectionId: string, documentIds: string[]) => Promise<void>;
  onRemoveFromLibrary: (documentIds: string[]) => Promise<void>;
  onOpenDocument: (document: StoredDocument) => void;
  onRevealInFileManager: (document: StoredDocument) => Promise<void>;
  scrollAnchorId?: string | null;
  onUpdateScrollAnchor?: (anchorId: string | null) => void;
  onLocateDocument?: (document: StoredDocument) => Promise<void>;
  onOpenAppMenu?: () => void;
  onDismissMessage?: () => void;
  onDismissError?: () => void;
  onOpenFile?: () => void;
  onOpenExternally?: (document: StoredDocument) => Promise<void>;
  focusSearchRequest?: number;
  openToolsRequest?: number;
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
      <img
        src={dataUrl}
        alt={`Cover for ${title}`}
        className="h-full w-full object-cover"
        loading="lazy"
      />
    );
  }

  return (
    <div
      className="flex h-full w-full items-center justify-center bg-muted text-foreground"
      aria-hidden="true"
    >
      <span className="font-serif text-4xl font-semibold tracking-wide text-muted-foreground">
        {getDocumentMonogram(title, format)}
      </span>
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
  onCreateAndAddToCollection,
  onRenameCollection,
  onDeleteCollection,
  onAddDocToCollection,
  onRemoveDocFromCollection,
  onRemoveFromLibrary,
  onOpenDocument,
  onRevealInFileManager,
  scrollAnchorId,
  onUpdateScrollAnchor,
  onLocateDocument,
  onOpenAppMenu,
  onDismissMessage,
  onDismissError,
  onOpenFile,
  onOpenExternally,
  focusSearchRequest,
  openToolsRequest,
}: LibraryViewProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [lastSelectedDocId, setLastSelectedDocId] = useState<string | null>(null);
  const handledToolsRequest = useRef(0);

  useEffect(() => {
    if (!openToolsRequest || openToolsRequest === handledToolsRequest.current) return;
    handledToolsRequest.current = openToolsRequest;
    setConversionModal({ mode: "convert" });
  }, [openToolsRequest]);


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
  const handleToggleSelectAll = useCallback(() => {
    const allSelected =
      visibleDocuments.length > 0 &&
      visibleDocuments.every((d) => selectedDocIds.has(d.record.id));
    if (allSelected) {
      const next = new Set(selectedDocIds);
      for (const d of visibleDocuments) {
        next.delete(d.record.id);
      }
      onSelectionChange(next);
    } else {
      const next = new Set(selectedDocIds);
      for (const d of visibleDocuments) {
        next.add(d.record.id);
      }
      onSelectionChange(next);
    }
  }, [visibleDocuments, selectedDocIds, onSelectionChange]);

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
      activeCollectionId: activeScope.kind === "collection" ? activeScope.collectionId : null,
      onOpen: (doc) => handleOpenDoc(doc),
      onAddToCollection: async (colId, docIds) => {
        await onAddDocToCollection(colId, docIds);
      },
      onRemoveFromLibrary: async (docIds) => {
        await onRemoveFromLibrary(docIds);
        handleClearSelection();
      },
      onRemoveFromCollection: async (colId, docIds) => {
        await onRemoveDocFromCollection(colId, docIds);
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
      activeScope,
      handleOpenDoc,
      onAddDocToCollection,
      onRemoveDocFromCollection,
      onRemoveFromLibrary,
      handleClearSelection,
      onRevealInFileManager,
      onLocateDocument,
    ]
  );

  function renderThumbnail(doc: StoredDocument): ReactNode {
    return (
      <DocCoverThumbnail
        documentId={doc.record.id}
        format={doc.record.format}
        title={getDocumentDisplayTitle(doc.record)}
        hasThumbnail={Boolean(doc.record.metadata?.thumbnailPath)}
      />
    );
  }

  const showContinueShelf = activeScope.kind === "all" && !searchQuery.trim();

  return (
    <SidebarProvider
      open={!sidebarCollapsed}
      onOpenChange={(open) => setSidebarCollapsed(!open)}
      className="h-svh min-h-0 overflow-hidden bg-background text-foreground"
    >
      <LibrarySidebar
        roots={roots}
        documents={documents}
        collections={collections}
        activeScope={activeScope}
        onSelectScope={onSelectScope}
        onAddRoot={onAddRoot}
        onScanRoot={onScanRoot}
        onRemoveRoot={onRemoveRoot}
        onCreateCollection={onCreateCollection}
        onRenameCollection={onRenameCollection}
        onDeleteCollection={onDeleteCollection}
      />
      <SidebarInset className="relative h-full min-h-0 min-w-0 overflow-hidden">
        <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
          <LibraryToolbar
            activeScope={activeScope}
            roots={roots}
            collections={collections}
            searchQuery={searchQuery}
            onSearchChange={onSearchChange}
            focusSearchRequest={focusSearchRequest}
            viewMode={viewMode}
            onViewModeChange={onViewModeChange}
            sortBy={sortBy}
            onSortChange={onSortChange}
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


          <main className="min-h-0 flex-1 overflow-y-auto px-6 py-5 max-sm:px-4 max-sm:py-4">
            {roots.length === 0 ? (
              <section className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
                <h2 className="text-xl font-semibold tracking-tight">Your library is empty</h2>
                <p className="text-sm text-muted-foreground">Add a folder or open a document to begin.</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onAddRoot}>Add folder</button>
                  {onOpenFile && (
                    <button type="button" className="inline-flex h-9 items-center justify-center rounded-md border border-input px-4 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onOpenFile}>Open file</button>
                  )}
                </div>
              </section>
            ) : (
              <>
                {showContinueShelf && (
                  <ContinueSection
                    documents={continueDocuments}
                    onOpenDocument={handleOpenDoc}
                    onOpenContextMenu={handleOpenContextMenu}
                    renderThumbnail={renderThumbnail}
                  />
                )}
                <section className="mt-6">
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
                        onToggleSelectAll={handleToggleSelectAll}
                      />
                    )
                  ) : (
                    <div className="py-12 text-center">
                      <p className="font-medium">
                        {searchQuery
                          ? `No documents matching “${searchQuery}”`
                          : activeScope.kind === "collection"
                            ? "This collection is empty"
                            : "No documents in this view"}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {searchQuery
                          ? "Try searching Entire Library or checking spelling."
                          : activeScope.kind === "collection"
                            ? "Right-click documents in your library to add them here."
                            : "Documents in this folder will appear here."}
                      </p>
                    </div>
                  )}
                </section>
              </>
            )}
          </main>
        </div>

      {(message || error) && (
        <div className="library-status-overlay pointer-events-none absolute bottom-4 left-4 z-40" aria-live="polite">
          <div className={`library-status-toast pointer-events-auto ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>
            <span className="min-w-0 flex-1">{error || message}</span>
            {(error ? onDismissError : onDismissMessage) && (
              <button
                type="button"
                className="library-status-dismiss"
                onClick={error ? onDismissError : onDismissMessage}
                aria-label="Dismiss notification"
              >
                ×
              </button>
            )}
          </div>
        </div>
      )}
      </SidebarInset>

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
          onOpenExternally={onOpenExternally}
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
            const ids =
              selectedDocuments.length > 0
                ? selectedDocuments.map((d) => d.record.id)
                : contextMenu?.targetDoc
                ? [contextMenu.targetDoc.record.id]
                : [];
            await onCreateAndAddToCollection(name, ids);
          }}
          onClose={() => setIsAddToCollectionOpen(false)}
        />
      )}
    </SidebarProvider>
  );
}
