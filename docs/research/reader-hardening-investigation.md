# Reader Hardening Investigation

Date: 2026-10-01

Scope: reproduce and triage the four primary reader findings without changing application source, dependencies, or lockfiles. Disposable EPUB fixtures, browser probes, and Bun serialization probes were removed after use. No commit or push was performed.

## 1. Security

### Finding: EPUB CSP coverage is incomplete

**Reproduced? Partial — confirmed by code and dependency behavior; end-to-end Tauri exploit not reproduced.**

**Evidence**

- `src/reader/EpubEngine.tsx` injects `EPUB_CSP` only by replacing the first regex match for `<head...>`.
- `isHtmlResource()` only recognizes `.xhtml`, `.html`, `.htm`, and `.xhtm` extensions.
- Headless HTML/XHTML, self-closing or malformed head tags, and SVG spine resources can bypass this injection.
- Installed foliate-js 1.0.1 creates content iframes with `sandbox="allow-same-origin allow-scripts"` in `paginator.js` and `fixed-layout.js`.
- The foliate-js README explicitly states that this combination is not a sufficient security boundary and relies on CSP.
- A standard browser Blob-iframe probe reproduced script execution and parent-window access when CSP was absent. The Clio probe loaded a head-bearing hostile chapter with the restrictive CSP and did not observe script execution. A headless chapter had no injected CSP; its particular test script was malformed by XML escaping, so direct script execution in that exact fixture was not claimed as reproduced.
- External resource attempts were observed as failed requests in the browser probe. No successful external exfiltration was observed.
- External anchor handling is implemented: `EpubEngine` cancels foliate's `external-link` event.
- `src-tauri/tauri.conf.json` sets the window CSP to `null`.
- Tauri injects `__TAURI_INTERNALS__` into the main frame, not automatically into child frames. The exact Blob-frame origin and Tauri ACL attribution under the shipped Linux WebKitGTK runtime were not reproduced.

**Actual risk**

The CSP bypass is a real containment gap for untrusted EPUB content. `allow-same-origin allow-scripts` permits scripts if no effective CSP blocks them. Native command escalation from an EPUB frame is **not confirmed**: it depends on target WebView Blob-origin behavior and Tauri request/ACL attribution. The unconditional native `read_document_bytes(path)` command also accepts arbitrary paths once an authorized caller reaches it, so it must not be treated as a complete security boundary.

**Recommended action**

Before treating EPUB as hardened, apply a complete resource policy to every HTML/XHTML/SVG spine resource, preferably by parsing/sanitizing rather than regex replacement. Strip active scripts and inline event handlers, define the handling of SVG and embedded content, and add an explicit native window CSP. Validate the resulting behavior in the packaged Tauri/WebKitGTK runtime. A truly isolated renderer/resource proxy remains the long-term solution if foliate's iframe constraints prevent a strong boundary.

### Finding: external links, network, frames, and SVG behavior

**Reproduced? Partial.**

- External anchor cancellation: reproduced by source/dependency inspection; the event is cancelable and Clio calls `preventDefault()`.
- Head-bearing HTML: restrictive `script-src`, `connect-src`, `frame-src`, `object-src`, and resource directives are present. Browser probes observed failed external resource requests, not successful loads.
- Headless/malformed HTML and SVG: policy omission is confirmed by code; exact WebKitGTK script/network behavior is not reproduced.
- Malformed XHTML fallback is present in foliate's parser, but no complete malformed-EPUB Tauri test was run.
- Multiple sections are independently loaded; a policy gap in one section is not corrected by another section's CSP.

## 2. Document-byte transport

### Current behavior (investigation snapshot)

```text
Rust fs::read
  -> Vec<u8>
  -> Tauri JSON response: [0, 17, 255, ...]
  -> JavaScript number[]
  -> Uint8Array.from()
  -> Blob
  -> PDF Blob.arrayBuffer() / EPUB ZIP reader
```

Evidence:

- `src-tauri/src/lib.rs`: `read_document_bytes` returns `Result<Vec<u8>, String>`.
- Tauri 2.11.5's blanket IPC response path serializes the vector with JSON; it is not a raw binary response.
- `src/storage/documentStorage.ts` types the result as `number[]`, then performs `Uint8Array.from()` and constructs a `Blob`.
- The normal desktop custom IPC path still returns JSON for this command; fallback paths do not make the vector binary.

### Measurements

Disposable Bun measurements of JSON serialization:

