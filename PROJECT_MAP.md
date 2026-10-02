# Project Map

This is a source-oriented guide to Clio's application architecture. The project is a Tauri 2 desktop application with a React 19/TypeScript frontend and a Rust native backend backed by SQLite.

## Core Interaction Flow

```text
Library → Document → Reading / Contextual Actions
```

1. **Library Home**: The default landing surface. Contains:
   - Single contextual toolbar (`src/library/LibraryToolbar.tsx`): handles sidebar toggle, scope title/breadcrumb, catalog search, presentation toggle (Grid/List), and switches to the Selection Action Bar when documents are selected.
   - Collapsible sidebar (`src/library/LibrarySidebar.tsx`): manages flat Collections and hierarchical Folders derived from library roots.
   - Continue section (`src/library/ContinueSection.tsx`): displays the top ~6 started reading items with reading progress bars.
   - Full catalog presentation (`src/library/DocumentGrid.tsx` and `DocumentList.tsx`): handles distinct selection and activation models.
2. **Document Reading**:
   - Clicking a document navigates to the document reading route (`src/reader/ReaderShell.tsx`).
   - The reading surface fills the viewport, restoring the exact last-read position (PDF page, EPUB CFI, TextScroll progression).
   - Back button returns to the previous Library state, restoring scope, scroll position, search query, and selection.
3. **Contextual Document Actions**:
   - Ellipsis and context menus (`src/library/DocumentContextMenu.tsx` and `src/commands/documentCommands.ts`) provide contextual actions: Open, Add to collection, Convert…, Extract pages…, Reveal in file manager, Properties, and Remove from library.

## Frontend Subsystems (`src/`)

- `src/App.tsx`: Top-level application shell, routing state (`AppRoute`), restoration stack, and native window bridge.
- `src/navigation/navigation.ts`: Route definitions (`AppRoute`, `LibraryScope`, `LibraryRestorationState`, `DEFAULT_LIBRARY_SCOPE`).
- `src/commands/documentCommands.ts`: Unified command architecture for document actions across context menus and action bars.
- `src/library/`: Library components, filtering (`libraryFilter.ts`), thumbnail generation, properties modal, and collection modals.
- `src/reader/`:
  - `ReaderShell.tsx`: Unified reader chrome, toolbar, zoom, search, TOC, bookmarks, and annotations.
  - `PdfEngine.tsx`: PDF.js-backed rendering and navigation.
  - `EpubEngine.tsx`: foliate-js-backed pagination, themes, and highlight overlays.
  - `TextEngine.tsx`: Plain text and Markdown reader with heading TOC extraction and TextScroll progression.
  - `readingState.ts`: Debounced reading state coordinator.
- `src/tools/`:
  - `ConversionWorkspace.tsx`: Local conversion, PDF merge, and PDF page extraction tool workspace.
- `src/storage/`:
  - `domain.ts`: Core data types (`DocumentRecord`, `SourceRef`, `StorageLocator`, `ReadingPosition`, `Bookmark`, `Annotation`, `Collection`).
  - `documentStorage.ts`: Tauri IPC client adapter for SQLite catalog operations.

## Backend Subsystems (`src-tauri/`)

- `src-tauri/src/main.rs`: Native desktop launcher.
- `src-tauri/src/lib.rs`: Tauri command registration, plugin initialization, and native IPC boundary.
- `src-tauri/src/storage.rs`: SQLite database (`LibraryDb`), migrations, scanning, reading-state persistence, collections, bookmarks, annotations, thumbnails, and canonical path resolution.
- `src-tauri/src/conversion.rs`: Capability registry, Pandoc and Poppler tool execution, overwrite policies, and PDF manipulation (merge & extraction).

## Key Commands

```bash
bun test                                     # Run frontend test suite
bun run build                                # TypeScript typecheck and Vite build
cargo test --manifest-path src-tauri/Cargo.toml   # Run native backend tests
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```
