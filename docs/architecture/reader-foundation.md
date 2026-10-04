# Reader Foundation Architecture

## Scope

This document records the implemented reader boundary and its handoff to Storage Core. Storage catalog and library behavior is described in [`storage.md`](storage.md); planned behavior is labeled there rather than being implied by this reader design.

```text
App
 └── ReaderShell
      ├── ReaderEngineHandle
      ├── PdfEngine  (PDF.js)
      └── EpubEngine (foliate-js + @zip.js/zip.js)

Reader document
 ├── DocumentRecord (opaque UUID identity)
 ├── SourceRef      (source coordinate)
 ├── StorageLocator (runtime access capability)
 └── ephemeral reader bytes (Blob)
```

## Responsibilities

`ReaderShell` owns common reader chrome and state: navigation controls, progress, search controls, contents panel, themes, keyboard interaction, loading/error presentation, and responsive layout.

`PdfEngine` owns PDF.js worker setup, PDF loading, page rendering, page navigation, zoom, current-page text extraction, and basic search.

`EpubEngine` owns EPUB ZIP resource access, foliate view creation, pagination, navigation, TOC extraction, basic search, theme application, restrictive CSP/resource handling, and lifecycle cleanup.

The shell depends on the format-neutral `ReaderEngineHandle`; it does not depend on PDF.js or foliate-js types. The engines do not define a universal document AST.

## Storage boundary

The current desktop reader flow authorizes a selected path with `authorize_reader_document`, then opens it with the session-only UUID returned by that command. Rust `read_document_bytes` accepts the token, not a raw path, and revalidates the canonical file identity before reading. The resulting bytes are an ephemeral reader `Blob`; neither bytes nor tokens are document identity.

Storage Core preserves this tokenized opening boundary while separating durable `SourceRef` coordinates from runtime `StorageLocator` capabilities. A raw filesystem path is a source coordinate or open input, never a universal `DocumentRecord` identity. Library records and reading state belong to the Storage Core catalog, not to reader engines.

## Security boundary

EPUB resources are loaded from the selected ZIP archive through an allowlisted entry map. EPUB documents receive a restrictive CSP with scripts, network connections, frames, objects, and forms disabled; external links are blocked. Sanitization and CSP remain defense-in-depth because documents are untrusted input.

Final packaged/native validation is incomplete: the release executable compiled and launched, but the packaged hostile EPUB could not be driven or inspected. Blob-origin Tauri ACL/native command reachability therefore remains unproven; the explicit CSP is defense-in-depth, not proof of renderer isolation.

## Deferred work

PDF page text-layer locator persistence and highlight rendering, filesystem watchers, mobile providers, cloud sources, and conversion redesign remain separate follow-up work. Bookmark/annotation storage, reader panels, annotation editing, and EPUB highlight rendering are implemented.
