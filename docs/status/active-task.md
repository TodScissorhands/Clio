# Active Task: Milestone 8A — Conversion Capability Architecture

## Status: COMPLETE

## Scope & Implementation Summary
Milestone 8A establishes a typed capability registry and planned job model without redesigning Storage Core, ReaderShell, or DocumentRecord:

1. **Audit of Conversion System (`src-tauri/src/conversion.rs`, `src-tauri/src/lib.rs`)**
   - Source formats supported: `pdf`, `epub`, `docx`, `odt`, `rtf`, `html`, `htm`, `md`, `txt`.
   - Engines: Poppler `pdftotext`, Pandoc, and composite Poppler+Pandoc pipeline.
   - Identified and fixed security & reliability issues:
     - Arbitrary unverified paths: added `canonical_regular_file`, `validate_output_destination`, and input == output canonical check.
     - Unsafe fixed PID temporary file: replaced with `TempFileGuard` using UUID-based unique paths and guaranteed cleanup on drop.
     - Unbacked format claims: removed unbacked PDF output from Pandoc registry (pandoc requires pdflatex which is absent).
     - Prohibited identity conversions (e.g. `md -> md`).

2. **Typed Capability Model (`src-tauri/src/conversion.rs`, `src/tools/conversion.ts`)**
   - `OperationKind`: `Convert`, `ExtractText`.
   - `ConversionEngine`: `Poppler`, `Pandoc`, `PopplerPandoc`.
   - `ConversionCapability`: encapsulates `sourceFormat`, `targetFormat`, `operation`, `engine`, `label`, `description`.
   - `CapabilityRegistry`: validates and filters executable capabilities based on verified local tools.

3. **Planned Job Model (`src-tauri/src/conversion.rs`, `src/tools/conversion.ts`)**
   - `ConversionJob`: format-independent job representation with `id` (UUID), `sourcePath`, `sourceFormat`, `targetFormat`, `outputPath`, `operation`, `engine`, `status` (`Planned`, `Running`, `Completed`, `Failed`), `error`, `createdAt`, `completedAt`.
   - `plan_job`: constructs planned jobs with safe destination path validation prior to execution.
   - `execute_job`: executes planned jobs using structured process arguments (`Command::new(...)`) and updates status.

4. **Safe Path Boundary & Process Security**
   - Prohibits shell interpolation; uses structured arguments only.
   - Validates that source exists, is a regular file.
   - Validates that source != output (checking canonical equality).
   - Validates that output parent directory exists and is a directory.
   - Rejects conversions if target is not registered in the capability registry.

5. **Conversion Workspace UI (`src/tools/ConversionWorkspace.tsx`)**
   - Replaced hard-coded static format array with dynamic query to `listConversionCapabilities(document.extension)`.
   - Renders only valid targets for the chosen source document, annotated with engine metadata (`Pandoc`, `Poppler`, `Poppler + Pandoc`).
   - Automatically pre-plans conversion jobs upon target selection.
   - Executes jobs through `executeConversionJob` upon user save confirmation.
   - Granular status reporting showing engine name, completion path, and structured error messages.

6. **Safe PDF Operations Investigation (`docs/research/pdf-operations-investigation.md`)**
   - Evaluated Poppler `pdfunite`, `pdfseparate`, pure-Rust `lopdf`, and other tools.
   - Staged **PDF Merge (`merge-pdf`)** via `pdfunite` as the initial operation for Milestone 8B.

7. **Verification & Tests**
   - `bun test`: 100/100 tests pass (new suite in `src/tools/conversion.test.ts` covering capability modeling, format metadata, engine labels, and job state transitions).
   - `bun run build`: Clean TypeScript check (`tsc`) and Vite production build.
   - `cargo test`: 15/15 tests pass (new unit tests in `conversion.rs` covering capability registry filtering, format normalization, job planning validation, and temp file guard cleanup).
   - `cargo fmt --check`: Clean (0 diffs).
   - `cargo clippy --all-targets --all-features -- -D warnings`: Clean (0 warnings).

## Files Changed
- `src-tauri/src/conversion.rs` (new)
- `src-tauri/src/lib.rs`
- `src/tools/conversion.ts` (new)
- `src/tools/conversion.test.ts` (new)
- `src/tools/ConversionWorkspace.tsx`
- `docs/research/pdf-operations-investigation.md` (new)
- `docs/status/current.md`
- `docs/roadmap.md`
- `docs/status/active-task.md`

## Exact Next Action
Commit and push Milestone 8A to `https://github.com/TodScissorhands/Clio.git`.