| Payload | Pattern | JSON size | Expansion | Stringify time |
|---:|---|---:|---:|---:|
| 50 MiB | deterministic byte pattern | 187,187,201 bytes | 3.57x | 1.36 s |
| 50 MiB | all zeroes | 104,857,601 bytes | 2.00x | 1.54 s |
| 50 MiB | all `255` | 209,715,201 bytes | 4.00x | 1.74 s |
| 100 MiB | deterministic byte pattern | ~357.03 MiB | 3.57x | ~3.83 s |

These are serialization-only measurements, not WebView end-to-end measurements. The full pipeline retains multiple representations: native bytes, JSON text/transport buffers, a JavaScript number array, typed bytes, Blob storage, and an additional PDF ArrayBuffer. Exact WebView peak memory is implementation-dependent. A Bun illustrative pipeline showed a 10 MiB payload reaching roughly 325 MB RSS versus roughly 114 MB baseline during JSON/parse stages; this is not a WebKit measurement.

### Alternatives investigated

| Option | Complexity | Memory behavior | Security/platform notes | Reader impact |
|---|---|---|---|---|
| Current JSON byte IPC | None | High amplification; whole-file copies | Current command accepts arbitrary path; desktop-only adapter | None |
| Raw `tauri::ipc::Response::new(Vec<u8>)` | Moderate | Removes decimal-array expansion; still whole-file Blob/PDF copies | Strong desktop path; fallback/mobile behavior must be validated; does not authorize paths | Small; Blob API can remain |
| Scoped asset/custom protocol with ranges | Moderate/high | Streaming and bounded range reads | Requires narrow per-file scope and platform adapters; built-in asset protocol is not currently enabled | Medium; URL/range source integration |
| Range-based command | High | Bounded chunks, more calls/latency | Requires portable native locator/session model | Significant |
| Temporary managed resource | High | Disk-backed, bounded reads | Explicit expiry/cleanup and mobile normalization required | Medium/high |
| Tokenized per-open protocol | High | Streaming/range-friendly | Strongest capability scoping if tokens/expiry are correct | Medium |

### Recommendation

The JSON transport is a confirmed large-file performance/stability risk, but it does not block the current modest-size desktop reader by itself. Do not replace it speculatively during investigation. Before a large-file, mobile, or storage-abstraction milestone, replace it with a measured binary/scoped transport. Raw binary IPC is the smallest short-term experiment; a scoped range-capable protocol is the long-term storage-compatible direction. Path validation/canonicalization is a separate required security concern, not solved by changing serialization.

## 3. EPUB lifecycle

### Reproduction results

**Reproduced at the installed Foliate API level; not fully reproduced through Clio's native file dialog.**

A disposable browser probe opened EPUB-like books A → B → A on one `foliate-view`. Three connected paginator renderers remained. Calling `view.close()` removed the active renderer and its contents.

Installed Foliate evidence:

- `view.open()` creates and appends a new renderer without closing the previous renderer.
- `view.close()` calls the current renderer's `destroy()` and removes it.
- `book.destroy()` separately destroys the EPUB loader and revokes cached Blob URLs.
- `ZipReader.close()` is not a substitute for either Foliate cleanup operation.

Current `EpubEngine` behavior (investigation snapshot):

- Reuses one `foliate-view` across document changes.
- Calls `view.open(epub)` repeatedly without `view.close()`.
- Closes the ZIP reader, but does not call `view.close()` or `epub.destroy()`.
- Uses `view.replaceChildren()` on unmount, which does not explicitly clean the closed shadow-root renderer.
- Has an async race: an older `openEpub`/`view.open` can resolve after a newer document starts and append stale content.

**Resource behavior**

Renderer accumulation is confirmed at the Foliate API level. Blob URL retention through the EPUB loader is confirmed by source inspection. A full Clio A → B → A → PDF → EPUB sequence was not run through the native picker. The current shell does reset its own TOC/progress/status state on document change; the engine-level renderer race remains.

### Required action (pre-implementation)

Fix lifecycle ownership before considering repeated document replacement production-safe. The smallest correct design must ensure each open operation owns and cleans its view/book/ZIP reader, calls `view.close()` and `book.destroy()`, and cannot close or replace a newer operation. A fresh view per document or serialized operation ownership is safer than adding a single unconditional `view.close()` to a shared-view cleanup.

## 4. PDF outline/TOC

### Current capability (investigation snapshot)

**Confirmed missing feature.** `PdfEngine` publishes `onToc([])` and implements `goToToc` as a no-op. The shell's generic `ReaderTocItem`/`ReaderEngineHandle` contract therefore exposes no PDF contents.

### PDF.js capability

Installed `pdfjs-dist` exposes:

- `PDFDocumentProxy.getOutline()` for hierarchical outline nodes;
- `getDestination(name)` for named destinations;
- `getPageIndex(ref)` for explicit page references.

