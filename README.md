# Clio

Clio is a local-first, offline-capable desktop document library and reader built with Tauri 2, React 19, TypeScript, and Rust. Your filesystem remains authoritative: Clio catalogs and reads documents from user-selected locations without taking ownership of their files or requiring an account or hosted processing service.

## Core capabilities

- Organize documents in a local library with folders, collections, search, sorting, and grid or list views.
- Read PDF, EPUB, TXT, and Markdown documents with navigation, search, themes, and persisted reading position.
- Inspect metadata and use local conversion and PDF tools where supported.
- Keep catalog and reading data locally; document bytes stay in their original locations.

## Architecture

```text
React 19 / TypeScript UI (shadcn/ui source components, Tailwind CSS 4)
        │ Tauri commands
        ▼
Rust services ── SQLite metadata catalog
        │
        ├── PDF.js / foliate-js / text reader
        └── local Pandoc / Poppler tools
```

The filesystem is the source of document bytes. SQLite stores catalog metadata, library roots, collections, reading state, bookmarks, and annotations. See [Storage Architecture](docs/architecture/storage.md), [Reader Architecture](docs/architecture/reader-foundation.md), [Current Status](docs/status/current.md), and the [Roadmap](docs/roadmap.md) for implementation details and boundaries.

## Development

Install dependencies and start the desktop app:

```bash
bun install
bun tauri dev
```

Run the frontend suite and production build:

```bash
bun test
bun run build
```

Run the Rust tests and checks:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

See [COMMANDS.md](COMMANDS.md) for additional development commands. Reader hardening findings and their validation limits are recorded in the [investigation](docs/research/reader-hardening-investigation.md).
