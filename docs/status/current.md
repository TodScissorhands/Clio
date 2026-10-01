# Clio Current Status

## Complete

- Tauri 2 + React 19 + TypeScript + Vite + Rust application shell.
- Native document open/save dialogs and existing local conversion workspace.
- Rust inspection and conversion commands using local Poppler/pdftotext and Pandoc.
- Read-only PDF reader foundation using PDF.js.
- Read-only EPUB reader foundation using foliate-js and `@zip.js/zip.js`.
- Reader shell with page navigation, progress, search controls, EPUB contents, themes, keyboard handling, loading/error states, and responsive layout.
- `ReaderEngineHandle` boundary separating shell behavior from PDF/EPUB adapters.
- `DocumentRecord`, `SourceRef`, and `StorageLocator` domain boundary for reader/storage integration.
- Restrictive EPUB resource loading/CSP and external-link blocking.
- Storage Core foundation: Rust rusqlite-backed SQLite catalog (`library.sqlite3`) with schema v1 migrations (`library_roots`, `documents`, `reading_state`) and schema v2 migrations (`bookmarks`, `annotations`).
- Explicit deterministic desktop library scanner supporting supported formats, format normalization (.htm → html), and error tolerance.
- Opaque UUID `DocumentRecord` identity separated from `SourceRef` coordinates and `StorageLocator` runtime tokens.
- Native command surface (`library_root_add`, `library_root_list`, `library_root_remove`, `library_root_scan`, `library_document_list`, `library_document_open`, `reader_open_selected`, `reading_state_get`, `reading_state_set`, `bookmark_create`, `bookmark_list`, `bookmark_delete`, `annotation_create`, `annotation_list`, `annotation_delete`).
- Reader ↔ Reading State integration: persistent PDF page and EPUB CFI restoration, debounced position saving, and lifecycle flushing on document replacement or reader close.
- Library UX milestone: polished, responsive, document-oriented Library interface with client-side title and path search, format filtering (All/PDF/EPUB/Other), multi-field sorting (Recently opened, Name, Size, Format), reading progress indicators, and available/missing status distinctions.
- Reader Feature Polish (Pass 1): match navigation (next/prev) with query cancellation for PDF and EPUB, PDF HiDPI rendering with devicePixelRatio backing and crisp logical CSS dimensions, PDF zoom controls in toolbar (- / 100% reset / +) with keyboard shortcuts, safe nested TOC resolution, and clamped EPUB progression.
- **Bookmarks and Annotation Foundation (Pass 2):** SQLite schema v2 with `bookmarks` and `annotations` tables (cascade deletes, FK constraints, input validation); `BookmarkDto` / `AnnotationDto` / `ReadingPosition` Rust types with serde; `create_bookmark`, `list_bookmarks`, `delete_bookmark`, `create_annotation`, `list_annotations`, `delete_annotation` Tauri commands; `Bookmark`, `Annotation`, `AnnotationKind` TypeScript types; `isSameReadingPosition` position matcher; `createBookmark`, `listBookmarks`, `deleteBookmark`, `createAnnotation`, `listAnnotations`, `deleteAnnotation` frontend API functions; `ReaderShell` integration: per-document bookmark load on document open, toggle (create/delete at current position), bookmarks panel with jump and per-item delete. `goToPosition` navigation in `PdfEngine` and `EpubEngine`.
- **Annotation Interaction Pass 3A — Selection + Locator Foundation:** `AnnotationLocator` union type (`epub-cfi-range` | `pdf-page-text`) with documented durability properties; `TextSelection` format-neutral boundary type; `validateAnnotationLocator` with runtime null/type guards; `onState` added to `ReaderEngineProps`; `onTextSelection` wired end-to-end through `ReaderEngineProps` → `PdfEngine` (pointer-up selection capture from current page) → `EpubEngine` (selectionchange via Foliate `load` event, `getCFI` range CFI) → `ReaderShell` (`pendingTextSelection` state, cleared on document change, exposed as `data-selection-active` attribute); 32 new tests across 6 describe blocks.
- **Annotation Interaction Pass 3B — Persistent Annotation Creation + Locator:** SQLite schema v3 migration with additive `locator TEXT` nullable column on `annotations`; Rust `AnnotationDto` extended with `locator: Option<String>` and `annotation_create` command accepting optional locator string; TypeScript `Annotation` model extended with `locator?: AnnotationLocator`; `createAnnotation` and `listAnnotations` handling JSON serialization/deserialization with `validateAnnotationLocator` integrity checks; `ReaderShell` toolbar "Annotate" action creating annotations directly from `pendingTextSelection` with document isolation and state clearance; responsive Annotations panel displaying notes/quotes with position jumping via `goToPosition` and deletion support.

## Current work

Pass 3B is complete. Next milestone is external review before Pass 3C (annotation note editing and deeper selection interactions).
- Filesystem/user-controlled sources remain authoritative.
- A raw filesystem path is not universal document identity.
- `DocumentRecord` uses an opaque UUID independent of any raw path.
- `SourceRef` records source coordinates separately from `StorageLocator`, which is a runtime access capability.
- SQLite stores metadata, source coordinates, reading state, bookmarks, and annotation records; it never stores document bytes or reader tokens.
- PDF.js is the PDF engine; foliate-js is the EPUB engine.
- Readium is reference-only and not a dependency.
- Reader shell owns common chrome; engines own parsing/rendering/pagination/resource loading.
- EPUB content is untrusted and keeps restrictive resource/security boundaries.
- Conversion remains a capability and must not define the core architecture.
- Platform-specific storage behavior belongs behind native/platform boundaries.

## Explicitly deferred

Highlight rendering, note editor UI, annotation toolbar redesign, PDF TextLayer (durable PDF locators), full annotation interaction UI, collections, cover caching, watchers, mobile providers, cloud sync, and conversion redesign remain deferred. Storage Core schema and command surface must be updated from the Rust implementation, not treated as a promise of unimplemented APIs.

## Blocked / requires triage

The exact Blob-origin-to-Tauri ACL/native command reachability boundary remains unproven because the packaged hostile EPUB could not be driven or inspected. Treat EPUB sanitization, CSP, and tokenized native reads as defense-in-depth rather than as proof of renderer isolation. An isolated renderer/resource proxy remains the stronger boundary for arbitrary hostile EPUBs.

## Recently verified

Pass 3B (Persistent Annotation Creation + Locator): `bun test` 84/84 pass (6 files; 38 tests in locator suite covering v3 locator serialization, validation, backward compatibility, and document isolation); `bun run build` clean (tsc + Vite); `cargo test` 10/10 pass (schema v3 migration idempotence, CRUD with locator, cascade deletion); `cargo fmt --check` clean; `cargo clippy -- -D warnings` clean.
