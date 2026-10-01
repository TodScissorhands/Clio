# Safe PDF Operations Investigation (Milestone 8A)

## Context & Objectives
Clio's long-term product vision combines reader, library management, and lightweight document tools without hosted cloud dependencies. Following Milestone 8A's capability architecture, this document records the technical investigation into local, safe PDF manipulation operations for Milestone 8B.

## Evaluation Criteria
1. **Local & Offline**: Must operate strictly on the local machine without remote network calls.
2. **Safe Argument Passing**: Must use structured process arguments (`Command::new("tool").arg(...)`), completely prohibiting shell interpolation or string concatenation.
3. **Dependency Footprint**: Prefer tools already present in Clio's prerequisite stack (Poppler / Pandoc) or small, audited Rust crates over heavyweight external toolchains.
4. **Input/Output Safety**: Distinct source and destination paths, canonical equality checks, validated directory permissions, and scoped temporary file guards (`TempFileGuard`).

---

## Tooling Analysis

### 1. Poppler Utilities (`pdfunite` & `pdfseparate`)
- **Availability**: Installed on Linux desktop via `poppler-utils` (already required for `pdftotext`). Verified present and functional on the host.
- **Operations Supported**:
  - `pdfunite <input1.pdf> <input2.pdf> ... <output.pdf>`: Merges multiple PDF files into a single unified document.
  - `pdfseparate -f <first> -l <last> <input.pdf> <output-%d.pdf>`: Extracts individual pages or page ranges from a PDF.
- **Pros**:
  - Zero new system dependencies; already co-located with `pdftotext`.
  - Fast C++ execution.
  - Mature PDF 1.4–2.0 format compatibility.
- **Cons**:
  - Requires `poppler-utils` binary presence on the host machine.

### 2. Pure Rust Libraries (`lopdf`)
- **Crate**: `lopdf` (MIT License).
- **Operations Supported**:
  - Document merging, page extraction, page rotation, metadata inspection, and outline manipulation.
- **Pros**:
  - No external CLI binary needed; compiles directly into the Tauri binary.
  - Cross-platform consistency across Linux, macOS, and Windows.
- **Cons**:
  - Increases compile time and binary size.
  - Certain complex PDF encryption or non-standard font dictionaries can fail during re-serialization.

### 3. Java / Heavyweight CLI Tools (`pdftk`, `qpdf`, `ghostscript`)
- **Analysis**: `pdftk` requires Java/GCJ runtime; `ghostscript` has complex security and licensing considerations (AGPL).
- **Decision**: Not suitable for Clio's lean local-first boundary.

---

## Candidate Operations for Milestone 8B

| Operation | Candidate Tool | Complexity | Feasibility |
|---|---|---|---|
| **PDF Merge (`merge-pdf`)** | `pdfunite` / `lopdf` | Low | **Immediate (Recommended for 8B)** |
| **Page Range Extraction (`extract-pages`)** | `pdfseparate` | Medium | Staged after merge |
| **Page Rotation (`rotate-pages`)** | `lopdf` | Medium | Staged after page extraction |
| **PDF Metadata Inspection** | `pdfinfo` / Rust parser | Low | Can accompany inspection |

---

## Architectural Decision for Next Pass
- **Primary Tool**: Use Poppler `pdfunite` as the initial native engine for PDF merging, leveraging the structured `Command::new("pdfunite").args(...)` execution boundary established in Milestone 8A.
- **First Planned Operation**: **PDF Merge (`merge-pdf`)** in Milestone 8B.
  - Input: two or more valid PDF files.
  - Capability: `ConversionCapability { source_format: "pdf", target_format: "pdf", operation: OperationKind::MergePdf, engine: ConversionEngine::Poppler, ... }`.
  - Planned Job: `ConversionJob` with ordered input paths and verified output destination.
