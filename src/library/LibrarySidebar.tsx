import { useEffect, useState, type ReactNode } from "react";
import type { Collection, LibraryRoot, StoredDocument } from "../storage/domain";
import type { LibraryScope } from "../navigation/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  useSidebar,
} from "../components/ui/sidebar";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../components/ui/collapsible";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
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
  onSelectScope: (scope: LibraryScope) => void;
  onAddRoot: () => void;
  onScanRoot: (rootId: string, relativePath?: string) => void;
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
  const [rootMenu, setRootMenu] = useState<{ id: string; label: string; relativePath: string | null; x: number; y: number } | null>(null);
  const [confirmRemoveRoot, setConfirmRemoveRoot] = useState<{ id: string; label: string } | null>(null);
  const [confirmDeleteCollection, setConfirmDeleteCollection] = useState<{ id: string; name: string } | null>(null);

  const { isMobile, setOpenMobile } = useSidebar();

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

  function handleScopeSelect(scope: LibraryScope) {
    onSelectScope(scope);
    if (isMobile) {
      setOpenMobile(false);
    }
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

  function renderFolderSubTree(rootId: string, nodes: FolderNode[]): ReactNode {
    return nodes.map((node) => {
      const isSelected =
        activeScope.kind === "folder" &&
        activeScope.rootId === rootId &&
        activeScope.relativePath === node.relativePath;
      const folderKey = `${rootId}:${node.relativePath}`;
      const isExpanded = Boolean(expandedFolders[folderKey]);
      const hasChildren = node.children.length > 0;

      return (
        <SidebarMenuSubItem
          key={node.relativePath}
          onContextMenu={(event) => {
            event.preventDefault();
            setRootMenu({ id: rootId, label: node.name, relativePath: node.relativePath, x: event.clientX, y: event.clientY });
          }}
        >
          <Collapsible
            open={isExpanded}
            onOpenChange={(open) => {
              if (open !== isExpanded) toggleFolder(folderKey);
            }}
          >
            <div className="flex min-w-0 items-center gap-0.5">
              {hasChildren ? (
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-5 shrink-0 p-0"
                    aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
                  >
                    <ChevronRightIcon className={`size-3.5 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                  </Button>
                </CollapsibleTrigger>
              ) : (
                <span className="size-5 shrink-0" aria-hidden="true" />
              )}
              <SidebarMenuSubButton
                asChild
                isActive={isSelected}
              >
                <button
                  type="button"
                  className="min-w-0"
                  data-library-scope
                  data-library-scope-root={rootId}
                  data-library-scope-path={node.relativePath}
                  onClick={() => handleScopeSelect({
                    kind: "folder",
                    rootId,
                    relativePath: node.relativePath,
                  })}
                >
                  <FolderIcon />
                  <span>{node.name}</span>
                </button>
              </SidebarMenuSubButton>
            </div>
            {hasChildren && (
              <CollapsibleContent>
                <SidebarMenuSub>{renderFolderSubTree(rootId, node.children)}</SidebarMenuSub>
              </CollapsibleContent>
            )}
          </Collapsible>
        </SidebarMenuSubItem>
      );
    });
  }

  return (
    <Sidebar collapsible="offcanvas" className="h-svh" aria-label="Library navigation">
      <SidebarContent className="overflow-y-auto">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={activeScope.kind === "all"}
                  data-library-scope
                  onClick={() => handleScopeSelect({ kind: "all" })}
                >
                  <BookOpenIcon />
                  <span>All Documents</span>
                  <SidebarMenuBadge>{documents.length}</SidebarMenuBadge>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Collections</SidebarGroupLabel>
          <SidebarGroupAction
            onClick={() => setIsCreatingCollection(true)}
            aria-label="Add collection"
          >
            <PlusIcon />
          </SidebarGroupAction>
          <SidebarGroupContent>
            {isCreatingCollection && (
              <form className="mb-2 space-y-2 px-2" onSubmit={handleCreateCollectionSubmit}>
                <Input
                  value={newCollectionName}
                  onChange={(e) => setNewCollectionName(e.target.value)}
                  placeholder="Collection name"
                  aria-label="Collection name"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setIsCreatingCollection(false);
                      setNewCollectionName("");
                    }
                  }}
                />
                <div className="flex items-center gap-2">
                  <Button type="submit" size="sm">Add</Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setIsCreatingCollection(false);
                      setNewCollectionName("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            <SidebarMenu>
              {collections.map((col) => {
                const isSelected =
                  activeScope.kind === "collection" && activeScope.collectionId === col.id;
                const docCount = documents.filter((d) => d.record.collections?.includes(col.id)).length;

                if (renamingCollectionId === col.id) {
                  return (
                    <SidebarMenuItem key={col.id}>
                      <form className="space-y-2 p-2" onSubmit={(e) => handleRenameSubmit(e, col.id)}>
                        <Input
                          value={renamingValue}
                          onChange={(e) => setRenamingValue(e.target.value)}
                          aria-label={`Rename ${col.name}`}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              setRenamingCollectionId(null);
                              setRenamingValue("");
                            }
                          }}
                        />
                        <div className="flex items-center gap-2">
                          <Button type="submit" size="sm">Save</Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setRenamingCollectionId(null);
                              setRenamingValue("");
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </form>
                    </SidebarMenuItem>
                  );
                }

                return (
                  <SidebarMenuItem
                    key={col.id}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setActiveContextMenu({ id: col.id, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <SidebarMenuButton
                      isActive={isSelected}
                      data-library-scope
                      onClick={() => handleScopeSelect({ kind: "collection", collectionId: col.id })}
                    >
                      <BookmarkIcon />
                      <span>{col.name}</span>
                      <SidebarMenuBadge className="right-7">{docCount}</SidebarMenuBadge>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveContextMenu({ id: col.id, x: e.clientX, y: e.clientY });
                      }}
                      aria-label={`Options for ${col.name}`}
                    >
                      <MoreHorizontalIcon />
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                );
              })}
              {collections.length === 0 && !isCreatingCollection && (
                <SidebarMenuItem>
                  <span className="px-2 py-1 text-xs text-muted-foreground">No collections yet</span>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Folders</SidebarGroupLabel>
          <SidebarGroupAction onClick={onAddRoot} aria-label="Add folder">
            <PlusIcon />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {roots.map((root) => {
                const isSelected = activeScope.kind === "root" && activeScope.rootId === root.id;
                const rootDocs = documents.filter(
                  (d) => d.source.kind === "library" && d.source.rootId === root.id
                );
                const folderTree = buildFolderTree(documents, root.id);
                const rootKey = `root:${root.id}`;
                const isExpanded = expandedFolders[rootKey] ?? true;
                const hasChildren = folderTree.length > 0;

                return (
                  <SidebarMenuItem
                    key={root.id}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setRootMenu({ id: root.id, label: root.label, relativePath: null, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <Collapsible
                      open={isExpanded}
                      onOpenChange={(open) => {
                        if (open !== isExpanded) toggleFolder(rootKey);
                      }}
                    >
                      <div className="flex min-w-0 items-center gap-0.5">
                        {hasChildren ? (
                          <CollapsibleTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="size-6 shrink-0 p-0"
                              aria-label={isExpanded ? `Collapse ${root.label}` : `Expand ${root.label}`}
                            >
                              <ChevronRightIcon className={`size-3.5 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                            </Button>
                          </CollapsibleTrigger>
                        ) : (
                          <span className="size-6 shrink-0" aria-hidden="true" />
                        )}
                        <SidebarMenuButton
                          isActive={isSelected}
                          data-library-scope
                          data-library-scope-root={root.id}
                          onClick={() => handleScopeSelect({ kind: "root", rootId: root.id })}
                        >
                          <FolderIcon />
                          <span>{root.label}</span>
                          <SidebarMenuBadge className="right-7">{rootDocs.length}</SidebarMenuBadge>
                        </SidebarMenuButton>
                        <SidebarMenuAction
                          showOnHover
                          onClick={(e) => {
                            e.stopPropagation();
                            setRootMenu({ id: root.id, label: root.label, relativePath: null, x: e.clientX, y: e.clientY });
                          }}
                          aria-label={`Folder options for ${root.label}`}
                        >
                          <MoreHorizontalIcon />
                        </SidebarMenuAction>
                      </div>
                      {hasChildren && (
                        <CollapsibleContent>
                          <SidebarMenuSub>{renderFolderSubTree(root.id, folderTree)}</SidebarMenuSub>
                        </CollapsibleContent>
                      )}
                    </Collapsible>
                  </SidebarMenuItem>
                );
              })}
              {roots.length === 0 && (
                <SidebarMenuItem>
                  <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={onAddRoot}>
                    <PlusIcon />
                    <span>Add a folder</span>
                  </Button>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

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
            aria-label="Collection options"
          >
            <button
              type="button"
              className="context-menu-item"
              role="menuitem"
              onClick={() => {
                const col = collections.find((c) => c.id === activeContextMenu.id);
                if (col) {
                  setRenamingCollectionId(col.id);
                  setRenamingValue(col.name);
                }
                setActiveContextMenu(null);
              }}
            >
              Rename collection…
            </button>
            <button
              type="button"
              className="context-menu-item danger"
              role="menuitem"
              onClick={() => {
                const col = collections.find((c) => c.id === activeContextMenu.id);
                if (col) {
                  setConfirmDeleteCollection({ id: col.id, name: col.name });
                }
                setActiveContextMenu(null);
              }}
            >
              Delete collection
            </button>
          </div>
        </div>
      )}

      {/* Root Context Menu */}
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
              top: `${Math.min(rootMenu.y, window.innerHeight - 140)}px`,
              left: `${Math.min(rootMenu.x, window.innerWidth - 200)}px`,
            }}
            onClick={(e) => e.stopPropagation()}
            role="menu"
            aria-label="Folder options"
          >
            <button
              type="button"
              className="context-menu-item"
              role="menuitem"
              onClick={() => {
                onScanRoot(rootMenu.id, rootMenu.relativePath ?? undefined);
                setRootMenu(null);
              }}
            >
              Rescan folder
            </button>
            {rootMenu.relativePath === null && (
              <button
                type="button"
                className="context-menu-item danger"
                role="menuitem"
                onClick={() => {
                  setConfirmRemoveRoot({ id: rootMenu.id, label: rootMenu.label });
                  setRootMenu(null);
                }}
              >
                Remove folder from library…
              </button>
            )}
        </div>
          </div>
      )}

      {/* Confirmation Modal: Remove Root */}
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
                aria-label="Close dialog"
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p className="modal-intro">
                Are you sure you want to remove <strong>{confirmRemoveRoot.label}</strong> from your
                library?
              </p>
              <p className="modal-subtext">
                This only removes the folder from Clio’s catalog. Your files on disk will{" "}
                <strong>not</strong> be deleted.
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
                  onRemoveRoot(confirmRemoveRoot.id);
                  setConfirmRemoveRoot(null);
                }}
              >
                Remove folder
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal: Delete Collection */}
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
                aria-label="Close dialog"
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p className="modal-intro">
                Are you sure you want to delete the collection{" "}
                <strong>{confirmDeleteCollection.name}</strong>?
              </p>
              <p className="modal-subtext">
                This only removes the collection grouping. Documents inside it will remain in your
                library and on disk.
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
                onClick={() => {
                  void onDeleteCollection(confirmDeleteCollection.id);
                  setConfirmDeleteCollection(null);
                }}
              >
                Delete collection
              </button>
            </div>
          </div>
        </div>
      )}
    </Sidebar>
  );
}
