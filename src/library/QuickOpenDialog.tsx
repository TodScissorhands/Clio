import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { getDocumentDisplayTitle, type StoredDocument } from "../storage/domain";
import { matchesSearch, sortDocuments } from "./libraryFilter";

interface QuickOpenDialogProps {
  documents: StoredDocument[];
  onClose: () => void;
  onOpenDocument: (document: StoredDocument) => void;
  onSearchLibrary: () => void;
  onToggleLayout: () => void;
  onRescan: () => void;
  onGoToLibrary: () => void;
  onOpenTools: () => void;
  onOpenShortcuts: () => void;
}

export function QuickOpenDialog({
  documents,
  onClose,
  onOpenDocument,
  onSearchLibrary,
  onToggleLayout,
  onRescan,
  onGoToLibrary,
  onOpenTools,
  onOpenShortcuts,
}: QuickOpenDialogProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const commands = useMemo(() => [
    { id: "search", title: "Search Library", detail: "Focus the Library search field", run: onSearchLibrary },
    { id: "layout", title: "Toggle Grid/List", detail: "Switch the Library presentation", run: onToggleLayout },
    { id: "rescan", title: "Rescan current scope", detail: "Refresh the current Library folders", run: onRescan },
    { id: "library", title: "Go to Library", detail: "Return to the current Library location", run: onGoToLibrary },
    { id: "tools", title: "Open Document Tools", detail: "Open conversion and document tools", run: onOpenTools },
    { id: "shortcuts", title: "Keyboard Shortcuts", detail: "Show the shortcut reference", run: onOpenShortcuts },
  ], [onGoToLibrary, onOpenShortcuts, onOpenTools, onRescan, onSearchLibrary, onToggleLayout]);
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matchingCommands = commands.filter((command) =>
      !normalized || `${command.title} ${command.detail}`.toLowerCase().includes(normalized)
    );
    const matchingDocuments = sortDocuments(
      documents.filter((document) => matchesSearch(document, query)),
      "recent"
    ).slice(0, 60);
    return [
      ...matchingCommands.map((command) => ({ kind: "command" as const, id: command.id, title: command.title, detail: command.detail })),
      ...matchingDocuments.map((document) => ({
        kind: "document" as const,
        id: document.record.id,
        title: getDocumentDisplayTitle(document.record),
        detail: document.record.metadata?.authors?.join(", ") || document.record.format.toUpperCase(),
      })),
    ];
  }, [commands, documents, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function activate(index: number) {
    const result = results[index];
    if (!result) return;
    if (result.kind === "command") {
      commands.find((command) => command.id === result.id)?.run();
    } else {
      const document = documents.find((candidate) => candidate.record.id === result.id);
      if (document) onOpenDocument(document);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal-card quick-open-card" role="dialog" aria-modal="true" aria-labelledby="quick-open-title">
        <div className="modal-header">
          <h2 id="quick-open-title" className="modal-title">Quick Open</h2>
          <Button type="button" size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close Quick Open">×</Button>
        </div>
        <div className="px-4 pb-3">
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setActiveIndex((index) => results.length ? (index + delta + results.length) % results.length : 0);
              } else if (event.key === "Enter") {
                event.preventDefault();
                activate(activeIndex);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            placeholder="Search documents or commands…"
            aria-label="Quick Open documents and commands"
            aria-controls="quick-open-results"
            aria-activedescendant={results[activeIndex] ? `quick-open-result-${activeIndex}` : undefined}
          />
        </div>
        <div id="quick-open-results" className="quick-open-results" role="listbox" aria-label="Quick Open results">
          {results.map((result, index) => (
            <button
              key={`${result.kind}:${result.id}`}
              id={`quick-open-result-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className="quick-open-result"
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => activate(index)}
            >
              <span className="min-w-0 truncate font-medium">{result.title}</span>
              <span className="shrink-0 truncate text-xs text-muted-foreground">{result.kind === "command" ? "Command · " : "Document · "}{result.detail}</span>
            </button>
          ))}
          {results.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted-foreground">No matching documents or commands.</p>}
        </div>
        <div className="modal-footer justify-between text-xs text-muted-foreground">
          <span>↑ ↓ to move · Enter to open · Esc to close</span>
          <kbd>Ctrl/Cmd+K</kbd>
        </div>
      </div>
    </div>
  );
}
