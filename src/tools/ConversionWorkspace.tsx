import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  executeConversionJob,
  formatDetail,
  formatLabel,
  listConversionCapabilities,
  planConversionJob,
  type ConversionCapability,
  type ConversionJob,
} from "./conversion";

type DocumentInfo = {
  path: string;
  name: string;
  extension: string;
  size: number;
  supported: boolean;
};

const fileFilters = [
  {
    name: "Documents",
    extensions: ["pdf", "epub", "docx", "odt", "rtf", "html", "htm", "md", "txt"],
  },
];

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ConversionWorkspace() {
  const [document, setDocument] = useState<DocumentInfo | null>(null);
  const [capabilities, setCapabilities] = useState<ConversionCapability[]>([]);
  const [target, setTarget] = useState("epub");
  const [plannedJob, setPlannedJob] = useState<ConversionJob | null>(null);
  const [status, setStatus] = useState<"idle" | "converting" | "done" | "error">("idle");
  const [message, setMessage] = useState("Choose a document to begin.");
  const [outputPath, setOutputPath] = useState("");

  // Load initial global capabilities for preview before document selection
  useEffect(() => {
    void listConversionCapabilities().then((allCaps) => {
      if (!document) {
        setCapabilities(allCaps);
      }
    });
  }, [document]);

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

      // Query capabilities specific to this document's format
      const caps = await listConversionCapabilities(info.extension);
      setCapabilities(caps);

      if (caps.length > 0) {
        // Pick first target if current target is not in valid targets
        const validTargets = caps.map((c) => c.targetFormat);
        const nextTarget = validTargets.includes(target) ? target : validTargets[0];
        setTarget(nextTarget);

        // Plan the job ahead of execution
        try {
          const job = await planConversionJob(info.path, nextTarget);
          setPlannedJob(job);
          setMessage(`Ready to convert. ${caps.length} target format${caps.length === 1 ? "" : "s"} available.`);
        } catch {
          setPlannedJob(null);
          setMessage("Ready to convert.");
        }
      } else {
        setPlannedJob(null);
        setMessage(`.${info.extension || "unknown"} is not supported for conversion.`);
      }
    } catch (error) {
      setStatus("error");
      setMessage(String(error));
    }
  }

  async function handleTargetSelect(newTarget: string) {
    setTarget(newTarget);
    if (document) {
      try {
        const job = await planConversionJob(document.path, newTarget);
        setPlannedJob(job);
      } catch {
        setPlannedJob(null);
      }
    }
  }

  async function convert() {
    if (!document) return chooseDocument();
    if (capabilities.length === 0) return;

    const output = await save({
      defaultPath: `${suggestedName}.${target}`,
      filters: [
        {
          name: formatLabel(target),
          extensions: [target],
        },
      ],
    });
    if (!output) return;

    setStatus("converting");
    setMessage("Planning and executing conversion…");
    try {
      // Plan job with concrete destination path
      const jobToRun = await planConversionJob(document.path, target, output);
      setMessage(`Converting with ${jobToRun.engine}…`);

      // Execute through native capability boundary
      const completedJob = await executeConversionJob(jobToRun);
      setPlannedJob(completedJob);
      setOutputPath(completedJob.outputPath);
      setStatus("done");
      setMessage(`Converted successfully with ${completedJob.engine}.`);
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
            {capabilities.map((cap) => (
              <button
                key={`${cap.sourceFormat}-${cap.targetFormat}`}
                type="button"
                className={`format-option ${target === cap.targetFormat ? "selected" : ""}`}
                onClick={() => void handleTargetSelect(cap.targetFormat)}
              >
                <strong>{formatLabel(cap.targetFormat)}</strong>
                <span>{formatDetail(cap.targetFormat)} · {cap.label}</span>
              </button>
            ))}
            {document && capabilities.length === 0 && (
              <p style={{ gridColumn: "1 / -1", color: "#8c8e83", fontSize: "12px", margin: "16px 0" }}>
                No conversion targets available for .{document.extension}.
              </p>
            )}
          </div>
        </div>
      </section>
      <section className="action-row">
        <div className={`conversion-message ${status}`}><span>{status === "done" ? "✓" : status === "error" ? "!" : "•"}</span>{message}</div>
        <button
          type="button"
          className="convert-button"
          onClick={() => void convert()}
          disabled={status === "converting" || (!!document && capabilities.length === 0)}
        >
          {status === "converting"
            ? "Converting…"
            : document
            ? `Convert to ${target.toUpperCase()}`
            : "Select a document"}
          <span>→</span>
        </button>
      </section>
      {outputPath && (
        <p className="output-path">
          Saved to <code>{outputPath}</code>
          {plannedJob && <span> · {plannedJob.engine}</span>}
        </p>
      )}
      <p className="tools-note">Powered by native tools · Poppler text extraction · Pandoc document conversion</p>
    </section>
  );
}
