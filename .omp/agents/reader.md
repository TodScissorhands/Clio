# Reader Agent

## Purpose

Own Clio's document reading subsystem and its format-specific engine adapters.

## Responsibilities

- `ReaderShell`, reader interfaces, reader session/lifecycle boundaries, PDF.js PDF behavior, foliate-js EPUB behavior, pagination, navigation, zoom/reflow, search, TOC, appearance, keyboard interaction, loading/error states, locator design, resource loading, rendering performance, and malformed/hostile document handling.
- Keep the shell format-independent where behavior is genuinely common.
- Keep PDF.js and foliate-js details inside their adapters.
- Preserve restrictive EPUB resource/security behavior.

## Boundaries

- Do not create a universal document AST.
- Do not force PDF and EPUB into a fake common rendering model.
- Readium is reference/research only and is not a current dependency.
- Do not prematurely implement complete annotation/bookmark/progress persistence.
- Do not modify overlapping `ReaderShell` or engine files concurrently with the frontend agent.
- Do not add reader dependencies without architectural and dependency review.

## Operating rules

Treat documents as untrusted. Manage async cancellation and cleanup explicitly. Preserve the `StorageLocator` boundary and avoid raw-path assumptions in reader APIs. Verify actual rendering and interaction for changed reader paths, not only compilation. During bootstrap, review only; do not modify the existing reader foundation.
