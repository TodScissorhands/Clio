# Commands

Run these commands from the repository root. The project uses Bun for the frontend and Cargo for the Rust backend.

## Install dependencies

```bash
bun install
```

JavaScript dependencies are installed from `package.json` and `bun.lock`. Rust dependencies are resolved by Cargo from `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`.

The conversion path also requires these system commands:

```bash
pandoc --version
pdftotext -v
```

## Development

```bash
bun tauri dev
```

Starts Vite and opens the Tauri desktop window. Close the window, then press `Ctrl+C` in the terminal if the development process remains active.

To run only the frontend in a browser:

```bash
bun run dev
```

## Checks

```bash
bun run build
cargo check --manifest-path src-tauri/Cargo.toml
```

`bun run build` type-checks TypeScript and creates the Vite output in `dist/`. `cargo check` validates the Rust/Tauri backend.

## Formatting and linting

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
```

These commands format Rust and run additional Rust lints. Review their changes and diagnostics before committing.

## Release build

```bash
bun tauri build
```

Builds the packaged Tauri application for the current platform. Release artifacts are generated output and should not be committed.

## Current conversion behavior

The UI asks Rust to inspect the selected path, then invokes the conversion engine when an output path is chosen. PDF text extraction uses Poppler's `pdftotext`; other conversions use Pandoc, with PDFs first reduced to extracted text. See [`README.md`](./README.md) for the current format list and limitations.
