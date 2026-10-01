# Active Task: Pass 3B — Persistent Annotation Creation + Locator

## Status: COMPLETE

## Architectural Decision
Decision B (Moderate Migration-Safe Change): Added additive nullable `locator TEXT` column to `annotations` table under SQLite `user_version = 3`. No legacy data rewritten. Existing rows safely receive `NULL`.

## Completed Steps

1. **SQLite Schema v3 Migration (`src-tauri/src/storage.rs`)**
   - Bumped `SCHEMA_VERSION` from 2 to 3.
   - Added migration block: `ALTER TABLE annotations ADD COLUMN locator TEXT; PRAGMA user_version = 3;`.
   - Preserved all foreign keys, cascades, indices, and legacy data.

2. **Rust Backend (`src-tauri/src/storage.rs`)**
   - Extended `AnnotationDto` with `locator: Option<String>`.
   - Updated `LibraryDb::create_annotation` to accept `locator: Option<&str>`, trim/normalize empty strings to `None`, and validate that provided locators start with `{` (basic JSON check).
   - Updated `annotation_from_row` to map column index 9 (`locator TEXT`) to `AnnotationDto.locator`.
   - Updated `annotation_create` Tauri command to accept `locator: Option<String>` and pass through to `create_annotation`.
   - Added unit tests:
     - `test_schema_migration_and_idempotence` verifying `user_version == 3`.
     - `test_annotation_crud_and_cascade_delete` verifying standard CRUD with `None` locator.
     - `test_annotation_locator_crud_and_schema_v3` covering:
       - EPUB CFI range locator storage & retrieval
       - PDF page-text locator storage & retrieval
       - Legacy / null locator handling
       - Empty string normalization to null
       - Rejection of invalid non-JSON locator strings
       - Document isolation
       - Cascade deletion on root deletion

3. **Frontend Domain & Storage (`src/storage/domain.ts`, `src/storage/documentStorage.ts`)**
   - Extended TypeScript `Annotation` model with `locator?: AnnotationLocator`.
   - Updated `createAnnotation` to accept `locator?: AnnotationLocator`, serialize to JSON string before invoke.
   - Added `deserializeAnnotation` helper in `documentStorage.ts` ensuring JSON parsing and runtime validation with `validateAnnotationLocator` (rejects malformed locators safely without crashing).
   - Updated `listAnnotations` to map returned rows through `deserializeAnnotation`.

4. **ReaderShell UI & Interaction (`src/reader/ReaderShell.tsx`, `src/reader/ReaderShell.css`)**
   - Added `annotations` list and `annotationsOpen` panel state.
   - Loaded document annotations via `listAnnotations` on document open with cancellation handling.
   - Contextual toolbar "Annotate" button appears when `pendingTextSelection !== null`.
   - Clicking "Annotate" invokes `createAnnotation` with current document ID, `"highlight"`, `currentPosition`, `selectedText`, and `pendingTextSelection.locator`.
   - After creation, selection is cleared (`pendingTextSelection → null`) and the new annotation is appended to state.
   - Added "Notes (N)" panel toggle to toolbar.
   - Implemented responsive Annotations panel:
     - Displays badge and selected text quotation / note.
     - Jump button navigates to annotation's `ReadingPosition` via `goToPosition`.
     - Delete button invokes `deleteAnnotation` and updates local state.
     - Escape key closes Annotations panel.
     - Responsive mobile drawer styling.

5. **Tests (`src/reader/locator.test.ts`)**
   - Added test suite for Annotation with locator:
     - EPUB CFI range locator shape
     - PDF page-text locator shape
     - Backward compatibility for annotations without locators
     - Safe JSON serialization & deserialization
     - Malformed JSON rejection
     - Document isolation verification across multiple documents

## Verification Performed

- `bun test`: 84/84 tests pass across 6 test files.
- `bun run build`: Clean TypeScript check (`tsc`) + Vite production build.
- `cargo test`: 10/10 tests pass across all units.
- `cargo fmt --check`: Clean (no formatting diffs).
- `cargo clippy -- -D warnings`: Clean (0 warnings).

## Known Limitations

- PDF text locator remains `pdf-page-text` (page number + display string context). It is not a durable highlight locator. TextLayer rendering is deferred to a future milestone.
- EPUB CFI range locator resolution for inline highlight rendering is deferred to Pass 3C / future rendering milestone. Navigation uses `ReadingPosition`.

## Blockers

None.

## Exact Next Step

External review of Pass 3B implementation before Pass 3C (note editing, highlight rendering).
