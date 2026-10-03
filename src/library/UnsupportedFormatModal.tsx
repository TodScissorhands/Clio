import { useEffect } from "react";
import type { StoredDocument } from "../storage/domain";

export interface UnsupportedFormatModalProps {
  document: StoredDocument;
  onOpenExternally: () => Promise<void>;
  onConvertAndRead: () => void;
  onClose: () => void;
}

export function UnsupportedFormatModal({
  document: doc,
  onOpenExternally,
  onConvertAndRead,
  onClose,
}: UnsupportedFormatModalProps) {
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
      aria-labelledby="unsupported-modal-title"
    >
      <div className="modal-card unsupported-format-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 id="unsupported-modal-title" className="modal-title">
            .{doc.record.format.toUpperCase()} Document
          </h3>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="unsupported-format-lead">This format isn’t directly readable here.</p>
          <p className="unsupported-format-desc">
            “{doc.record.name}” can be opened in your default system application, or converted to a format Clio can display.
          </p>
        </div>
        <div className="modal-footer unsupported-format-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void onOpenExternally()}
          >
            Open externally
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={onConvertAndRead}
          >
            Convert and read
          </button>
        </div>
      </div>
    </div>
  );
}
