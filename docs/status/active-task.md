# Active Task: Milestone 8B — Safe PDF Merge

## Status: COMPLETE

## Scope & Implementation Summary
Milestone 8B implements safe PDF merging via the locally verified Poppler utility `pdfunite` within the capability/job architecture:

1. **Multi-Source Job Model (`src-tauri/src/conversion.rs`, `src/tools/conversion.ts`)**
   - Extended `ConversionJob` with `source_paths: Vec<String>` in Rust and `sourcePaths?: string[]` in TypeScript.
   - Backward-compatible: single-source conversions populate `source_path` and `source_paths = [source_path]`; `#[serde(default)]` handles deserialization seamlessly.

2. **Typed Merge Capability (`src-tauri/src/conversion.rs`, `src/tools/conversion.ts`)**
   - Added `OperationKind::MergePdf` (`"merge-pdf"`).
   - `CapabilityRegistry` dynamically checks `is_tool_installed("pdfunite")` before registering `MergePdf` capability.
   - Single-document target filtering (`find_capability` & `supported_targets_for`) explicitly filters out `MergePdf`, preventing accidental identity conversion from being exposed.
   - Dedicated lookup: `find_capability_for_operation("pdf", "pdf", OperationKind::MergePdf)`.

3. **Strict Validation & Safe Path Boundary (`src-tauri/src/conversion.rs`)**
   - `plan_merge_job` requires `>= 2` source files.
   - Validates that every source file exists, is a regular file, and has a `.pdf` extension.
   - Canonicalizes every input path and uses a `HashSet` to reject duplicate inputs.
   - Validates that output destination does not alias or overwrite any input (checking both verbatim and canonical paths).
   - Verifies that output parent directory exists and is accessible.

4. **Structured Native Execution (`src-tauri/src/conversion.rs`)**
   - `execute_job` invokes `pdfunite` using structured arguments: `Command::new("pdfunite").args(&inputs).arg(output)`.
   - Zero shell interpolation or string concatenation.
   - Captures stderr and reports structured failure upon error.

5. **Conversion Workspace UI (`src/tools/ConversionWorkspace.tsx`, `src/App.css`)**
   - Added mode switch in view heading: `Convert Document` | `Merge PDF`.
   - Multi-PDF selection via native file picker (`multiple: true`, `.pdf` filter).
   - Ordered list showing index (`1`, `2`, `3`...), file name, and file size.
   - Reordering controls: move up (`↑`) and move down (`↓`) buttons.
   - Removal control (`✕`) per item and `Clear all` button.
   - Enforces minimum 2 PDFs before enabling the merge action.
   - Destination selection using native `save` dialog with suggested name `${first_stem}-merged.pdf`.
   - Job planning and execution status reporting with engine name and output path.

6. **Verification & Tests**
   - `bun test`: 103/103 tests pass (new tests in `src/tools/conversion.test.ts` covering `MergePdf` job structure, input ordering, and minimum-2 validation).
   - `bun run build`: Clean TypeScript check (`tsc`) and Vite production build.
   - `cargo test`: 16/16 tests pass (new integration test in `src-tauri/src/conversion.rs` testing two-file merge, multi-file merge, input count rejection, non-PDF rejection, duplicate rejection, input/output collision rejection, missing input rejection, invalid output dir rejection, and actual execution with `pdfunite` on deterministic minimal PDFs).
   - `cargo fmt --check`: Clean (0 diffs).
   - `cargo clippy --all-targets --all-features -- -D warnings`: Clean (0 warnings).

## Files Changed
- `src-tauri/src/conversion.rs`
- `src-tauri/src/lib.rs`
- `src/tools/conversion.ts`
- `src/tools/conversion.test.ts`
- `src/tools/ConversionWorkspace.tsx`
- `src/App.css`
- `docs/status/current.md`
- `docs/roadmap.md`
- `docs/status/active-task.md`

## Exact Next Action
Commit and push Milestone 8B to `https://github.com/TodScissorhands/Clio.git`.
