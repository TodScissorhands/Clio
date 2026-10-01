import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

type DocumentInfo = {
  path: string;
  name: string;
  extension: string;
  size: number;
  supported: boolean;
};

type ConversionResult = {
  outputPath: string;
  engine: string;
};

const formats = [
  { id: "pdf", label: "PDF", detail: "Portable document" },
  { id: "epub", label: "EPUB", detail: "E-reader book" },
  { id: "docx", label: "DOCX", detail: "Word document" },
  { id: "odt", label: "ODT", detail: "Open document" },
  { id: "html", label: "HTML", detail: "Web page" },
  { id: "md", label: "Markdown", detail: "Plain text markup" },
  { id: "txt", label: "Plain text", detail: "Simple text" },
];

const fileFilters = [
  { name: "Documents", extensions: ["pdf", "epub", "docx", "odt", "rtf", "html", "htm", "md", "txt"] },
];

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ConversionWorkspace() {
  const [document, setDocument] = useState<DocumentInfo | null>(null);
  const [target, setTarget] = useState("epub");
  const [status, setStatus] = useState<"idle" | "converting" | "done" | "error">("idle");
  const [message, setMessage] = useState("Choose a document to begin.");
  const [outputPath, setOutputPath] = useState("");

  const suggestedName = useMemo(() => {
    if (!document) return "converted-document";
    return document.name.replace(/\.[^.]+$/, "") || document.name;
  }, [document]);

  async function chooseDocument() {
    const path = await open({ multiple: false, directory: false, filters: fileFilters });
    if (!path || Array.isArray(path)) return;

    try {
      const info = await invoke<DocumentInfo>("inspect_document", { path });
      setDocument(info);
      setOutputPath("");
      setStatus("idle");
      setMessage(info.supported ? "Ready to convert." : `.${info.extension || "unknown"} is not supported yet.`);
    } catch (error) {
      setStatus("error");
      setMessage(String(error));
    }
  }

  async function convert() {
    if (!document) return chooseDocument();
    if (!document.supported) return;

    const output = await save({
      defaultPath: `${suggestedName}.${target}`,
      filters: [{ name: formats.find((format) => format.id === target)?.label ?? target, extensions: [target] }],
    });
    if (!output) return;

    setStatus("converting");
    setMessage("Converting your document…");
    try {
      const result = await invoke<ConversionResult>("convert_document", {
        inputPath: document.path,
        outputPath: output,
        outputFormat: target,
      });
      setOutputPath(result.outputPath);
      setStatus("done");
      setMessage(`Converted with ${result.engine}.`);
    } catch (error) {
      setStatus("error");
      setMessage(String(error));
    }
  }

  return (
    <section className="tools-view">
      <div className="view-heading">
        <div>
          <p className="eyebrow">Local document tools</p>
          <h1>Convert with confidence.</h1>
          <p className="view-intro">Use the existing native conversion workflow without leaving Clio.</p>
        </div>
      </div>
      <section className="conversion-workspace" aria-label="Document conversion workspace">
        <div className="source-card">
          <div className="card-heading"><span className="step">01</span><span>Source document</span></div>
          {document ? (
            <div className="selected-file">
              <div className="file-icon">{document.extension.slice(0, 3).toUpperCase() || "DOC"}</div>
              <div className="file-info"><strong>{document.name}</strong><span>{document.extension.toUpperCase() || "Unknown"} · {formatBytes(document.size)}</span></div>
              <button className="quiet-button" onClick={chooseDocument}>Replace</button>
            </div>
          ) : (
            <button className="drop-zone" onClick={chooseDocument}>
              <span className="plus">+</span><strong>Choose a document</strong><small>PDF, EPUB, DOCX, ODT, Markdown, HTML, or text</small>
            </button>
          )}
        </div>
        <div className="connector" aria-hidden="true"><span>→</span></div>
        <div className="target-card">
          <div className="card-heading"><span className="step">02</span><span>Convert to</span></div>
          <div className="format-grid">
            {formats.map((format) => (
              <button key={format.id} className={`format-option ${target === format.id ? "selected" : ""}`} onClick={() => setTarget(format.id)}>
                <strong>{format.label}</strong><span>{format.detail}</span>
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="action-row">
        <div className={`conversion-message ${status}`}><span>{status === "done" ? "✓" : status === "error" ? "!" : "•"}</span>{message}</div>
        <button className="convert-button" onClick={convert} disabled={status === "converting" || (!!document && !document.supported)}>
          {status === "converting" ? "Converting…" : document ? `Convert to ${target.toUpperCase()}` : "Select a document"}
          <span>→</span>
        </button>
      </section>
      {outputPath && <p className="output-path">Saved to <code>{outputPath}</code></p>}
      <p className="tools-note">Powered by native tools · PDF text extraction · Pandoc document conversion</p>
    </section>
  );
}
