use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationKind {
    Convert,
    ExtractText,
    MergePdf,
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
            Self::Poppler => "Poppler (pdftotext / pdfunite)",
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionJob {
    pub id: String,
    pub source_path: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionResult {
    pub output_path: String,
    pub engine: String,
}

pub fn normalize_format(format_or_ext: &str) -> String {
    let trimmed = format_or_ext
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    match trimmed.as_str() {
        "htm" => "html".to_string(),
        "jpeg" => "jpg".to_string(),
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
            .filter(|c| c.source_format == src && c.operation != OperationKind::MergePdf)
            .map(|c| c.target_format.clone())
            .collect();
        targets.sort();
        targets.dedup();
        targets
    }
}

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
    // Standard ISO 8601 UTC timestamp approximation
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

fn validate_output_destination(input: &Path, output: &Path) -> Result<(), String> {
    if input == output {
        return Err("Choose a different location for the converted file.".into());
    }

    // Check canonical equality if output already exists
    if output.exists() {
        if let (Ok(can_in), Ok(can_out)) = (fs::canonicalize(input), fs::canonicalize(output)) {
            if can_in == can_out {
                return Err("Choose a different location for the converted file.".into());
            }
        }
    }

    // Verify output parent directory exists and is accessible
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

fn run_command(command: &mut Command, tool: &str) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|error| format!("Could not run {tool}. Make sure it is installed: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!(
        "{tool} could not convert this file{}",
        if details.is_empty() {
            ".".into()
        } else {
            format!(": {details}")
        }
    ))
}

struct TempFileGuard {
    path: PathBuf,
}

impl TempFileGuard {
    fn new(prefix: &str, ext: &str) -> Self {
        let unique_name = format!("{prefix}-{}.{ext}", Uuid::new_v4());
        let path = std::env::temp_dir().join(unique_name);
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

pub fn plan_job(
    registry: &CapabilityRegistry,
    source_path_str: &str,
    target_format_str: &str,
    output_path_opt: Option<&str>,
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
    })
}

pub fn plan_merge_job(
    registry: &CapabilityRegistry,
    source_paths_slice: &[String],
    output_path_opt: Option<&str>,
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

    // Validate output destination does not alias or overwrite any input
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
    })
}

pub fn execute_job(job: &mut ConversionJob) -> Result<(), String> {
    let output = Path::new(&job.output_path);

    let inputs: Vec<PathBuf> = if job.source_paths.is_empty() {
        vec![PathBuf::from(&job.source_path)]
    } else {
        job.source_paths.iter().map(PathBuf::from).collect()
    };

    for input in &inputs {
        validate_output_destination(input, output)?;
    }

    job.status = JobStatus::Running;

    let result = match job.operation {
        OperationKind::MergePdf => {
            let mut cmd = Command::new("pdfunite");
            for input in &inputs {
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
            }
        },
    };
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

// ─── Tauri Command Handlers ──────────────────────────────────────────────────

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
) -> Result<ConversionJob, String> {
    let registry = CapabilityRegistry::new();
    plan_job(
        &registry,
        &source_path,
        &target_format,
        output_path.as_deref(),
    )
}

