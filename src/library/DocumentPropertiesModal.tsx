import { useEffect } from "react";
import type { Collection, LibraryRoot, StoredDocument } from "../storage/domain";
import { formatBytes, getDocumentDisplayTitle } from "../storage/domain";
import { formatReadingProgress, formatRelativeTime } from "./libraryFilter";

export interface DocumentPropertiesModalProps {
  document: StoredDocument | null;
  roots: LibraryRoot[];
  collections: Collection[];
  onLocate?: (doc: StoredDocument) => void;
  onClose: () => void;
}

export function DocumentPropertiesModal({
  document,
  roots,
  collections,
  onLocate,
  onClose,
}: DocumentPropertiesModalProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!document) return null;

  const displayTitle = getDocumentDisplayTitle(document.record);
  const source = document.source;
  const root =
    source.kind === "library"
      ? roots.find((r) => r.id === source.rootId)
      : null;
  const rootLabel = root ? root.label : "Direct picked file";
  const relativePath =
    source.kind === "library" ? source.relativePath : "—";
  const progress = formatReadingProgress(document.readingState ?? undefined);
  const lastOpened = document.readingState?.lastOpenedAt
    ? formatRelativeTime(document.readingState.lastOpenedAt)
    : "Never";

  const docCollections = collections.filter((c) =>
    document.record.collections?.includes(c.id)
  );
  const meta = document.record.metadata;

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="props-modal-title">
      <div className="modal-card properties-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2 id="props-modal-title" className="modal-title">
            Document Properties
          </h2>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ✕
          </button>
        </header>

        <div className="properties-content">
          {document.availability === "missing" && (
            <div className="props-missing-banner" role="alert">
              <span className="props-missing-icon">⚠</span>
              <div className="props-missing-text">
                <strong>Document unavailable at saved location</strong>
                <p>The file may have been moved or renamed outside Clio.</p>
              </div>
            </div>
          )}

          <div className="props-header-card">
            <span className={`format-badge format-${document.record.format}`}>
              {document.record.format.toUpperCase()}
            </span>
            <div className="props-header-titles">
              <h3 className="props-display-title">{displayTitle}</h3>
              {meta?.authors && meta.authors.length > 0 && (
                <span className="props-authors">{meta.authors.join(", ")}</span>
              )}
            </div>
          </div>

          <table className="props-table">
            <tbody>
              <tr>
                <th>Format & Size</th>
                <td>{document.record.format.toUpperCase()} · {formatBytes(document.record.sizeBytes)}</td>
              </tr>
              <tr>
                <th>Location</th>
                <td>
                  <span className="props-root-label">{rootLabel}</span>
                  <code className="props-path-code">{relativePath}</code>
                </td>
              </tr>
              <tr>
                <th>Reading Progress</th>
                <td>{progress ?? "Not started"}</td>
              </tr>
              <tr>
                <th>Last Opened</th>
                <td>{lastOpened}</td>
              </tr>
              <tr>
                <th>Status</th>
                <td>
                  <span className={`status-pill ${document.availability}`}>
                    {document.availability === "present" ? "Available in library" : "Missing from disk"}
                  </span>
                </td>
              </tr>
              {docCollections.length > 0 && (
                <tr>
                  <th>Collections</th>
                  <td>{docCollections.map((c) => c.name).join(", ")}</td>
                </tr>
              )}

              {/* Bibliographic metadata if available */}
              {meta?.publisher && (
                <tr>
                  <th>Publisher</th>
                  <td>{meta.publisher}</td>
                </tr>
              )}
              {meta?.publishedDate && (
                <tr>
                  <th>Published</th>
                  <td>{meta.publishedDate}</td>
                </tr>
              )}
              {meta?.language && (
                <tr>
                  <th>Language</th>
                  <td>{meta.language.toUpperCase()}</td>
                </tr>
              )}
              {meta?.description && (
                <tr>
                  <th>Description</th>
                  <td className="props-desc-cell">{meta.description}</td>
                </tr>
              )}
              {displayTitle !== document.record.name && (
                <tr>
                  <th>File Name</th>
                  <td><code>{document.record.name}</code></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <footer className="modal-footer">
          {document.availability === "missing" && onLocate && (
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                onClose();
                onLocate(document);
              }}
            >
              Locate file…
            </button>
          )}
          <button type="button" className="secondary-button" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
