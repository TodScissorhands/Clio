# Clio Roadmap

## Authority and status

This is Clio's single forward-looking roadmap. The [Product Design Contract](product-design-contract.md) defines enduring product and interaction rules; it is not a second schedule. [Current Status](status/current.md) records implementation state and reported verification. [Active Task](status/active-task.md) records the repository's current implementation focus where known. The superseded [Product Implementation Roadmap](product-implementation-roadmap.md) is retained as a historical acceptance record, not a current plan.

Use these status terms precisely:

- **Implemented:** present in the current source tree.
- **Verified:** supported by recorded test or runtime evidence; this does not mean rerun in this report.
- **Accepted:** acceptance was recorded for the stated scope.
- **Current commitment:** approved work underway or needed to complete an existing objective.
- **Existing roadmap commitment:** approved future objective not yet started.
- **Candidate:** research proposal, not authorized implementation.
- **Deferred:** intentionally postponed pending requirements, evidence, or a decision.
- **Unresolved:** a decision or evidence gap remains open.

## Product direction

Clio is a local-first, offline-capable document library, reader, and processing application. User-controlled filesystem locations remain authoritative; SQLite stores catalog and reading information, not document bytes. Reading, preview, metadata, conversion, and manipulation capabilities vary by format. Keep Tauri 2, React/TypeScript, Rust, SQLite, PDF.js, Foliate.js, Pandoc, Poppler, and the current filesystem authorization boundary unless concrete evidence and separate approval justify a change. Do not introduce a universal document model or all-to-all converter.

## Objectives and commitments

### Library and local document management

**Implemented:** Rust-owned SQLite catalog, currently schema version 6; explicit desktop library roots and scans; opaque document identity separate from source coordinates and expiring reader access tokens; collections; metadata; reading state; bookmarks and annotations; root attach/detach/relink and scan ownership boundaries. The filesystem remains authoritative.

The Library supports folder/collection scopes, grid and list views, client-side sorting and search over names, metadata and paths, selection/actions, and distinct loading/empty/error/missing states. Search is not full-text search. The current frontend loads the catalog for client-side filtering; large-library behavior has not been benchmarked.

### Format-specific reading and reader experience

**Implemented:** PDF.js PDF reading, Foliate.js EPUB reading, and TXT/Markdown reading. Other registered formats currently provide subsets of metadata, thumbnails, or conversion; registration does not imply reader support. The current format registry includes PDF, EPUB, DOCX, ODT, RTF, HTML, Markdown, and TXT. PPTX, XLSX, and image reading are not implemented in that registry.

**Current commitment — Stage 3 PDF controls and navigation:** the current worktree contains the transient-controls/Navigator, page-entry/fit-mode, and bounded lazy-thumbnail slices. The status report records their test and managed-browser evidence; Stage 3 is still **in progress**, and this roadmap does not claim its acceptance criteria are complete. Remaining acceptance work recorded in [Current Status](status/current.md): native WebView wide/narrow and interaction QA; PDF.js runtime cancellation/unmount verification; wider page-integrity and performance checks. Do not disturb the active Stage 3 implementation.

The Stage 3 design discrepancy is **unresolved**: the design contract specifies a floating Navigator that does not resize the PDF page; the current implementation docks it beside the page and hides the page viewport when narrow. Keep the contract decision recorded as the approved design rule until an explicit product decision approves or rejects the implementation deviation. Do not silently treat implementation as design approval.

**Existing reader objectives, after Stage 3:**

- Improve EPUB ergonomics while retaining Foliate pagination/CFI, EPUB-specific display settings, and the distinction between EPUB content theme and application theme.
- Consolidate Library, reader, dialogs, and tools consistency/design debt in one later design review. Include EPUB theme/background integration, Continue Reading density and prominence, and other observed Library/reader inconsistencies. These are review topics, not a new phase or individually approved fixes.
- Preserve the existing acceptance criteria for responsive controls, keyboard/focus/Escape behavior, dialog focus and recovery, honest operation status, and actual runtime verification in the [historical acceptance record](product-implementation-roadmap.md). Those criteria remain useful; that document no longer sequences work.
- PDF.js TextLayer, real PDF text selection/copy, and search-match geometry remain unimplemented. They are an existing design-contract objective, not a claim of current capability; implementation still requires its own scoped authorization and WebView evidence.
- Durable PDF annotation restoration remains **gated** on explicit approval of locator semantics, source identity, bounds, stale-source behavior, and legacy handling. No schema migration or durable-highlight implementation is authorized by the roadmap alone.

