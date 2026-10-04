import { useState } from "react";
import type { Collection, StoredDocument } from "../storage/domain";
import {
  canMergeSelected,
  documentCommands,
  type CommandContext,
  type DocumentCommand,
} from "../commands/documentCommands";

export interface DocumentContextMenuProps {
  x: number;
  y: number;
  targetDoc: StoredDocument | null;
  selectedDocs: StoredDocument[];
  collections: Collection[];
  commandContext: CommandContext;
  onClose: () => void;
  onCreateCollectionPrompt?: () => void;
  onOpenExternally?: (document: StoredDocument) => Promise<void>;
}

export function DocumentContextMenu({
  x,
  y,
  targetDoc,
  selectedDocs,
  collections,
  commandContext,
  onClose,
  onCreateCollectionPrompt,
  onOpenExternally,
}: DocumentContextMenuProps) {
  const [collectionSubmenuOpen, setCollectionSubmenuOpen] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);

  // Effective documents for this action
  const docs = selectedDocs.length > 0 ? selectedDocs : targetDoc ? [targetDoc] : [];
  if (docs.length === 0) return null;

  // Filter available commands based on context
  const availableCommands = documentCommands.filter((cmd) => cmd.isAvailable(commandContext));
  const group1 = availableCommands.filter((c) => c.group === 1 && c.id !== "add-to-collection");
  const hasAddToCollection = availableCommands.some((c) => c.id === "add-to-collection");
  const group2 = availableCommands.filter((c) => c.group === 2);
  const group3 = availableCommands.filter((c) => c.group === 3);
  const canMerge = canMergeSelected(docs);

  // Bounds clamping so menu stays on screen
  const menuStyle = {
    top: `${Math.min(y, window.innerHeight - 320)}px`,
    left: `${Math.min(x, window.innerWidth - 240)}px`,
  };

  function executeCommand(cmd: DocumentCommand) {
    onClose();
    void cmd.execute(commandContext);
  }

  async function handleAssignCollection(collectionId: string) {
    onClose();
    const docIds = docs.map((d) => d.record.id);
    await commandContext.onAddToCollection(collectionId, docIds);
  }

  return (
    <div
      className="context-menu-backdrop"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="context-menu-popover document-context-menu"
        style={menuStyle}
        onClick={(e) => e.stopPropagation()}
        role="menu"
        aria-label="Document actions"
      >
        {/* GROUP 1 */}
        {group1.map((cmd) => (
          <button
            key={cmd.id}
            type="button"
            className="context-menu-item"
            role="menuitem"
            onClick={() => executeCommand(cmd)}
          >
            {cmd.label}
          </button>
        ))}
        {docs.length === 1 && docs[0]?.source.kind === "library" && docs[0].availability === "present" && onOpenExternally && (
          <>
            <button
              type="button"
              className="context-menu-item"
              role="menuitem"
              onClick={() => {
                const document = docs[0];
                onClose();
                if (document) void onOpenExternally(document);
              }}
            >
              Open externally
            </button>
            <div className="context-menu-divider" role="separator" />
          </>
        )}

        {hasAddToCollection && (
          <div
            className="context-menu-submenu-wrap"
            onMouseEnter={() => setCollectionSubmenuOpen(true)}
            onMouseLeave={() => setCollectionSubmenuOpen(false)}
          >
            <button
              type="button"
              className="context-menu-item submenu-parent"
              role="menuitem"
              aria-haspopup="true"
              aria-expanded={collectionSubmenuOpen}
              onClick={() => setCollectionSubmenuOpen((v) => !v)}
            >
              <span>Add to collection</span>
              <span className="submenu-arrow">›</span>
            </button>

            {collectionSubmenuOpen && (
              <div className="context-submenu-popover" role="menu">
                {collections.map((col) => (
                  <button
                    key={col.id}
                    type="button"
                    className="context-menu-item"
                    role="menuitem"
                    onClick={() => void handleAssignCollection(col.id)}
                  >
                    🏷️ {col.name}
                  </button>
                ))}
                {collections.length === 0 && (
                  <div className="submenu-empty-hint">No collections yet</div>
                )}
                {onCreateCollectionPrompt && (
                  <button
                    type="button"
                    className="context-menu-item create-collection-item"
                    role="menuitem"
                    onClick={() => {
                      onClose();
                      onCreateCollectionPrompt();
                    }}
                  >
                    + New collection…
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Separator between Group 1 and Group 2 */}
        {(group1.length > 0 || hasAddToCollection) && (group2.length > 0 || canMerge) && (
          <div className="context-menu-divider" role="separator" />
        )}

        {/* GROUP 2 */}
        {group2.map((cmd) => (
          <button
            key={cmd.id}
            type="button"
            className="context-menu-item"
            role="menuitem"
            onClick={() => executeCommand(cmd)}
          >
            {cmd.label}
          </button>
        ))}

        {canMerge && (
          <button
            type="button"
            className="context-menu-item"
            role="menuitem"
            onClick={() => {
              onClose();
              commandContext.onMerge(docs);
            }}
          >
            Merge PDFs…
          </button>
        )}

        {/* Separator between Group 2 and Group 3 */}
        {(group2.length > 0 || canMerge) && group3.length > 0 && (
          <div className="context-menu-divider" role="separator" />
        )}

        {/* GROUP 3 — render remove-from-library with inline confirmation */}
        {group3.map((cmd) => {
          if (cmd.id === "remove-from-library") {
            return removeConfirm ? (
              <div key={cmd.id} className="context-menu-remove-confirm">
                <span className="context-menu-confirm-label">
                  Remove {docs.length === 1 ? "this document" : `${docs.length} documents`}?
                </span>
                <button
                  type="button"
                  className="context-menu-item danger"
                  role="menuitem"
                  onClick={() => executeCommand(cmd)}
                >
                  Remove
                </button>
                <button
                  type="button"
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => setRemoveConfirm(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                key={cmd.id}
                type="button"
                className="context-menu-item danger"
                role="menuitem"
                onClick={() => setRemoveConfirm(true)}
              >
                {cmd.label}
              </button>
            );
          }
          return (
            <button
              key={cmd.id}
              type="button"
              className="context-menu-item"
              role="menuitem"
              onClick={() => executeCommand(cmd)}
            >
              {cmd.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
