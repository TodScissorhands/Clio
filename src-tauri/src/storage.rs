use crate::metadata::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
pub mod commands;
mod migrations;

#[allow(unused_imports)]
pub use commands::{
    annotation_create, annotation_delete, annotation_list, annotation_update, bookmark_create,
    bookmark_delete, bookmark_list, format_capabilities_get, library_collection_add_document,
    library_collection_create, library_collection_delete, library_collection_list,
    library_collection_list_documents, library_collection_remove_document,
    library_collection_rename, library_document_add_external, library_document_collections_list,
    library_document_list, library_document_path, library_document_relink, library_document_remove,
    library_folder_scan, library_metadata_get, library_metadata_update, library_root_add,
    library_root_list, library_root_remove, library_root_scan, library_thumbnail_get,
    reading_state_get, reading_state_list, reading_state_set,
};
#[cfg(test)]
use migrations::table_exists;

const SUPPORTED_FORMATS: &[&str] = &[
    "pdf", "epub", "docx", "odt", "rtf", "html", "htm", "md", "markdown", "txt",
];

#[derive(Clone)]
pub struct LibraryDb {
    connection: Arc<Mutex<Connection>>,
    scan_lock: Arc<Mutex<()>>,
    pub thumbnail_dir: PathBuf,
}

impl LibraryDb {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let p = path.as_ref();
        let thumb_dir = p.parent().unwrap_or(Path::new(".")).join("thumbnails");
        Self::open_with_thumbnail_dir(p, thumb_dir)
    }

    pub fn open_with_thumbnail_dir(
        path: impl AsRef<Path>,
        thumbnail_dir: impl AsRef<Path>,
    ) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(db_error)?;
        let thumb_dir = thumbnail_dir.as_ref().to_path_buf();
        let _ = fs::create_dir_all(&thumb_dir);
        let db = Self {
            connection: Arc::new(Mutex::new(connection)),
            scan_lock: Arc::new(Mutex::new(())),
            thumbnail_dir: thumb_dir,
        };
        db.migrate()?;
        Ok(db)
    }

    #[allow(dead_code)]
    pub fn open_in_memory() -> Result<Self, String> {
        let thumb_dir = std::env::temp_dir().join(format!("clio-thumbs-{}", Uuid::new_v4()));
        let _ = fs::create_dir_all(&thumb_dir);
        let connection = Connection::open_in_memory().map_err(db_error)?;
        let db = Self {
            connection: Arc::new(Mutex::new(connection)),
            scan_lock: Arc::new(Mutex::new(())),
            thumbnail_dir: thumb_dir,
        };
        db.migrate()?;
        Ok(db)
    }

    /// The catalog version is SQLite's user_version, not an application table.
    pub fn migrate(&self) -> Result<(), String> {
        let mut connection = self.lock()?;
        migrations::run(&mut connection)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.connection
            .lock()
            .map_err(|_| "Library database is unavailable.".to_string())
    }

    fn root(&self, root_id: &str) -> Result<Option<RootRow>, String> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT id, label, locator_kind, locator_value, last_scanned_at, created_at, updated_at
                 FROM library_roots WHERE id = ?1",
                [root_id],
                root_from_row,
            )
            .optional()
            .map_err(db_error)
    }

    pub fn add_root(&self, path: &str, label: Option<&str>) -> Result<LibraryRootDto, String> {
        let directory = canonical_directory(path)?;
        let locator_value = directory.to_string_lossy().into_owned();
        let now = timestamp();
        let connection = self.lock()?;
        let existing: Option<RootRow> = connection
            .query_row(
                "SELECT id, label, locator_kind, locator_value, last_scanned_at, created_at, updated_at
                 FROM library_roots WHERE locator_kind = 'filesystem-directory' AND locator_value = ?1",
                [&locator_value],
                root_from_row,
            )
            .optional()
            .map_err(db_error)?;
        let row = if let Some(existing) = existing {
            let next_label = label
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&existing.label);
            connection
                .execute(
                    "UPDATE library_roots SET label = ?1, updated_at = ?2 WHERE id = ?3",
                    params![next_label, now, existing.id],
                )
                .map_err(db_error)?;
            RootRow {
                label: next_label.to_string(),
                updated_at: now,
                ..existing
            }
        } else {
            let root = RootRow {
                id: Uuid::new_v4().to_string(),
                label: label
                    .filter(|value| !value.trim().is_empty())
                    .map(ToOwned::to_owned)
                    .or_else(|| {
                        directory
                            .file_name()
                            .and_then(|value| value.to_str())
                            .map(ToOwned::to_owned)
                    })
                    .unwrap_or_else(|| locator_value.clone()),
                locator_kind: "filesystem-directory".to_string(),
                locator_value,
                last_scanned_at: None,
                created_at: now.clone(),
                updated_at: now,
            };
            connection
                .execute(
                    "INSERT INTO library_roots
                         (id, label, locator_kind, locator_value, last_scanned_at, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![root.id, root.label, root.locator_kind, root.locator_value, root.last_scanned_at, root.created_at, root.updated_at],
                )
                .map_err(db_error)?;
            root
        };
        Ok(row.into_dto())
    }

    pub fn list_roots(&self) -> Result<Vec<LibraryRootDto>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT id, label, locator_kind, locator_value, last_scanned_at, created_at, updated_at
                 FROM library_roots ORDER BY label COLLATE NOCASE, id",
            )
            .map_err(db_error)?;
        let rows = statement.query_map([], root_from_row).map_err(db_error)?;
        rows.map(|row| row.map_err(db_error).map(RootRow::into_dto))
            .collect()
    }

    fn raw_roots(&self) -> Result<Vec<RootRow>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT id, label, locator_kind, locator_value, last_scanned_at, created_at, updated_at
                 FROM library_roots ORDER BY label COLLATE NOCASE, id",
            )
            .map_err(db_error)?;
        let rows = statement.query_map([], root_from_row).map_err(db_error)?;
        rows.map(|r| r.map_err(db_error)).collect()
    }

    pub fn remove_root(&self, root_id: &str) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction().map_err(db_error)?;
        transaction
            .execute("DELETE FROM library_roots WHERE id = ?1", [root_id])
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)
    }

    pub fn scan_root(&self, root_id: &str) -> Result<LibraryScanResultDto, String> {
        self.scan_root_at(root_id, None)
    }

    pub fn scan_folder(
        &self,
        root_id: &str,
        relative_path: &str,
    ) -> Result<LibraryScanResultDto, String> {
        self.scan_root_at(root_id, Some(relative_path))
    }

    fn scan_root_at(
        &self,
        root_id: &str,
        relative_path: Option<&str>,
    ) -> Result<LibraryScanResultDto, String> {
        let _scan_guard = self
            .scan_lock
            .lock()
            .map_err(|_| "Library scanner is busy.".to_string())?;
        let root = self
            .root(root_id)?
            .ok_or_else(|| "Library root was not found.".to_string())?;
        if root.locator_kind != "filesystem-directory" {
            return Err("This library root is not a filesystem directory.".to_string());
        }
        let root_path = PathBuf::from(&root.locator_value);
        // A missing root is an observation, not a catalog mutation. In particular,
        // do not advance last_scanned_at or mark all documents missing here.
        if !directory_exists(&root.locator_value) {
            return Ok(LibraryScanResultDto {
                root_id: root_id.to_string(),
                scanned: 0,
                inserted: 0,
                added: 0,
                updated: 0,
                missing: self.missing_count(root_id)?,
                errors: vec![ScanErrorDto {
                    path: root.locator_value,
                    message: "The library directory is missing.".to_string(),
                }],
            });
        }
        let canonical_root = fs::canonicalize(&root_path)
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
                Ok(_) => {
                    return Err("The selected folder is outside this library root.".to_string())
                }
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
        let now = timestamp();
        let scan_marker = format!("{now}_{}", Uuid::new_v4());
        let mut connection = self.lock()?;
        let transaction = connection.transaction().map_err(db_error)?;
        let mut inserted = 0;
        let mut updated = 0;
        for (path, relative_path) in &files {
            let metadata = match fs::metadata(path) {
                Ok(value) => value,
                Err(error) => {
                    errors.push(ScanErrorDto {
                        path: path.display().to_string(),
                        message: error.to_string(),
                    });
                    continue;
                }
            };
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Untitled document")
                .to_string();
            let format_id = match FormatId::from_path(path) {
                Some(value) => value,
                None => continue,
            };
            let existing: Option<(String, Option<String>)> = transaction
                .query_row(
                    "SELECT id, excluded_at FROM documents WHERE root_id = ?1 AND relative_path = ?2",
                    params![root_id, relative_path],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(db_error)?;
            let doc_id = if let Some((document_id, excluded_at)) = existing {
                if excluded_at.is_some() {
                    // OD-1: Excluded document stays excluded across future scans
                    transaction
                        .execute(
                            "UPDATE documents SET last_seen_scan = ?1, availability = 'present' WHERE id = ?2",
                            params![scan_marker, document_id],
                        )
                        .map_err(db_error)?;
                    continue;
                }
                transaction
                    .execute(
                        "UPDATE documents
                         SET name = ?1, format_id = ?2, size_bytes = ?3, updated_at = ?4,
                             last_seen_scan = ?5, availability = 'present'
                         WHERE id = ?6",
                        params![
                            name,
                            format_id.as_str(),
                            metadata.len() as i64,
                            now,
                            scan_marker,
                            document_id
                        ],
                    )
                    .map_err(db_error)?;
                updated += 1;
                document_id
            } else {
                let document_id = Uuid::new_v4().to_string();
                transaction
                    .execute(
                        "INSERT INTO documents
                             (id, root_id, relative_path, name, format_id, size_bytes,
                              first_seen_at, updated_at, last_seen_scan, availability)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'present')",
                        params![
                            document_id,
                            root_id,
                            relative_path,
                            name,
                            format_id.as_str(),
                            metadata.len() as i64,
                            now,
                            now,
                            scan_marker
                        ],
                    )
                    .map_err(db_error)?;
                inserted += 1;
                document_id
            };

            // Extract metadata & thumbnail for present document
            let (doc_meta, _thumb) = extract_metadata_and_thumbnail(
                path,
                format_id.as_str(),
                &doc_id,
                &self.thumbnail_dir,
            );
            let authors_json =
                serde_json::to_string(&doc_meta.authors).unwrap_or_else(|_| "[]".to_string());
            let idents_json =
                serde_json::to_string(&doc_meta.identifiers).unwrap_or_else(|_| "[]".to_string());
            let prov_str = match doc_meta.provenance {
                MetadataProvenance::Embedded => "embedded",
                MetadataProvenance::Fallback => "fallback",
            };
            transaction
                .execute(
                    "INSERT INTO document_metadata
                         (document_id, title, authors, publisher, published_date, description,
                          language, identifiers, provenance, thumbnail_path, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                     ON CONFLICT(document_id) DO UPDATE SET
                         title = excluded.title,
                         authors = excluded.authors,
                         publisher = excluded.publisher,
                         published_date = excluded.published_date,
                         description = excluded.description,
                         language = excluded.language,
                         identifiers = excluded.identifiers,
                         provenance = excluded.provenance,
                         thumbnail_path = COALESCE(excluded.thumbnail_path, document_metadata.thumbnail_path),
                         updated_at = excluded.updated_at",
                    params![
                        doc_id,
                        doc_meta.title,
                        authors_json,
                        doc_meta.publisher,
                        doc_meta.published_date,
                        doc_meta.description,
                        doc_meta.language,
                        idents_json,
                        prov_str,
                        doc_meta.thumbnail_path,
                        now,
                    ],
                )
                .map_err(db_error)?;
        }
        if let Some(scope_path) = &scope_path {
            transaction
                .execute(
                    "UPDATE documents SET availability = 'missing'
                     WHERE root_id = ?1
                       AND (relative_path = ?2 OR substr(relative_path, 1, length(?2) + 1) = ?2 || '/')
                       AND (last_seen_scan IS NULL OR last_seen_scan <> ?3)",
                    params![root_id, scope_path, scan_marker],
                )
                .map_err(db_error)?;
        } else {
            transaction
                .execute(
                    "UPDATE documents SET availability = 'missing'
                     WHERE root_id = ?1 AND (last_seen_scan IS NULL OR last_seen_scan <> ?2)",
                    params![root_id, scan_marker],
                )
                .map_err(db_error)?;
            transaction
                .execute(
                    "UPDATE library_roots SET last_scanned_at = ?1, updated_at = ?1 WHERE id = ?2",
                    params![now, root_id],
                )
                .map_err(db_error)?;
        }
        let missing: i64 = if let Some(scope_path) = &scope_path {
            transaction
                .query_row(
                    "SELECT COUNT(*) FROM documents
                     WHERE root_id = ?1 AND availability = 'missing' AND excluded_at IS NULL
                       AND (relative_path = ?2 OR substr(relative_path, 1, length(?2) + 1) = ?2 || '/')",
                    params![root_id, scope_path],
                    |row| row.get(0),
                )
                .map_err(db_error)?
        } else {
            transaction
                .query_row(
                    "SELECT COUNT(*) FROM documents WHERE root_id = ?1 AND availability = 'missing' AND excluded_at IS NULL",
                    [root_id],
                    |row| row.get(0),
                )
                .map_err(db_error)?
        };
        transaction.commit().map_err(db_error)?;
        errors.sort_by(|left, right| {
            left.path
                .cmp(&right.path)
                .then(left.message.cmp(&right.message))
        });
        Ok(LibraryScanResultDto {
            root_id: root_id.to_string(),
            scanned: files.len() as u64,
            inserted,
            added: inserted,
            updated,
            missing: missing as u64,
            errors,
        })
    }

    fn missing_count(&self, root_id: &str) -> Result<u64, String> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT COUNT(*) FROM documents WHERE root_id = ?1 AND availability = 'missing' AND excluded_at IS NULL",
                [root_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value.max(0) as u64)
            .map_err(db_error)
    }

    pub fn list_documents(
        &self,
        root_id: Option<&str>,
        include_missing: bool,
    ) -> Result<Vec<DocumentDto>, String> {
        let connection = self.lock()?;
        let mut col_stmt = connection
            .prepare("SELECT document_id, collection_id FROM document_collections")
            .map_err(db_error)?;
        let mut doc_collections: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let col_rows = col_stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?;
        for r in col_rows {
            let (doc_id, col_id) = r.map_err(db_error)?;
            doc_collections.entry(doc_id).or_default().push(col_id);
        }

        let mut rs_stmt = connection
            .prepare("SELECT document_id, position_kind, page, cfi, progression, last_opened_at, updated_at FROM reading_state")
            .map_err(db_error)?;
        let mut doc_reading_states: std::collections::HashMap<String, ReadingState> =
            std::collections::HashMap::new();
        let rs_rows = rs_stmt
            .query_map([], reading_state_from_row)
            .map_err(db_error)?;
        for r in rs_rows {
            let state = r.map_err(db_error)?;
            doc_reading_states.insert(state.document_id.clone(), state);
        }

        let mut statement = connection
            .prepare(
                "SELECT d.id, d.name, d.format_id, d.size_bytes, d.first_seen_at, d.updated_at,
                        d.root_id, d.relative_path, d.availability,
                        dm.title, dm.authors, dm.publisher, dm.published_date,
                        dm.description, dm.language, dm.identifiers, dm.provenance, dm.thumbnail_path
                 FROM documents d
                 LEFT JOIN document_metadata dm ON dm.document_id = d.id
                 WHERE (?1 IS NULL OR d.root_id = ?1) AND (?2 OR d.availability = 'present') AND d.excluded_at IS NULL
                 ORDER BY d.name COLLATE NOCASE, d.id",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![root_id, include_missing], document_from_row)
            .map_err(db_error)?;
        rows.map(|row| {
            let doc = row.map_err(db_error)?;
            let collections = doc_collections.get(&doc.id).cloned().unwrap_or_default();
            let reading_state = doc_reading_states.remove(&doc.id);
            Ok(doc.into_dto(collections, reading_state))
        })
        .collect()
    }

    pub fn remove_document(&self, document_id: &str) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction().map_err(db_error)?;
        let now = timestamp();
        transaction
            .execute(
                "UPDATE documents SET excluded_at = ?1 WHERE id = ?2",
                params![now, document_id],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)
    }

    pub fn list_reading_states(&self) -> Result<Vec<ReadingState>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT document_id, position_kind, page, cfi, progression, last_opened_at, updated_at FROM reading_state")
            .map_err(db_error)?;
        let rows = statement
            .query_map([], reading_state_from_row)
            .map_err(db_error)?;
        rows.map(|r| r.map_err(db_error)).collect()
    }

    pub fn open_library_document<F>(
        &self,
        document_id: &str,
        mint_token: F,
    ) -> Result<ReaderOpen, String>
    where
        F: FnOnce(&Path) -> Result<String, String>,
    {
        let document = self
            .document(document_id)?
            .ok_or_else(|| "Library document was not found.".to_string())?;
        if document.availability != "present" {
            return Err("This library document is missing from its root.".to_string());
        }
        let path = canonical_library_path(&document.root_locator, &document.relative_path)?;
        let token = mint_token(&path)?;
        Ok(ReaderOpen {
            record: document.record,
            source: SourceRef::Library {
                root_id: document.root_id,
                relative_path: document.relative_path,
            },
            locator: StorageLocator::desktop_session(token),
        })
    }
    pub fn document_path(&self, document_id: &str) -> Result<String, String> {
        let document = self
            .document(document_id)?
            .ok_or_else(|| "Library document was not found.".to_string())?;
        if document.availability != "present" {
            return Err("This library document is missing from its root.".to_string());
        }
        let path = canonical_library_path(&document.root_locator, &document.relative_path)?;
        Ok(path.to_string_lossy().into_owned())
    }

    pub fn relink_document(
        &self,
        document_id: &str,
        new_path: &str,
    ) -> Result<DocumentDto, String> {
        let p = Path::new(new_path);
        let canonical_p = p
            .canonicalize()
            .map_err(|e| format!("Failed to access file: {e}"))?;
        if !canonical_p.is_file() {
            return Err("The selected path is not a file.".to_string());
        }

        let roots = self.raw_roots()?;
        let mut target_root_id = None;
        let mut target_rel_path = None;

        for root in &roots {
            if root.locator_kind != "filesystem-directory" {
                continue;
            }
            if let Ok(root_canon) = Path::new(&root.locator_value).canonicalize() {
                if let Ok(rel) = canonical_p.strip_prefix(&root_canon) {
                    target_root_id = Some(root.id.clone());
                    target_rel_path = Some(rel.to_string_lossy().replace('\\', "/"));
                    break;
                }
            }
        }

        let (root_id, relative_path) = match (target_root_id, target_rel_path) {
            (Some(rid), Some(rp)) => (rid, rp),
            _ => {
                return Err(
                    "The selected file is not inside any Library folder. Add its folder to the Library first."
                        .to_string(),
                );
            }
        };

        let format_id = match FormatId::from_path(&canonical_p) {
            Some(f) => f,
            None => return Err("The selected file is not a supported document format.".to_string()),
        };

        let metadata = fs::metadata(&canonical_p).map_err(|e| e.to_string())?;
        let name = canonical_p
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("Untitled document")
            .to_string();
        let now = timestamp();

        let mut connection = self.lock()?;
        let transaction = connection.transaction().map_err(db_error)?;

        // Ensure target document exists
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM documents WHERE id = ?1)",
                [document_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if !exists {
            return Err("Document was not found.".to_string());
        }

        // If another document is already registered at this (root_id, relative_path):
        // If it was created during a recent scan after move, remove it so relink succeeds.
        let conflicting_id: Option<String> = transaction
            .query_row(
                "SELECT id FROM documents WHERE root_id = ?1 AND relative_path = ?2 AND id != ?3",
                params![root_id, relative_path, document_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;

        if let Some(conflict) = conflicting_id {
            transaction
                .execute("DELETE FROM documents WHERE id = ?1", [&conflict])
                .map_err(db_error)?;
        }

        transaction
            .execute(
                "UPDATE documents
                 SET root_id = ?1, relative_path = ?2, name = ?3, format_id = ?4, size_bytes = ?5,
                     updated_at = ?6, availability = 'present', excluded_at = NULL
                 WHERE id = ?7",
                params![
                    root_id,
                    relative_path,
                    name,
                    format_id.as_str(),
                    metadata.len() as i64,
                    now,
                    document_id
                ],
            )
            .map_err(db_error)?;

        transaction.commit().map_err(db_error)?;
        drop(connection);

        // Fetch and return the updated DocumentDto
        let docs = self.list_documents(Some(&root_id), true)?;
        docs.into_iter()
            .find(|d| d.id == document_id)
            .ok_or_else(|| "Failed to retrieve relinked document.".to_string())
    }

    pub fn add_external_document_to_library(&self, file_path: &str) -> Result<DocumentDto, String> {
        let p = Path::new(file_path);
        let canonical_p = p
            .canonicalize()
            .map_err(|e| format!("Failed to access file: {e}"))?;
        if !canonical_p.is_file() {
            return Err("The selected path is not a file.".to_string());
        }

        let roots = self.raw_roots()?;
        let mut matching_root = None;
        for root in &roots {
            if root.locator_kind != "filesystem-directory" {
                continue;
            }
            if let Ok(root_canon) = Path::new(&root.locator_value).canonicalize() {
                if canonical_p.starts_with(&root_canon) {
                    matching_root = Some(root.id.clone());
                    break;
                }
            }
        }

        let root_id = match matching_root {
            Some(rid) => rid,
            None => {
                let parent = canonical_p
                    .parent()
                    .ok_or_else(|| "File has no parent directory.".to_string())?;
                let new_root = self.add_root(&parent.to_string_lossy(), None)?;
                new_root.id
            }
        };

        self.scan_root(&root_id)?;
        let docs = self.list_documents(Some(&root_id), false)?;
        for doc in docs {
            if let Ok(path) = self.document_path(&doc.id) {
                if let Ok(p_canon) = Path::new(&path).canonicalize() {
                    if p_canon == canonical_p {
                        return Ok(doc);
                    }
                }
            }
        }
        Err("Document could not be located after scanning.".to_string())
    }

    pub fn set_reading_state(&self, state: ReadingState) -> Result<(), String> {
        state.position.validate()?;
        let connection = self.lock()?;
        let known: Option<String> = connection
            .query_row(
                "SELECT id FROM documents WHERE id = ?1",
                [&state.document_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if known.is_none() {
            return Err("Reading state refers to an unknown document.".to_string());
        }
        let (kind, page, cfi, progression) = state.position.columns()?;
        connection
            .execute(
                "INSERT INTO reading_state(document_id, position_kind, page, cfi, progression, last_opened_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(document_id) DO UPDATE SET
                   position_kind = excluded.position_kind, page = excluded.page, cfi = excluded.cfi,
                   progression = excluded.progression, last_opened_at = excluded.last_opened_at,
                   updated_at = excluded.updated_at",
                params![state.document_id, kind, page, cfi, progression, state.last_opened_at, state.updated_at],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn get_reading_state(&self, document_id: &str) -> Result<Option<ReadingState>, String> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT document_id, position_kind, page, cfi, progression, last_opened_at, updated_at
                 FROM reading_state WHERE document_id = ?1",
                [document_id],
                reading_state_from_row,
            )
            .optional()
            .map_err(db_error)
    }

    pub fn create_bookmark(
        &self,
        document_id: &str,
        position: ReadingPosition,
        title: Option<&str>,
    ) -> Result<BookmarkDto, String> {
        position.validate()?;
        let connection = self.lock()?;
        let known: Option<String> = connection
            .query_row(
                "SELECT id FROM documents WHERE id = ?1",
                [document_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if known.is_none() {
            return Err(
                "Bookmarks are only supported for catalog documents in your library.".to_string(),
            );
        }
        let id = Uuid::new_v4().to_string();
        let now = timestamp();
        let (kind, page, cfi, progression) = position.columns()?;
        let fallback_title = match &position {
            ReadingPosition::PdfPage { page, .. } => format!("Page {page}"),
            ReadingPosition::EpubCfi {
                progression: Some(p),
                ..
            } => format!("{}%", (p * 100.0).round()),
            ReadingPosition::EpubCfi { .. } => "Bookmark".to_string(),
            ReadingPosition::TextScroll { progression } => {
                format!("{}%", (progression * 100.0).round())
            }
        };
        let bookmark_title = title
            .filter(|t| !t.trim().is_empty())
            .map(|t| t.trim().to_string())
            .unwrap_or(fallback_title);

        connection
            .execute(
                "INSERT INTO bookmarks(id, document_id, position_kind, page, cfi, progression, title, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    id,
                    document_id,
                    kind,
                    page,
                    cfi,
                    progression,
                    bookmark_title,
                    now,
                    now
                ],
            )
            .map_err(db_error)?;

        Ok(BookmarkDto {
            id,
            document_id: document_id.to_string(),
            position,
            title: Some(bookmark_title),
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn list_bookmarks(&self, document_id: &str) -> Result<Vec<BookmarkDto>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT id, document_id, position_kind, page, cfi, progression, title, created_at, updated_at
                 FROM bookmarks WHERE document_id = ?1
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([document_id], bookmark_from_row)
            .map_err(db_error)?;
        rows.map(|r| r.map_err(db_error)).collect()
    }

    pub fn delete_bookmark(&self, bookmark_id: &str) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction().map_err(db_error)?;
        transaction
            .execute("DELETE FROM bookmarks WHERE id = ?1", [bookmark_id])
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)
    }

    pub fn create_annotation(
        &self,
        document_id: &str,
        kind: &str,
        position: ReadingPosition,
        selected_text: Option<&str>,
        note: Option<&str>,
        locator: Option<&str>,
    ) -> Result<AnnotationDto, String> {
        position.validate()?;
        if kind.trim().is_empty() {
            return Err("Annotation kind is required.".to_string());
        }
        // Reject obviously non-JSON locator values to catch caller errors early.
        // Full structural validation is the frontend's responsibility.
        if let Some(loc) = locator {
            let trimmed = loc.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('{') {
                return Err("Annotation locator must be a JSON object string or null.".to_string());
            }
        }
        let connection = self.lock()?;
        let known: Option<String> = connection
            .query_row(
                "SELECT id FROM documents WHERE id = ?1",
                [document_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if known.is_none() {
            return Err(
                "Annotations are only supported for catalog documents in your library.".to_string(),
            );
        }
        let id = Uuid::new_v4().to_string();
        let now = timestamp();
        let (pos_kind, page, cfi, progression) = position.columns()?;
        // Normalize: empty locator string is stored as NULL.
        let locator_stored = locator.and_then(|s| {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        });

        connection
            .execute(
                "INSERT INTO annotations(id, document_id, kind, position_kind, page, cfi, progression, selected_text, note, locator, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    id,
                    document_id,
                    kind.trim(),
                    pos_kind,
                    page,
                    cfi,
                    progression,
                    selected_text.map(str::trim),
                    note.map(str::trim),
                    locator_stored,
                    now,
                    now
                ],
            )
            .map_err(db_error)?;

        Ok(AnnotationDto {
            id,
            document_id: document_id.to_string(),
            kind: kind.trim().to_string(),
            position,
            selected_text: selected_text.map(|s| s.trim().to_string()),
            note: note.map(|s| s.trim().to_string()),
            locator: locator_stored,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn list_annotations(&self, document_id: &str) -> Result<Vec<AnnotationDto>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT id, document_id, kind, position_kind, page, cfi, progression, selected_text, note, locator, created_at, updated_at
                 FROM annotations WHERE document_id = ?1
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([document_id], annotation_from_row)
            .map_err(db_error)?;
        rows.map(|r| r.map_err(db_error)).collect()
    }

    pub fn update_annotation(
        &self,
        annotation_id: &str,
        note: Option<&str>,
    ) -> Result<AnnotationDto, String> {
        let connection = self.lock()?;
        let now = timestamp();
        let note_stored = note.map(str::trim).filter(|s| !s.is_empty());
        let updated = connection
            .execute(
                "UPDATE annotations SET note = ?1, updated_at = ?2 WHERE id = ?3",
                params![note_stored, now, annotation_id],
            )
            .map_err(db_error)?;
        if updated == 0 {
            return Err("Annotation was not found.".to_string());
        }
        let mut statement = connection
            .prepare(
                "SELECT id, document_id, kind, position_kind, page, cfi, progression, selected_text, note, locator, created_at, updated_at
                 FROM annotations WHERE id = ?1",
            )
            .map_err(db_error)?;
        statement
            .query_row([annotation_id], annotation_from_row)
            .map_err(db_error)
    }

    pub fn delete_annotation(&self, annotation_id: &str) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction().map_err(db_error)?;
        let deleted = transaction
            .execute("DELETE FROM annotations WHERE id = ?1", [annotation_id])
            .map_err(db_error)?;
        if deleted == 0 {
            return Err("Annotation was not found.".to_string());
        }
        transaction.commit().map_err(db_error)
    }

    fn document(&self, document_id: &str) -> Result<Option<OpenDocument>, String> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT d.id, d.name, d.format_id, d.size_bytes, d.first_seen_at, d.updated_at,
                        d.root_id, d.relative_path, d.availability, r.locator_value
                 FROM documents d JOIN library_roots r ON r.id = d.root_id
                 WHERE d.id = ?1",
                [document_id],
                open_document_from_row,
            )
            .optional()
            .map_err(db_error)
    }

    pub fn create_collection(
        &self,
        name: &str,
        description: Option<&str>,
    ) -> Result<CollectionDto, String> {
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err("Collection name cannot be empty.".to_string());
        }
        let connection = self.lock()?;
        let id = Uuid::new_v4().to_string();
        let now = timestamp();
        let desc = description
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        connection
            .execute(
                "INSERT INTO collections (id, name, description, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, trimmed_name, desc, now, now],
            )
            .map_err(|e| {
                if e.to_string().contains("UNIQUE") {
                    "A collection with this name already exists.".to_string()
                } else {
                    db_error(e)
                }
            })?;
        Ok(CollectionDto {
            id,
            name: trimmed_name.to_string(),
            description: desc,
            document_count: 0,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn list_collections(&self) -> Result<Vec<CollectionDto>, String> {
        let connection = self.lock()?;
        let mut stmt = connection
            .prepare(
                "SELECT c.id, c.name, c.description, c.created_at, c.updated_at,
                        COUNT(dc.document_id) as doc_count
                 FROM collections c
                 LEFT JOIN document_collections dc ON dc.collection_id = c.id
                 GROUP BY c.id
                 ORDER BY c.name COLLATE NOCASE, c.id",
            )
            .map_err(db_error)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(CollectionDto {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    document_count: row.get::<_, i64>(5)?.max(0) as u64,
                })
            })
            .map_err(db_error)?;
        rows.map(|r| r.map_err(db_error)).collect()
    }

    pub fn rename_collection(&self, id: &str, new_name: &str) -> Result<CollectionDto, String> {
        let trimmed_name = new_name.trim();
        if trimmed_name.is_empty() {
            return Err("Collection name cannot be empty.".to_string());
        }
        let connection = self.lock()?;
        let now = timestamp();
        let updated = connection
            .execute(
                "UPDATE collections SET name = ?1, updated_at = ?2 WHERE id = ?3",
                params![trimmed_name, now, id],
            )
            .map_err(|e| {
                if e.to_string().contains("UNIQUE") {
                    "A collection with this name already exists.".to_string()
                } else {
                    db_error(e)
                }
            })?;
        if updated == 0 {
            return Err("Collection was not found.".to_string());
        }
        connection
            .query_row(
                "SELECT c.id, c.name, c.description, c.created_at, c.updated_at,
                        COUNT(dc.document_id) as doc_count
                 FROM collections c
                 LEFT JOIN document_collections dc ON dc.collection_id = c.id
                 WHERE c.id = ?1
                 GROUP BY c.id",
                [id],
                |row| {
                    Ok(CollectionDto {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        description: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                        document_count: row.get::<_, i64>(5)?.max(0) as u64,
                    })
                },
            )
            .map_err(db_error)
    }

    pub fn delete_collection(&self, id: &str) -> Result<(), String> {
        let connection = self.lock()?;
        let deleted = connection
            .execute("DELETE FROM collections WHERE id = ?1", [id])
            .map_err(db_error)?;
        if deleted == 0 {
            return Err("Collection was not found.".to_string());
        }
        Ok(())
    }

    pub fn add_document_to_collection(
        &self,
        collection_id: &str,
        document_id: &str,
    ) -> Result<(), String> {
        let connection = self.lock()?;
        let col_exists: Option<String> = connection
            .query_row(
                "SELECT id FROM collections WHERE id = ?1",
                [collection_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if col_exists.is_none() {
            return Err("Collection was not found.".to_string());
        }
        let doc_exists: Option<String> = connection
            .query_row(
                "SELECT id FROM documents WHERE id = ?1",
                [document_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if doc_exists.is_none() {
            return Err("Document was not found.".to_string());
        }
        let now = timestamp();
        connection
            .execute(
                "INSERT INTO document_collections (collection_id, document_id, added_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(collection_id, document_id) DO NOTHING",
                params![collection_id, document_id, now],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn remove_document_from_collection(
        &self,
        collection_id: &str,
        document_id: &str,
    ) -> Result<(), String> {
        let connection = self.lock()?;
        connection
            .execute(
                "DELETE FROM document_collections WHERE collection_id = ?1 AND document_id = ?2",
                params![collection_id, document_id],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn list_collection_documents(
        &self,
        collection_id: &str,
    ) -> Result<Vec<DocumentDto>, String> {
        let connection = self.lock()?;
        let mut col_stmt = connection
            .prepare("SELECT document_id, collection_id FROM document_collections")
            .map_err(db_error)?;
        let mut doc_collections: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let col_rows = col_stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?;
        for r in col_rows {
            let (doc_id, col_id) = r.map_err(db_error)?;
            doc_collections.entry(doc_id).or_default().push(col_id);
        }

        let mut statement = connection
            .prepare(
                "SELECT d.id, d.name, d.format_id, d.size_bytes, d.first_seen_at, d.updated_at,
                        d.root_id, d.relative_path, d.availability,
                        dm.title, dm.authors, dm.publisher, dm.published_date,
                        dm.description, dm.language, dm.identifiers, dm.provenance, dm.thumbnail_path
                 FROM documents d
                 JOIN document_collections dc ON dc.document_id = d.id
                 LEFT JOIN document_metadata dm ON dm.document_id = d.id
                 WHERE dc.collection_id = ?1 AND d.excluded_at IS NULL
                 ORDER BY d.name COLLATE NOCASE, d.id",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([collection_id], document_from_row)
            .map_err(db_error)?;
        let mut rs_stmt = connection
            .prepare("SELECT document_id, position_kind, page, cfi, progression, last_opened_at, updated_at FROM reading_state")
            .map_err(db_error)?;
        let mut doc_reading_states: std::collections::HashMap<String, ReadingState> =
            std::collections::HashMap::new();
        let rs_rows = rs_stmt
            .query_map([], reading_state_from_row)
            .map_err(db_error)?;
        for r in rs_rows {
            let state = r.map_err(db_error)?;
            doc_reading_states.insert(state.document_id.clone(), state);
        }

        rows.map(|row| {
            let doc = row.map_err(db_error)?;
            let collections = doc_collections.get(&doc.id).cloned().unwrap_or_default();
            let reading_state = doc_reading_states.remove(&doc.id);
            Ok(doc.into_dto(collections, reading_state))
        })
        .collect()
    }

    pub fn list_document_collections(&self, document_id: &str) -> Result<Vec<String>, String> {
        let connection = self.lock()?;
        let mut stmt = connection
            .prepare("SELECT collection_id FROM document_collections WHERE document_id = ?1")
            .map_err(db_error)?;
        let rows = stmt
            .query_map([document_id], |row| row.get::<_, String>(0))
            .map_err(db_error)?;
        rows.map(|r| r.map_err(db_error)).collect()
    }

    pub fn get_metadata(&self, document_id: &str) -> Result<Option<DocumentMetadata>, String> {
        let connection = self.lock()?;
        let mut stmt = connection
            .prepare(
                "SELECT title, authors, publisher, published_date, description, language,
                        identifiers, provenance, thumbnail_path
                 FROM document_metadata WHERE document_id = ?1",
            )
            .map_err(db_error)?;
        let meta = stmt
            .query_row([document_id], |row| {
                let title: Option<String> = row.get(0)?;
                let authors_raw: Option<String> = row.get(1)?;
                let publisher: Option<String> = row.get(2)?;
                let published_date: Option<String> = row.get(3)?;
                let description: Option<String> = row.get(4)?;
                let language: Option<String> = row.get(5)?;
                let idents_raw: Option<String> = row.get(6)?;
                let provenance_raw: Option<String> = row.get(7)?;
                let thumbnail_path: Option<String> = row.get(8)?;

                let authors: Vec<String> = authors_raw
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default();
                let identifiers: Vec<String> = idents_raw
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default();
                let provenance = match provenance_raw.as_deref() {
                    Some("embedded") => MetadataProvenance::Embedded,
                    _ => MetadataProvenance::Fallback,
                };
                Ok(DocumentMetadata {
                    title,
                    authors,
                    publisher,
                    published_date,
                    description,
                    language,
                    identifiers,
                    provenance,
                    thumbnail_path,
                })
            })
            .optional()
            .map_err(db_error)?;
        Ok(meta)
    }

    pub fn update_metadata(
        &self,
        document_id: &str,
        metadata: DocumentMetadata,
    ) -> Result<DocumentMetadata, String> {
        let connection = self.lock()?;
        let now = timestamp();
        let authors_json =
            serde_json::to_string(&metadata.authors).unwrap_or_else(|_| "[]".to_string());
        let idents_json =
            serde_json::to_string(&metadata.identifiers).unwrap_or_else(|_| "[]".to_string());
        let prov_str = match metadata.provenance {
            MetadataProvenance::Embedded => "embedded",
            MetadataProvenance::Fallback => "fallback",
        };
        connection
            .execute(
                "INSERT INTO document_metadata
                     (document_id, title, authors, publisher, published_date, description, language, identifiers, provenance, thumbnail_path, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(document_id) DO UPDATE SET
                     title = excluded.title,
                     authors = excluded.authors,
                     publisher = excluded.publisher,
                     published_date = excluded.published_date,
                     description = excluded.description,
                     language = excluded.language,
                     identifiers = excluded.identifiers,
                     provenance = excluded.provenance,
                     thumbnail_path = COALESCE(excluded.thumbnail_path, document_metadata.thumbnail_path),
                     updated_at = excluded.updated_at",
                params![
                    document_id,
                    metadata.title,
                    authors_json,
                    metadata.publisher,
                    metadata.published_date,
                    metadata.description,
                    metadata.language,
                    idents_json,
                    prov_str,
                    metadata.thumbnail_path,
                    now,
                ],
            )
            .map_err(db_error)?;
        Ok(metadata)
    }

    pub fn get_thumbnail_data_url(&self, document_id: &str) -> Result<Option<String>, String> {
        let connection = self.lock()?;
        let path: Option<String> = connection
            .query_row(
                "SELECT thumbnail_path FROM document_metadata WHERE document_id = ?1",
                [document_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?
            .flatten();
        let Some(rel_path) = path else {
            return Ok(None);
        };
        let full_path = self.thumbnail_dir.join(&rel_path);
        if !full_path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&full_path).map_err(|e| format!("Could not read thumbnail: {e}"))?;
        let mime = if rel_path.ends_with(".png") {
            "image/png"
        } else if rel_path.ends_with(".jpg") || rel_path.ends_with(".jpeg") {
            "image/jpeg"
        } else if rel_path.ends_with(".webp") {
            "image/webp"
        } else {
            "application/octet-stream"
        };
        let b64 = base64_encode(&bytes);
        Ok(Some(format!("data:{mime};base64,{b64}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionDto {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub document_count: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRootDto {
    pub id: String,
    pub label: String,
    pub kind: &'static str,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDto {
    pub id: String,
    pub name: String,
    pub format: FormatId,
    pub size_bytes: u64,
    pub first_seen_at: String,
    pub updated_at: String,
    pub source: SourceRef,
    pub root_id: String,
    pub relative_path: String,
    pub availability: String,
    pub metadata: Option<DocumentMetadata>,
    pub collections: Vec<String>,
    pub reading_state: Option<ReadingState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanErrorDto {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScanResultDto {
    pub root_id: String,
    pub scanned: u64,
    pub inserted: u64,
    pub added: u64,
    pub updated: u64,
    pub missing: u64,
    pub errors: Vec<ScanErrorDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageLocator {
    pub kind: String,
    pub value: String,
    pub access: String,
}

impl StorageLocator {
    fn desktop_session(value: String) -> Self {
        Self {
            kind: "desktop-token".to_string(),
            value,
            access: "session".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceRef {
    #[serde(rename_all = "camelCase")]
    Library {
        root_id: String,
        relative_path: String,
    },
    #[serde(rename_all = "camelCase")]
    Direct { locator: StorageLocator },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderOpen {
    pub record: ReaderRecord,
    pub source: SourceRef,
    pub locator: StorageLocator,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderRecord {
    pub id: String,
    pub name: String,
    pub format: FormatId,
    pub size_bytes: u64,
    pub first_seen_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingState {
    pub document_id: String,
    pub position: ReadingPosition,
    pub last_opened_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkDto {
    pub id: String,
    pub document_id: String,
    pub position: ReadingPosition,
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationDto {
    pub id: String,
    pub document_id: String,
    pub kind: String,
    pub position: ReadingPosition,
    pub selected_text: Option<String>,
    pub note: Option<String>,
    /// Serialized JSON of the AnnotationLocator, or None for annotations
    /// created before schema v3 (or without a selection locator).
    pub locator: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ReadingPosition {
    PdfPage {
        page: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        progression: Option<f64>,
    },
    EpubCfi {
        cfi: String,
        progression: Option<f64>,
    },
    TextScroll {
        progression: f64,
    },
}

impl ReadingPosition {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::PdfPage { page, .. } if *page == 0 || i64::try_from(*page).is_err() => {
                Err("PDF page must be at least 1.".to_string())
            }
            Self::PdfPage {
                progression: Some(value),
                ..
            } if !value.is_finite() || !(0.0..=1.0).contains(value) => {
                Err("PDF progression must be between 0 and 1.".to_string())
            }
            Self::EpubCfi { cfi, progression } if cfi.trim().is_empty() => {
                Err("EPUB reading position requires a CFI.".to_string())
            }
            Self::EpubCfi {
                progression: Some(value),
                ..
            } if !value.is_finite() || !(0.0..=1.0).contains(value) => {
                Err("EPUB progression must be between 0 and 1.".to_string())
            }
            Self::TextScroll { progression }
                if !progression.is_finite() || !(0.0..=1.0).contains(progression) =>
            {
                Err("Text progression must be between 0 and 1.".to_string())
            }
            _ => Ok(()),
        }
    }

    #[allow(clippy::type_complexity)]
    fn columns(&self) -> Result<(&'static str, Option<i64>, Option<&str>, Option<f64>), String> {
        self.validate()?;
        match self {
            Self::PdfPage { page, progression } => Ok((
                "pdf-page",
                Some(i64::try_from(*page).map_err(|_| "PDF page is too large.".to_string())?),
                None,
                *progression,
            )),
            Self::EpubCfi { cfi, progression } => {
                Ok(("epub-cfi", None, Some(cfi.as_str()), *progression))
            }
            Self::TextScroll { progression } => Ok(("text-scroll", None, None, Some(*progression))),
        }
    }
}

impl FormatId {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Epub => "epub",
            Self::Docx => "docx",
            Self::Odt => "odt",
            Self::Rtf => "rtf",
            Self::Html => "html",
            Self::Md => "md",
            Self::Txt => "txt",
        }
    }

    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = extension(path);
        let normalized = crate::conversion::normalize_format(&ext);
        match normalized.as_str() {
            "pdf" => Some(Self::Pdf),
            "epub" => Some(Self::Epub),
            "docx" => Some(Self::Docx),
            "odt" => Some(Self::Odt),
            "rtf" => Some(Self::Rtf),
            "html" => Some(Self::Html),
            "md" => Some(Self::Md),
            "txt" => Some(Self::Txt),
            _ => None,
        }
    }

    pub fn capabilities(&self) -> FormatCapabilitiesDto {
        match self {
            Self::Pdf => FormatCapabilitiesDto {
                read: true,
                search: true,
                toc: true,
                text_selection: true,
                annotations: true,
                bookmarks: true,
                thumbnail: true,
                metadata: true,
                convert: true,
                extract_text: true,
            },
            Self::Epub => FormatCapabilitiesDto {
                read: true,
                search: true,
                toc: true,
                text_selection: true,
                annotations: true,
                bookmarks: true,
                thumbnail: true,
                metadata: true,
                convert: true,
                extract_text: false,
            },
            Self::Txt => FormatCapabilitiesDto {
                read: true,
                search: true,
                toc: false,
                text_selection: true,
                annotations: false,
                bookmarks: true,
                thumbnail: false,
                metadata: true,
                convert: true,
                extract_text: false,
            },
            Self::Md => FormatCapabilitiesDto {
                read: true,
                search: true,
                toc: true,
                text_selection: true,
                annotations: false,
                bookmarks: true,
                thumbnail: false,
                metadata: true,
                convert: true,
                extract_text: false,
            },
            Self::Docx => FormatCapabilitiesDto {
                read: false,
                search: false,
                toc: false,
                text_selection: false,
                annotations: false,
                bookmarks: false,
                thumbnail: true,
                metadata: true,
                convert: true,
                extract_text: false,
            },
            Self::Odt => FormatCapabilitiesDto {
                read: false,
                search: false,
                toc: false,
                text_selection: false,
                annotations: false,
                bookmarks: false,
                thumbnail: true,
                metadata: true,
                convert: true,
                extract_text: false,
            },
            Self::Rtf => FormatCapabilitiesDto {
                read: false,
                search: false,
                toc: false,
                text_selection: false,
                annotations: false,
                bookmarks: false,
                thumbnail: false,
                metadata: true,
                convert: true,
                extract_text: false,
            },
            Self::Html => FormatCapabilitiesDto {
                read: false,
                search: false,
                toc: false,
                text_selection: false,
                annotations: false,
                bookmarks: false,
                thumbnail: false,
                metadata: true,
                convert: true,
                extract_text: false,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatCapabilitiesDto {
    pub read: bool,
    pub search: bool,
    pub toc: bool,
    pub text_selection: bool,
    pub annotations: bool,
    pub bookmarks: bool,
    pub thumbnail: bool,
    pub metadata: bool,
    pub convert: bool,
    pub extract_text: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FormatId {
    Pdf,
    Epub,
    Docx,
    Odt,
    Rtf,
    Html,
    Md,
    Txt,
}

// Compatibility aliases for callers that used the original internal names.
#[allow(dead_code)]
pub type StorageLocatorDto = StorageLocator;
#[allow(dead_code)]
pub type SourceRefDto = SourceRef;
#[allow(dead_code)]
pub type ReaderOpenDto = ReaderOpen;
#[allow(dead_code)]
pub type ReaderRecordDto = ReaderRecord;
#[allow(dead_code)]
pub type ReadingStateDto = ReadingState;
#[allow(dead_code)]
pub type ReadingPositionDto = ReadingPosition;

/// Build a tokenized response for a directly selected file. The callback is owned by lib.rs so
/// its token is inserted into the same authorization registry used by read_document_bytes.
pub fn direct_open<F>(path: String, mint_token: F) -> Result<ReaderOpen, String>
where
    F: FnOnce(&Path) -> Result<String, String>,
{
    let file = canonical_file(&path)?;
    let metadata =
        fs::metadata(&file).map_err(|error| format!("Could not read document: {error}"))?;
    let token = mint_token(&file)?;
    let record = ReaderRecord {
        id: Uuid::new_v4().to_string(),
        name: file
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Untitled document")
            .to_string(),
        format: FormatId::from_path(&file)
            .ok_or_else(|| "Unsupported document format.".to_string())?,
        size_bytes: metadata.len(),
        first_seen_at: timestamp(),
        updated_at: timestamp(),
    };
    let locator = StorageLocator::desktop_session(token);
    Ok(ReaderOpen {
        record,
        source: SourceRef::Direct {
            locator: locator.clone(),
        },
        locator,
    })
}

#[allow(dead_code)]
pub fn direct_open_with_token(path: String, token: String) -> Result<ReaderOpen, String> {
    direct_open(path, |_| Ok(token.clone()))
}

fn canonical_file(path: &str) -> Result<PathBuf, String> {
    let file =
        fs::canonicalize(path).map_err(|error| format!("Could not read document: {error}"))?;
    let metadata =
        fs::metadata(&file).map_err(|error| format!("Could not read document: {error}"))?;
    if !metadata.is_file() {
        return Err("Please choose a file, not a folder.".to_string());
    }
    Ok(file)
}

fn canonical_directory(path: &str) -> Result<PathBuf, String> {
    let directory = fs::canonicalize(path)
        .map_err(|error| format!("Could not read library directory: {error}"))?;
    let metadata = fs::metadata(&directory)
        .map_err(|error| format!("Could not read library directory: {error}"))?;
    if !metadata.is_dir() {
        return Err("Please choose a directory for the library root.".to_string());
    }
    Ok(directory)
}

fn canonical_library_path(root: &str, relative: &str) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Library document path escaped its root.".to_string());
    }
    let root = canonical_directory(root)?;
    let candidate = root.join(relative_path);
    let file = canonical_file(candidate.to_string_lossy().as_ref())?;
    if !file.starts_with(&root) {
        return Err("Library document path escaped its root.".to_string());
    }
    Ok(file)
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

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn directory_exists(path: &str) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
}

fn timestamp() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = elapsed.as_secs();
    let millis = elapsed.subsec_millis();
    let days = seconds / 86_400;
    let rem = seconds % 86_400;
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;
    let (year, month, day) = civil_date(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn civil_date(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

fn db_error(error: rusqlite::Error) -> String {
    format!("Library database error: {error}")
}

struct RootRow {
    id: String,
    label: String,
    locator_kind: String,
    locator_value: String,
    last_scanned_at: Option<String>,
    created_at: String,
    updated_at: String,
}

impl RootRow {
    fn into_dto(self) -> LibraryRootDto {
        LibraryRootDto {
            id: self.id,
            label: self.label,
            kind: "filesystem-directory",
            status: if self.locator_kind == "filesystem-directory"
                && directory_exists(&self.locator_value)
            {
                "active"
            } else {
                "missing"
            }
            .to_string(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

struct DocumentRow {
    id: String,
    name: String,
    format: FormatId,
    size_bytes: i64,
    first_seen_at: String,
    updated_at: String,
    root_id: String,
    relative_path: String,
    availability: String,
    metadata: Option<DocumentMetadata>,
}

impl DocumentRow {
    fn into_dto(
        self,
        collections: Vec<String>,
        reading_state: Option<ReadingState>,
    ) -> DocumentDto {
        DocumentDto {
            id: self.id,
            name: self.name,
            format: self.format,
            size_bytes: self.size_bytes.max(0) as u64,
            first_seen_at: self.first_seen_at,
            updated_at: self.updated_at,
            source: SourceRef::Library {
                root_id: self.root_id.clone(),
                relative_path: self.relative_path.clone(),
            },
            root_id: self.root_id,
            relative_path: self.relative_path,
            availability: self.availability,
            metadata: self.metadata,
            collections,
            reading_state,
        }
    }
}

struct OpenDocument {
    record: ReaderRecord,
    root_id: String,
    relative_path: String,
    root_locator: String,
    availability: String,
}

fn root_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RootRow> {
    Ok(RootRow {
        id: row.get(0)?,
        label: row.get(1)?,
        locator_kind: row.get(2)?,
        locator_value: row.get(3)?,
        last_scanned_at: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn document_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocumentRow> {
    let title: Option<String> = row.get(9)?;
    let authors_raw: Option<String> = row.get(10)?;
    let publisher: Option<String> = row.get(11)?;
    let published_date: Option<String> = row.get(12)?;
    let description: Option<String> = row.get(13)?;
    let language: Option<String> = row.get(14)?;
    let idents_raw: Option<String> = row.get(15)?;
    let provenance_raw: Option<String> = row.get(16)?;
    let thumbnail_path: Option<String> = row.get(17)?;

    let metadata = if provenance_raw.is_some() || title.is_some() {
        let authors: Vec<String> = authors_raw
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let identifiers: Vec<String> = idents_raw
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let provenance = match provenance_raw.as_deref() {
            Some("embedded") => MetadataProvenance::Embedded,
            _ => MetadataProvenance::Fallback,
        };
        Some(DocumentMetadata {
            title,
            authors,
            publisher,
            published_date,
            description,
            language,
            identifiers,
            provenance,
            thumbnail_path,
        })
    } else {
        None
    };

    Ok(DocumentRow {
        id: row.get(0)?,
        name: row.get(1)?,
        format: parse_format(row.get::<_, String>(2)?)?,
        size_bytes: row.get(3)?,
        first_seen_at: row.get(4)?,
        updated_at: row.get(5)?,
        root_id: row.get(6)?,
        relative_path: row.get(7)?,
        availability: row.get(8)?,
        metadata,
    })
}

fn open_document_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OpenDocument> {
    Ok(OpenDocument {
        record: ReaderRecord {
            id: row.get(0)?,
            name: row.get(1)?,
            format: parse_format(row.get::<_, String>(2)?)?,
            size_bytes: row.get::<_, i64>(3)?.max(0) as u64,
            first_seen_at: row.get(4)?,
            updated_at: row.get(5)?,
        },
        root_id: row.get(6)?,
        relative_path: row.get(7)?,
        availability: row.get(8)?,
        root_locator: row.get(9)?,
    })
}

fn reading_state_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReadingState> {
    let kind: String = row.get(1)?;
    let position = match kind.as_str() {
        "pdf-page" => ReadingPosition::PdfPage {
            page: row.get::<_, Option<i64>>(2)?.unwrap_or(1).max(1) as u64,
            progression: row.get(4)?,
        },
        "epub-cfi" => ReadingPosition::EpubCfi {
            cfi: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            progression: row.get(4)?,
        },
        "text-scroll" => ReadingPosition::TextScroll {
            progression: row.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
        },
        _ => {
            return Err(rusqlite::Error::InvalidColumnType(
                1,
                "position_kind".to_string(),
                rusqlite::types::Type::Text,
            ))
        }
    };
    Ok(ReadingState {
        document_id: row.get(0)?,
        position,
        last_opened_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn bookmark_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BookmarkDto> {
    let kind: String = row.get(2)?;
    let position = match kind.as_str() {
        "pdf-page" => ReadingPosition::PdfPage {
            page: row.get::<_, Option<i64>>(3)?.unwrap_or(1).max(1) as u64,
            progression: row.get(5)?,
        },
        "epub-cfi" => ReadingPosition::EpubCfi {
            cfi: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            progression: row.get(5)?,
        },
        "text-scroll" => ReadingPosition::TextScroll {
            progression: row.get::<_, Option<f64>>(5)?.unwrap_or(0.0),
        },
        _ => {
            return Err(rusqlite::Error::InvalidColumnType(
                2,
                "position_kind".to_string(),
                rusqlite::types::Type::Text,
            ))
        }
    };
    Ok(BookmarkDto {
        id: row.get(0)?,
        document_id: row.get(1)?,
        position,
        title: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn annotation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AnnotationDto> {
    let kind: String = row.get(2)?;
    let pos_kind: String = row.get(3)?;
    let position = match pos_kind.as_str() {
        "pdf-page" => ReadingPosition::PdfPage {
            page: row.get::<_, Option<i64>>(4)?.unwrap_or(1).max(1) as u64,
            progression: row.get(6)?,
        },
        "epub-cfi" => ReadingPosition::EpubCfi {
            cfi: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            progression: row.get(6)?,
        },
        "text-scroll" => ReadingPosition::TextScroll {
            progression: row.get::<_, Option<f64>>(6)?.unwrap_or(0.0),
        },
        _ => {
            return Err(rusqlite::Error::InvalidColumnType(
                3,
                "position_kind".to_string(),
                rusqlite::types::Type::Text,
            ))
        }
    };
    Ok(AnnotationDto {
        id: row.get(0)?,
        document_id: row.get(1)?,
        kind,
        position,
        selected_text: row.get(7)?,
        note: row.get(8)?,
        locator: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn parse_format(value: String) -> rusqlite::Result<FormatId> {
    let normalized = crate::conversion::normalize_format(&value);
    match normalized.as_str() {
        "pdf" => Ok(FormatId::Pdf),
        "epub" => Ok(FormatId::Epub),
        "docx" => Ok(FormatId::Docx),
        "odt" => Ok(FormatId::Odt),
        "rtf" => Ok(FormatId::Rtf),
        "html" => Ok(FormatId::Html),
        "md" => Ok(FormatId::Md),
        "txt" => Ok(FormatId::Txt),
        _ => Err(rusqlite::Error::InvalidColumnType(
            2,
            "format_id".to_string(),
            rusqlite::types::Type::Text,
        )),
    }
}

#[cfg(test)]
mod tests;
