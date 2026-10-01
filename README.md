# Clio

Clio is an early-stage local-first desktop document workbench built with Tauri, React, TypeScript, and Rust. It currently focuses on selecting a local document, inspecting its basic metadata, and converting it with locally installed command-line tools.

The project is intentionally not a full document reader or library manager yet. The filesystem remains the source of truth; the application does not upload or copy documents into a cloud service.

## Current status

Implemented:

- Native file selection and save dialogs.
- Basic inspection of a selected file: path, filename, extension, size, and extension-based support status.
- Conversion requests from the React UI to Rust through Tauri commands.
- Local conversion using Poppler's `pdftotext` and Pandoc.
- A responsive single-screen conversion UI with status and output-path feedback.

Not implemented yet:

- A document library, indexing, collections, search, or metadata database.
- PDF or EPUB reading and rendering.
- Page-level PDF manipulation.
- Reading progress, bookmarks, thumbnails, or keyboard navigation.
- DOCX, PPTX, XLSX, image, or spreadsheet-specific workflows.
- Bundled conversion engines; Pandoc and Poppler are external system dependencies.

This is a prototype baseline, not a feature-complete release.

## Supported formats in the current prototype

The backend recognizes these input extensions:

`pdf`, `epub`, `docx`, `odt`, `rtf`, `html`, `htm`, `md`, and `txt`.

The UI offers these output formats:

`pdf`, `epub`, `docx`, `odt`, `html`, `md`, and `txt`.

Support is currently based on the filename extension, not deep format validation. The backend uses:

- `pdftotext` for PDF to plain-text conversion.
- `pdftotext` followed by Pandoc for other PDF output targets.
- Pandoc for non-PDF inputs.

Pandoc's installed version and the source/target combination determine whether a particular conversion succeeds. The current UI does not expose a per-format capability matrix.

## Architecture

```text
React + TypeScript (src/)
        │ Tauri invoke()
        ▼
Rust commands (src-tauri/src/lib.rs)
        │
        ├── native file dialogs through Tauri plugins
        └── local pdftotext / pandoc processes
```

- `src/App.tsx` contains the current screen and user flow.
- `src/App.css` contains the current visual design and responsive layout.
- `src-tauri/src/lib.rs` exposes `inspect_document` and `convert_document`.
- `src-tauri/tauri.conf.json` configures the desktop window and packaging.
- `src-tauri/capabilities/default.json` grants the current window's Tauri permissions.

## Development setup

### Prerequisites

- [Bun](https://bun.sh/)
- Rust and Cargo
- Tauri's platform prerequisites for your operating system
- [Pandoc](https://pandoc.org/)
- Poppler's `pdftotext` command

Pandoc and Poppler are only used locally. They are not JavaScript or Rust package dependencies and are not bundled by this repository.

### Install and run

From the repository root:

```bash
bun install
bun tauri dev
```

The Vite frontend alone can be started with:

```bash
bun run dev
```

### Checks and builds

```bash
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
bun tauri build
```

See [`COMMANDS.md`](./COMMANDS.md) for the command reference and [`PROJECT_MAP.md`](./PROJECT_MAP.md) for a source-oriented guide.

## Repository hygiene

The repository contains source code, configuration, documentation, lockfiles, and application icons. It must not contain personal documents, a local document library, local databases, secrets, dependency directories, or generated build output. Root `.gitignore` and `src-tauri/.gitignore` cover the project's current generated and local-only paths.

## Direction

The intended product is a lightweight filesystem-oriented reader and document utility. Planned work is staged rather than treated as one large feature:

1. Establish a reliable conversion foundation with explicit per-format capabilities and tests.
2. Add a read-only document surface, starting with formats that have mature local rendering options.
3. Add opt-in filesystem indexing, search, collections, recent files, favorites, and reading state without taking ownership of files.
4. Add safe PDF operations and format-specific import/export workflows.
5. Harden packaging, dependency detection, accessibility, keyboard behavior, and offline/local privacy guarantees.

Complex formats should continue to use mature libraries or system utilities instead of new parsers where practical.

## License

No license has been selected for this project yet.
