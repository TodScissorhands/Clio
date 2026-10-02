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
}: DocumentContextMenuProps) {
  const [collectionSubmenuOpen, setCollectionSubmenuOpen] = useState(false);

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

        {/* GROUP 3 */}
        {group3.map((cmd) => (
          <button
            key={cmd.id}
            type="button"
            className={`context-menu-item ${cmd.id === "remove-from-library" ? "danger" : ""}`}
            role="menuitem"
            onClick={() => executeCommand(cmd)}
          >
            {cmd.label}
          </button>
        ))}
      </div>
    </div>
  );
}
