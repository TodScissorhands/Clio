import type { StoredDocument } from "../storage/domain";
import { ConversionWorkspace } from "../tools/ConversionWorkspace";

export interface ConversionModalProps {
  mode: "convert" | "merge" | "extract";
  sourceDocument?: StoredDocument | null;
  mergeDocuments?: StoredDocument[];
  onClose: () => void;
}

export function ConversionModal({
  mode,
  sourceDocument,
  mergeDocuments,
  onClose,
}: ConversionModalProps) {
  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Document conversion workspace"
    >
      <div className="modal-card conversion-modal-card" onClick={(e) => e.stopPropagation()}>
        <ConversionWorkspace
          initialMode={mode}
          initialDocument={sourceDocument}
          initialMergeDocuments={mergeDocuments}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
