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

The first reader foundation and application-shell milestone is implemented in the main repository. Current application source includes:

- Clio shell navigation with Library, Reader, Tools, and Settings placeholder views.
- `ReaderShell` with navigation, progress, search UI, contents UI, themes, loading/error state, keyboard handling, and responsive layout.
- `PdfEngine` using PDF.js for local PDF loading, canvas rendering, page navigation, zoom, text extraction, and basic search.
- `EpubEngine` using foliate-js and `@zip.js/zip.js` for local EPUB loading, pagination, navigation, TOC, basic search, and themes.
- `ReaderEngineHandle` and format-neutral reader types separating shell behavior from engine implementation.
- `StorageLocator`, `SourceRef`, and `DocumentRecord` concepts with a desktop path-to-bytes adapter.
- Rust `read_document_bytes` in addition to the existing inspection and conversion commands.
- Existing conversion workspace preserved under `src/tools/ConversionWorkspace.tsx`.

This is a read-only reader foundation, not a document library or editor. There is no persistent catalog, SQLite database, filesystem index, durable reading state, bookmarks, annotations, thumbnails, page-level PDF manipulation, or additional office/image reader workflow.

Bootstrap work must not restart, redesign, or extend this reader foundation. Genuine blocking findings must be documented first and fixed only through an explicitly approved follow-up.

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
- `ReadingState`: future durable reading position and reader state.
- `Locator`: format-aware position within a document.
- `Bookmark` and `Annotation`: future reader artifacts.
- `ConversionJob`: future conversion/manipulation job model.

A logical document and its physical source are separate concepts.

### Storage

The eventual storage model is hybrid:

- Desktop: user-selected/watched directories, with the filesystem authoritative.
- Mobile: managed copies or persisted content-URI/security-scoped access where required.
- Future locator kinds may include watched paths, managed files, Android content URIs, iOS security-scoped bookmarks, temporary picked files, and external provider references.

Do not implement every locator now. Do not assume Unix paths exist on every target. Keep platform conditions in platform services, not scattered through React. Do not add a database until library or reading-state requirements justify it.

### Security

Documents are untrusted input, especially EPUB. Preserve restrictive resource boundaries. Do not casually enable arbitrary scripts, external network access, external frames, or unrestricted filesystem access. Prefer scoped resource/session mechanisms over passing arbitrary paths into a document WebView. Security-sensitive changes require review.

### Dependencies

Do not add dependencies automatically. A significant dependency requires a concrete current requirement, compatibility and licensing review, maintenance assessment, bundle/runtime impact assessment, and an explicit boundary decision. Prefer mature libraries and system utilities over new format parsers. Do not copy GPL/AGPL application code into Clio merely because a reference project is useful.

### Conversion

Conversion is a capability, not the center of the architecture. Existing Pandoc/Poppler behavior must remain functional. The eventual direction is:

```text
OperationPlanner -> CapabilityRegistry -> JobManager -> format/tool adapter
```

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

The reader foundation plus application shell is complete. The reader hardening investigation is complete and recorded in `docs/research/reader-hardening-investigation.md`. No hardening implementation has started. Storage/library implementation remains explicitly blocked until the reader byte/security/lifecycle boundaries are settled.

For future meaningful features:

1. Understand the actual code, docs, Git state, and project context.
2. Classify the work as research, architecture, frontend, Rust/platform, reader, integration, or review.
3. Define affected subsystems, interfaces, dependencies, and verification.
4. Use the appropriate specialist; serialize overlapping ownership.
5. Run targeted builds, tests, smoke checks, and document rendering checks.
6. Run a read-only reviewer for meaningful or security-sensitive work.
7. Update `docs/status/current.md` and relevant architecture/research documents.

The single recommended next milestone is reader hardening implementation: EPUB containment and lifecycle correctness, native file-read authorization, measured byte transport handling, PDF loading-task cleanup, and basic local PDF outline/TOC support. Do not begin storage, indexing, catalog, or database work before this milestone is complete and reviewed.
