# Active Task: Pass 3C — Annotation Interaction + Highlight UX

## Status: COMPLETE

## Completed Implementation Steps

1. **Rust Storage & Native Command (`src-tauri/src/storage.rs`, `src-tauri/src/lib.rs`)**
   - Implemented `LibraryDb::update_annotation(&self, annotation_id: &str, note: Option<&str>) -> Result<AnnotationDto, String>`.
     - Updates note and `updated_at`.
     - Normalizes empty/whitespace notes to `None` (`NULL` in SQLite).
     - Returns updated `AnnotationDto` with all fields and persistent `locator` intact.
     - Returns `Err("Annotation was not found.")` if no row was updated.
   - Updated `LibraryDb::delete_annotation(&self, annotation_id: &str)` to return an error when zero rows are deleted.
   - Added Tauri command `annotation_update(db, annotation_id, note)` and registered in `invoke_handler!` in `lib.rs`.
   - Added unit test `test_annotation_update_and_deletion_failure` verifying:
     - note modification while preserving locator, id, document_id, position, selected_text.
     - note clearing to NULL.
     - failure on non-existent annotation ID for update and delete.
     - clean deletion of existing annotation.

2. **Frontend Storage API (`src/storage/documentStorage.ts`)**
   - Added `updateAnnotation(annotationId: string, note?: string): Promise<Annotation>` calling `annotation_update` and deserializing with runtime locator validation.

3. **EPUB Highlight Rendering (`src/reader/EpubEngine.tsx`, `src/reader/foliate.d.ts`)**
   - Integrated Foliate's `Overlayer` via `foliate-js/overlayer.js`.
   - Wired `view.addEventListener("draw-annotation", ...)` using `Overlayer.highlight` with `--reader-highlight-color`.
   - Added overlay synchronization on section creation (`create-overlay` event), book initialization, and `annotations` prop changes.
   - Preserves EPUB CSP, sanitization, resource allowlisting, and tokenized read security boundaries.
   - Stale/malformed CFIs are handled gracefully without crashing the reader.

4. **Reader UI & Interaction (`src/reader/ReaderShell.tsx`, `src/reader/ReaderShell.css`)**
   - **Note Creation**: Contextual toolbar annotate bar displays note input, Save, and Cancel buttons when text is selected; allows Enter to save with optional note, Esc to cancel.
   - **Note Editing**: Inline note editor within each annotation in the Annotations panel with Save / Cancel actions, updating `note` and `updatedAt`.
   - **Error Handling**: Replaced silent catch blocks in create, update, and delete actions with `onState("error", ...)`. Preserves user's selection and note input on failure.
   - **Loading State**: `annotationsLoading` spinner displayed in the Annotations panel during document retrieval.
   - **Active State Indication**: Current reading position matching highlights the active annotation item with `.active` styling and a "current" chip.
   - **Navigation**: Jumping to annotation position delegates cleanly to `engineRef.current?.goToPosition(a.position)`.
   - **Engine Prop**: Passed `annotations={annotations}` to `Engine`.

5. **PDF Text-Layer Investigation Result**
   - Investigated PDF.js `TextLayer` integration in `PdfEngine.tsx`.
   - Full TextLayer rendering requires scale-factor transform synchronization (`--total-scale-factor`), font-loading lifecycle coordination, and container overlay management.
   - Adding a full text layer within this pass would destabilize the existing canvas render task, HiDPI scaling, and search navigation.
   - In accordance with the prompt's instruction ("If it requires a substantial renderer redesign: stop at investigation/documentation. Do not redesign PdfEngine during this pass."), the `pdf-page-text` locator remains explicitly non-durable and canvas rendering is preserved.

6. **Test Verification**
   - `bun test`: 92/92 tests pass (+8 new Pass 3C tests in `locator.test.ts`).
   - `bun run build`: Clean TypeScript check (`tsc`) and Vite production build.
   - `cargo test`: 11/11 tests pass (+1 new test in `storage.rs`).
   - `cargo fmt --check`: Clean (no formatting diffs).
   - `cargo clippy --all-targets --all-features -- -D warnings`: Clean (0 warnings).

## Files Changed
- `src-tauri/src/storage.rs`
- `src-tauri/src/lib.rs`
- `src/storage/documentStorage.ts`
- `src/reader/types.ts`
- `src/reader/foliate.d.ts`
- `src/reader/EpubEngine.tsx`
- `src/reader/PdfEngine.tsx`
- `src/reader/ReaderShell.tsx`
- `src/reader/ReaderShell.css`
- `src/reader/locator.test.ts`
- `docs/status/current.md`
- `docs/roadmap.md`
- `docs/status/active-task.md`

## Exact Next Action
Commit and push Pass 3C to `https://github.com/TodScissorhands/Clio.git`.
