import { useState, type ReactNode } from "react";
import type { Collection, LibraryRoot, StoredDocument } from "../storage/domain";
import type { LibraryScope } from "../navigation/navigation";

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
              <div
                className={`folder-item-row ${isSelected ? "active" : ""}`}
                style={{ paddingLeft: `${depth * 14 + 8}px` }}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    className="folder-chevron"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFolder(folderKey);
                    }}
                    aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
                  >
                    {isExpanded ? "▾" : "▸"}
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
                  <span className="folder-icon">📁</span>
                  <span className="folder-name-text">{node.name}</span>
                </button>
              </div>
              {hasChildren && isExpanded && renderFolderNodes(rootId, node.children, depth + 1)}
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
          <span className="sidebar-icon">📚</span>
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
            +
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
                <button
                  type="button"
                  className="sidebar-item-btn"
                  onClick={() => onSelectScope({ kind: "collection", collectionId: col.id })}
                >
                  <span className="sidebar-icon">🏷️</span>
                  <span className="sidebar-label">{col.name}</span>
                  <span className="sidebar-count">{docCount}</span>
                </button>
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
            +
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
                <div className={`root-item-row ${isSelected ? "active" : ""}`}>
                  {folderTree.length > 0 ? (
                    <button
                      type="button"
                      className="folder-chevron"
                      onClick={() => toggleFolder(rootKey)}
                      aria-label={isExpanded ? "Collapse folders" : "Expand folders"}
                    >
                      {isExpanded ? "▾" : "▸"}
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
                    <span className="sidebar-icon">📁</span>
                    <span className="sidebar-label">{root.label}</span>
                    <span className="sidebar-count">{rootDocs.length}</span>
                  </button>
                  <button
                    type="button"
                    className="sidebar-action-icon-btn"
                    onClick={() => onScanRoot(root.id)}
                    title="Rescan folder"
                    aria-label={`Rescan ${root.label}`}
                  >
                    ↻
                  </button>
                  <button
                    type="button"
                    className="sidebar-action-icon-btn remove-root-btn"
                    onClick={() => onRemoveRoot(root.id)}
                    title="Remove folder from library"
                    aria-label={`Remove ${root.label}`}
                  >
                    ✕
                  </button>
                </div>
                {folderTree.length > 0 && isExpanded && renderFolderNodes(root.id, folderTree, 1)}
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
            style={{ top: `${activeContextMenu.y}px`, left: `${activeContextMenu.x}px` }}
            onClick={(e) => e.stopPropagation()}
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
              onClick={async () => {
                const colId = activeContextMenu.id;
                setActiveContextMenu(null);
                await onDeleteCollection(colId);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
