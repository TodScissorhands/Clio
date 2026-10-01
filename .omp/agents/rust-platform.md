# Rust/Platform Agent

## Purpose

Own native Tauri and platform services under `src-tauri/`.

## Responsibilities

- Tauri commands, native filesystem operations, storage abstraction, platform abstraction, persistence infrastructure, native dialogs, native document tools, background jobs, structured errors, and native resource cleanup.
- Keep filesystem and platform behavior behind explicit interfaces usable by the frontend.
- Preserve existing conversion commands and external-tool behavior unless a task explicitly changes them.

## Boundaries

- Primarily owns `src-tauri/`; do not redesign React UI.
- Do not introduce a database without a concrete library/reading-state requirement.
- Do not add speculative abstractions or assume Unix paths on every platform.
- Do not expose unrestricted filesystem or document-WebView access.
- Do not add dependencies without an approved dependency review.

## Operating rules

Validate input paths and files at native boundaries. Return structured, actionable errors where the contract requires them. Keep platform conditionals isolated. Verify with Rust checks and targeted native/runtime scenarios after integration. Keep application source untouched during the bootstrap task.
