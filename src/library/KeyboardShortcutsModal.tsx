import { useEffect } from "react";

export interface KeyboardShortcutsModalProps {
  onClose: () => void;
}

export function KeyboardShortcutsModal({ onClose }: KeyboardShortcutsModalProps) {
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
      aria-labelledby="shortcuts-modal-title"
    >
      <div className="modal-card shortcuts-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 id="shortcuts-modal-title" className="modal-title">
            Keyboard Shortcuts
          </h3>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close shortcuts">
            ✕
          </button>
        </div>

        <div className="shortcuts-modal-content">
          <div className="shortcuts-section">
            <h4 className="shortcuts-section-title">Library</h4>
            <div className="shortcuts-grid">
              <div className="shortcut-row">
                <kbd>Enter</kbd>
                <span>Open selected document</span>
              </div>
              <div className="shortcut-row">
                <kbd>Space</kbd>
                <span>Toggle selection</span>
              </div>
              <div className="shortcut-row">
                <kbd>/</kbd> or <kbd>Ctrl</kbd>+<kbd>K</kbd>
                <span>Focus search</span>
              </div>
              <div className="shortcut-row">
                <kbd>Escape</kbd>
                <span>Clear selection or search</span>
              </div>
              <div className="shortcut-row">
                <kbd>Ctrl/Cmd</kbd>+<kbd>Click</kbd>
                <span>Multi-select documents</span>
              </div>
              <div className="shortcut-row">
                <kbd>Shift</kbd>+<kbd>Click</kbd>
                <span>Range select documents</span>
              </div>
            </div>
          </div>

          <div className="shortcuts-section">
            <h4 className="shortcuts-section-title">Reader</h4>
            <div className="shortcuts-grid">
              <div className="shortcut-row">
                <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>Cmd</kbd>+<kbd>[</kbd>
                <span>Back to Library</span>
              </div>
              <div className="shortcut-row">
                <kbd>Ctrl/Cmd</kbd>+<kbd>F</kbd>
                <span>Find in document</span>
              </div>
              <div className="shortcut-row">
                <kbd>Enter</kbd> / <kbd>Shift</kbd>+<kbd>Enter</kbd>
                <span>Next / Previous search match</span>
              </div>
              <div className="shortcut-row">
                <kbd>Ctrl/Cmd</kbd>+<kbd>B</kbd>
                <span>Toggle bookmark</span>
              </div>
              <div className="shortcut-row">
                <kbd>←</kbd> / <kbd>→</kbd>
                <span>Previous / Next page</span>
              </div>
              <div className="shortcut-row">
                <kbd>Ctrl/Cmd</kbd>+<kbd>+</kbd> / <kbd>-</kbd> / <kbd>0</kbd>
                <span>Zoom in / out / reset (PDF)</span>
              </div>
              <div className="shortcut-row">
                <kbd>Escape</kbd>
                <span>Dismiss panel, Find, selection, or chrome</span>
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="primary-button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
