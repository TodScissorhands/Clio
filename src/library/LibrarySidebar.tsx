import { useEffect, useState, type ReactNode } from "react";
import type { Collection, LibraryRoot, StoredDocument } from "../storage/domain";
import type { LibraryScope } from "../navigation/navigation";
import {
  BookOpenIcon,
  BookmarkIcon,
  ChevronRightIcon,
  FolderIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "./LibraryIcons";
export interface FolderNode {
  name: string;
  relativePath: string;
  children: FolderNode[];
}

export function buildFolderTree(documents: StoredDocument[], rootId: string): FolderNode[] {
  const rootDocs = documents.filter(
    (d) => d.source.kind === "library" && d.source.rootId === rootId
  );
  const folderSet = new Set<string>();
  for (const doc of rootDocs) {
    if (doc.source.kind !== "library") continue;
    const parts = doc.source.relativePath.replace(/\\/g, "/").split("/");
    parts.pop(); // discard file name
    let current = "";
    for (const part of parts) {
      if (!part) continue;
      current = current ? `${current}/${part}` : part;
      folderSet.add(current);
    }
  }

  const sortedFolders = Array.from(folderSet).sort();
  const rootNodes: FolderNode[] = [];
  const nodeMap = new Map<string, FolderNode>();

  for (const path of sortedFolders) {
    const parts = path.split("/");
    const name = parts[parts.length - 1];
    const node: FolderNode = { name, relativePath: path, children: [] };
    nodeMap.set(path, node);
    if (parts.length === 1) {
      rootNodes.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join("/");
      const parent = nodeMap.get(parentPath);
      if (parent) {
        parent.children.push(node);
      } else {
        rootNodes.push(node);
      }
    }
  }

  return rootNodes;
}

export interface LibrarySidebarProps {
  roots: LibraryRoot[];
  documents: StoredDocument[];
  collections: Collection[];
  activeScope: LibraryScope;
  collapsed: boolean;
  onSelectScope: (scope: LibraryScope) => void;
  onAddRoot: () => void;
  onScanRoot: (rootId: string) => void;
  onRemoveRoot: (rootId: string) => void;
  onCreateCollection: (name: string) => Promise<void>;
  onRenameCollection: (id: string, name: string) => Promise<void>;
  onDeleteCollection: (id: string) => Promise<void>;
}

export function LibrarySidebar({
  roots,
  documents,
  collections,
  activeScope,
  collapsed,
  onSelectScope,
  onAddRoot,
  onScanRoot,
  onRemoveRoot,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
}: LibrarySidebarProps) {
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [isCreatingCollection, setIsCreatingCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [renamingCollectionId, setRenamingCollectionId] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState("");
  const [activeContextMenu, setActiveContextMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [rootMenu, setRootMenu] = useState<{ id: string; label: string; x: number; y: number } | null>(null);
  const [confirmRemoveRoot, setConfirmRemoveRoot] = useState<{ id: string; label: string } | null>(null);
  const [confirmDeleteCollection, setConfirmDeleteCollection] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (!activeContextMenu && !rootMenu && !confirmRemoveRoot && !confirmDeleteCollection) return;
      event.preventDefault();
      setActiveContextMenu(null);
      setRootMenu(null);
      setConfirmRemoveRoot(null);
      setConfirmDeleteCollection(null);
    }

    window.addEventListener("keydown", dismissOnEscape);
    return () => window.removeEventListener("keydown", dismissOnEscape);
  }, [activeContextMenu, rootMenu, confirmRemoveRoot, confirmDeleteCollection]);

  if (collapsed) {
    return null;
  }

  function toggleFolder(key: string) {
    setExpandedFolders((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function handleCreateCollectionSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = newCollectionName.trim();
    if (name) {
      await onCreateCollection(name);
      setNewCollectionName("");
      setIsCreatingCollection(false);
    }
  }

  async function handleRenameSubmit(e: React.FormEvent, id: string) {
    e.preventDefault();
    const name = renamingValue.trim();
    if (name) {
      await onRenameCollection(id, name);
      setRenamingCollectionId(null);
      setRenamingValue("");
    }
  }

  function renderFolderNodes(rootId: string, nodes: FolderNode[], depth = 1): ReactNode {
    return (
      <ul className="folder-tree-list">
        {nodes.map((node) => {
          const isSelected =
            activeScope.kind === "folder" &&
            activeScope.rootId === rootId &&
            activeScope.relativePath === node.relativePath;
          const folderKey = `${rootId}:${node.relativePath}`;
          const isExpanded = Boolean(expandedFolders[folderKey]);
          const hasChildren = node.children.length > 0;

          return (
            <li key={node.relativePath} className="folder-tree-node">
              <div className={`folder-item-row ${isSelected ? "active" : ""}`}>
                {hasChildren ? (
                  <button
                    type="button"
                    className={`folder-chevron ${isExpanded ? "expanded" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFolder(folderKey);
                    }}
                    aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
                  >
                    <ChevronRightIcon className={`folder-chevron-icon ${isExpanded ? "expanded" : ""}`} />
                  </button>
                ) : (
                  <span className="folder-chevron-placeholder" />
                )}
                <button
                  type="button"
                  className="folder-name-btn"
                  onClick={() =>
                    onSelectScope({
                      kind: "folder",
                      rootId,
                      relativePath: node.relativePath,
                    })
                  }
                  title={node.relativePath}
                >
                  <FolderIcon className="folder-icon" />
                  <span className="folder-name-text">{node.name}</span>
                </button>
              </div>
              {hasChildren && isExpanded && (
                <div className="folder-sub-tree">
                  {renderFolderNodes(rootId, node.children, depth + 1)}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <aside className="library-sidebar" aria-label="Library navigation">
      {/* Scope: All */}
      <div className="sidebar-section scope-all-section">
        <button
          type="button"
          className={`sidebar-scope-btn ${activeScope.kind === "all" ? "active" : ""}`}
          onClick={() => onSelectScope({ kind: "all" })}
        >
          <BookOpenIcon className="sidebar-icon" />
          <span className="sidebar-label">All Documents</span>
          <span className="sidebar-count">{documents.length}</span>
        </button>
      </div>

      {/* Collections Section */}
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="section-title">Collections</span>
          <button
            type="button"
            className="sidebar-add-btn"
            onClick={() => setIsCreatingCollection(true)}
            title="Create new collection"
            aria-label="Add collection"
          >
            <PlusIcon />
          </button>
        </div>

        {isCreatingCollection && (
          <form className="inline-add-form" onSubmit={handleCreateCollectionSubmit}>
            <input
              type="text"
              className="inline-input"
              value={newCollectionName}
              onChange={(e) => setNewCollectionName(e.target.value)}
              placeholder="Collection name…"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setIsCreatingCollection(false);
                  setNewCollectionName("");
                }
              }}
            />
            <div className="inline-form-actions">
              <button type="submit" className="inline-save-btn">
                Add
              </button>
              <button
                type="button"
                className="inline-cancel-btn"
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

        <ul className="sidebar-list collections-list">
          {collections.map((col) => {
            const isSelected =
              activeScope.kind === "collection" && activeScope.collectionId === col.id;
            const docCount = documents.filter((d) => d.record.collections?.includes(col.id)).length;

            if (renamingCollectionId === col.id) {
              return (
                <li key={col.id} className="sidebar-item">
                  <form className="inline-add-form" onSubmit={(e) => handleRenameSubmit(e, col.id)}>
                    <input
                      type="text"
                      className="inline-input"
                      value={renamingValue}
                      onChange={(e) => setRenamingValue(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setRenamingCollectionId(null);
                          setRenamingValue("");
                        }
                      }}
                    />
                    <div className="inline-form-actions">
                      <button type="submit" className="inline-save-btn">
                        Save
                      </button>
                      <button
                        type="button"
                        className="inline-cancel-btn"
                        onClick={() => {
                          setRenamingCollectionId(null);
                          setRenamingValue("");
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </form>
                </li>
              );
            }

            return (
              <li
                key={col.id}
                className={`sidebar-item ${isSelected ? "active" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setActiveContextMenu({ id: col.id, x: e.clientX, y: e.clientY });
                }}
              >
                <div className="sidebar-item-row">
                  <button
                    type="button"
                    className="sidebar-item-btn"
                    onClick={() => onSelectScope({ kind: "collection", collectionId: col.id })}
                  >
                    <BookmarkIcon className="sidebar-icon" />
                    <span className="sidebar-label">{col.name}</span>
                    <span className="sidebar-count">{docCount}</span>
                  </button>
                  <button
                    type="button"
                    className="sidebar-more-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveContextMenu({ id: col.id, x: e.clientX, y: e.clientY });
                    }}
                    title={`Options for ${col.name}`}
                    aria-label={`Options for ${col.name}`}
                  >
                    <MoreHorizontalIcon />
                  </button>
                </div>
              </li>
            );
          })}
          {collections.length === 0 && !isCreatingCollection && (
            <li className="sidebar-empty-hint">No collections yet</li>
          )}
        </ul>
      </div>

      {/* Folders (Library Roots & Subfolders) */}
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="section-title">Folders</span>
          <button
            type="button"
            className="sidebar-add-btn"
            onClick={onAddRoot}
            title="Add a folder to library"
            aria-label="Add folder"
          >
            <PlusIcon />
          </button>
        </div>

        <ul className="sidebar-list roots-list">
          {roots.map((root) => {
            const isSelected = activeScope.kind === "root" && activeScope.rootId === root.id;
            const rootDocs = documents.filter(
              (d) => d.source.kind === "library" && d.source.rootId === root.id
            );
            const folderTree = buildFolderTree(documents, root.id);
            const rootKey = `root:${root.id}`;
            const isExpanded = expandedFolders[rootKey] ?? true;

            return (
              <li key={root.id} className="root-tree-item">
                <div
                  className={`root-item-row ${isSelected ? "active" : ""}`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setRootMenu({ id: root.id, label: root.label, x: e.clientX, y: e.clientY });
                  }}
                >
                  {folderTree.length > 0 ? (
                    <button
                      className={`folder-chevron ${isExpanded ? "expanded" : ""}`}
                      onClick={() => toggleFolder(rootKey)}
                      aria-label={isExpanded ? "Collapse folders" : "Expand folders"}
                    >
                      <ChevronRightIcon className={`folder-chevron-icon ${isExpanded ? "expanded" : ""}`} />
                    </button>
                  ) : (
                    <span className="folder-chevron-placeholder" />
                  )}
                  <button
                    type="button"
                    className="sidebar-item-btn root-btn"
                    onClick={() => onSelectScope({ kind: "root", rootId: root.id })}
                    title={root.label}
                  >
                    <FolderIcon className="sidebar-icon" />
                    <span className="sidebar-label">{root.label}</span>
                    <span className="sidebar-count">{rootDocs.length}</span>
                  </button>
                  <button
                    type="button"
                    className="sidebar-more-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRootMenu({ id: root.id, label: root.label, x: e.clientX, y: e.clientY });
                    }}
                    title={`Folder options for ${root.label}`}
                    aria-label={`Folder options for ${root.label}`}
                  >
                    <MoreHorizontalIcon />
                  </button>
                </div>
                {folderTree.length > 0 && isExpanded && (
                  <div className="folder-sub-tree">
                    {renderFolderNodes(root.id, folderTree, 1)}
                  </div>
                )}
              </li>
            );
          })}
          {roots.length === 0 && (
            <li className="sidebar-empty-hint">
              <button type="button" className="link-button" onClick={onAddRoot}>
                Add a folder
              </button>
            </li>
          )}
        </ul>
      </div>

      {/* Collection Context Menu */}
      {activeContextMenu && (
        <div
          className="context-menu-backdrop"
          onClick={() => setActiveContextMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setActiveContextMenu(null);
          }}
        >
          <div
            className="context-menu-popover"
            style={{
              top: `${Math.min(activeContextMenu.y, window.innerHeight - 120)}px`,
              left: `${Math.min(activeContextMenu.x, window.innerWidth - 200)}px`,
            }}
            onClick={(e) => e.stopPropagation()}
            role="menu"
            aria-label="Collection actions"
          >
            <button
              type="button"
              className="context-menu-item"
              onClick={() => {
                const targetCol = collections.find((c) => c.id === activeContextMenu.id);
                if (targetCol) {
                  setRenamingCollectionId(targetCol.id);
                  setRenamingValue(targetCol.name);
                }
                setActiveContextMenu(null);
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="context-menu-item danger"
              onClick={() => {
                const targetCol = collections.find((c) => c.id === activeContextMenu.id);
                setActiveContextMenu(null);
                if (targetCol) {
                  setConfirmDeleteCollection({ id: targetCol.id, name: targetCol.name });
                }
              }}
            >
              Delete…
            </button>
          </div>
        </div>
      )}

      {/* Folder Context / Options Menu */}
      {rootMenu && (
        <div
          className="context-menu-backdrop"
          onClick={() => setRootMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setRootMenu(null);
          }}
        >
          <div
            className="context-menu-popover"
            style={{
              top: `${Math.min(rootMenu.y, window.innerHeight - 120)}px`,
              left: `${Math.min(rootMenu.x, window.innerWidth - 200)}px`,
            }}
            onClick={(e) => e.stopPropagation()}
            role="menu"
            aria-label="Folder actions"
          >
            <button
              type="button"
              className="context-menu-item"
              role="menuitem"
              onClick={() => {
                const id = rootMenu.id;
                setRootMenu(null);
                onScanRoot(id);
              }}
            >
              Rescan folder
            </button>
            <div className="context-menu-divider" role="separator" />
            <button
              type="button"
              className="context-menu-item danger"
              role="menuitem"
              onClick={() => {
                const target = { id: rootMenu.id, label: rootMenu.label };
                setRootMenu(null);
                setConfirmRemoveRoot(target);
              }}
            >
              Remove from library…
            </button>
          </div>
        </div>
      )}

      {/* Remove Folder Explicit Confirmation Modal (OD-1, Section 6) */}
      {confirmRemoveRoot && (
        <div
          className="modal-backdrop"
          onClick={() => setConfirmRemoveRoot(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="remove-root-modal-title"
        >
          <div className="modal-card remove-root-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 id="remove-root-modal-title" className="modal-title">
                Remove Folder from Library
              </h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setConfirmRemoveRoot(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p className="remove-root-lead">Remove “{confirmRemoveRoot.label}” from Clio?</p>
              <p className="remove-root-desc">
                Your files will remain on your computer untouched. Clio will only remove its catalog index for this folder.
              </p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setConfirmRemoveRoot(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button danger"
                onClick={() => {
                  const id = confirmRemoveRoot.id;
                  setConfirmRemoveRoot(null);
                  onRemoveRoot(id);
                }}
              >
                Remove folder
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Collection Confirmation Modal */}
      {confirmDeleteCollection && (
        <div
          className="modal-backdrop"
          onClick={() => setConfirmDeleteCollection(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-col-modal-title"
        >
          <div className="modal-card delete-col-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 id="delete-col-modal-title" className="modal-title">
                Delete Collection
              </h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setConfirmDeleteCollection(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p className="remove-root-lead">Delete collection “{confirmDeleteCollection.name}”?</p>
              <p className="remove-root-desc">
                Documents in this collection will stay in your library.
              </p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setConfirmDeleteCollection(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button danger"
                onClick={async () => {
                  const id = confirmDeleteCollection.id;
                  setConfirmDeleteCollection(null);
                  await onDeleteCollection(id);
                }}
              >
                Delete collection
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
