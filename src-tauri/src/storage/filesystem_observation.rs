use super::{extension, ScanErrorDto, SUPPORTED_FORMATS};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(super) struct FilesystemObservation {
    pub(super) scope_path: Option<String>,
    pub(super) files: Vec<(PathBuf, String)>,
    pub(super) errors: Vec<ScanErrorDto>,
}

pub(super) fn observe(
    root_path: &Path,
    relative_path: Option<&str>,
) -> Result<FilesystemObservation, String> {
    let canonical_root = fs::canonicalize(root_path)
        .map_err(|error| format!("Could not access library directory: {error}"))?;
    let scope_path = if let Some(relative_path) = relative_path {
        let relative = Path::new(relative_path);
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("The folder path must be relative to the library root.".to_string());
        }
        Some(relative.to_string_lossy().replace('\\', "/"))
    } else {
        None
    };
    let scan_path = if let Some(scope_path) = &scope_path {
        let candidate = canonical_root.join(scope_path);
        match fs::canonicalize(&candidate) {
            Ok(path) if path.starts_with(&canonical_root) && path.is_dir() => path,
            Ok(_) => return Err("The selected folder is outside this library root.".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err("The selected folder no longer exists.".to_string());
            }
            Err(error) => return Err(format!("Could not access selected folder: {error}")),
        }
    } else {
        canonical_root.clone()
    };

    let mut files = Vec::new();
    let mut errors = Vec::new();
    collect_files(&canonical_root, &scan_path, &mut files, &mut errors);
    files.sort_by(|left, right| left.1.cmp(&right.1));
    errors.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then(left.message.cmp(&right.message))
    });

    Ok(FilesystemObservation {
        scope_path,
        files,
        errors,
    })
}

fn collect_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<(PathBuf, String)>,
    errors: &mut Vec<ScanErrorDto>,
) {
    let entries = match fs::read_dir(current) {
        Ok(entries) => entries,
        Err(error) => {
            errors.push(ScanErrorDto {
                path: current.display().to_string(),
                message: error.to_string(),
            });
            return;
        }
    };
    let mut entries = entries
        .filter_map(|entry| match entry {
            Ok(entry) => Some(entry),
            Err(error) => {
                errors.push(ScanErrorDto {
                    path: current.display().to_string(),
                    message: error.to_string(),
                });
                None
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.path().to_string_lossy().into_owned());
    for entry in entries {
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                errors.push(ScanErrorDto {
                    path: path.display().to_string(),
                    message: error.to_string(),
                });
                continue;
            }
        };
        if metadata.is_dir() {
            collect_files(root, &path, files, errors);
        } else if metadata.is_file() && SUPPORTED_FORMATS.contains(&extension(&path).as_str()) {
            if let Ok(relative) = path.strip_prefix(root) {
                let rel = relative.to_string_lossy().replace('\\', "/");
                files.push((path, rel));
            }
        }
    }
}