#[tauri::command]
pub fn conversion_plan_merge_job(
    source_paths: Vec<String>,
    output_path: Option<String>,
) -> Result<ConversionJob, String> {
    let registry = CapabilityRegistry::new();
    plan_merge_job(&registry, &source_paths, output_path.as_deref())
}

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
    let mut job = plan_job(&registry, &input_path, &output_format, Some(&output_path))?;
    execute_job(&mut job)?;
    Ok(ConversionResult {
        output_path: job.output_path,
        engine: job.engine.display_name().into(),
    })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_capability_registry_initialization_and_filtering() {
        let registry = CapabilityRegistry::new();

        // 1. All capabilities list
        let all = registry.list_capabilities(None);
        assert!(!all.is_empty());

        // 2. Filter by PDF: should offer txt (extract-text) and md, html, docx, odt, epub (poppler-pandoc)
        // 2. Filter by PDF: should offer txt (extract-text) and md, html, docx, odt, epub (poppler-pandoc), plus merge if pdfunite installed
        let pdf_caps = registry.list_capabilities(Some("pdf"));
        if is_tool_installed("pdfunite") {
            assert_eq!(pdf_caps.len(), 7);
            let merge_cap =
                registry.find_capability_for_operation("pdf", "pdf", OperationKind::MergePdf);
            assert!(merge_cap.is_some());
            assert_eq!(merge_cap.unwrap().operation, OperationKind::MergePdf);
        } else {
            assert_eq!(pdf_caps.len(), 6);
        }
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

        // 4. Unsupported source
        let unknown = registry.list_capabilities(Some("xyz"));
        assert!(unknown.is_empty());
        assert!(!registry.is_supported_source("xyz"));
    }

    #[test]
    fn test_format_normalization() {
        assert_eq!(normalize_format(".MD"), "md");
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
        let job =
            plan_job(&registry, &source_file.to_string_lossy(), "html", None).expect("plan job");

        assert_eq!(job.source_format, "md");
        assert_eq!(job.target_format, "html");
        assert_eq!(job.engine, ConversionEngine::Pandoc);
        assert_eq!(job.status, JobStatus::Planned);
        assert!(job.output_path.ends_with("sample.html"));

        // 2. Reject unsupported target (e.g. md -> pdf which has no pdf engine)
        let unbacked = plan_job(&registry, &source_file.to_string_lossy(), "pdf", None);
        assert!(unbacked.is_err());

        // 3. Reject same input and output path
        let same_path = plan_job(
            &registry,
            &source_file.to_string_lossy(),
            "html",
            Some(&source_file.to_string_lossy()),
        );
        assert!(same_path.is_err());

        // 4. Reject non-existent source
        let non_existent = plan_job(
            &registry,
            &temp_dir.join("missing.md").to_string_lossy(),
            "html",
            None,
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

        // 1. Valid two-file merge planning
        let two_files = vec![
            p1.to_string_lossy().into_owned(),
            p2.to_string_lossy().into_owned(),
        ];
        let job2 = plan_merge_job(&registry, &two_files, None).expect("plan two-file merge");
        assert_eq!(job2.operation, OperationKind::MergePdf);
        assert_eq!(job2.engine, ConversionEngine::Poppler);
        assert_eq!(job2.status, JobStatus::Planned);
        assert_eq!(job2.source_format, "pdf");
        assert_eq!(job2.target_format, "pdf");
        assert_eq!(job2.source_paths.len(), 2);
        assert!(job2.output_path.ends_with("doc1-merged.pdf"));

        // 2. Valid multi-file merge planning (3 files)
        let three_files = vec![
            p1.to_string_lossy().into_owned(),
            p2.to_string_lossy().into_owned(),
            p3.to_string_lossy().into_owned(),
        ];
        let custom_out = temp_dir.join("custom_merged.pdf");
        let job3 = plan_merge_job(&registry, &three_files, Some(&custom_out.to_string_lossy()))
            .expect("plan three-file merge");
        assert_eq!(job3.source_paths.len(), 3);
        assert_eq!(job3.output_path, custom_out.to_string_lossy());

        // 3. Fewer than two inputs rejected
        let one_file = vec![p1.to_string_lossy().into_owned()];
        assert!(plan_merge_job(&registry, &one_file, None).is_err());
        let zero_files: Vec<String> = vec![];
        assert!(plan_merge_job(&registry, &zero_files, None).is_err());

        // 4. Non-PDF input rejected
        let mixed = vec![
            p1.to_string_lossy().into_owned(),
            txt_file.to_string_lossy().into_owned(),
        ];
        let res_mixed = plan_merge_job(&registry, &mixed, None);
        assert!(res_mixed.is_err());
        assert!(res_mixed.unwrap_err().contains("not a PDF"));

        // 5. Duplicate input rejected
        let dupes = vec![
            p1.to_string_lossy().into_owned(),
            p1.to_string_lossy().into_owned(),
        ];
        let res_dupes = plan_merge_job(&registry, &dupes, None);
        assert!(res_dupes.is_err());
        assert!(res_dupes.unwrap_err().contains("Duplicate input"));

        // 6. Input/output canonical collision rejected
        let collision = plan_merge_job(&registry, &two_files, Some(&p1.to_string_lossy()));
        assert!(collision.is_err());

        // 7. Missing input rejected
        let missing = vec![
            p1.to_string_lossy().into_owned(),
            temp_dir
                .join("nonexistent.pdf")
                .to_string_lossy()
                .into_owned(),
        ];
        assert!(plan_merge_job(&registry, &missing, None).is_err());

        // 8. Invalid output directory rejected
        let bad_out = temp_dir.join("nonexistent_folder").join("out.pdf");
        assert!(plan_merge_job(&registry, &two_files, Some(&bad_out.to_string_lossy())).is_err());

        // 9. Integration execution with actual pdfunite
        let mut exec_job = job2;
        execute_job(&mut exec_job).expect("execute pdfunite merge");
        assert_eq!(exec_job.status, JobStatus::Completed);
        assert!(Path::new(&exec_job.output_path).exists());
        let meta = fs::metadata(&exec_job.output_path).expect("read merged metadata");
        assert!(meta.len() > 0);

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
