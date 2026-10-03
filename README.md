# Clio

Clio is a local-first, offline-capable desktop document library and reader built with Tauri 2, React 19, TypeScript, and Rust.

The filesystem remains authoritative; Clio indexes and organizes your documents without taking ownership of file bytes or uploading documents to cloud services.

## Interaction Model

Clio follows a document-first product architecture:

```text
Library → Document → Reading / Contextual Actions
```

- **Library is Home**: The permanent application landing surface. Features a single contextual toolbar, sidebar (Collections & Folders), a Continue shelf for active reading, and the full document catalog in Grid or List presentation.
- **Documents as Objects**: Reading is the primary interaction. Clicking a document enters reading mode with persistent reading position restoration.
- **Contextual Actions**: Format conversion, PDF merging, page extraction, metadata inspection, and collection assignments are contextual actions available from document ellipsis menus, right-click, or the selection action bar.

## Architecture

```text
Clio (src/App.tsx)
├── Library View (src/library/LibraryView.tsx)
│   ├── Contextual Toolbar & Selection Action Bar (src/library/LibraryToolbar.tsx)
│   ├── Sidebar: Collections & Folders (src/library/LibrarySidebar.tsx)
│   ├── Continue Section: Active reading (src/library/ContinueSection.tsx)
│   ├── Presentation: Grid & List (src/library/DocumentGrid.tsx, DocumentList.tsx)
│   ├── Command Architecture & Context Menus (src/commands/documentCommands.tsx)
│   └── Contextual Modals: Properties, Conversion, Collections
└── Reader Surface (src/reader/ReaderShell.tsx)
    ├── Transient compact top bar: ‹ Library · Title · Find · Navigator · Display · ⋯
    ├── Navigator overlay: Contents / Bookmarks / Notes tabs
    ├── Find bar: floating overlay, no document reflow
    ├── Display popover: theme (light/sepia/dark), zoom (PDF), persisted preferences
    ├── Document menu (⋯): capability-filtered commands from documentCommands
    ├── Progress strip: thin bar + page or percentage label
    ├── PDF Engine (PDF.js)
    ├── EPUB Engine (foliate-js)
    └── Plain Text & Markdown Engine (src/reader/TextEngine.tsx)
        │
        ├── Tauri IPC (Rust backend: src-tauri/src/)
        ▼
SQLite Catalog & Native Platform Services (src-tauri/src/storage.rs)
        ├── Documents, Metadata, Thumbnails, Collections
        ├── Reading State, Bookmarks, Annotations
        └── Local Poppler & Pandoc tool adapters (src-tauri/src/conversion.rs)
```

## Supported Formats

- **Reading**: PDF, EPUB, TXT, and Markdown (`.md`).
- **Cataloging & Metadata**: PDF, EPUB, DOCX, ODT, RTF, HTML, Markdown, and TXT.
- **Contextual Tools**:
  - Format conversion via Pandoc & Poppler.
  - PDF Merge via Poppler (`pdfunite`).
  - PDF Page Extraction via Poppler (`pdfseparate`).

## Development

```bash
# Install dependencies
bun install

# Run desktop development shell
bun tauri dev

# Run tests
bun test
cargo test --manifest-path src-tauri/Cargo.toml

# Production build
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Security & Local-First Principles

- Local SQLite storage (`library.sqlite3`) in application data directory.
- Direct filesystem containment: user files remain in their original directories.
- Strict Content Security Policy (CSP) and sandboxing for untrusted EPUB content.
- Zero network dependencies, telemetry, or remote analytics.
