# Project Map

This is a source-oriented guide to the current prototype. The project is a Tauri 2 desktop application with a React/TypeScript frontend and a Rust backend.

## What the project currently does

The implemented flow is:

1. The user chooses a local document through the native file picker.
2. React invokes Rust's `inspect_document` command.
3. The UI displays the filename, extension, size, and extension-based support status.
4. The user chooses an output format and destination.
5. React invokes Rust's `convert_document` command.
6. Rust runs local `pdftotext` and/or `pandoc`, then returns the saved output path and engine name.

There is no reader, filesystem library, catalog, search index, or page-level document manipulation yet.

## How to run it

From the repository root:

```bash
bun install
bun tauri dev
```

The conversion path requires `pandoc` and `pdftotext` to be installed on the host. See [`COMMANDS.md`](./COMMANDS.md) for checks and build commands.

## Frontend

The visible UI is in [`src/App.tsx`](./src/App.tsx). It is one responsive conversion workspace containing:

- a source-document picker and selected-file summary;
- output-format choices;
- a conversion action;
- status and saved-output messages.

[`src/App.css`](./src/App.css) provides the current desktop-oriented visual design and narrow-window layout. [`src/main.tsx`](./src/main.tsx) mounts the React application.

The frontend uses:

- `@tauri-apps/api/core` for `invoke`;
- `@tauri-apps/plugin-dialog` for native open/save dialogs;
- React state for the selected document, target format, status, and output path.

## Backend

[`src-tauri/src/main.rs`](./src-tauri/src/main.rs) is the native launcher. [`src-tauri/src/lib.rs`](./src-tauri/src/lib.rs) contains:

- extension-based document inspection;
- `inspect_document`;
- `convert_document`;
- process execution for `pdftotext` and `pandoc`;
- Tauri plugin initialization and command registration.

The backend does not parse document formats itself. It delegates conversion to locally installed tools. The current PDF path extracts text first, so it does not preserve a PDF's full layout, images, or page structure.

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

The backend recognizes `pdf`, `epub`, `docx`, `odt`, `rtf`, `html`, `htm`, `md`, and `txt` input extensions. The UI offers `pdf`, `epub`, `docx`, `odt`, `html`, `md`, and `txt` outputs. This is a conversion prototype, not a capability guarantee for every source/target pair.

## What is intentionally not here yet

The product direction includes reading, indexing, collections, search, progress, bookmarks, thumbnails, PDF operations, and additional office/image workflows. Those features are planned but should be added through explicit format-specific capabilities rather than assumed from the current generic conversion button.