Outline nodes provide title, destination, URL, and child items.

### Interface implications

The current generic interface is adequate. `PdfEngine` can recursively map outline nodes to `ReaderTocItem` and keep a private ID-to-destination map. Local named/explicit destinations can resolve to a page and call the existing page loader. External URL-only outline entries require an explicit policy. No ReaderEngineHandle redesign is justified.

### Recommendation

Implement basic local PDF outline extraction/navigation in the next reader hardening implementation milestone if the product owner considers contents parity required. Keep external outline URLs deferred. Separately retain/destroy the PDF loading task and guard stale asynchronous page updates; these are lifecycle hardening concerns.

## 5. Lower-priority findings

| Finding | Classification | Evidence | Action |
|---|---|---|---|
| PDF device-pixel-ratio rendering | Confirmed bug, non-blocking | Canvas backing dimensions equal logical viewport dimensions in `PdfEngine`; HiDPI output is upscaled | Fix with PDF rendering hardening; verify visual output |
| Search rejection/cancellation | Architectural concern | Shell has no `try/catch`; PDF/EPUB loops have no abort/token ownership | Defer until reader hardening tests or search UX milestone; add cancellation with targeted verification |
| Conversion workspace state on top-level navigation | Confirmed behavior outside this milestone | `App.tsx` conditionally unmounts `ConversionWorkspace` | Defer; unrelated to reader security/lifecycle |
| Desktop-path-specific storage entry points | Architectural concern | `TauriDocumentStorage` rejects non-desktop locators; opener accepts `path: string`; ID derives from path and size | Defer until storage abstraction milestone; do not begin that milestone here |
| PDF theme behavior | Missing feature | `PdfEngine` does not consume/apply the shell theme to its canvas | Defer as reader polish |
| Automated tests | Confirmed gap | No test script/framework or permanent tests are configured | Add focused regression tests alongside fixes; do not add a framework only for this investigation |

## 6. Investigation-era required fixes

### BLOCKING

These block calling the reader hardened for untrusted-content and repeated-document use:

1. Close the EPUB CSP/resource-policy gap for every spine resource and validate it in the packaged Tauri/WebKitGTK runtime.
2. Correct Foliate view/book/ZIP lifecycle ownership and async replacement races.
3. Define and enforce the native file-read authorization boundary before exposing broader document sources. The exact EPUB-to-Tauri exploit was not reproduced, but arbitrary path acceptance is not a sufficient boundary.

### NON-BLOCKING

1. Replace JSON byte IPC before large-file, mobile, or storage-abstraction work; raw binary IPC is the smallest experiment, while a scoped range-capable protocol is the long-term option.
2. Retain and destroy `PDFDocumentLoadingTask`, order PDF render cancellation and cleanup correctly, and reject stale page/progress updates.
3. Implement basic PDF outline extraction/navigation without changing the generic reader interface.
4. Add device-pixel-ratio rendering.
5. Add focused regression coverage for hostile resources, repeated EPUB replacement, PDF outlines, and byte transport behavior.

### DEFERRED

1. Full range streaming and managed-resource storage architecture.
2. Conversion workspace persistence.
3. Universal/mobile locator abstraction.
4. PDF text-layer selection, advanced search highlighting, bookmarks, annotations, and library/catalog work.

## 7. Architecture decisions

### DECISION REQUIRED

**Question:** What document-byte transport should Clio standardize for the next implementation milestone?

**Options:**

- Raw Tauri binary `Response` now; retain whole-file Blob loading.
- A scoped/range-capable custom protocol or tokenized per-open resource.
- Keep current JSON IPC temporarily for modest desktop files and explicitly limit supported size.

**Recommendation:** Use a small raw-binary transport experiment only if large-file support is part of the next milestone; otherwise keep the current transport isolated and document its size limitation. Design the eventual storage boundary around a scoped/range-capable resource, not around raw paths.

**Reason:** Raw binary removes confirmed JSON expansion with minimal reader impact, while a scoped range protocol better matches future desktop/mobile storage but has materially higher design and validation cost.

**Impact:** The choice determines whether `DocumentStorage` remains Blob-oriented or becomes a range/resource source. It does not solve path authorization by itself.

### DECISION REQUIRED

**Question:** What is Clio's EPUB scripting policy?

**Options:**

- Preserve foliate's layout model and sanitize/strip active content plus enforce CSP on every resource.
- Move EPUB rendering to an isolated unprivileged renderer/resource proxy.
- Support only a restricted EPUB subset until isolation is available.

**Recommendation:** Minimum containment now: strip scripts/event handlers, apply a strict policy to HTML/XHTML/SVG, block network/frames/forms, and validate Tauri/WebKitGTK behavior. Treat an isolated renderer/resource proxy as the long-term solution if the policy cannot be proven in the current WebView.