PDF page thumbnails are implemented in the current Stage 3 worktree; PDF cover thumbnails are a separate Library metadata capability. PDF annotation records and note workflows exist, but PDF highlight restoration is not implemented. EPUB CFI annotation overlays are implemented. The investigation and implementation limits for reader security/lifecycle are preserved in [Reader Hardening Investigation](research/reader-hardening-investigation.md); the exact Blob-origin-to-Tauri ACL/native-command boundary remains unresolved.

### Local conversion and document operations

**Implemented:** capability-based local conversion using Pandoc/Poppler, PDF merge, and PDF page extraction. Runtime capability advertisement depends on available tools. PDF rotation remains deferred because no suitable reliable capability is currently advertised. Preserve structured native invocation, validation, overwrite policy, and temporary-file cleanup.

Do not expand this into generic all-to-all conversion or promise safe in-flight cancellation without an explicit native cancellation contract and observable stopped state.

### Additional formats, platform reach, and product quality

The existing roadmap direction is to add useful local format capabilities according to actual needs—not to make every format equally readable or editable. No order for DOCX, presentations, spreadsheets, images, or other formats is approved. Mobile providers/managed storage and mobile indexing are **deferred** until target requirements are concrete. Packaging, accessibility, offline/privacy clarity, reliability, and performance remain long-term quality concerns; the former proposed product-wide integration/reliability/release sequence is not an approved milestone plan.

## Candidate improvements — not approved implementation

These items arise from source inspection or prior architecture research. No performance benchmark or migration experiment is claimed here.

| Candidate | Evidence and mechanism | Disposition |
|---|---|---|
| Measure document-byte transport for representative large files | Rust returns `Vec<u8>` over Tauri IPC; the frontend receives `number[]`, copies to `Uint8Array`, then constructs a `Blob`. This is a plausible memory/latency cost, not a measured user-visible defect. | Prototype only after defining representative sizes and exercising the target WebView. Preserve token authorization; no raw-path transport. |
| Measure scan latency and SQLite transaction duration | Current scan code extracts metadata/thumbnails while the catalog write transaction is open. Moving expensive extraction could shorten lock duration, but requires preserving scan consistency and stale-file safeguards. | Benchmark first; consider a bounded change only if measurements justify it. |
| Evaluate mature ZIP/XML parsers for EPUB/DOCX/ODT metadata | Current code uses bounded `unzip -p` output and custom XML/string handling. A library is not drop-in: output/size limits, path containment, malformed archive behavior, and current fallbacks must remain covered. | Dependency/parser prototype only after compatibility, maintenance, security, and licensing review. |
| Evaluate a mature Markdown parser | `TextEngine` currently parses a limited Markdown subset and emits React elements. A parser could broaden syntax, but safe React rendering and an explicit raw-HTML policy must remain. | Prototype only if broader Markdown behavior is required; do not render untrusted raw HTML by default. |
| Benchmark large-library behavior | The catalog is loaded into frontend state and filtered/sorted client-side. No large-library benchmark is recorded. | Measure before adopting virtualization or database-backed filtering. |
| Define full-text search | Current search is metadata/path scoped; the product requirements for indexed formats, body text, updates, and storage are unspecified. | Deferred until requirements justify extraction/index maintenance and a SQLite FTS evaluation. |
| Replace or wrap the current PDF.js viewer integration | Clio already has a format-neutral engine boundary and a custom PDF.js engine; the design contract says preserve PDF.js absent an evidenced limitation. No migration is authorized. | Research/prototype only for a concrete unmet requirement; do not treat React-PDF or official viewer internals as drop-in lifecycle/scheduling solutions. |

## Settled boundaries and deferred capabilities

- Keep the current SQLite catalog, Pandoc/Poppler capability model, PDF.js and Foliate.js engines, and filesystem authorization boundary. A candidate is not permission to replace them.
- Keep the logical document record, physical source reference, and runtime storage locator distinct. Do not persist document bytes or reader tokens in SQLite.
- Filesystem watchers, mobile content providers, cloud services/sync, full office editing, full PDF/EPUB editing, generic conversion, full-text indexing, and broad renderer replacements are deferred or explicitly out of scope.
- The reader hardening implementation records improved EPUB containment/lifecycle, tokenized native reads, PDF loading-task cleanup and outline support. This is defense-in-depth, not proof of native renderer isolation; see the investigation's verification section.
- No current objective authorizes a new framework, dependency, database, schema migration, reader engine, or security-boundary change.

## Historical record

The milestone chronology and its recorded verification remain in [Current Status](status/current.md). Important decision records remain in the reader-hardening and PDF-operations investigations. Earlier implementation sequences and review findings are preserved in their existing files and marked historical/superseded where applicable; their original evidence is not rewritten as if it had been independently rerun.
