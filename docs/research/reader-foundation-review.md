# Reader Foundation Review

Date: 2026-10-01

A read-only reviewer inspected the completed reader foundation, storage boundary, Rust commands, Tauri configuration, dependencies, responsive shell, and conversion integration. No application source was modified in response to this review. Findings below are reviewer findings pending lead/product-owner triage; they are not claims of independent reproduction during this bootstrap.

## BLOCKING

1. **Potential arbitrary file read / command execution through EPUB content and native IPC.**
   - Evidence cited: `src-tauri/src/lib.rs` (`read_document_bytes`), `src-tauri/tauri.conf.json` (`app.security.csp`), and `src/reader/EpubEngine.tsx` (`EPUB_CSP`, `loadText`, `isHtmlResource`).
   - Concern: the Tauri window CSP is `null`; EPUB CSP is injected with a regex that may miss head-less HTML/XHTML and SVG resources; foliate rendering uses an iframe sandbox with scripts enabled. The reviewer warns that a hostile document could reach same-origin application internals and invoke unrestricted native commands, including arbitrary file reads or conversion writes.
   - Status: requires security-focused validation before reader security changes or broader document support. Not fixed during bootstrap.

2. **Potential severe memory amplification from JSON IPC byte arrays.**
   - Evidence cited: `read_document_bytes` returns `Vec<u8>`, `TauriDocumentStorage.open` receives `number[]`, and reader engines create additional `ArrayBuffer`/`Blob` copies.
   - Concern: large documents may cause high peak memory and UI freezes because bytes cross the bridge as serialized arrays and are synchronously copied into a `Uint8Array`.
   - Status: requires a measured IPC/large-file decision. Not fixed during bootstrap.

3. **EPUB lifecycle cleanup may leak renderers across document changes.**
   - Evidence cited: `src/reader/EpubEngine.tsx` cleanup paths close the ZIP reader but do not call a foliate view close operation.
   - Concern: reopening a document on the same `foliate-view` may retain renderers, iframes, listeners, and memory.
   - Status: requires targeted document-switch lifecycle verification. Not fixed during bootstrap.

4. **PDF outline/contents contract is incomplete.**
   - Evidence cited: `src/reader/PdfEngine.tsx` calls `onToc([])` and implements `goToToc` as a no-op.
   - Concern: the common contents UI cannot expose PDF outlines, and the engine handle contains an unimplemented operation.
   - Status: reader feature gap, not addressed during bootstrap.

## NON-BLOCKING

1. **PDF canvas does not account for device pixel ratio.** `src/reader/PdfEngine.tsx` uses logical viewport dimensions as backing-store dimensions, which may blur HiDPI rendering.
2. **Search errors and cancellation are weak.** `ReaderShell.runSearch` has no error boundary; PDF/EPUB searches are sequential and lack explicit cancellation.
3. **Conversion workspace state is lost when changing top-level views.** `src/App.tsx` conditionally unmounts `ConversionWorkspace`.
4. **Storage entry point is desktop-path-specific.** `openReaderDocument(path: string, ...)` hardcodes a desktop locator, and the current record ID combines path and size.
5. **PDF theme prop is currently unused.** Theme controls do not alter PDF canvas rendering.
6. **No automated test suite is configured.** Storage mapping, Rust IPC boundaries, TOC behavior, and reader lifecycle are currently covered only by smoke verification.

## OBSERVATIONS

- Regex-based mutation of untrusted EPUB HTML is fragile; a parser or more isolated resource-serving model should be evaluated before expanding EPUB support.
- PDF currently displays a text preview rather than a PDF.js text layer, so native text selection/highlighting is not present.
- `PDFDocumentLoadingTask` is not retained for explicit loading-task destruction.
- PDF canvas sizing is fixed rather than fit-to-container.

## RECOMMENDED FIXES

1. Evaluate binary IPC or a scoped/custom native resource protocol, and define native path/file validation before supporting large files or wider document access.
2. Perform a focused EPUB hostile-content security review. Validate window CSP, iframe origin/sandbox behavior, script stripping/CSP insertion coverage, and Tauri command exposure. Do not rely on regex-only sanitization without evidence.
3. Verify and implement foliate lifecycle cleanup before treating repeated document switching as production-safe.
4. Decide whether PDF outlines and zoom controls are part of the next reader-polish milestone; if so, complete the engine contract and UI together.
5. Add targeted tests/smoke scenarios for storage mapping, repeated document replacement, hostile EPUB resources, large-file behavior, and conversion regression.
6. Preserve the current shell/engine/storage boundaries while addressing findings; do not introduce a universal document AST or broad dependency expansion.
