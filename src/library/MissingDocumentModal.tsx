import { useEffect } from "react";
import type { StoredDocument } from "../storage/domain";

export interface MissingDocumentModalProps {
  document: StoredDocument;
  onLocate: () => void;
  onRemove: () => void;
  onClose: () => void;
}

export function MissingDocumentModal({
  document: doc,
  onLocate,
  onRemove,
  onClose,
}: MissingDocumentModalProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="missing-modal-title"
    >
      <div className="modal-card missing-doc-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 id="missing-modal-title" className="modal-title">
            Document Missing
          </h3>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="missing-doc-lead">
            “{doc.record.name}” is missing from its library folder.
          </p>
          <p className="missing-doc-desc">
            The file may have been moved or renamed outside Clio. You can locate its new location to preserve your reading position, notes, and collections, or remove it from your library.
          </p>
        </div>
        <div className="modal-footer missing-doc-actions">
          <button
            type="button"
            className="secondary-button danger"
            onClick={onRemove}
          >
            Remove from library
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={onLocate}
          >
            Locate file…
          </button>
        </div>
      </div>
    </div>
  );
}
