import { useState, useEffect } from "react";
import type { Collection } from "../storage/domain";

export interface AddToCollectionModalProps {
  documentCount: number;
  collections: Collection[];
  onAddToCollection: (collectionId: string) => Promise<void>;
  onCreateAndAddToCollection: (name: string) => Promise<void>;
  onClose: () => void;
}

export function AddToCollectionModal({
  documentCount,
  collections,
  onAddToCollection,
  onCreateAndAddToCollection,
  onClose,
}: AddToCollectionModalProps) {
  const [selectedColId, setSelectedColId] = useState<string>(collections[0]?.id ?? "");
  const [isCreatingNew, setIsCreatingNew] = useState(collections.length === 0);
  const [newColName, setNewColName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    try {
      if (isCreatingNew) {
        const name = newColName.trim();
        if (!name) return;
        await onCreateAndAddToCollection(name);
      } else if (selectedColId) {
        await onAddToCollection(selectedColId);
      }
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="add-col-title">
      <div className="modal-card add-to-collection-card" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2 id="add-col-title" className="modal-title">
            Add to Collection
          </h2>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </header>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <p className="modal-intro">
              Add {documentCount} {documentCount === 1 ? "document" : "documents"} to a logical collection.
            </p>

            {collections.length > 0 && (
              <div className="modal-radio-group">
                <label className="modal-radio-label">
                  <input
                    type="radio"
                    name="col-mode"
                    checked={!isCreatingNew}
                    onChange={() => setIsCreatingNew(false)}
                  />
                  <span>Existing collection</span>
                </label>
                <label className="modal-radio-label">
                  <input
                    type="radio"
                    name="col-mode"
                    checked={isCreatingNew}
                    onChange={() => setIsCreatingNew(true)}
                  />
                  <span>Create new collection</span>
                </label>
              </div>
            )}

            {!isCreatingNew && collections.length > 0 ? (
              <div className="form-field">
                <label htmlFor="collection-select" className="form-label">
                  Select collection:
                </label>
                <select
                  id="collection-select"
                  className="modal-select"
                  value={selectedColId}
                  onChange={(e) => setSelectedColId(e.target.value)}
                >
                  {collections.map((col) => (
                    <option key={col.id} value={col.id}>
                      {col.name} ({col.documentCount} {col.documentCount === 1 ? "doc" : "docs"})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="form-field">
                <label htmlFor="new-col-input" className="form-label">
                  New collection name:
                </label>
                <input
                  id="new-col-input"
                  type="text"
                  className="modal-input"
                  placeholder="e.g. Research, To Read, Work"
                  value={newColName}
                  onChange={(e) => setNewColName(e.target.value)}
                  autoFocus
                />
              </div>
            )}
          </div>

          <footer className="modal-footer">
            <button type="button" className="secondary-button" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={isSubmitting || (isCreatingNew && !newColName.trim()) || (!isCreatingNew && !selectedColId)}
            >
              {isSubmitting ? "Adding…" : "Add"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
