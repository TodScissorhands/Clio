use serde::Serialize;
use std::{fs, path::Path, process::Command};

const SUPPORTED: &[&str] = &[
    "pdf", "epub", "docx", "odt", "rtf", "html", "htm", "md", "txt",
];
const OUTPUTS: &[&str] = &["pdf", "epub", "docx", "odt", "html", "md", "txt"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentInfo {
    path: String,
    name: String,
    extension: String,
    size: u64,
    supported: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversionResult {
    output_path: String,
    engine: String,
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

#[tauri::command]
fn inspect_document(path: String) -> Result<DocumentInfo, String> {
    let document = Path::new(&path);
    let metadata =
        fs::metadata(document).map_err(|error| format!("Could not read document: {error}"))?;
    if !metadata.is_file() {
        return Err("Please choose a file, not a folder.".into());
    }
    let ext = extension(document);
    let name = document
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled document")
        .to_string();
    Ok(DocumentInfo {
        path,
        name,
        extension: ext.clone(),
        size: metadata.len(),
        supported: SUPPORTED.contains(&ext.as_str()),
    })
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

#[tauri::command]
fn convert_document(
    input_path: String,
    output_path: String,
    output_format: String,
) -> Result<ConversionResult, String> {
    let input = Path::new(&input_path);
    let output = Path::new(&output_path);
    let source_format = extension(input);
    let target = output_format.to_ascii_lowercase();
    if !SUPPORTED.contains(&source_format.as_str()) {
        return Err(format!("Unsupported input format: .{source_format}"));
    }
    if !OUTPUTS.contains(&target.as_str()) {
        return Err(format!("Unsupported output format: .{target}"));
    }
    if input == output {
        return Err("Choose a different location for the converted file.".into());
    }

    if source_format == "pdf" && target == "txt" {
        run_command(
            Command::new("pdftotext").arg(input).arg(output),
            "Poppler (pdftotext)",
        )?;
        return Ok(ConversionResult {
            output_path,
            engine: "Poppler text extraction".into(),
        });
    }

    if source_format == "pdf" {
        let temporary =
            std::env::temp_dir().join(format!("clio-{}-source.txt", std::process::id()));
        run_command(
            Command::new("pdftotext").arg(input).arg(&temporary),
            "Poppler (pdftotext)",
        )?;
        let conversion = run_command(
            Command::new("pandoc").arg(&temporary).arg("-o").arg(output),
            "Pandoc",
        );
        let _ = fs::remove_file(temporary);
        conversion?;
        return Ok(ConversionResult {
            output_path,
            engine: "Poppler + Pandoc".into(),
        });
    }

    run_command(
        Command::new("pandoc").arg(input).arg("-o").arg(output),
        "Pandoc",
    )?;
    Ok(ConversionResult {
        output_path,
        engine: "Pandoc".into(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![inspect_document, convert_document])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
