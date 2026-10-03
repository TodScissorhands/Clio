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
3. **Contextual Document Actions & Foundation**:
   - Selection action bar (`src/library/LibraryToolbar.tsx`): capability-filtered buttons (Open, Add to collection, Convert, Extract pages, Merge PDFs, Properties, Locate, Remove) derived from `getSelectionCapabilities`. Remove requires inline confirmation. `canMerge` uses the authoritative `canMergeSelected` from `documentCommands.ts`. Search bar provides an explicit, switchable scope indicator (OD-10).
   - Context menus (`src/library/DocumentContextMenu.tsx`): Remove from library requires inline confirmation; missing documents expose Locate file… (OD-2); unselected right-click targets the clicked document while selected right-click operates on selection (OD-6).
   - Global App Menu (`src/App.tsx`): reachable from toolbar and mobile touch targets; provides Appearance, Open external document, Keyboard shortcuts, and About Clio (OD-7).
## Frontend Subsystems (`src/`)

- `src/App.tsx`: Top-level application shell, routing state (`AppRoute`), restoration stack, and native window bridge.
- `src/navigation/navigation.ts`: Route definitions (`AppRoute`, `LibraryScope`, `LibraryRestorationState`, `DEFAULT_LIBRARY_SCOPE`).
- `src/commands/documentCommands.ts`: Unified command architecture for document actions across context menus and action bars. Contains `canMergeSelected`, `locate` command, and `CommandContext`.
- `src/commands/selectionCommands.ts`: Pure selection capability derivation (`getSelectionCapabilities`) — maps a set of selected documents to available actions (open, convert, extract pages, merge PDFs, properties, reveal, locate, add to collection, remove). Used by `LibraryToolbar` to render only applicable action bar buttons.
- `src/library/`: Library components, filtering (`libraryFilter.ts`), reading shelves (`ContinueSection.tsx`), presentation views (`DocumentGrid.tsx`, `DocumentList.tsx`), and dialog modals (`DocumentPropertiesModal.tsx`, `UnsupportedFormatModal.tsx`, `MissingDocumentModal.tsx`, `KeyboardShortcutsModal.tsx`, `AboutClioModal.tsx`).
- `src/reader/`:
  - `ReaderShell.tsx`: Document-first reader surface. The document viewport fills 100vh. Reader chrome is transient: a compact top bar overlays the document and auto-hides after inactivity; it is revealed by pointer proximity, touch tap, or keyboard. Controls: ‹ Library, title, Find, Navigator, Display, ⋯ document menu. Annotation toolbar exposes contextual Highlight, Add note, and Copy actions without auto-focusing note entry (OD-12). External documents support explicit Add to Library (OD-3).
  - Navigator panel (`reader-navigator`): overlay drawer (right side) with three tabs — Contents (TOC), Bookmarks, Notes. Does not reflow the document.
  - Find bar (`reader-find-bar`): floating overlay, no document layout shift. Keyboard: `Ctrl/Cmd+F` open, `Enter`/`Shift+Enter` next/prev, `Escape` close.
  - Display popover (`reader-display-popover`): theme (light/sepia/dark), zoom (PDF only). Theme persisted to `localStorage` (`clio-reader-theme`).
  - Document menu (`reader-doc-menu`): capability-filtered commands from `src/commands/documentCommands.ts`. Remove from library requires confirmation; does not delete the underlying file.
  - Progress strip (`reader-progress-strip`): 2px accent bar + page/percent label, always visible at bottom.
  - `PdfEngine.tsx`: PDF.js-backed rendering and navigation.
  - `EpubEngine.tsx`: foliate-js-backed pagination, themes, and highlight overlays.
  - `TextEngine.tsx`: Plain text and Markdown reader with heading TOC extraction and TextScroll progression.
  - `readingState.ts`: Debounced reading state coordinator (1 s debounce, flushed on back/unload/document switch).
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