**Reason:** The current iframe sandbox is not sufficient by itself, while removing `allow-same-origin` may break Foliate/WebKit layout behavior.

**Impact:** This affects EPUB compatibility, security, and whether Clio can safely open arbitrary user-supplied EPUBs.

## 8. Recommended next milestone (pre-implementation)

**Reader hardening implementation: EPUB containment and lifecycle correctness, with bounded byte transport and PDF outline support.**

Scope:

1. Close the EPUB view/book/ZIP ownership and async race defects.
2. Implement complete active-content/resource containment and validate it in packaged Tauri/WebKitGTK.
3. Establish native file-read authorization at the command boundary.
4. Run a small raw-binary transport experiment if measured file-size limits require it; otherwise document and enforce the current limitation.
5. Retain/destroy PDF loading tasks and implement basic local PDF outline/TOC navigation.
6. Add focused regression checks for these paths.

Explicitly excluded: storage/library implementation, databases, indexing, collections, mobile catalog work, broad UI changes, new reader engines, and dependency replacement.

## 9. Implementation update — 2026-10-01

This section records the completed reader-hardening implementation. The investigation evidence above is preserved as the pre-implementation record; its recommendations are superseded only where this section explicitly records an implemented change.

### EPUB containment

- EPUB processing now sanitizes likely markup independently of common file-name extensions.
- Resource `href` query strings and fragments are normalized before ZIP lookup.
- Scripts, inline event handlers, forms, frames, `object`, `embed`, and active SVG elements/references are stripped.
- Safe `blob:` and `data:` image sources are preserved.
- An HTML document receives a CSP `<meta>` when it has a `<head>`; a `<head>` is created when needed.
- SVG metadata is not claimed to provide enforceable CSP. SVG relies on sanitization plus containment by the outer reader.

### Foliate lifecycle

Each operation now owns its view, book, and `ZipReader` cleanup. Cleanup invokes `view.close()`, `book.destroy()`, and `ZipReader.close()`. Stale operations cannot update or close the current view.

### Tauri reader-read authorization

Reader reads now use a session-only in-memory UUID token issued by `authorize_reader_document`. `read_document_bytes` accepts the token only and validates both expiry and canonical file identity. Inspect/conversion raw paths remain unchanged.

This is defense-in-depth, not proof of a complete native boundary: the exact Blob-origin Tauri ACL attribution/native exploit was not proven. The authorize command still receives a path from the trusted application flow, so an isolated renderer/resource proxy remains the long-term boundary.

### PDF hardening and outline support

PDF now retains and destroys its loading task, guards document and navigation asynchronous races, extracts local outline destinations, and renders with DPR-scaled canvas dimensions. External URL-only outline entries remain non-navigable.

### Explicitly deferred scope

JSON number-array byte IPC remains in place; its large-file amplification is deferred and documented. No storage, library, catalog, or mobile work was started as part of this implementation.

### Verification status

- `bun run build` passed, including TypeScript checking and Vite production bundling.
- `cargo check` passed.
- `cargo test` passed, including `reader_authorization_is_token_only_and_revalidates_the_file`.
- `cargo fmt --check` passed.
- A packaged Tauri/WebKitGTK hostile-EPUB runtime exercise was not run; the Blob-origin Tauri ACL attribution and exact native exploit remain unproven.

### Final packaged/native validation — 2026-10-01

Result: **B — partially verified with a documented residual limitation.**

- `bun run tauri build` compiled the release Tauri executable successfully and produced the native release binary. Linux `.deb` and `.rpm` bundles were also produced; AppImage bundling failed only while downloading the external AppImage bootstrap artifact.
- The release executable launched under the host's actual WebKitGTK 2.52.6 runtime and displayed the Clio shell. The configured CSP was present in `tauri info`.
- The packaged window could not be driven or attached to through an available WebKit inspector/CDP endpoint in this environment. Therefore no hostile EPUB was opened in the packaged runtime, and script execution, external-request blocking, Blob-frame origin, or native-command reachability were not directly observed there.
- The earlier browser/DOM probes remain non-native evidence only. They do not prove that an EPUB frame cannot reach `window.__TAURI_INTERNALS__` or invoke privileged Tauri commands under this WebKitGTK build.

The current boundary is therefore: sanitized EPUB resources and explicit CSP provide defense-in-depth; reader byte access uses expiring canonicalized native tokens; the exact Blob-origin-to-Tauri ACL boundary remains unproven. An isolated renderer/resource proxy remains the required stronger boundary before treating arbitrary hostile EPUBs as fully isolated.
