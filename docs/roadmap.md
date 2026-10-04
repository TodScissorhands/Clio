# Clio Roadmap

This roadmap is intentionally staged. It describes direction, not promises to implement every listed capability immediately.

1. **Reader foundation — implemented**
   - Application shell, PDF.js PDF reader, foliate-js EPUB reader, local byte loading, navigation, search foundations, EPUB TOC, themes, responsive behavior, conversion workspace separation, and tokenized native reader opening.
   - The packaged hostile EPUB could not be driven or inspected. Blob-origin Tauri ACL/native command reachability remains unproven; sanitization and CSP are defense-in-depth.
2. **Storage Core & Library UX — implemented**
   - Rust-owned SQLite metadata catalog (`library.sqlite3`), explicit desktop library roots and scans, opaque UUID `DocumentRecord` identity, separate `SourceRef` and runtime `StorageLocator` boundaries, tokenized reader opening, and durable reading state.
   - Responsive Library interface with client-side search across title and relative path, format filtering, sorting, reading progress, and available/missing document states. Collections support nested folders and assignment/removal workflows.
   - Library visual refinement uses locally vendored shadcn/ui source components, Radix UI primitives, Tailwind CSS 4 utilities and Clio tokens; the shadcn CLI is not a runtime dependency.
3. **Reader polish (Pass 1) — implemented**
   - Search match navigation (next/previous with wrap-around), match count badges, query cancellation tokens, and document isolation across PDF and EPUB.
   - PDF HiDPI canvas backing scaling with `devicePixelRatio`, render task cancellation, zoom toolbar controls (`-`, reset to 100%, `+`), and keyboard shortcuts (`Ctrl+F`, `Ctrl+=`, `Ctrl+-`, `Ctrl+0`).
   - Safe nested outline resolution for PDF, recursive TOC for EPUB, and strict `[0.0, 1.0]` progression clamping.
4. **Bookmarks and annotation foundation (Pass 2) — implemented**
   - SQLite schema v2: `bookmarks` and `annotations` tables with FK cascade deletes, input validation (page ≥ 1, non-empty CFI, progression in `[0.0, 1.0]`, known document ID, non-empty kind), and deterministic ordering by `(created_at, id)`.
   - Rust `BookmarkDto`, `AnnotationDto`, `ReadingPosition` types with full serde serialization; six new Tauri commands (`bookmark_create`, `bookmark_list`, `bookmark_delete`, `annotation_create`, `annotation_list`, `annotation_delete`).
   - TypeScript `Bookmark`, `Annotation`, `AnnotationKind` types; `isSameReadingPosition` position matcher; six frontend API functions.
   - `ReaderShell` integration: per-document bookmark load on open, toolbar toggle (create/delete at current position), count badge (`Bookmarks (N)`), bookmarks panel with per-item jump and delete. `goToPosition` navigation in `PdfEngine` (PDF.js page load) and `EpubEngine` (foliate-js CFI `goTo`).
   - v1→v2 migration path preserves existing catalog data. Annotation editing UI, highlight rendering, and text selection are deferred.
5. **Annotation interaction Pass 3A — Selection + Locator Foundation — implemented**
   - `AnnotationLocator` union type: `epub-cfi-range` (CFI range string from foliate-js `getCFI`) and `pdf-page-text` (page + selected text; explicitly documented as non-durable pending TextLayer).
   - `TextSelection` format-neutral boundary type; no DOM objects, Blob URLs, or iframe references cross the boundary.
   - `validateAnnotationLocator` with runtime null/type guards for robustness against JSON.parse payloads.
   - `onState` added to `ReaderEngineProps` (was missing from the type, causing pre-existing TS errors now fixed).
   - `onTextSelection` wired end-to-end: `PdfEngine` (pointer-up, `window.getSelection`, page-scoped), `EpubEngine` (selectionchange via Foliate `load` event, `getCFI` range validation), `ReaderShell` (`pendingTextSelection` state, cleared on document change, `data-selection-active` attribute).
   - 32 new tests: validation, JSON round-trip, PDF/EPUB TextSelection shape, document isolation, malformed/null inputs.
   - **Known limitation:** PDF locator is `pdf-page-text` only. Highlight restoration requires a future TextLayer milestone. Cross-page PDF selections are not representable.
