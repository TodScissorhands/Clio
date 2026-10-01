# Project Map

This is a source-oriented guide to the current prototype. The project is a Tauri 2 desktop application with a React/TypeScript frontend and a Rust backend.

## What the project currently does

The implemented application has four shell areas:

1. **Library placeholder** — explains the future local library direction.
2. **Reader** — opens local PDF and EPUB files through the native picker and reads them without uploading or copying them to a cloud service.
3. **Tools** — preserves the original conversion flow.
4. **Settings placeholder** — reserves space for local preferences and permissions.

The reader flow is:

1. The user chooses a PDF or EPUB through the native file picker.
2. React invokes Rust's `inspect_document` command.
3. React invokes Rust's `read_document_bytes` command through `StorageLocator`.
4. `ReaderShell` selects the PDF.js or foliate-js engine by format.
5. The engine renders locally and reports progress, search, contents, and loading/error state.

The tools flow remains:

1. The user chooses a local document.
2. React invokes Rust's `inspect_document` command.
3. The UI displays filename, extension, size, and extension-based support status.
4. The user chooses an output format and destination.
5. React invokes Rust's `convert_document` command.
6. Rust runs local `pdftotext` and/or `pandoc`, then returns the saved output path and engine name.

## How to run it

From the repository root:

```bash
bun install
bun tauri dev
```

The conversion path requires `pandoc` and `pdftotext` to be installed on the host. See [`COMMANDS.md`](./COMMANDS.md) for checks and build commands.

## Frontend

The visible shell is in [`src/App.tsx`](./src/App.tsx). It provides:

- navigation for Library, Reader, Tools, and Settings;
- a reader surface in [`src/reader/ReaderShell.tsx`](./src/reader/ReaderShell.tsx);
- the existing conversion workspace in [`src/tools/ConversionWorkspace.tsx`](./src/tools/ConversionWorkspace.tsx);
- placeholders for the future library and settings surfaces.

The reader subsystem contains:

- `ReaderShell.tsx` for common chrome, progress, search, contents, themes, keyboard behavior, and responsive layout;
- `PdfEngine.tsx` for PDF.js loading, canvas rendering, page navigation, zoom, text extraction, and search;
- `EpubEngine.tsx` for foliate-js loading, ZIP resource access, pagination, navigation, TOC, search, themes, and restrictive resource handling;
- `types.ts` for `ReaderEngineHandle`, `DocumentRecord`, `SourceRef`, and `StorageLocator`.

The frontend uses:

- `@tauri-apps/api/core` for `invoke`;
- `@tauri-apps/plugin-dialog` for native open/save dialogs;
- React state for shell, reader, and conversion UI state;
- `StorageLocator` through `TauriDocumentStorage` rather than direct filesystem access in reader components.

## Backend

[`src-tauri/src/main.rs`](./src-tauri/src/main.rs) is the native launcher. [`src-tauri/src/lib.rs`](./src-tauri/src/lib.rs) contains:

- extension-based document inspection;
- `read_document_bytes` for the current desktop reader storage adapter;
- `convert_document`;
- process execution for `pdftotext` and `pandoc`;
- Tauri plugin initialization and command registration.

The backend does not parse document formats itself. It delegates conversion to locally installed tools. The current PDF conversion path extracts text first, so it does not preserve a PDF's full layout, images, or page structure.

## Configuration

| File | Purpose |
| --- | --- |
| [`package.json`](./package.json) | Bun scripts and frontend dependencies |
| [`bun.lock`](./bun.lock) | Locked JavaScript dependency graph |
| [`vite.config.ts`](./vite.config.ts) | Vite and Tauri development-server settings |
| [`tsconfig.json`](./tsconfig.json) | TypeScript compiler settings for `src/` |
| [`src-tauri/Cargo.toml`](./src-tauri/Cargo.toml) | Rust package and Tauri dependencies |
| [`src-tauri/Cargo.lock`](./src-tauri/Cargo.lock) | Locked Rust dependency graph |
| [`src-tauri/tauri.conf.json`](./src-tauri/tauri.conf.json) | Window, build, and bundle configuration |
| [`src-tauri/capabilities/default.json`](./src-tauri/capabilities/default.json) | Permissions for the main window |
| [`src-tauri/icons/`](./src-tauri/icons/) | Desktop and platform bundle icons |

## Current format boundary

The reader currently opens `pdf` and `epub`. PDF uses PDF.js; EPUB uses foliate-js with `@zip.js/zip.js`.

The conversion backend recognizes `pdf`, `epub`, `docx`, `odt`, `rtf`, `html`, `htm`, `md`, and `txt` input extensions. The UI offers `pdf`, `epub`, `docx`, `odt`, `html`, `md`, and `txt` outputs. This is a conversion prototype, not a capability guarantee for every source/target pair.

## What is intentionally not here yet

The product direction includes reading, indexing, collections, search, progress, bookmarks, thumbnails, PDF operations, and additional office/image workflows. The reader foundation is now present, but library indexing, persistence, durable reading state, annotations, and page-level manipulation remain planned. Add them through explicit format-specific and storage-aware capabilities rather than assuming they follow from the current reader or generic conversion command.
