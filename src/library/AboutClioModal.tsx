import { useEffect } from "react";

export interface AboutClioModalProps {
  onClose: () => void;
}

export function AboutClioModal({ onClose }: AboutClioModalProps) {
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
      aria-labelledby="about-modal-title"
    >
      <div className="modal-card about-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="about-brand">
            <span className="about-brand-icon" aria-hidden="true">📖</span>
            <div>
              <h3 id="about-modal-title" className="modal-title">Clio</h3>
              <span className="about-version">v0.1.0 (D4 Foundation)</span>
            </div>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </div>

        <div className="about-modal-body">
          <p className="about-lead">
            A local-first, offline-capable desktop document library and reader.
          </p>
          <ul className="about-features-list">
            <li><strong>Filesystem authoritative:</strong> Your files stay in your folders. Clio never moves or modifies them without your explicit instruction.</li>
            <li><strong>Privacy-first:</strong> Zero cloud accounts, zero telemetry, zero remote tracking. All data is kept locally in SQLite.</li>
            <li><strong>Document formats:</strong> PDF, EPUB, Plain Text, and Markdown readers with integrated Pandoc and Poppler conversion workflows.</li>
            <li><strong>Fast and quiet:</strong> Content-first architecture with transient chrome and persistent reading state.</li>
          </ul>
        </div>

        <div className="modal-footer">
          <button type="button" className="primary-button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
