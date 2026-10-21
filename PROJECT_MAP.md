# Project Map

This is a source-oriented guide to Clio's application architecture. Clio is a Tauri 2 desktop application with a React 19/TypeScript frontend and a Rust native backend using SQLite schema v6. For the current implementation state and reported verification, see [Current Status](docs/status/current.md); [Roadmap](docs/roadmap.md) is the sole forward-looking plan.

## Core Interaction Flow

```text
Library → Document → Reading / Contextual Actions
```

1. **Library Home**: Catalog views (`src/library/DocumentGrid.tsx`, `DocumentList.tsx`), collections/folder navigation (`LibrarySidebar.tsx`), Continue Reading (`ContinueSection.tsx`), search, selection, and contextual actions.
2. **Document Reading**:
   - Clicking a document navigates to the reader route (`src/reader/ReaderShell.tsx`).
   - Reading positions are persisted for PDF, EPUB, and text/Markdown formats.
   - Returning to Library restores navigation context; consult source for the current restoration state.
3. **Contextual Document Actions**: Selection actions and context menus are capability-driven. Removal from the library does not delete the underlying file.

## Frontend Subsystems (`src/`)

- `src/App.tsx`: Top-level application shell, routing state (`AppRoute`), restoration stack, and native window bridge.
- `src/navigation/navigation.ts`: Route definitions (`AppRoute`, `LibraryScope`, `LibraryRestorationState`, `DEFAULT_LIBRARY_SCOPE`).
- `src/commands/documentCommands.ts`: Unified command architecture for document actions across context menus and action bars. Contains `canMergeSelected`, `locate` command, and `CommandContext`.
- `src/commands/selectionCommands.ts`: Pure selection capability derivation (`getSelectionCapabilities`) — maps a set of selected documents to available actions (open, convert, extract pages, merge PDFs, properties, reveal, locate, add to collection, remove). Used by `LibraryToolbar` to render only applicable action bar buttons.
- `src/library/`: Library components, filtering (`libraryFilter.ts`), reading shelves (`ContinueSection.tsx`), presentation views (`DocumentGrid.tsx`, `DocumentList.tsx`), and dialog modals (`DocumentPropertiesModal.tsx`, `UnsupportedFormatModal.tsx`, `MissingDocumentModal.tsx`, `KeyboardShortcutsModal.tsx`, `AboutClioModal.tsx`).
- `src/reader/`:
  - `ReaderShell.tsx`: Document-first reader surface with reader chrome, Find, Navigator, Display, document menu, and annotation interactions.
  - Navigator panel (`reader-navigator`): Contents, Bookmarks, and Notes. Current Stage 3 implementation docks the Navigator; the design contract calls for a floating non-dimming overlay. This discrepancy is unresolved; see [Roadmap](docs/roadmap.md).
  - Find bar (`reader-find-bar`): floating overlay, no document layout shift. Keyboard: `Ctrl/Cmd+F` open, `Enter`/`Shift+Enter` next/prev, `Escape` close.
  - `reader-display-popover`: reader display controls. PDF controls include zoom and Stage 3 page-entry/fit modes; consult source and status for exact current behavior.
  - Document menu (`reader-doc-menu`): capability-filtered commands from `src/commands/documentCommands.ts`. Remove from library requires confirmation; does not delete the underlying file.
  - `reader-progress-strip`: reader progress presentation; transient-control behavior is under active Stage 3 work.
  - `PdfEngine.tsx`: PDF.js-backed rendering and navigation.
  - `EpubEngine.tsx`: foliate-js-backed pagination, themes, and highlight overlays.
  - `TextEngine.tsx`: Plain text and Markdown reader with heading TOC extraction and TextScroll progression.
  - `readingState.ts`: Debounced reading-state coordinator, flushed on reader exit/document switch.
- `src/tools/`:
  - `ConversionWorkspace.tsx`: Local conversion, PDF merge, and PDF page extraction tool workspace.
- `src/storage/`: frontend domain types and the Tauri IPC adapter for SQLite catalog operations.

## Backend Subsystems (`src-tauri/`)

- `src-tauri/src/main.rs`: Native desktop launcher.
- `src-tauri/src/lib.rs`: Tauri command registration, plugin initialization, and native IPC boundary.
- `src-tauri/src/storage.rs` and `src-tauri/src/storage/`: SQLite catalog (`LibraryDb`), schema v6 migrations, scanning, reading-state persistence, collections, bookmarks, annotations, thumbnails, and path resolution.
- `src-tauri/src/conversion.rs`: Capability registry, Pandoc and Poppler tool execution, overwrite policies, and PDF manipulation (merge and page extraction).

## Key Commands

```bash
bun test                                     # Run frontend test suite
bun run build                                # TypeScript typecheck and Vite build
cargo test --manifest-path src-tauri/Cargo.toml   # Run native backend tests
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

Stage 3 PDF reader controls and navigation is in progress. Its bounded thumbnail, page-entry, and fit-mode slices are implemented, but acceptance is incomplete; see [Current Status](docs/status/current.md). The Navigator placement discrepancy remains unresolved. Do not use this map or historical research as an alternate plan.
