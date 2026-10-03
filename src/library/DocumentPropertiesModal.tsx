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
          <div className="props-summary-row">
            <span className={`format-badge format-${document.record.format}`}>
              {document.record.format.toUpperCase()}
            </span>
            <strong className="props-display-title">{displayTitle}</strong>
          </div>

          <table className="props-table">
            <tbody>
              <tr>
                <th>File Name</th>
                <td>{document.record.name}</td>
              </tr>
              <tr>
                <th>File Size</th>
                <td>{formatBytes(document.record.sizeBytes)}</td>
              </tr>
              <tr>
                <th>Library Folder</th>
                <td>{rootLabel}</td>
              </tr>
              <tr>
                <th>Relative Path</th>
                <td>
                  <code className="props-path-code">{relativePath}</code>
                </td>
              </tr>
              <tr>
                <th>Status</th>
                <td>
                  <span className={`status-pill ${document.availability}`}>
                    {document.availability === "present" ? "Available" : "Missing from disk"}
                  </span>
                </td>
              </tr>
              <tr>
                <th>Last Opened</th>
                <td>{lastOpened}</td>
              </tr>
              <tr>
                <th>Reading Progress</th>
                <td>{progress ?? "Not started"}</td>
              </tr>
              <tr>
                <th>Collections</th>
                <td>
                  {docCollections.length > 0
                    ? docCollections.map((c) => c.name).join(", ")
                    : "None"}
                </td>
              </tr>

              {/* Metadata rows if available */}
              {meta?.authors && meta.authors.length > 0 && (
                <tr>
                  <th>Authors</th>
                  <td>{meta.authors.join(", ")}</td>
                </tr>
              )}
              {meta?.publisher && (
                <tr>
                  <th>Publisher</th>
                  <td>{meta.publisher}</td>
                </tr>
              )}
              {meta?.publishedDate && (
                <tr>
                  <th>Published Date</th>
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
              {meta?.identifiers && meta.identifiers.length > 0 && (
                <tr>
                  <th>Identifiers</th>
                  <td>{meta.identifiers.join(", ")}</td>
                </tr>
              )}
              {meta?.provenance && (
                <tr>
                  <th>Provenance</th>
                  <td>{meta.provenance === "embedded" ? "Embedded document metadata" : "Filename fallback"}</td>
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
