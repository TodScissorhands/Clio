# Clio Agent Context

This file is the canonical persistent project context for Clio agents. Read it before planning or changing the repository. Role files under `.omp/agents/` define specialist ownership; they do not replace this document.

## Product

Clio is a local-first, offline-capable, filesystem-oriented document library and reader. It is intended to combine the useful parts of a book reader, PDF utility, and lightweight document manager without requiring an account, cloud storage, or a hosted processing service. User-controlled directories remain authoritative; Clio should not take ownership of document bytes unnecessarily.

Long-term formats include PDF, EPUB, DOCX, PPTX/PPT, XLSX, TXT, Markdown, images, and other practical formats. Capabilities are format-specific: reading, previewing, editing, conversion, manipulation, metadata, and import/export must not be assumed to be identical.

## Stack

- Tauri 2 desktop shell and native boundary
- React 19 and TypeScript frontend
- Vite frontend tooling
- Rust native/backend implementation
- Bun package manager and scripts
- Existing local conversion tools: Pandoc and Poppler/pdftotext; LibreOffice may be used where available

Desktop/Linux is the immediate environment. Cross-platform interfaces are required from the beginning, but Android/iOS implementations are not yet in scope.

## Current implementation state

Clio has a persistent SQLite-backed library and reader, in addition to its conversion tools. For the source-grounded implementation state and verification history, consult `docs/status/current.md`; the forward-looking plan lives only in `docs/roadmap.md`.

Current boundaries include PDF.js PDF reading, Foliate.js EPUB reading, and a text/Markdown reader; SQLite schema v6 stores catalog and reader artifacts, not document bytes or runtime reader tokens. Local conversion, PDF merge, and PDF page extraction are implemented. Do not infer that every registered format has a reader or that all planned features are implemented.

Stage 3 PDF controls and navigation is in progress. Its implemented slices and remaining acceptance checks are recorded in `docs/status/current.md`; preserve active work and do not claim completion. The floating-versus-docked Navigator discrepancy remains unresolved as recorded in `docs/roadmap.md`; do not decide it implicitly.

Legacy research documents are historical snapshots, not current implementation instructions. Read them for preserved findings, then reconcile present claims against source and status.

## Settled architecture decisions

### Shell and engines

Conceptually:

```text
ReaderShell
    |
    +-- ReaderSession (future boundary)
    |
    +-- ReaderEngine
          +-- PdfEngine (PDF.js)
          +-- EpubEngine (foliate-js)
```

`ReaderShell` owns common reader chrome and interaction. Engines own parsing, pagination, resource loading, rendering, geometry, and format-specific navigation. PDF.js and foliate-js implementation details must not spread through the application. Do not create a universal document AST or force PDF and EPUB into an artificial common rendering model.

Readium is research/reference material only and is not a current dependency.

### Domain concepts

Use these concepts as boundaries rather than treating a raw path as universal document identity:

- `DocumentRecord`: logical document metadata and identity.
- `SourceRef`: physical source representation reference.
- `StorageLocator`: portable location/access representation.
- `FormatId`: format identity.
- `ReadingState`: implemented durable reading position and reader state.
- `Locator`: format-aware position within a document; current PDF `pdf-page-text` annotation locators are non-durable, and durable PDF restoration remains approval-gated.
- `Bookmark` and `Annotation`: implemented reader artifacts; visual restoration is format-specific and PDF highlights do not currently restore.
- `ConversionJob`: a possible future job model; do not imply a general job manager exists.

A logical document and its physical source are separate concepts.

### Storage

The implemented desktop catalog is hybrid:

- User-selected library roots and the filesystem are authoritative; roots are explicitly scanned, not watched.
- SQLite schema v6 stores catalog, root attachment, reading state, bookmarks, and annotations; it stores neither document bytes nor runtime reader tokens.
- Mobile managed copies and persisted content-URI/security-scoped access remain deferred.
- Future locator kinds may include managed files, Android content URIs, iOS security-scoped bookmarks, temporary picked files, and external provider references.

Do not implement every locator now. Do not assume Unix paths exist on every target. Keep platform conditions in platform services, not scattered through React.

### Security

Documents are untrusted input, especially EPUB. Preserve restrictive resource boundaries. Do not casually enable arbitrary scripts, external network access, external frames, or unrestricted filesystem access. Prefer scoped resource/session mechanisms over passing arbitrary paths into a document WebView. Security-sensitive changes require review.

### Dependencies

Do not add dependencies automatically. A significant dependency requires a concrete current requirement, compatibility and licensing review, maintenance assessment, bundle/runtime impact assessment, and an explicit boundary decision. Prefer mature libraries and system utilities over new format parsers. Do not copy GPL/AGPL application code into Clio merely because a reference project is useful.

### Conversion
The current conversion workspace invokes local Pandoc/Poppler capabilities and PDF operations. A general `OperationPlanner -> CapabilityRegistry -> JobManager -> format/tool adapter` remains an architectural direction, not an implemented job-management pipeline.

Do not implement a universal all-to-all converter.

## Ownership and coordination

- Frontend agent owns `src/` UI, React, TypeScript, responsive behavior, accessibility, and frontend state.
- Rust/platform agent owns `src-tauri/`, Tauri commands, native filesystem/platform services, persistence infrastructure, dialogs, jobs, and structured native errors.
- Reader agent owns the reader subsystem under `src/reader/` and its reader-specific integration. Reader and frontend work on overlapping reader files must be serialized or assigned to one integration owner.
- Architect agent is read-only by default and owns architectural research, design review, dependency evaluation, and cross-platform/domain/storage analysis.
- Reviewer agent is read-only by default and reports `BLOCKING`, `NON-BLOCKING`, `OBSERVATIONS`, and `RECOMMENDED FIXES`.
- The lead/coordinator owns decomposition, interfaces, integration sequencing, verification, documentation, and final decisions.

Never use Git as synchronization. Parallelize only genuinely independent slices with clear ownership. Before spawning agents, map shared files/contracts. Every implementation agent must skip build/lint/test/format commands until the coordinator runs the relevant checks once after integration.

## Git safety

Never force-push, reset hard, delete branches, remove user files, clean destructively, rewrite history, commit secrets, commit generated output, or commit personal documents. Do not commit or push unless the product owner explicitly requests it. Inspect status and affected files before any history-changing operation.

## Explicitly deferred

Do not spontaneously implement cloud accounts/sync, a server backend, AI/RAG, a plugin marketplace, a universal document AST, a custom document renderer, handwriting, TTS, multi-user collaboration, generic all-to-all conversion, a full office editor, a full PDF/EPUB editor, complex mobile background indexing, multi-window support, conflict resolution, custom dependency injection, an event bus, or an unnecessary state-management framework.

## Current milestone and working method

Stage 3 PDF controls and navigation is in progress. See `docs/status/current.md` for implemented slices, evidence, and remaining acceptance work. `docs/roadmap.md` is the sole forward-looking roadmap. Do not claim Stage 3 acceptance or decide the unresolved floating-versus-docked Navigator discrepancy.

For meaningful work:

1. Understand the actual code, docs, and project context.
2. Classify the work as research, architecture, frontend, Rust/platform, reader, integration, or review.
3. Define affected subsystems, interfaces, dependencies, and verification.
4. Use the appropriate specialist; serialize overlapping ownership.
5. Run targeted builds, tests, smoke checks, and document rendering checks as assigned by the coordinator.
6. Run a read-only reviewer for meaningful or security-sensitive work.
7. Update `docs/status/current.md` and relevant architecture/research documents.
