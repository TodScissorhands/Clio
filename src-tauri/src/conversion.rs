use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use uuid::Uuid;

// ─── Domain types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationKind {
    Convert,
    ExtractText,
    MergePdf,
    ExtractPages,
    /// Architecture placeholder. No native tool provides reliable per-page
    /// rotation on this host without an inappropriate external dependency
    /// (qpdf not installed; gs selective rotation is unreliable).
    /// Registered in the registry only when a suitable backend is available.
    RotatePages,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConversionEngine {
    Poppler,
    Pandoc,
    PopplerPandoc,
}

impl ConversionEngine {
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::Poppler => "Poppler (pdftotext / pdfunite / pdfseparate)",
            Self::Pandoc => "Pandoc",
            Self::PopplerPandoc => "Poppler + Pandoc",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionCapability {
    pub source_format: String,
    pub target_format: String,
    pub operation: OperationKind,
    pub engine: ConversionEngine,
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Planned,
    Running,
    Completed,
    Failed,
}

/// A validated, immutable description of work to perform.
///
/// All paths stored here are canonical. The backend never blindly trusts
/// frontend-supplied fields at execution time; `execute_job` re-validates
/// the job against the current file system and capability registry before
/// touching any file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionJob {
    pub id: String,
    /// Canonical path of the primary source file.
    pub source_path: String,
    /// Canonical paths of all source files (populated for merge; mirrors
    /// `source_path` for single-source operations).
    #[serde(default)]
    pub source_paths: Vec<String>,
    pub source_format: String,
    pub target_format: String,
    pub output_path: String,
    pub operation: OperationKind,
    pub engine: ConversionEngine,
    pub status: JobStatus,
    pub error: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_selection: Option<Vec<u32>>,
    /// When `false` (the default), execution is rejected if the output file
    /// already exists and is not the same file as any source. When `true`,
    /// an existing unrelated output file is replaced. Source/output aliasing
    /// is always rejected regardless of this flag.
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct PageSelection {
    pub pages: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionResult {
    pub output_path: String,
    pub engine: String,
}

// ─── Utilities ────────────────────────────────────────────────────────────────

pub fn normalize_format(format_or_ext: &str) -> String {
    let trimmed = format_or_ext
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    match trimmed.as_str() {
        "htm" => "html".to_string(),
        "jpeg" => "jpg".to_string(),
        "markdown" => "md".to_string(),
        _ => trimmed,
    }
}

pub fn is_tool_installed(tool: &str) -> bool {
    Command::new(tool)
        .arg("-v")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ─── Capability Registry ──────────────────────────────────────────────────────

pub struct CapabilityRegistry {
    capabilities: Vec<ConversionCapability>,
}

impl Default for CapabilityRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl CapabilityRegistry {
    pub fn new() -> Self {
        let mut caps = Vec::new();

        // PDF merge via Poppler (pdfunite)
        if is_tool_installed("pdfunite") {
            caps.push(ConversionCapability {
                source_format: "pdf".into(),
                target_format: "pdf".into(),
                operation: OperationKind::MergePdf,
                engine: ConversionEngine::Poppler,
                label: "PDF Merge (Poppler)".into(),
                description: "Merge multiple PDF documents into a single PDF".into(),
            });
        }

        // PDF page extraction via Poppler (pdfseparate + pdfunite + pdfinfo)
        if is_tool_installed("pdfseparate")
            && is_tool_installed("pdfunite")
            && is_tool_installed("pdfinfo")
        {
            caps.push(ConversionCapability {
                source_format: "pdf".into(),
                target_format: "pdf".into(),
                operation: OperationKind::ExtractPages,
                engine: ConversionEngine::Poppler,
                label: "PDF Page Extraction (Poppler)".into(),
                description: "Extract page range or selection into a new PDF".into(),
            });
        }

        // RotatePages: NOT registered. qpdf is not installed on this host and
        // gs per-page selective rotation is unreliable. The variant exists in
        // OperationKind so the architecture is ready, but no capability is
        // advertised until a reliable backend (e.g. qpdf) is available.

        // 1. PDF conversions
        // PDF -> TXT: direct extraction via Poppler
        caps.push(ConversionCapability {
            source_format: "pdf".into(),
            target_format: "txt".into(),
            operation: OperationKind::ExtractText,
            engine: ConversionEngine::Poppler,
            label: "Text Extraction (Poppler)".into(),
            description: "Extract plain text content from PDF document".into(),
        });

        // PDF -> Document formats via Poppler extraction + Pandoc formatting
        for target in &["md", "html", "docx", "odt", "epub"] {
            caps.push(ConversionCapability {
                source_format: "pdf".into(),
                target_format: (*target).into(),
                operation: OperationKind::Convert,
                engine: ConversionEngine::PopplerPandoc,
                label: "Poppler + Pandoc".into(),
                description: format!("Extract text from PDF and convert to {target}"),
            });
        }

        // 2. Pandoc-supported document conversions (verified working)
        let pandoc_sources = ["md", "txt", "html", "docx", "odt", "rtf", "epub"];
        let pandoc_targets = ["md", "txt", "html", "docx", "odt", "epub"];

        for src in &pandoc_sources {
            for tgt in &pandoc_targets {
                if src == tgt {
                    continue; // Skip identity conversions
                }
                caps.push(ConversionCapability {
                    source_format: (*src).into(),
                    target_format: (*tgt).into(),
                    operation: OperationKind::Convert,
                    engine: ConversionEngine::Pandoc,
                    label: "Pandoc".into(),
                    description: format!("Convert {src} to {tgt} format"),
                });
            }
        }

        Self { capabilities: caps }
    }

    pub fn list_capabilities(&self, source_format: Option<&str>) -> Vec<ConversionCapability> {
        match source_format {
            Some(src) => {
                let normalized = normalize_format(src);
                self.capabilities
                    .iter()
                    .filter(|c| c.source_format == normalized)
                    .cloned()
                    .collect()
            }
            None => self.capabilities.clone(),
        }
    }

    pub fn find_capability(
        &self,
        source_format: &str,
        target_format: &str,
    ) -> Option<ConversionCapability> {
        let src = normalize_format(source_format);
        let tgt = normalize_format(target_format);
        self.capabilities
            .iter()
            .find(|c| {
                c.source_format == src
                    && c.target_format == tgt
                    && c.operation != OperationKind::MergePdf
                    && c.operation != OperationKind::ExtractPages
                    && c.operation != OperationKind::RotatePages
            })
            .cloned()
    }

    pub fn find_capability_for_operation(
        &self,
        source_format: &str,
        target_format: &str,
        operation: OperationKind,
    ) -> Option<ConversionCapability> {
        let src = normalize_format(source_format);
        let tgt = normalize_format(target_format);
        self.capabilities
            .iter()
            .find(|c| c.source_format == src && c.target_format == tgt && c.operation == operation)
            .cloned()
    }

    #[allow(dead_code)]
    pub fn is_supported_source(&self, source_format: &str) -> bool {
        let src = normalize_format(source_format);
        self.capabilities.iter().any(|c| c.source_format == src)
    }

    #[allow(dead_code)]
    pub fn supported_targets_for(&self, source_format: &str) -> Vec<String> {
        let src = normalize_format(source_format);
        let mut targets: Vec<String> = self
            .capabilities
            .iter()
            .filter(|c| {
                c.source_format == src
                    && c.operation != OperationKind::MergePdf
                    && c.operation != OperationKind::ExtractPages
                    && c.operation != OperationKind::RotatePages
            })
            .map(|c| c.target_format.clone())
            .collect();
        targets.sort();
        targets.dedup();
        targets
    }
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

fn canonical_regular_file(path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Could not read source document: {error}"))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("Could not read source document metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("Please choose a file, not a directory.".into());
    }
    Ok(canonical)
}

fn extension_from_path(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(normalize_format)
        .unwrap_or_default()
}

fn timestamp() -> String {
    let now = std::time::SystemTime::now();
    let duration = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    let days = (secs / 86400) as i64;
    let day_secs = (secs % 86400) as u32;
    let hours = day_secs / 3600;
    let minutes = (day_secs % 3600) / 60;
    let seconds = day_secs % 60;
    let (year, month, day) = civil_date(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn civil_date(days: i64) -> (i64, i64, i64) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1024 + doe / 1461 - doe / 14245) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as i64;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as i64;
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

/// Validate that `output` is a safe destination for a job whose inputs include
/// `inputs`.
///
/// Rules (in priority order):
/// 1. The output path must never be the same canonical file as any input —
///    this is an unconditional rejection regardless of the overwrite flag.
/// 2. If the output already exists and `overwrite` is `false`, reject.
/// 3. The output's parent directory must exist and be a directory.
fn validate_output_path(inputs: &[&Path], output: &Path, overwrite: bool) -> Result<(), String> {
    // Rule 1: source/output alias is always forbidden
    for &input in inputs {
        // Compare by string first (fast, works when output doesn't exist yet)
        if input == output {
            return Err(
                "Output path is the same as a source file. Choose a different destination.".into(),
            );
        }
        // Compare canonical paths when both exist
        if output.exists() {
            if let (Ok(can_in), Ok(can_out)) = (fs::canonicalize(input), fs::canonicalize(output)) {
                if can_in == can_out {
                    return Err(
                        "Output path is the same as a source file. Choose a different destination."
                            .into(),
                    );
                }
            }
        }
    }

    // Rule 2: overwrite guard
    if output.exists() && !overwrite {
        return Err(format!(
            "Output file already exists: {}. Enable overwrite to replace it.",
            output.display()
        ));
    }

    // Rule 3: parent directory must exist
    let parent = output
        .parent()
        .ok_or_else(|| "Invalid output destination path.".to_string())?;
    if !parent.as_os_str().is_empty() && !parent.is_dir() {
        return Err(format!(
            "Destination folder does not exist: {}",
            parent.display()
        ));
    }

    Ok(())
}

/// Planner-time validation: checks only source/output aliasing and parent
/// directory existence. The "output already exists" check is deferred to
/// execution time, where the job's actual `overwrite` flag is applied.
fn validate_output_destination(input: &Path, output: &Path) -> Result<(), String> {
    validate_output_path(&[input], output, true)
}

fn run_command(command: &mut Command, tool: &str) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|error| format!("Could not run {tool}. Make sure it is installed: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!(
        "{tool} could not process this file{}",
        if details.is_empty() {
            ".".into()
        } else {
            format!(": {details}")
        }
    ))
}

// ─── Temporary file helpers ───────────────────────────────────────────────────

struct TempFileGuard {
    path: PathBuf,
}

impl TempFileGuard {
    fn new(prefix: &str, ext: &str) -> Self {
        let name = format!("{prefix}-{}.{ext}", Uuid::new_v4());
        let path = std::env::temp_dir().join(name);
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if self.path.exists() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    pub fn new(prefix: &str) -> Result<Self, String> {
        let unique_name = format!("{prefix}-{}", Uuid::new_v4());
        let path = std::env::temp_dir().join(unique_name);
        fs::create_dir_all(&path)
            .map_err(|e| format!("Could not create temporary directory: {e}"))?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        if self.path.exists() {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

// ─── PDF utilities ────────────────────────────────────────────────────────────

pub fn get_pdf_page_count(path: &Path) -> Result<u32, String> {
    let output = Command::new("pdfinfo")
        .arg(path)
        .output()
        .map_err(|e| format!("Could not inspect PDF metadata with pdfinfo: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pdfinfo failed: {}", err.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("Pages:") {
            if let Ok(count) = rest.trim().parse::<u32>() {
                if count > 0 {
                    return Ok(count);
                }
            }
        }
    }
    Err("Could not determine page count from PDF metadata.".to_string())
}

pub fn parse_page_selection(input: &str, max_pages: u32) -> Result<Vec<u32>, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Page selection cannot be empty.".into());
    }

    let mut pages = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for raw_part in trimmed.split(',') {
        let part = raw_part.trim();
        if part.is_empty() {
            return Err(
                "Empty entry in page selection (e.g. trailing or consecutive comma).".into(),
            );
        }

        if part.contains('-') {
            if part.starts_with('-') {
                return Err("Negative page numbers or leading dashes are not allowed.".into());
            }
            if part.ends_with('-') {
                return Err("Open-ended page ranges are not allowed.".into());
            }
            let sub_parts: Vec<&str> = part.split('-').map(str::trim).collect();
            if sub_parts.len() != 2 {
                return Err(format!("Malformed page range: '{part}'."));
            }

            let start = sub_parts[0]
                .parse::<u32>()
                .map_err(|_| format!("Invalid start page number in range: '{}'.", sub_parts[0]))?;
            let end = sub_parts[1]
                .parse::<u32>()
                .map_err(|_| format!("Invalid end page number in range: '{}'.", sub_parts[1]))?;

            if start == 0 || end == 0 {
                return Err("Page numbers are 1-based; page 0 is invalid.".into());
            }
            if start > end {
                return Err(format!(
                    "Impossible page range: start page ({start}) cannot be greater than end page ({end})."
                ));
            }
            if end > max_pages {
                return Err(format!(
                    "Page {end} exceeds document's total page count ({max_pages})."
                ));
            }

            for p in start..=end {
                if !seen.insert(p) {
                    return Err(format!("Duplicate page {p} in page selection."));
                }
                pages.push(p);
            }
        } else {
            let p = part
                .parse::<u32>()
                .map_err(|_| format!("Invalid page number: '{part}'."))?;
            if p == 0 {
                return Err("Page numbers are 1-based; page 0 is invalid.".into());
            }
            if p > max_pages {
                return Err(format!(
                    "Page {p} exceeds document's total page count ({max_pages})."
                ));
            }
            if !seen.insert(p) {
                return Err(format!("Duplicate page {p} in page selection."));
            }
            pages.push(p);
        }
    }

    if pages.is_empty() {
        return Err("Page selection cannot be empty.".into());
    }

    Ok(pages)
}

// ─── Job planners ─────────────────────────────────────────────────────────────

/// Plan a single-source format conversion job.
///
/// `overwrite` controls whether execution is allowed to replace an existing
/// output file. The planner itself always rejects source/output aliasing and
/// invalid output directories; it only defers the "output exists" check to
/// execution time when `overwrite` might be true.
pub fn plan_job(
    registry: &CapabilityRegistry,
    source_path_str: &str,
    target_format_str: &str,
    output_path_opt: Option<&str>,
    overwrite: bool,
) -> Result<ConversionJob, String> {
    let source_path = Path::new(source_path_str);
    let canonical_source = canonical_regular_file(source_path)?;
    let source_format = extension_from_path(&canonical_source);
    if source_format.is_empty() {
        return Err("Source file has no extension.".into());
    }

    let target_format = normalize_format(target_format_str);
    if target_format.is_empty() {
        return Err("Target format is required.".into());
    }

    let capability = registry
        .find_capability(&source_format, &target_format)
        .ok_or_else(|| {
            format!("No conversion capability available from .{source_format} to .{target_format}.")
        })?;

    let output_path = match output_path_opt {
        Some(custom) if !custom.trim().is_empty() => PathBuf::from(custom.trim()),
        _ => {
            let stem = source_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("converted");
            let default_name = format!("{stem}.{target_format}");
            source_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(default_name)
        }
    };

    // Always reject source/output aliasing and missing parent at plan time.
    // The overwrite check (output exists) is enforced at execute time.
    validate_output_destination(&canonical_source, &output_path)?;

    let source_path_str = canonical_source.to_string_lossy().into_owned();
    Ok(ConversionJob {
        id: Uuid::new_v4().to_string(),
        source_path: source_path_str.clone(),
        source_paths: vec![source_path_str],
        source_format,
        target_format,
        output_path: output_path.to_string_lossy().into_owned(),
        operation: capability.operation,
        engine: capability.engine,
        status: JobStatus::Planned,
        error: None,
        created_at: timestamp(),
        completed_at: None,
        page_selection: None,
        overwrite,
    })
}

/// Plan a PDF merge job from multiple source files.
pub fn plan_merge_job(
    registry: &CapabilityRegistry,
    source_paths_slice: &[String],
    output_path_opt: Option<&str>,
    overwrite: bool,
) -> Result<ConversionJob, String> {
    if source_paths_slice.len() < 2 {
        return Err("PDF merge requires at least 2 source PDF files.".into());
    }

    let mut canonical_sources: Vec<PathBuf> = Vec::with_capacity(source_paths_slice.len());
    let mut seen_canonical = std::collections::HashSet::new();

    for path_str in source_paths_slice {
        let path = Path::new(path_str);
        let canonical = canonical_regular_file(path)?;
        let format = extension_from_path(&canonical);
        if format != "pdf" {
            return Err(format!(
                "Source file '{}' is not a PDF (found: .{}).",
                canonical.display(),
                if format.is_empty() { "none" } else { &format }
            ));
        }
        if !seen_canonical.insert(canonical.clone()) {
            return Err(format!(
                "Duplicate input file detected: {}",
                canonical.display()
            ));
        }
        canonical_sources.push(canonical);
    }

    let capability = registry
        .find_capability_for_operation("pdf", "pdf", OperationKind::MergePdf)
        .ok_or_else(|| {
            "PDF merge capability is not available on this system (requires Poppler pdfunite)."
                .to_string()
        })?;

    let output_path = match output_path_opt {
        Some(custom) if !custom.trim().is_empty() => PathBuf::from(custom.trim()),
        _ => {
            let first_input = &canonical_sources[0];
            let stem = first_input
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("document");
            let default_name = format!("{stem}-merged.pdf");
            first_input
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(default_name)
        }
    };

    // Always reject source/output aliasing and missing parent at plan time.
    for input in &canonical_sources {
        validate_output_destination(input, &output_path)?;
    }

    let source_strings: Vec<String> = canonical_sources
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let primary_source = source_strings[0].clone();

    Ok(ConversionJob {
        id: Uuid::new_v4().to_string(),
        source_path: primary_source,
        source_paths: source_strings,
        source_format: "pdf".into(),
        target_format: "pdf".into(),
        output_path: output_path.to_string_lossy().into_owned(),
        operation: capability.operation,
        engine: capability.engine,
        status: JobStatus::Planned,
        error: None,
        created_at: timestamp(),
        completed_at: None,
        page_selection: None,
        overwrite,
    })
}

/// Plan a PDF page extraction job.
pub fn plan_extract_pages_job(
    registry: &CapabilityRegistry,
    source_path_str: &str,
    pages: &[u32],
    output_path_opt: Option<&str>,
    overwrite: bool,
) -> Result<ConversionJob, String> {
    if pages.is_empty() {
        return Err("No pages selected for extraction.".into());
    }

    let source_path = Path::new(source_path_str);
    let canonical_source = canonical_regular_file(source_path)?;
    let format = extension_from_path(&canonical_source);
    if format != "pdf" {
        return Err(format!(
            "Source file '{}' is not a PDF (found: .{}).",
            canonical_source.display(),
            if format.is_empty() { "none" } else { &format }
        ));
    }

    let max_pages = get_pdf_page_count(&canonical_source)?;
    let mut seen = std::collections::HashSet::new();
    for &p in pages {
        if p == 0 {
            return Err("Page numbers are 1-based; page 0 is invalid.".into());
        }
        if p > max_pages {
            return Err(format!(
                "Page {p} exceeds document's total page count ({max_pages})."
            ));
        }
        if !seen.insert(p) {
            return Err(format!("Duplicate page {p} in page selection."));
        }
    }

    let capability = registry
        .find_capability_for_operation("pdf", "pdf", OperationKind::ExtractPages)
        .ok_or_else(|| {
            "PDF page extraction capability is not available on this system \
             (requires Poppler pdfseparate, pdfunite, and pdfinfo)."
                .to_string()
        })?;

    let output_path = match output_path_opt {
        Some(custom) if !custom.trim().is_empty() => PathBuf::from(custom.trim()),
        _ => {
            let stem = canonical_source
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("document");
            let default_name = format!("{stem}-extracted.pdf");
            canonical_source
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(default_name)
        }
    };

    validate_output_destination(&canonical_source, &output_path)?;

    let source_str = canonical_source.to_string_lossy().into_owned();

    Ok(ConversionJob {
        id: Uuid::new_v4().to_string(),
        source_path: source_str.clone(),
        source_paths: vec![source_str],
        source_format: "pdf".into(),
        target_format: "pdf".into(),
        output_path: output_path.to_string_lossy().into_owned(),
        operation: capability.operation,
        engine: capability.engine,
        status: JobStatus::Planned,
        error: None,
        created_at: timestamp(),
        completed_at: None,
        page_selection: Some(pages.to_vec()),
        overwrite,
    })
}

// ─── Job execution ────────────────────────────────────────────────────────────

/// Execute a conversion job.
///
/// # Security model
///
/// The WebView can supply a `ConversionJob` to the Tauri command boundary.
/// This function MUST NOT blindly trust the frontend-supplied job fields.
/// Before any file operation begins, it:
///
/// 1. Re-canonicalizes every source path and verifies each is a regular file.
/// 2. Verifies the operation and engine match a registered capability on the
///    current host.
/// 3. Re-validates the output path (existence, aliasing, parent directory).
/// 4. For page-selection operations, re-validates the selection against the
///    current page count of the document.
///
/// This means a tampered or stale job cannot force an unsupported operation,
/// reach an unexpected output path, or bypass the overwrite policy.
pub fn execute_job(job: &mut ConversionJob) -> Result<(), String> {
    let validation_result = validate_and_prepare_job(job);
    let (canonical_inputs, output_buf) = match validation_result {
        Ok(prepared) => prepared,
        Err(err) => {
            job.status = JobStatus::Failed;
            job.error = Some(err.clone());
            job.completed_at = Some(timestamp());
            return Err(err);
        }
    };

    job.status = JobStatus::Running;

    let result = execute_operation(job, &canonical_inputs, &output_buf);

    job.completed_at = Some(timestamp());
    match result {
        Ok(()) => {
            job.status = JobStatus::Completed;
            job.error = None;
            Ok(())
        }
        Err(err) => {
            job.status = JobStatus::Failed;
            job.error = Some(err.clone());
            Err(err)
        }
    }
}

fn validate_and_prepare_job(job: &mut ConversionJob) -> Result<(Vec<PathBuf>, PathBuf), String> {
    // ── Step 1: Validate and re-canonicalize source paths ─────────────────
    let raw_inputs: Vec<PathBuf> = if job.source_paths.is_empty() {
        vec![PathBuf::from(&job.source_path)]
    } else {
        job.source_paths.iter().map(PathBuf::from).collect()
    };
    if raw_inputs.is_empty() {
        return Err("No source files specified in job.".to_string());
    }

    let mut canonical_inputs: Vec<PathBuf> = Vec::with_capacity(raw_inputs.len());
    for raw in &raw_inputs {
        let canonical = canonical_regular_file(raw)
            .map_err(|e| format!("Source file is no longer accessible: {e}"))?;
        canonical_inputs.push(canonical);
    }

    // ── Step 2: Authoritatively derive source format from canonical source ─
    let actual_source_format = if job.operation == OperationKind::MergePdf {
        if canonical_inputs.len() < 2 {
            return Err("PDF merge requires at least 2 source files.".to_string());
        }
        for c in &canonical_inputs {
            let fmt = extension_from_path(c);
            if fmt != "pdf" {
                return Err(format!(
                    "Source file '{}' is not a PDF (found: .{}).",
                    c.display(),
                    if fmt.is_empty() { "none" } else { &fmt }
                ));
            }
        }
        let claimed_source_format = normalize_format(&job.source_format);
        if claimed_source_format != "pdf" {
            return Err(format!(
                "Source format mismatch: MergePdf requires 'pdf', but job claimed '.{claimed_source_format}'."
            ));
        }
        "pdf".to_string()
    } else {
        if canonical_inputs.len() > 1 {
            return Err(format!(
                "Operation '{:?}' only supports a single source file.",
                job.operation
            ));
        }
        let derived_fmt = extension_from_path(&canonical_inputs[0]);
        if derived_fmt.is_empty() {
            return Err("Source file has no extension.".into());
        }
        let claimed_source_format = normalize_format(&job.source_format);
        if claimed_source_format != derived_fmt {
            return Err(format!(
                "Source format mismatch: document is '.{derived_fmt}', but job claimed '.{claimed_source_format}'."
            ));
        }
        if job.operation == OperationKind::ExtractPages && derived_fmt != "pdf" {
            return Err(format!(
                "Source file '{}' is not a PDF (found: .{}).",
                canonical_inputs[0].display(),
                derived_fmt
            ));
        }
        derived_fmt
    };

    // ── Step 3: Target format & exact capability and engine resolution ─────
    let registry = CapabilityRegistry::new();
    let target_format = normalize_format(&job.target_format);
    if target_format.is_empty() {
        return Err("Target format is required.".to_string());
    }

    let capability = registry
        .find_capability_for_operation(&actual_source_format, &target_format, job.operation)
        .ok_or_else(|| {
            if job.operation == OperationKind::RotatePages {
                "PDF page rotation is not supported on this system. qpdf is required but not installed.".to_string()
            } else {
                format!(
                    "No conversion capability available for operation '{:?}' from '.{actual_source_format}' to '.{target_format}'.",
                    job.operation
                )
            }
        })?;

    if job.engine != capability.engine {
        return Err(format!(
            "Engine mismatch: job specified engine '{:?}', but registered capability requires '{:?}'.",
            job.engine, capability.engine
        ));
    }

    // Update job formats to canonical normalized forms
    job.source_format = actual_source_format;
    job.target_format = target_format;

    // ── Step 4: Validate output path ──────────────────────────────────────
    let output = PathBuf::from(&job.output_path);
    let input_refs: Vec<&Path> = canonical_inputs.iter().map(|p| p.as_path()).collect();
    validate_output_path(&input_refs, &output, job.overwrite)?;

    // ── Step 5: Operation-specific parameter validation ───────────────────
    if job.operation == OperationKind::ExtractPages {
        let pages = job
            .page_selection
            .as_ref()
            .ok_or_else(|| "Page selection is missing from extract-pages job.".to_string())?;
        if pages.is_empty() {
            return Err("No pages selected for extraction.".to_string());
        }
        // Re-validate page selection against the actual current document.
        let source = &canonical_inputs[0];
        let max_pages = get_pdf_page_count(source)?;
        let mut seen = std::collections::HashSet::new();
        for &p in pages {
            if p == 0 {
                return Err("Page numbers are 1-based; page 0 is invalid.".to_string());
            }
            if p > max_pages {
                return Err(format!(
                    "Page {p} exceeds document's current page count ({max_pages})."
                ));
            }
            if !seen.insert(p) {
                return Err(format!("Duplicate page {p} in page selection."));
            }
        }
    }

    // For MergePdf validate no duplicate canonical sources
    if job.operation == OperationKind::MergePdf {
        let mut seen = std::collections::HashSet::new();
        for c in &canonical_inputs {
            if !seen.insert(c.clone()) {
                return Err(format!("Duplicate source file detected: {}", c.display()));
            }
        }
    }

    Ok((canonical_inputs, output))
}

/// Inner: performs the actual file operation. Called only after full validation.
fn execute_operation(job: &ConversionJob, inputs: &[PathBuf], output: &Path) -> Result<(), String> {
    match job.operation {
        OperationKind::ExtractPages => {
            let pages = job.page_selection.as_ref().unwrap(); // validated above

            let temp_dir_guard = TempDirGuard::new("clio-extract")?;
            let temp_dir = temp_dir_guard.path();
            let input = &inputs[0];

            if pages.len() == 1 {
                let p = pages[0];
                let p_str = p.to_string();
                let pattern = temp_dir.join(format!("page_{p}_%d.pdf"));
                let mut cmd = Command::new("pdfseparate");
                cmd.arg("-f")
                    .arg(&p_str)
                    .arg("-l")
                    .arg(&p_str)
                    .arg(input)
                    .arg(&pattern);
                run_command(&mut cmd, "Poppler (pdfseparate)")?;

                let generated_page = temp_dir.join(format!("page_{p}_{p}.pdf"));
                if !generated_page.exists() {
                    return Err(format!(
                        "Extracted page file was not generated for page {p}."
                    ));
                }
                fs::copy(&generated_page, output)
                    .map_err(|e| format!("Could not write extracted PDF output: {e}"))?;
            } else {
                // Extract unique pages (deduplication already validated, this is a safety net)
                let mut unique_pages = pages.clone();
                unique_pages.sort_unstable();
                unique_pages.dedup();

                for &p in &unique_pages {
                    let p_str = p.to_string();
                    let pattern = temp_dir.join(format!("page_{p}_%d.pdf"));
                    let mut cmd = Command::new("pdfseparate");
                    cmd.arg("-f")
                        .arg(&p_str)
                        .arg("-l")
                        .arg(&p_str)
                        .arg(input)
                        .arg(&pattern);
                    run_command(&mut cmd, "Poppler (pdfseparate)")?;
                }

                // Assemble in the requested order (which may differ from sort order)
                let mut cmd = Command::new("pdfunite");
                for &p in pages {
                    let page_file = temp_dir.join(format!("page_{p}_{p}.pdf"));
                    if !page_file.exists() {
                        return Err(format!("Extracted page file was not found for page {p}."));
                    }
                    cmd.arg(&page_file);
                }
                cmd.arg(output);
                run_command(&mut cmd, "Poppler (pdfunite)")?;
            }

            // temp_dir_guard drops here → temp directory and all fragments cleaned up
            Ok(())
        }

        OperationKind::MergePdf => {
            let mut cmd = Command::new("pdfunite");
            for input in inputs {
                cmd.arg(input);
            }
            cmd.arg(output);
            run_command(&mut cmd, "Poppler (pdfunite)")
        }

        OperationKind::ExtractText => {
            let input = &inputs[0];
            run_command(
                Command::new("pdftotext").arg(input).arg(output),
                "Poppler (pdftotext)",
            )
        }

        OperationKind::Convert => match job.engine {
            ConversionEngine::Poppler => {
                let input = &inputs[0];
                run_command(
                    Command::new("pdftotext").arg(input).arg(output),
                    "Poppler (pdftotext)",
                )
            }
            ConversionEngine::Pandoc => {
                let input = &inputs[0];
                run_command(
                    Command::new("pandoc").arg(input).arg("-o").arg(output),
                    "Pandoc",
                )
            }
            ConversionEngine::PopplerPandoc => {
                let input = &inputs[0];
                let temp_guard = TempFileGuard::new("clio-conv", "txt");
                run_command(
                    Command::new("pdftotext").arg(input).arg(temp_guard.path()),
                    "Poppler (pdftotext)",
                )?;
                run_command(
                    Command::new("pandoc")
                        .arg(temp_guard.path())
                        .arg("-o")
                        .arg(output),
                    "Pandoc",
                )
                // temp_guard drops here → intermediate txt cleaned up
            }
        },

        OperationKind::RotatePages => {
            Err("PDF page rotation is not supported on this system.".to_string())
        }
    }
}

// ─── Tauri Command Handlers ───────────────────────────────────────────────────

#[tauri::command]
pub fn conversion_capabilities(
    source_format: Option<String>,
) -> Result<Vec<ConversionCapability>, String> {
    let registry = CapabilityRegistry::new();
    Ok(registry.list_capabilities(source_format.as_deref()))
}

#[tauri::command]
pub fn conversion_plan_job(
    source_path: String,
    target_format: String,
    output_path: Option<String>,
    overwrite: Option<bool>,
) -> Result<ConversionJob, String> {
    let registry = CapabilityRegistry::new();
    plan_job(
        &registry,
        &source_path,
        &target_format,
        output_path.as_deref(),
        overwrite.unwrap_or(false),
    )
}

#[tauri::command]
pub fn conversion_plan_merge_job(
    source_paths: Vec<String>,
    output_path: Option<String>,
    overwrite: Option<bool>,
) -> Result<ConversionJob, String> {
    let registry = CapabilityRegistry::new();
    plan_merge_job(
        &registry,
        &source_paths,
        output_path.as_deref(),
        overwrite.unwrap_or(false),
    )
}

#[tauri::command]
pub fn conversion_parse_page_selection(
    source_path: String,
    range_string: String,
) -> Result<Vec<u32>, String> {
    let source = Path::new(&source_path);
    let canonical = canonical_regular_file(source)?;
    let max_pages = get_pdf_page_count(&canonical)?;
    parse_page_selection(&range_string, max_pages)
}

#[tauri::command]
pub fn conversion_pdf_page_count(source_path: String) -> Result<u32, String> {
    let source = Path::new(&source_path);
    let canonical = canonical_regular_file(source)?;
    get_pdf_page_count(&canonical)
}

#[tauri::command]
pub fn conversion_plan_extract_pages_job(
    source_path: String,
    page_selection: Vec<u32>,
    output_path: Option<String>,
    overwrite: Option<bool>,
) -> Result<ConversionJob, String> {
    let registry = CapabilityRegistry::new();
    plan_extract_pages_job(
        &registry,
        &source_path,
        &page_selection,
        output_path.as_deref(),
        overwrite.unwrap_or(false),
    )
}

/// Execute a previously planned job.
///
/// The job fields supplied by the frontend are fully re-validated inside
/// `execute_job` before any file operations occur. The frontend cannot
/// bypass the planner's security checks by submitting a crafted job.
#[tauri::command]
pub fn conversion_execute_job(mut job: ConversionJob) -> Result<ConversionJob, String> {
    execute_job(&mut job)?;
    Ok(job)
}

#[tauri::command]
pub fn convert_document(
    input_path: String,
    output_path: String,
    output_format: String,
) -> Result<ConversionResult, String> {
    let registry = CapabilityRegistry::new();
    let mut job = plan_job(
        &registry,
        &input_path,
        &output_format,
        Some(&output_path),
        false,
    )?;
    execute_job(&mut job)?;
    Ok(ConversionResult {
        output_path: job.output_path,
        engine: job.engine.display_name().into(),
    })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_capability_registry_initialization_and_filtering() {
        let registry = CapabilityRegistry::new();

        // 1. All capabilities list is non-empty
        let all = registry.list_capabilities(None);
        assert!(!all.is_empty());

        // 2. RotatePages is never advertised (no backend on this host)
        assert!(
            all.iter()
                .all(|c| c.operation != OperationKind::RotatePages),
            "RotatePages must not appear in capabilities without qpdf"
        );

        // 3. Filter by PDF: txt + 5×convert + merge? + extract-pages?
        let pdf_caps = registry.list_capabilities(Some("pdf"));
        let extract_pages_available = is_tool_installed("pdfseparate")
            && is_tool_installed("pdfunite")
            && is_tool_installed("pdfinfo");
        let expected_pdf_caps = if is_tool_installed("pdfunite") {
            if extract_pages_available {
                8
            } else {
                7
            }
        } else if extract_pages_available {
            7
        } else {
            6
        };
        assert_eq!(pdf_caps.len(), expected_pdf_caps);
        if is_tool_installed("pdfunite") {
            let merge_cap =
                registry.find_capability_for_operation("pdf", "pdf", OperationKind::MergePdf);
            assert!(merge_cap.is_some());
            assert_eq!(merge_cap.unwrap().operation, OperationKind::MergePdf);
        }
        if extract_pages_available {
            let extract_cap =
                registry.find_capability_for_operation("pdf", "pdf", OperationKind::ExtractPages);
            assert!(extract_cap.is_some());
            assert_eq!(extract_cap.unwrap().operation, OperationKind::ExtractPages);
        }

        // 4. Manipulation ops do not appear in supported_targets_for
        let targets = registry.supported_targets_for("pdf");
        assert!(targets.contains(&"txt".to_string()));
        assert!(targets.contains(&"md".to_string()));
        assert!(targets.contains(&"html".to_string()));
        assert!(targets.contains(&"docx".to_string()));
        assert!(targets.contains(&"odt".to_string()));
        assert!(targets.contains(&"epub".to_string()));
        assert!(!targets.contains(&"pdf".to_string())); // No identity or self-convert

        let md_caps = registry.list_capabilities(Some(".MD")); // Case and leading dot normalized
        assert_eq!(md_caps.len(), 5);
        let md_targets = registry.supported_targets_for("md");
        assert!(md_targets.contains(&"docx".to_string()));
        assert!(md_targets.contains(&"epub".to_string()));
        assert!(!md_targets.contains(&"md".to_string())); // No md -> md
        assert!(!md_targets.contains(&"pdf".to_string())); // No unbacked pdf output

        // 5. Unsupported source
        let unknown = registry.list_capabilities(Some("xyz"));
        assert!(unknown.is_empty());
        assert!(!registry.is_supported_source("xyz"));
    }

    #[test]
    fn test_format_normalization() {
        assert_eq!(normalize_format(".MD"), "md");
        assert_eq!(normalize_format(".markdown"), "md");
        assert_eq!(normalize_format("MARKDOWN"), "md");
        assert_eq!(normalize_format("HTM"), "html");
        assert_eq!(normalize_format(".htm"), "html");
        assert_eq!(normalize_format("  .Docx  "), "docx");
        assert_eq!(normalize_format("jpeg"), "jpg");
    }

    #[test]
    fn test_plan_job_validation_and_construction() {
        let registry = CapabilityRegistry::new();
        let temp_dir = std::env::temp_dir().join(format!("clio-plan-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");
        let source_file = temp_dir.join("sample.md");
        fs::write(&source_file, b"# Test Markdown").expect("write sample");

        // 1. Valid plan with auto-generated output path
        let job = plan_job(
            &registry,
            &source_file.to_string_lossy(),
            "html",
            None,
            false,
        )
        .expect("plan job");
        assert_eq!(job.source_format, "md");
        assert_eq!(job.target_format, "html");
        assert_eq!(job.engine, ConversionEngine::Pandoc);
        assert_eq!(job.status, JobStatus::Planned);
        assert!(job.output_path.ends_with("sample.html"));
        assert!(!job.overwrite);

        // 2. Plan with overwrite=true propagates the flag
        let job_ow = plan_job(
            &registry,
            &source_file.to_string_lossy(),
            "html",
            None,
            true,
        )
        .unwrap();
        assert!(job_ow.overwrite);

        // 3. Reject unsupported target (e.g. md -> pdf which has no pdf engine)
        let unbacked = plan_job(
            &registry,
            &source_file.to_string_lossy(),
            "pdf",
            None,
            false,
        );
        assert!(unbacked.is_err());

        // 4. Reject same input and output path
        let same_path = plan_job(
            &registry,
            &source_file.to_string_lossy(),
            "html",
            Some(&source_file.to_string_lossy()),
            false,
        );
        assert!(same_path.is_err());

        // 5. Reject non-existent source
        let non_existent = plan_job(
            &registry,
            &temp_dir.join("missing.md").to_string_lossy(),
            "html",
            None,
            false,
        );
        assert!(non_existent.is_err());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_temp_file_guard_cleanup() {
        let path = {
            let guard = TempFileGuard::new("clio-test-guard", "txt");
            fs::write(guard.path(), b"guard content").expect("write guard file");
            assert!(guard.path().exists());
            guard.path().to_path_buf()
        }; // guard drops here
        assert!(!path.exists(), "temp file must be deleted on drop");
    }

    #[test]
    fn test_temp_dir_guard_cleanup() {
        let (dir_path, file_path) = {
            let guard = TempDirGuard::new("clio-test-dir-guard").expect("create temp dir");
            let fpath = guard.path().join("inner.txt");
            fs::write(&fpath, b"content").expect("write inner file");
            assert!(guard.path().exists());
            assert!(fpath.exists());
            (guard.path().to_path_buf(), fpath)
        }; // guard drops here
        assert!(!dir_path.exists(), "temp dir must be removed on drop");
        assert!(!file_path.exists(), "files inside temp dir must be removed");
    }

    // ── Overwrite policy ──────────────────────────────────────────────────────

    #[test]
    fn test_overwrite_policy() {
        let temp_dir = std::env::temp_dir().join(format!("clio-ow-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let input = temp_dir.join("input.txt");
        let output = temp_dir.join("output.txt");
        fs::write(&input, b"input").expect("write input");

        // 1. Output does not exist → always allowed
        assert!(validate_output_path(&[input.as_path()], &output, false).is_ok());
        assert!(validate_output_path(&[input.as_path()], &output, true).is_ok());

        // 2. Output exists + overwrite=false → rejected
        fs::write(&output, b"existing").expect("write existing output");
        let err = validate_output_path(&[input.as_path()], &output, false);
        assert!(
            err.is_err(),
            "must reject existing output when overwrite=false"
        );
        assert!(err.unwrap_err().contains("already exists"));

        // 3. Output exists + overwrite=true → allowed
        assert!(validate_output_path(&[input.as_path()], &output, true).is_ok());

        // 4. Source/output alias → always rejected, even with overwrite=true
        let alias_err = validate_output_path(&[input.as_path()], &input, true);
        assert!(
            alias_err.is_err(),
            "source/output alias must always be rejected"
        );

        // 5. Missing parent directory → rejected
        let missing_parent = temp_dir.join("nonexistent").join("out.txt");
        assert!(validate_output_path(&[input.as_path()], &missing_parent, false).is_err());
        assert!(validate_output_path(&[input.as_path()], &missing_parent, true).is_err());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_overwrite_through_execute_job() {
        // This test exercises the overwrite policy through the full execute_job
        // boundary, using a real Pandoc conversion.
        let registry = CapabilityRegistry::new();
        let temp_dir = std::env::temp_dir().join(format!("clio-ow-exec-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let source = temp_dir.join("doc.md");
        let output = temp_dir.join("doc.html");
        fs::write(&source, b"# Hello").expect("write source");

        // First run — output absent, overwrite=false → success
        let mut job = plan_job(
            &registry,
            &source.to_string_lossy(),
            "html",
            Some(&output.to_string_lossy()),
            false,
        )
        .expect("plan");
        execute_job(&mut job).expect("first execute");
        assert_eq!(job.status, JobStatus::Completed);
        assert!(output.exists());

        // Second run — output exists, overwrite=false → rejected at execute time
        let mut job2 = plan_job(
            &registry,
            &source.to_string_lossy(),
            "html",
            Some(&output.to_string_lossy()),
            false,
        )
        .expect("plan second");
        let err = execute_job(&mut job2);
        assert!(
            err.is_err(),
            "execute must reject existing output when overwrite=false"
        );
        assert_eq!(job2.status, JobStatus::Failed);
        assert!(job2.error.is_some());

        // Third run — overwrite=true → succeeds
        let mut job3 = plan_job(
            &registry,
            &source.to_string_lossy(),
            "html",
            Some(&output.to_string_lossy()),
            true,
        )
        .expect("plan third");
        execute_job(&mut job3).expect("overwrite execute");
        assert_eq!(job3.status, JobStatus::Completed);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    // ── Execution boundary hardening ──────────────────────────────────────────

    #[test]
    fn test_execute_job_rejects_rotate_pages() {
        // RotatePages has no capability and must always fail at execute time.
        let temp_dir = std::env::temp_dir().join(format!("clio-rot-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create");
        let src = temp_dir.join("s.pdf");
        fs::write(&src, b"%PDF-1.4 dummy").expect("write");

        let mut job = ConversionJob {
            id: "fake-rotate".into(),
            source_path: src.to_string_lossy().into(),
            source_paths: vec![src.to_string_lossy().into()],
            source_format: "pdf".into(),
            target_format: "pdf".into(),
            output_path: temp_dir.join("out.pdf").to_string_lossy().into(),
            operation: OperationKind::RotatePages,
            engine: ConversionEngine::Poppler,
            status: JobStatus::Planned,
            error: None,
            created_at: timestamp(),
            completed_at: None,
            page_selection: None,
            overwrite: false,
        };

        let err = execute_job(&mut job);
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("rotation"));
        assert_eq!(job.status, JobStatus::Failed);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_execute_job_rejects_nonexistent_source() {
        let mut job = ConversionJob {
            id: "test".into(),
            source_path: "/tmp/clio_nonexistent_source_99999.md".into(),
            source_paths: vec!["/tmp/clio_nonexistent_source_99999.md".into()],
            source_format: "md".into(),
            target_format: "html".into(),
            output_path: "/tmp/clio_nonexistent_out_99999.html".into(),
            operation: OperationKind::Convert,
            engine: ConversionEngine::Pandoc,
            status: JobStatus::Planned,
            error: None,
            created_at: timestamp(),
            completed_at: None,
            page_selection: None,
            overwrite: false,
        };

        let err = execute_job(&mut job);
        assert!(err.is_err());
        assert_eq!(job.status, JobStatus::Failed);
        assert!(job.error.is_some());
    }

    #[test]
    fn test_execute_job_rejects_unsupported_operation_engine_combo() {
        // Submitting a job with Pandoc engine for a MergePdf operation must fail
        // at the capability re-validation step.
        let temp_dir = std::env::temp_dir().join(format!("clio-eng-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create");
        let src = temp_dir.join("s.pdf");
        fs::write(&src, b"%PDF-1.4").expect("write");

        let mut job = ConversionJob {
            id: "crafted".into(),
            source_path: src.to_string_lossy().into(),
            source_paths: vec![src.to_string_lossy().into(), src.to_string_lossy().into()],
            source_format: "pdf".into(),
            target_format: "pdf".into(),
            output_path: temp_dir.join("out.pdf").to_string_lossy().into(),
            operation: OperationKind::MergePdf,
            engine: ConversionEngine::Pandoc, // wrong engine
            status: JobStatus::Planned,
            error: None,
            created_at: timestamp(),
            completed_at: None,
            page_selection: None,
            overwrite: false,
        };

        let err = execute_job(&mut job);
        assert!(err.is_err());
        assert_eq!(job.status, JobStatus::Failed);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    // ── Job lifecycle ─────────────────────────────────────────────────────────

    #[test]
    fn test_job_lifecycle_completed() {
        let registry = CapabilityRegistry::new();
        let temp_dir = std::env::temp_dir().join(format!("clio-lc-ok-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create");

        let source = temp_dir.join("doc.md");
        let output = temp_dir.join("doc.html");
        fs::write(&source, b"# Hello").expect("write");

        let mut job = plan_job(
            &registry,
            &source.to_string_lossy(),
            "html",
            Some(&output.to_string_lossy()),
            false,
        )
        .expect("plan");

        assert_eq!(job.status, JobStatus::Planned);
        assert!(job.completed_at.is_none());

        execute_job(&mut job).expect("execute");

        assert_eq!(job.status, JobStatus::Completed);
        assert!(job.completed_at.is_some());
        assert!(job.error.is_none());
        assert!(output.exists());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_job_lifecycle_failed() {
        // Force a failure by pointing at a non-existent source.
        let mut job = ConversionJob {
            id: "fail".into(),
            source_path: "/tmp/clio_no_such_source.md".into(),
            source_paths: vec!["/tmp/clio_no_such_source.md".into()],
            source_format: "md".into(),
            target_format: "html".into(),
            output_path: "/tmp/clio_no_such_output.html".into(),
            operation: OperationKind::Convert,
            engine: ConversionEngine::Pandoc,
            status: JobStatus::Planned,
            error: None,
            created_at: timestamp(),
            completed_at: None,
            page_selection: None,
            overwrite: false,
        };

        assert_eq!(job.status, JobStatus::Planned);
        let err = execute_job(&mut job);
        assert!(err.is_err());
        assert_eq!(job.status, JobStatus::Failed);
        assert!(job.error.is_some(), "failed job must have error message");
        // completed_at is set even on failure (records when the job ended)
        assert!(job.completed_at.is_some());
    }

    // ── Temporary file safety ─────────────────────────────────────────────────

    #[test]
    fn test_extract_pages_temp_dir_cleaned_up_on_success() {
        if !is_tool_installed("pdfseparate")
            || !is_tool_installed("pdfunite")
            || !is_tool_installed("pdfinfo")
        {
            return;
        }

        let temp_dir = std::env::temp_dir().join(format!("clio-tmp-ok-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create");
        let source = temp_dir.join("source.pdf");
        fs::write(&source, MINIMAL_PDF).expect("write");

        let output = temp_dir.join("extracted.pdf");
        let registry = CapabilityRegistry::new();
        let mut job = plan_extract_pages_job(
            &registry,
            &source.to_string_lossy(),
            &[1],
            Some(&output.to_string_lossy()),
            false,
        )
        .expect("plan");

        execute_job(&mut job).expect("execute");
        assert!(output.exists());

        // Count temp dirs created by Clio in /tmp — there should be none
        // named clio-extract-* after the job completes.
        let tmp = std::env::temp_dir();
        let leaked: Vec<_> = fs::read_dir(&tmp)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                name.starts_with("clio-extract-") && !name.starts_with("clio-extract-test-")
            })
            .collect();
        assert!(
            leaked.is_empty(),
            "temp extraction dirs must be cleaned up: {:?}",
            leaked
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    // ── Page selection parser ─────────────────────────────────────────────────

    #[test]
    fn test_parse_page_selection_valid() {
        assert_eq!(parse_page_selection("1", 10).unwrap(), vec![1]);
        assert_eq!(parse_page_selection("10", 10).unwrap(), vec![10]);
        assert_eq!(parse_page_selection("1-3", 10).unwrap(), vec![1, 2, 3]);
        assert_eq!(
            parse_page_selection("1-3,7,10-12", 20).unwrap(),
            vec![1, 2, 3, 7, 10, 11, 12]
        );
        assert_eq!(parse_page_selection("5,2,8", 10).unwrap(), vec![5, 2, 8]);
        assert!(parse_page_selection("5-3", 10).is_err());
        assert_eq!(
            parse_page_selection(" 1 - 3 , 5 ", 10).unwrap(),
            vec![1, 2, 3, 5]
        );
    }

    #[test]
    fn test_parse_page_selection_errors() {
        assert!(parse_page_selection("", 10).is_err());
        assert!(parse_page_selection("  ", 10).is_err());
        assert!(parse_page_selection("0", 10).is_err());
        assert!(parse_page_selection("0-3", 10).is_err());
        assert!(parse_page_selection("1-0", 10).is_err());
        assert!(parse_page_selection("11", 10).is_err());
        assert!(parse_page_selection("8-11", 10).is_err());
        assert!(parse_page_selection("1-3,2", 10).is_err());
        assert!(parse_page_selection("5,5", 10).is_err());
        assert!(parse_page_selection("abc", 10).is_err());
        assert!(parse_page_selection("1-2-3", 10).is_err());
        assert!(parse_page_selection(",1", 10).is_err());
        assert!(parse_page_selection("1,", 10).is_err());
        assert!(parse_page_selection("-1", 10).is_err());
        assert!(parse_page_selection("1-", 10).is_err());
    }

    const MINIMAL_PDF: &[u8] = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 3 3]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n162\n%%EOF\n";

    #[test]
    fn test_plan_merge_job_validation_and_construction() {
        let registry = CapabilityRegistry::new();
        if !is_tool_installed("pdfunite") {
            return;
        }

        let temp_dir = std::env::temp_dir().join(format!("clio-merge-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let p1 = temp_dir.join("doc1.pdf");
        let p2 = temp_dir.join("doc2.pdf");
        let p3 = temp_dir.join("doc3.pdf");
        let txt_file = temp_dir.join("doc4.txt");

        fs::write(&p1, MINIMAL_PDF).expect("write p1");
        fs::write(&p2, MINIMAL_PDF).expect("write p2");
        fs::write(&p3, MINIMAL_PDF).expect("write p3");
        fs::write(&txt_file, b"not a pdf").expect("write txt");

        let two_files = vec![
            p1.to_string_lossy().into_owned(),
            p2.to_string_lossy().into_owned(),
        ];
        let job2 = plan_merge_job(&registry, &two_files, None, false).expect("plan two-file merge");
        assert_eq!(job2.operation, OperationKind::MergePdf);
        assert_eq!(job2.engine, ConversionEngine::Poppler);
        assert_eq!(job2.status, JobStatus::Planned);
        assert_eq!(job2.source_format, "pdf");
        assert_eq!(job2.target_format, "pdf");
        assert_eq!(job2.source_paths.len(), 2);
        assert!(job2.output_path.ends_with("doc1-merged.pdf"));
        assert!(!job2.overwrite);

        let three_files = vec![
            p1.to_string_lossy().into_owned(),
            p2.to_string_lossy().into_owned(),
            p3.to_string_lossy().into_owned(),
        ];
        let custom_out = temp_dir.join("custom_merged.pdf");
        let job3 = plan_merge_job(
            &registry,
            &three_files,
            Some(&custom_out.to_string_lossy()),
            true,
        )
        .expect("plan three-file merge");
        assert_eq!(job3.source_paths.len(), 3);
        assert_eq!(job3.output_path, custom_out.to_string_lossy());
        assert!(job3.overwrite);

        // Fewer than two inputs rejected
        let one_file = vec![p1.to_string_lossy().into_owned()];
        assert!(plan_merge_job(&registry, &one_file, None, false).is_err());
        let zero_files: Vec<String> = vec![];
        assert!(plan_merge_job(&registry, &zero_files, None, false).is_err());

        // Non-PDF input rejected
        let mixed = vec![
            p1.to_string_lossy().into_owned(),
            txt_file.to_string_lossy().into_owned(),
        ];
        let res_mixed = plan_merge_job(&registry, &mixed, None, false);
        assert!(res_mixed.is_err());
        assert!(res_mixed.unwrap_err().contains("not a PDF"));

        // Duplicate input rejected
        let dupes = vec![
            p1.to_string_lossy().into_owned(),
            p1.to_string_lossy().into_owned(),
        ];
        let res_dupes = plan_merge_job(&registry, &dupes, None, false);
        assert!(res_dupes.is_err());
        assert!(res_dupes.unwrap_err().contains("Duplicate input"));

        // Input/output canonical collision rejected
        let collision = plan_merge_job(&registry, &two_files, Some(&p1.to_string_lossy()), false);
        assert!(collision.is_err());

        // Missing input rejected
        let missing = vec![
            p1.to_string_lossy().into_owned(),
            temp_dir
                .join("nonexistent.pdf")
                .to_string_lossy()
                .into_owned(),
        ];
        assert!(plan_merge_job(&registry, &missing, None, false).is_err());

        // Invalid output directory rejected
        let bad_out = temp_dir.join("nonexistent_folder").join("out.pdf");
        assert!(plan_merge_job(
            &registry,
            &two_files,
            Some(&bad_out.to_string_lossy()),
            false
        )
        .is_err());

        // Integration execution with actual pdfunite
        let mut exec_job = job2;
        execute_job(&mut exec_job).expect("execute pdfunite merge");
        assert_eq!(exec_job.status, JobStatus::Completed);
        assert!(Path::new(&exec_job.output_path).exists());
        let meta = fs::metadata(&exec_job.output_path).expect("read merged metadata");
        assert!(meta.len() > 0);

        // Overwrite=false rejects second execution on same output
        let mut exec_job2 =
            plan_merge_job(&registry, &three_files, Some(&exec_job.output_path), false)
                .expect("plan merge 2");
        assert!(execute_job(&mut exec_job2).is_err());
        assert_eq!(exec_job2.status, JobStatus::Failed);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_plan_extract_pages_job_validation_and_construction() {
        let registry = CapabilityRegistry::new();
        if !is_tool_installed("pdfseparate")
            || !is_tool_installed("pdfunite")
            || !is_tool_installed("pdfinfo")
        {
            return;
        }

        let temp_dir = std::env::temp_dir().join(format!("clio-extract-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let source = temp_dir.join("source.pdf");
        fs::write(&source, MINIMAL_PDF).expect("write source pdf");
        let source_str = source.to_string_lossy().into_owned();

        // 1. Valid single-page plan
        let job = plan_extract_pages_job(&registry, &source_str, &[1], None, false)
            .expect("plan single-page extraction");
        assert_eq!(job.operation, OperationKind::ExtractPages);
        assert_eq!(job.engine, ConversionEngine::Poppler);
        assert_eq!(job.source_format, "pdf");
        assert_eq!(job.target_format, "pdf");
        assert_eq!(job.status, JobStatus::Planned);
        assert!(job.page_selection.as_ref().unwrap() == &vec![1u32]);
        assert!(job.output_path.ends_with("source-extracted.pdf"));
        assert!(!job.overwrite);

        // 2. Custom output path + overwrite
        let custom_out = temp_dir.join("out-custom.pdf");
        let job_custom = plan_extract_pages_job(
            &registry,
            &source_str,
            &[1],
            Some(&custom_out.to_string_lossy()),
            true,
        )
        .expect("plan custom output");
        assert_eq!(job_custom.output_path, custom_out.to_string_lossy());
        assert!(job_custom.overwrite);

        // 3. Empty pages rejected
        assert!(plan_extract_pages_job(&registry, &source_str, &[], None, false).is_err());

        // 4. Duplicate page rejected
        assert!(plan_extract_pages_job(&registry, &source_str, &[1, 1], None, false).is_err());

        // 5. Out-of-range page rejected
        assert!(plan_extract_pages_job(&registry, &source_str, &[999], None, false).is_err());

        // 6. Zero page rejected
        assert!(plan_extract_pages_job(&registry, &source_str, &[0], None, false).is_err());

        // 7. Non-PDF source rejected
        let txt_file = temp_dir.join("doc.txt");
        fs::write(&txt_file, b"hello").expect("write txt");
        assert!(
            plan_extract_pages_job(&registry, &txt_file.to_string_lossy(), &[1], None, false)
                .is_err()
        );

        // 8. Non-existent source rejected
        assert!(plan_extract_pages_job(
            &registry,
            "/tmp/nonexistent_clio_test.pdf",
            &[1],
            None,
            false
        )
        .is_err());

        // 9. Output/source canonical collision rejected
        assert!(
            plan_extract_pages_job(&registry, &source_str, &[1], Some(&source_str), false).is_err()
        );

        // 10. Integration: execute actual extraction
        let exec_out = temp_dir.join("exec-out.pdf");
        let mut exec_job = plan_extract_pages_job(
            &registry,
            &source_str,
            &[1],
            Some(&exec_out.to_string_lossy()),
            false,
        )
        .expect("plan exec job");
        execute_job(&mut exec_job).expect("execute extraction");
        assert_eq!(exec_job.status, JobStatus::Completed);
        assert!(exec_out.exists());
        let meta = fs::metadata(&exec_out).expect("read extracted metadata");
        assert!(meta.len() > 0);

        // 11. Overwrite=false rejects on existing output
        let mut exec_job2 = plan_extract_pages_job(
            &registry,
            &source_str,
            &[1],
            Some(&exec_out.to_string_lossy()),
            false,
        )
        .expect("plan second extraction");
        assert!(execute_job(&mut exec_job2).is_err());
        assert_eq!(exec_job2.status, JobStatus::Failed);

        // 12. Overwrite=true succeeds on existing output
        let mut exec_job3 = plan_extract_pages_job(
            &registry,
            &source_str,
            &[1],
            Some(&exec_out.to_string_lossy()),
            true,
        )
        .expect("plan third extraction");
        execute_job(&mut exec_job3).expect("overwrite extraction");
        assert_eq!(exec_job3.status, JobStatus::Completed);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    // ── Exact capability & engine binding tests (tampered WebView simulation) ──

    #[test]
    fn test_tampered_job_pdf_to_md_with_correct_engine_succeeds() {
        // TEST 1: Valid PDF → MD conversion job with the correct engine (PopplerPandoc).
        // Expected: accepted, planned, executable.
        if !is_tool_installed("pdftotext") || !is_tool_installed("pandoc") {
            return;
        }

        let registry = CapabilityRegistry::new();
        let temp_dir = std::env::temp_dir().join(format!("clio-t1-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let source = temp_dir.join("sample.pdf");
        fs::write(&source, MINIMAL_PDF).expect("write sample pdf");
        let output = temp_dir.join("sample.md");

        let mut job = plan_job(
            &registry,
            &source.to_string_lossy(),
            "md",
            Some(&output.to_string_lossy()),
            false,
        )
        .expect("plan job");

        assert_eq!(job.operation, OperationKind::Convert);
        assert_eq!(job.engine, ConversionEngine::PopplerPandoc);

        execute_job(&mut job).expect("execute valid job");
        assert_eq!(job.status, JobStatus::Completed);
        assert!(output.exists());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_tampered_job_pdf_to_md_with_wrong_engine_rejected() {
        // TEST 2: Same valid PDF → MD job but engine changed to Pandoc (bypassing PopplerPandoc).
        // Expected: rejected with Engine mismatch error.
        let registry = CapabilityRegistry::new();
        let temp_dir = std::env::temp_dir().join(format!("clio-t2-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let source = temp_dir.join("sample.pdf");
        fs::write(&source, MINIMAL_PDF).expect("write sample pdf");
        let output = temp_dir.join("sample.md");

        let mut job = plan_job(
            &registry,
            &source.to_string_lossy(),
            "md",
            Some(&output.to_string_lossy()),
            false,
        )
        .expect("plan job");

        // Tamper with engine: claim Pandoc instead of PopplerPandoc
        job.engine = ConversionEngine::Pandoc;

        let err = execute_job(&mut job);
        assert!(err.is_err());
        assert_eq!(job.status, JobStatus::Failed);
        let msg = err.unwrap_err();
        assert!(
            msg.contains("Engine mismatch"),
            "Expected 'Engine mismatch' in message, got: {msg}"
        );
        assert!(
            msg.contains("Pandoc") && msg.contains("PopplerPandoc"),
            "Expected both engines in message, got: {msg}"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_tampered_job_source_format_docx_on_pdf_file_rejected() {
        // TEST 3: Actual PDF source but source_format changed to DOCX.
        // Expected: rejected with Source format mismatch error.
        let registry = CapabilityRegistry::new();
        let temp_dir = std::env::temp_dir().join(format!("clio-t3-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let source = temp_dir.join("sample.pdf");
        fs::write(&source, MINIMAL_PDF).expect("write sample pdf");
        let output = temp_dir.join("sample.md");

        let mut job = plan_job(
            &registry,
            &source.to_string_lossy(),
            "md",
            Some(&output.to_string_lossy()),
            false,
        )
        .expect("plan job");

        // Tamper with source_format: relabel .pdf file as docx
        job.source_format = "docx".into();

        let err = execute_job(&mut job);
        assert!(err.is_err());
        assert_eq!(job.status, JobStatus::Failed);
        let msg = err.unwrap_err();
        assert!(
            msg.contains("Source format mismatch"),
            "Expected 'Source format mismatch' in message, got: {msg}"
        );
        assert!(
            msg.contains(".pdf") && msg.contains(".docx"),
            "Expected .pdf and .docx in message, got: {msg}"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_tampered_job_source_format_html_on_pdf_file_rejected() {
        // TEST 4: Actual PDF source but source_format changed to HTML.
        // Expected: rejected with Source format mismatch error.
        let registry = CapabilityRegistry::new();
        let temp_dir = std::env::temp_dir().join(format!("clio-t4-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let source = temp_dir.join("sample.pdf");
        fs::write(&source, MINIMAL_PDF).expect("write sample pdf");
        let output = temp_dir.join("sample.md");

        let mut job = plan_job(
            &registry,
            &source.to_string_lossy(),
            "md",
            Some(&output.to_string_lossy()),
            false,
        )
        .expect("plan job");

        // Tamper with source_format: relabel .pdf file as html
        job.source_format = "html".into();

        let err = execute_job(&mut job);
        assert!(err.is_err());
        assert_eq!(job.status, JobStatus::Failed);
        let msg = err.unwrap_err();
        assert!(
            msg.contains("Source format mismatch"),
            "Expected 'Source format mismatch' in message, got: {msg}"
        );
        assert!(
            msg.contains(".pdf") && msg.contains(".html"),
            "Expected .pdf and .html in message, got: {msg}"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_tampered_job_unsupported_target_format_rejected() {
        // TEST 5: Valid conversion with target format changed to an unsupported target.
        // Expected: rejected with No conversion capability available error.
        let registry = CapabilityRegistry::new();
        let temp_dir = std::env::temp_dir().join(format!("clio-t5-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let source = temp_dir.join("sample.md");
        fs::write(&source, b"# Markdown").expect("write sample md");
        let output = temp_dir.join("sample.xyz");

        let mut job = plan_job(
            &registry,
            &source.to_string_lossy(),
            "html",
            Some(&output.to_string_lossy()),
            false,
        )
        .expect("plan job");

        // Tamper with target_format: unsupported target format "xyz"
        job.target_format = "xyz".into();

        let err = execute_job(&mut job);
        assert!(err.is_err());
        assert_eq!(job.status, JobStatus::Failed);
        let msg = err.unwrap_err();
        assert!(
            msg.contains("No conversion capability available"),
            "Expected capability error, got: {msg}"
        );
        assert!(msg.contains(".xyz"), "Expected .xyz in message, got: {msg}");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_tampered_job_merge_pdf_operation_changed_to_convert_rejected() {
        // TEST 6: Valid MergePdf job with operation changed to Convert.
        // Expected: rejected because Convert pdf -> pdf does not exist (or multiple inputs for Convert).
        if !is_tool_installed("pdfunite") {
            return;
        }

        let registry = CapabilityRegistry::new();
        let temp_dir = std::env::temp_dir().join(format!("clio-t6-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let p1 = temp_dir.join("p1.pdf");
        let p2 = temp_dir.join("p2.pdf");
        fs::write(&p1, MINIMAL_PDF).expect("write p1");
        fs::write(&p2, MINIMAL_PDF).expect("write p2");

        let two_files = vec![
            p1.to_string_lossy().into_owned(),
            p2.to_string_lossy().into_owned(),
        ];
        let mut job = plan_merge_job(&registry, &two_files, None, false).expect("plan merge");

        // Tamper with operation: change MergePdf to Convert
        job.operation = OperationKind::Convert;

        let err = execute_job(&mut job);
        assert!(err.is_err());
        assert_eq!(job.status, JobStatus::Failed);
        let msg = err.unwrap_err();
        assert!(
            msg.contains("Convert"),
            "Expected 'Convert' mentioned in error, got: {msg}"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_tampered_job_extract_pages_operation_changed_to_convert_rejected() {
        // TEST 7: Valid ExtractPages job with operation changed to Convert.
        // Expected: rejected because Convert pdf -> pdf does not exist.
        if !is_tool_installed("pdfseparate")
            || !is_tool_installed("pdfunite")
            || !is_tool_installed("pdfinfo")
        {
            return;
        }

        let registry = CapabilityRegistry::new();
        let temp_dir = std::env::temp_dir().join(format!("clio-t7-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let source = temp_dir.join("source.pdf");
        fs::write(&source, MINIMAL_PDF).expect("write source pdf");

        let mut job =
            plan_extract_pages_job(&registry, &source.to_string_lossy(), &[1], None, false)
                .expect("plan extract pages");

        // Tamper with operation: change ExtractPages to Convert
        job.operation = OperationKind::Convert;

        let err = execute_job(&mut job);
        assert!(err.is_err());
        assert_eq!(job.status, JobStatus::Failed);
        let msg = err.unwrap_err();
        assert!(
            msg.contains(
                "No conversion capability available for operation 'Convert' from '.pdf' to '.pdf'"
            ),
            "Expected missing capability for Convert pdf->pdf, got: {msg}"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_tampered_job_rotate_pages_rejected_no_capability() {
        // TEST 8: RotatePages job with no registered capability.
        // Expected: rejected because RotatePages has no capability registered.
        let temp_dir = std::env::temp_dir().join(format!("clio-t8-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let source = temp_dir.join("source.pdf");
        fs::write(&source, MINIMAL_PDF).expect("write source pdf");

        let mut job = ConversionJob {
            id: Uuid::new_v4().to_string(),
            source_path: source.to_string_lossy().into(),
            source_paths: vec![source.to_string_lossy().into()],
            source_format: "pdf".into(),
            target_format: "pdf".into(),
            output_path: temp_dir.join("rotated.pdf").to_string_lossy().into(),
            operation: OperationKind::RotatePages,
            engine: ConversionEngine::Poppler,
            status: JobStatus::Planned,
            error: None,
            created_at: timestamp(),
            completed_at: None,
            page_selection: Some(vec![1]),
            overwrite: false,
        };

        let err = execute_job(&mut job);
        assert!(err.is_err());
        assert_eq!(job.status, JobStatus::Failed);
        let msg = err.unwrap_err();
        assert!(
            msg.contains("rotation"),
            "Expected 'rotation' in error message, got: {msg}"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_htm_html_normalization_and_tamper_rejection() {
        // TEST 9: Ensure htm/html normalization still behaves correctly.
        if !is_tool_installed("pandoc") {
            return;
        }

        let temp_dir = std::env::temp_dir().join(format!("clio-t9-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        let htm_source = temp_dir.join("document.htm");
        fs::write(&htm_source, b"<p>Hello Clio</p>").expect("write htm");
        let output = temp_dir.join("document.docx");

        // 1. Legitimate job on .htm file with source_format="htm" executes successfully
        let mut job_htm = ConversionJob {
            id: Uuid::new_v4().to_string(),
            source_path: htm_source.to_string_lossy().into(),
            source_paths: vec![htm_source.to_string_lossy().into()],
            source_format: "htm".into(),
            target_format: "docx".into(),
            output_path: output.to_string_lossy().into(),
            operation: OperationKind::Convert,
            engine: ConversionEngine::Pandoc,
            status: JobStatus::Planned,
            error: None,
            created_at: timestamp(),
            completed_at: None,
            page_selection: None,
            overwrite: false,
        };

        execute_job(&mut job_htm).expect("htm execute");
        assert_eq!(job_htm.status, JobStatus::Completed);
        assert_eq!(job_htm.source_format, "html"); // canonical normalized
        assert!(output.exists());

        // 2. Legitimate job on .htm file with source_format="html" also matches
        let output2 = temp_dir.join("document2.docx");
        let mut job_html = ConversionJob {
            id: Uuid::new_v4().to_string(),
            source_path: htm_source.to_string_lossy().into(),
            source_paths: vec![htm_source.to_string_lossy().into()],
            source_format: "html".into(),
            target_format: "docx".into(),
            output_path: output2.to_string_lossy().into(),
            operation: OperationKind::Convert,
            engine: ConversionEngine::Pandoc,
            status: JobStatus::Planned,
            error: None,
            created_at: timestamp(),
            completed_at: None,
            page_selection: None,
            overwrite: false,
        };

        execute_job(&mut job_html).expect("html execute");
        assert_eq!(job_html.status, JobStatus::Completed);
        assert_eq!(job_html.source_format, "html");

        // 3. Tampered job claiming source_format="docx" on .htm file is rejected
        let mut job_tampered = ConversionJob {
            id: Uuid::new_v4().to_string(),
            source_path: htm_source.to_string_lossy().into(),
            source_paths: vec![htm_source.to_string_lossy().into()],
            source_format: "docx".into(),
            target_format: "docx".into(),
            output_path: temp_dir.join("tampered.docx").to_string_lossy().into(),
            operation: OperationKind::Convert,
            engine: ConversionEngine::Pandoc,
            status: JobStatus::Planned,
            error: None,
            created_at: timestamp(),
            completed_at: None,
            page_selection: None,
            overwrite: false,
        };

        let err = execute_job(&mut job_tampered);
        assert!(err.is_err());
        assert_eq!(job_tampered.status, JobStatus::Failed);
        let msg = err.unwrap_err();
        assert!(
            msg.contains("Source format mismatch"),
            "Expected 'Source format mismatch', got: {msg}"
        );
        assert!(
            msg.contains(".html") && msg.contains(".docx"),
            "Expected .html and .docx in message, got: {msg}"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