6. **Annotation interaction Pass 3B — Persistent Annotation Creation + Locator — implemented**
   - SQLite schema v3 migration: additive `locator TEXT` column on `annotations` table; legacy rows default to `NULL`.
   - Rust `AnnotationDto.locator: Option<String>` storing serialized JSON locator; `annotation_create` command accepting optional locator string.
   - TypeScript `Annotation.locator?: AnnotationLocator` integrated with `createAnnotation` and `listAnnotations` using JSON serialization and `validateAnnotationLocator` validation.
   - ReaderShell UI: contextual "Annotate" toolbar button active when `pendingTextSelection` is present; creates highlight annotation and clears selection.
   - Annotations panel: listing per-document notes/highlights, jumping to position via `goToPosition`, and deleting annotations with cascade/storage sync.
   - Complete test suite: 10/10 Rust tests, 84/84 Bun tests.
7. **Annotation interaction Pass 3C — Annotation Interaction + Highlight UX — implemented**
   - Annotation note/memo editing: Rust `update_annotation` storage API, `annotation_update` Tauri command, and `updateAnnotation` frontend API. Allows attaching notes on creation and editing/clearing existing notes while preserving immutable identity, locators, and positions.
   - EPUB highlight rendering: Foliate `Overlayer` integration via `foliate-js/overlayer.js` rendering translucent highlights from persisted `epub-cfi-range` locators. Synchronizes highlights across chapter/section pagination and annotation updates; handles stale/malformed CFIs safely without crashes.
   - Annotations panel UX: Inline note editor with Save / Cancel; loading indicator during async retrieval; visual active indicator (`current`) for annotations matching current reading position; error-resilient delete and jump navigation.
   - Persistence error handling: Creation, update, and deletion failures surface clear reader error notifications via `onState("error", ...)` instead of silently swallowing in empty catch blocks, preserving user selection and input state.
   - PDF Text-Layer investigation: Evaluated PDF.js `TextLayer` integration in `PdfEngine`. Documented that full TextLayer overlay requires scale-factor transform synchronization and font-loading lifecycle coordination; preserved existing non-durable `pdf-page-text` locator without claiming fake durability or destabilizing canvas rendering.
8. **Conversion and manipulation improvements**
   - **8A. Conversion capability architecture — implemented**: Typed capability registry (`ConversionCapability`, `CapabilityRegistry`), planned job model (`ConversionJob`), safe path validation (canonical equality, directory permissions), unique UUID temporary file guards (`TempFileGuard`), and `ConversionWorkspace` UI dynamically consuming capabilities and executing planned jobs. Safe PDF operations investigated (`pdfunite`, `pdfseparate`, `lopdf`).
   - **8B. Safe PDF operations (PDF Merge) — implemented**: Safe native multi-source PDF merge via Poppler `pdfunite` using structured command invocation, `OperationKind::MergePdf` capability, multi-source `ConversionJob` planning, strict validation (minimum-2, canonical comparison, duplicate/collision rejection), and compact Tools UI workflow with deterministic reordering and removal.
   - **8C. PDF page manipulation (Page Extraction & Split)**: Page range extraction via Poppler `pdfseparate` within the capability/job architecture.
9. **Additional document formats**
   - Add mature local rendering/preview paths for text, Markdown, DOCX, presentations, spreadsheets, and images according to capability rather than a universal model.
10. **Cross-platform/mobile implementation**
    - Implement managed copies, content URIs, security-scoped resources, and mobile-specific indexing only when target requirements are concrete.
11. **Packaging and long-term polish**
    - Dependency detection, installer/runtime diagnostics, offline/privacy guarantees, accessibility, and performance hardening.

Storage Core intentionally excludes filesystem watchers, mobile providers, cloud services, and conversion redesign. It stores collections, bookmarks, annotations, reading state, metadata, and source coordinates, but not document bytes or reader tokens. Its schema and command surface must be updated from the Rust implementation rather than treated as a promise of unimplemented APIs.
