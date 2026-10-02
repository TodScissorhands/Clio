import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  executeConversionJob,
  formatDetail,
  formatLabel,
  getPdfPageCount,
  listConversionCapabilities,
  parsePagesFromRange,
  planConversionJob,
  planExtractPagesJob,
  planMergeJob,
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

/** Pending job ready to be retried with overwrite=true. */
type PendingOverwrite = { job: ConversionJob; label: string };

export function ConversionWorkspace() {
  const [mode, setMode] = useState<"convert" | "merge" | "extract">("convert");
  const [document, setDocument] = useState<DocumentInfo | null>(null);
  const [capabilities, setCapabilities] = useState<ConversionCapability[]>([]);
  const [target, setTarget] = useState("epub");
  const [plannedJob, setPlannedJob] = useState<ConversionJob | null>(null);
  const [status, setStatus] = useState<"idle" | "converting" | "done" | "error">("idle");
  const [message, setMessage] = useState("Choose a document to begin.");
  const [outputPath, setOutputPath] = useState("");
  const [mergeFiles, setMergeFiles] = useState<DocumentInfo[]>([]);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [pageRange, setPageRange] = useState("");
  const [parsedPages, setParsedPages] = useState<number[] | null>(null);
  const [pageRangeError, setPageRangeError] = useState<string | null>(null);
  // When the backend rejects because output exists, we stash the job here so
  // the user can confirm overwrite without picking the path again.
  const [pendingOverwrite, setPendingOverwrite] = useState<PendingOverwrite | null>(null);

  useEffect(() => {
    void listConversionCapabilities().then((allCaps) => {
      if (!document) setCapabilities(allCaps);
    });
  }, [document]);

  const suggestedName = useMemo(
    () => (document ? document.name.replace(/\.[^.]+$/, "") || document.name : "converted-document"),
    [document]
  );

  const suggestedMergeName = useMemo(() => {
    if (mergeFiles.length === 0) return "merged-document";
    return `${mergeFiles[0].name.replace(/\.[^.]+$/, "") || "document"}-merged`;
  }, [mergeFiles]);

  async function chooseDocument() {
    const path = await open({ multiple: false, directory: false, filters: fileFilters });
    if (!path || Array.isArray(path)) return;
    try {
      const info = await invoke<DocumentInfo>("inspect_document", { path });
      setDocument(info);
      setOutputPath("");
      setStatus("idle");
      setPendingOverwrite(null);
      setPageRange("");
      setParsedPages(null);
      setPageRangeError(null);
      setPageCount(null);
      if (info.extension.toLowerCase() === "pdf") {
        void getPdfPageCount(info.path).then(setPageCount).catch(() => setPageCount(null));
      }
      const caps = await listConversionCapabilities(info.extension);
      setCapabilities(caps);
      if (caps.length > 0) {
        const validTargets = caps.map((c) => c.targetFormat);
        const nextTarget = validTargets.includes(target) ? target : validTargets[0];
        setTarget(nextTarget);
        try {
          const job = await planConversionJob(info.path, nextTarget);
          setPlannedJob(job);
          setMessage(
            `Ready to convert. ${caps.length} target format${caps.length === 1 ? "" : "s"} available.`
          );
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
    setPendingOverwrite(null);
    if (document) {
      try {
        const job = await planConversionJob(document.path, newTarget);
        setPlannedJob(job);
      } catch {
        setPlannedJob(null);
      }
    }
  }

  async function addMergeDocuments() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "PDF Documents", extensions: ["pdf"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    const newInfos: DocumentInfo[] = [];
    for (const p of paths) {
      try {
        const info = await invoke<DocumentInfo>("inspect_document", { path: p });
        if (info.extension.toLowerCase() === "pdf") newInfos.push(info);
      } catch {}
    }
    setMergeFiles((prev) => {
      const existingPaths = new Set(prev.map((f) => f.path));
      const combined = [...prev, ...newInfos.filter((f) => !existingPaths.has(f.path))];
      setMessage(
        combined.length >= 2
          ? `Ready to merge ${combined.length} PDFs.`
          : "Add at least 2 PDF files to merge."
      );
      return combined;
    });
  }

  function moveMergeFile(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= mergeFiles.length) return;
    setMergeFiles((prev) => {
      const next = [...prev];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  }

  function removeMergeFile(index: number) {
    setMergeFiles((prev) => {
      const next = prev.filter((_, i) => i !== index);
      setMessage(
        next.length >= 2
          ? `Ready to merge ${next.length} PDFs.`
          : "Add at least 2 PDF files to merge."
      );
      return next;
    });
  }

  function clearMergeFiles() {
    setMergeFiles([]);
    setOutputPath("");
    setStatus("idle");
    setPendingOverwrite(null);
    setMessage("Add at least 2 PDF files to merge.");
  }

  /** Run a planned job and handle the overwrite-rejection case. */
  async function runJob(
    job: ConversionJob,
    overwriteLabel: string,
    onSuccess: (completed: ConversionJob) => void
  ) {
    setStatus("converting");
    setPendingOverwrite(null);
    try {
      const completedJob = await executeConversionJob(job);
      onSuccess(completedJob);
    } catch (error) {
      const msg = String(error);
      setStatus("error");
      setMessage(msg);
      // If the backend rejected because output exists, offer a one-click overwrite.
      if (msg.includes("already exists")) {
        const overwroteJob: ConversionJob = { ...job, overwrite: true };
        setPendingOverwrite({ job: overwroteJob, label: overwriteLabel });
      }
    }
  }

  async function merge() {
    if (mergeFiles.length < 2) return;
    const output = await save({
      defaultPath: `${suggestedMergeName}.pdf`,
      filters: [{ name: "PDF Document", extensions: ["pdf"] }],
    });
    if (!output) return;
    setMessage(`Merging ${mergeFiles.length} PDF files…`);
    const sourcePaths = mergeFiles.map((f) => f.path);
    try {
      const jobToRun = await planMergeJob(sourcePaths, output, false);
      await runJob(jobToRun, `Overwrite and merge ${mergeFiles.length} PDFs`, (completed) => {
        setPlannedJob(completed);
        setOutputPath(completed.outputPath);
        setStatus("done");
        setMessage(`Successfully merged ${mergeFiles.length} PDFs with ${completed.engine}.`);
      });
    } catch (error) {
      setStatus("error");
      setMessage(String(error));
    }
  }

  async function convert() {
    if (!document) return chooseDocument();
    if (capabilities.length === 0) return;
    const output = await save({
      defaultPath: `${suggestedName}.${target}`,
      filters: [{ name: formatLabel(target), extensions: [target] }],
    });
    if (!output) return;
    setMessage("Planning conversion…");
    try {
      const jobToRun = await planConversionJob(document.path, target, output, false);
      setMessage(`Converting with ${jobToRun.engine}…`);
      await runJob(jobToRun, `Overwrite and convert to ${target.toUpperCase()}`, (completed) => {
        setPlannedJob(completed);
        setOutputPath(completed.outputPath);
        setStatus("done");
        setMessage(`Converted successfully with ${completed.engine}.`);
      });
    } catch (error) {
      setStatus("error");
      setMessage(String(error));
    }
  }

  async function handlePageRangeChange(value: string) {
    setPageRange(value);
    setParsedPages(null);
    setPageRangeError(null);
    if (!document || !value.trim()) return;
    try {
      setParsedPages(await parsePagesFromRange(document.path, value));
    } catch (error) {
      setPageRangeError(String(error));
    }
  }

  async function extractPages() {
    if (!document || !parsedPages || parsedPages.length === 0) return;
    const stem = document.name.replace(/\.[^.]+$/, "") || "document";
    const output = await save({
      defaultPath: `${stem}-extracted.pdf`,
      filters: [{ name: "PDF Document", extensions: ["pdf"] }],
    });
    if (!output) return;
    const pageLabel = `${parsedPages.length} page${parsedPages.length === 1 ? "" : "s"}`;
    setMessage(`Extracting ${pageLabel}…`);
    try {
      const jobToRun = await planExtractPagesJob(document.path, parsedPages, output, false);
      await runJob(jobToRun, `Overwrite and extract ${pageLabel}`, (completed) => {
        setPlannedJob(completed);
        setOutputPath(completed.outputPath);
        setStatus("done");
        setMessage(`Extracted ${pageLabel} successfully. Source PDF is not modified.`);
      });
    } catch (error) {
      setStatus("error");
      setMessage(String(error));
    }
  }

  async function confirmOverwrite() {
    if (!pendingOverwrite) return;
    const { job, label } = pendingOverwrite;
    setMessage(`${label}…`);
    await runJob(job, label, (completed) => {
      setPlannedJob(completed);
      setOutputPath(completed.outputPath);
      setStatus("done");
      setMessage(`Done: ${completed.outputPath.split("/").pop() ?? completed.outputPath}`);
    });
  }

  return (
    <section className="tools-view">
      <div className="tools-header">
        <div className="tools-title-group">
          <h1>Document Tools</h1>
          <p>Local-only format conversion, PDF merging, and page extraction.</p>
        </div>
        <div className="workspace-mode-toggle" role="tablist" aria-label="Tool mode">
          <button
            type="button"
            className={`mode-btn ${mode === "convert" ? "selected" : ""}`}
            onClick={() => {
              setMode("convert");
              setStatus("idle");
              setPendingOverwrite(null);
              setMessage(document ? "Ready to convert." : "Choose a document to begin.");
              setOutputPath("");
            }}
          >
            Convert
          </button>
          <button
            type="button"
            className={`mode-btn ${mode === "merge" ? "selected" : ""}`}
            onClick={() => {
              setMode("merge");
              setStatus("idle");
              setPendingOverwrite(null);
              setMessage(
                mergeFiles.length >= 2
                  ? `Ready to merge ${mergeFiles.length} PDFs.`
                  : "Add at least 2 PDF files to merge."
              );
              setOutputPath("");
            }}
          >
            Merge PDF
          </button>
          <button
            type="button"
            className={`mode-btn ${mode === "extract" ? "selected" : ""}`}
            onClick={() => {
              setMode("extract");
              setStatus("idle");
              setPendingOverwrite(null);
              setMessage(
                document?.extension?.toLowerCase() === "pdf"
                  ? "Enter a page selection, then choose where to save."
                  : "Choose a PDF document to extract pages from."
              );
              setOutputPath("");
            }}
          >
            Extract Pages
          </button>
        </div>
      </div>
      <section className="conversion-workspace" aria-label="Document conversion workspace">
        {mode === "convert" ? (
          <>
            <div className="source-card">
              <div className="card-heading">
                <span>Input Document</span>
              </div>
              {document ? (
                <div className="selected-file">
                  <div className="file-icon">{document.extension.slice(0, 3).toUpperCase() || "DOC"}</div>
                  <div className="file-info">
                    <strong>{document.name}</strong>
                    <span>
                      {document.extension.toUpperCase() || "Unknown"} · {formatBytes(document.size)}
                    </span>
                  </div>
                  <button className="quiet-button" onClick={chooseDocument}>
                    Replace
                  </button>
                </div>
              ) : (
                <button className="drop-zone" onClick={chooseDocument}>
                  <span className="plus">+</span>
                  <strong>Choose a document</strong>
                  <small>PDF, EPUB, DOCX, ODT, Markdown, HTML, or text</small>
                </button>
              )}
            </div>
            <div className="connector" aria-hidden="true">
              <span>→</span>
            </div>
            <div className="target-card">
              <div className="card-heading">
                <span>Target Format</span>
              </div>
              <div className="format-grid">
                {capabilities.map((cap) => (
                  <button
                    key={`${cap.sourceFormat}-${cap.targetFormat}`}
                    type="button"
                    className={`format-option ${target === cap.targetFormat ? "selected" : ""}`}
                    onClick={() => void handleTargetSelect(cap.targetFormat)}
                  >
                    <strong>{formatLabel(cap.targetFormat)}</strong>
                    <span>
                      {formatDetail(cap.targetFormat)} · {cap.label}
                    </span>
                  </button>
                ))}
                {document && capabilities.length === 0 && (
                  <p className="no-targets-msg">
                    No conversion targets available for .{document.extension}.
                  </p>
                )}
              </div>
            </div>
          </>
        ) : mode === "merge" ? (
          <>
            <div className="source-card">
              <div className="card-heading">
                <span>PDF Inputs ({mergeFiles.length})</span>
              </div>
              {mergeFiles.length > 0 ? (
                <>
                  <div className="merge-files-list">
                    {mergeFiles.map((file, idx) => (
                      <div key={file.path} className="merge-file-item">
                        <span className="merge-file-idx">{idx + 1}</span>
                        <div className="merge-file-info">
                          <strong title={file.name}>{file.name}</strong>
                          <span>{formatBytes(file.size)}</span>
                        </div>
                        <div className="merge-file-controls">
                          <button
                            type="button"
                            className="merge-reorder-btn"
                            onClick={() => moveMergeFile(idx, -1)}
                            disabled={idx === 0 || status === "converting"}
                            aria-label={`Move ${file.name} up`}
                            title="Move up"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="merge-reorder-btn"
                            onClick={() => moveMergeFile(idx, 1)}
                            disabled={idx === mergeFiles.length - 1 || status === "converting"}
                            aria-label={`Move ${file.name} down`}
                            title="Move down"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="merge-remove-btn"
                            onClick={() => removeMergeFile(idx)}
                            disabled={status === "converting"}
                            aria-label={`Remove ${file.name}`}
                            title="Remove"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="merge-actions-row">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void addMergeDocuments()}
                      disabled={status === "converting"}
                    >
                      + Add more PDFs
                    </button>
                    <button
                      type="button"
                      className="quiet-button"
                      onClick={clearMergeFiles}
                      disabled={status === "converting"}
                    >
                      Clear all
                    </button>
                  </div>
                </>
              ) : (
                <button type="button" className="drop-zone" onClick={() => void addMergeDocuments()}>
                  <span className="plus">+</span>
                  <strong>Choose PDF documents</strong>
                  <small>Select at least 2 PDF files to combine</small>
                </button>
              )}
            </div>
            <div className="connector" aria-hidden="true">
              <span>→</span>
            </div>
            <div className="target-card">
              <div className="card-heading">
                <span>Merge Output</span>
              </div>
              <div className="merge-target-box">
                <span className="merge-target-badge">PDF (Merged)</span>
                <strong>Poppler (pdfunite)</strong>
                <p className="merge-target-desc">
                  {mergeFiles.length >= 2
                    ? `Files will be combined in the exact deterministic order (1 to ${mergeFiles.length}) listed on the left.`
                    : "Add at least 2 PDF documents to enable merge."}
                </p>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="source-card">
              <div className="card-heading">
                <span>Source PDF</span>
              </div>
              {document && document.extension.toLowerCase() === "pdf" ? (
                <div className="selected-file">
                  <div className="file-icon">PDF</div>
                  <div className="file-info">
                    <strong>{document.name}</strong>
                    <span>
                      {formatBytes(document.size)}
                      {pageCount !== null
                        ? ` · ${pageCount} page${pageCount === 1 ? "" : "s"}`
                        : ""}
                    </span>
                  </div>
                  <button
                    className="quiet-button"
                    onClick={chooseDocument}
                    disabled={status === "converting"}
                  >
                    Replace
                  </button>
                </div>
              ) : (
                <button className="drop-zone" onClick={chooseDocument}>
                  <span className="plus">+</span>
                  <strong>Choose a PDF document</strong>
                  <small>Only PDF files are supported for page extraction</small>
                </button>
              )}
            </div>
            <div className="connector" aria-hidden="true">
              <span>→</span>
            </div>
            <div className="target-card">
              <div className="card-heading">
                <span>Pages to Extract</span>
              </div>
              <div className="extract-selection-box">
                <label htmlFor="page-range-input" className="extract-label">
                  Pages to extract
                  {pageCount !== null && (
                    <span className="extract-page-hint">
                      {" "}
                      (document has {pageCount} page{pageCount === 1 ? "" : "s"})
                    </span>
                  )}
                </label>
                <input
                  id="page-range-input"
                  type="text"
                  className={`extract-range-input${
                    pageRangeError ? " input-error" : parsedPages ? " input-ok" : ""
                  }`}
                  placeholder="e.g. 1-3,7,10-12"
                  value={pageRange}
                  onChange={(e) => void handlePageRangeChange(e.target.value)}
                  disabled={
                    !document ||
                    document.extension.toLowerCase() !== "pdf" ||
                    status === "converting"
                  }
                  aria-describedby="page-range-feedback"
                />
                <p
                  id="page-range-feedback"
                  className={`extract-feedback${pageRangeError ? " extract-feedback-error" : ""}`}
                >
                  {pageRangeError
                    ? pageRangeError
                    : parsedPages
                    ? `${parsedPages.length} page${parsedPages.length === 1 ? "" : "s"} selected: ${parsedPages.slice(0, 10).join(", ")}${parsedPages.length > 10 ? "…" : ""}`
                    : "Enter pages or ranges separated by commas (e.g. 1-3,7,10-12)."}
                </p>
                <p className="extract-note">The source PDF is not modified. A new file is created.</p>
              </div>
            </div>
          </>
        )}
      </section>
      <section className="action-row">
        <div className={`conversion-message ${status}`}>
          <span>{status === "done" ? "✓" : status === "error" ? "!" : "•"}</span>
          {message}
        </div>
        {/* Overwrite confirmation — appears after backend rejects an existing output */}
        {pendingOverwrite && status === "error" && (
          <button
            type="button"
            className="overwrite-button"
            onClick={() => void confirmOverwrite()}
          >
            {pendingOverwrite.label} →
          </button>
        )}
        {mode === "convert" ? (
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
        ) : mode === "merge" ? (
          <button
            type="button"
            className="convert-button"
            onClick={() => void merge()}
            disabled={status === "converting" || mergeFiles.length < 2}
          >
            {status === "converting"
              ? "Merging…"
              : mergeFiles.length >= 2
              ? `Merge ${mergeFiles.length} PDFs`
              : "Select at least 2 PDFs"}
            <span>→</span>
          </button>
        ) : (
          <button
            type="button"
            className="convert-button"
            onClick={() => void extractPages()}
            disabled={
              status === "converting" ||
              !document ||
              document.extension.toLowerCase() !== "pdf" ||
              !parsedPages ||
              parsedPages.length === 0 ||
              !!pageRangeError
            }
          >
            {status === "converting"
              ? "Extracting…"
              : parsedPages && parsedPages.length > 0
              ? `Extract ${parsedPages.length} page${parsedPages.length === 1 ? "" : "s"}`
              : "Enter page selection"}
            <span>→</span>
          </button>
        )}
      </section>
      {outputPath && (
        <p className="output-path">
          Saved to <code>{outputPath}</code>
          {plannedJob && <span> · {plannedJob.engine}</span>}
        </p>
      )}
      <p className="tools-note">
        Powered by native tools · Poppler text extraction · Pandoc document conversion
      </p>
    </section>
  );
}
