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

Run complete repository verification with the canonical check:

```bash
bun run check
```

This runs the frontend and Rust checks through the dedicated scripts:

```bash
bun run check:frontend
bun run check:rust
```

### Frontend checks

Run the individual frontend commands:

```bash
bun run test
bun run build
```

`bun run build` performs the TypeScript static check and creates the Vite output. The project does not configure a separate JavaScript lint tool. `bun run check:frontend` runs both commands.

### Rust checks

Run the individual Rust commands:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

`bun run check:rust` runs the Rust tests, formatting check, and Clippy check.

## Formatting and linting

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

The formatting command updates Rust files; Clippy runs the configured Rust lints. Review their changes and diagnostics before committing.

## Release build

```bash
bun tauri build
```

Builds the packaged Tauri application for the current platform. Release artifacts are generated output and should not be committed.

## Current conversion behavior

The UI asks Rust to inspect the selected path, then invokes the conversion engine when an output path is chosen. PDF text extraction uses Poppler's `pdftotext`; other conversions use Pandoc, with PDFs first reduced to extracted text. See [`README.md`](./README.md) for the current format list and limitations.
