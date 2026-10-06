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
mod catalog_reconciliation;
mod collections;
pub mod commands;
mod document_read_context;
mod filesystem_observation;
mod migrations;
mod reader_artifacts;
mod roots;
mod rows;
use document_read_context::DocumentReadContext;
use rows::{
    annotation_from_row, bookmark_from_row, document_from_row, open_document_from_row,
    reading_state_from_row, OpenDocument,
};

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
        fs::create_dir_all(&thumb_dir)
            .map_err(|e| format!("Could not create thumbnail directory: {e}"))?;
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
        fs::create_dir_all(&thumb_dir)
            .map_err(|e| format!("Could not create thumbnail directory: {e}"))?;
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
        let filesystem_observation = filesystem_observation::observe(&root_path, relative_path)?;
        let filesystem_observation::FilesystemObservation {
            scope_path,
            files,
            mut errors,
        } = filesystem_observation;
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
            let reconciled = catalog_reconciliation::reconcile_document(
                &transaction,
                root_id,
                relative_path,
                &name,
                format_id.as_str(),
                metadata.len() as i64,
                &now,
                &scan_marker,
            )?;
            let Some(reconciled) = reconciled else {
                continue;
            };
            if reconciled.inserted {
                inserted += 1;
            } else {
                updated += 1;
            }
            let doc_id = reconciled.document_id;

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
        let missing = catalog_reconciliation::reconcile_missing_documents(
            &transaction,
            root_id,
            scope_path.as_deref(),
            &scan_marker,
            &now,
        )?;
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
        let mut read_context = DocumentReadContext::load(&connection)?;

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
            Ok(read_context.attach(doc))
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

    fn document(&self, document_id: &str) -> Result<Option<OpenDocument>, String> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT d.id, d.name, d.format_id, d.size_bytes, d.first_seen_at, d.updated_at,
                        d.root_id, d.relative_path, d.availability, r.locator_value
                 FROM documents d JOIN library_roots r ON r.id = d.root_id
                 WHERE d.id = ?1 AND d.excluded_at IS NULL",
                [document_id],
                open_document_from_row,
            )
            .optional()
            .map_err(db_error)
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
        let relative = Path::new(&rel_path);
        if rel_path.trim().is_empty()
            || relative.is_absolute()
            || relative
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err("Thumbnail path escaped its thumbnail directory.".to_string());
        }
        let thumbnail_root = fs::canonicalize(&self.thumbnail_dir)
            .map_err(|e| format!("Could not access thumbnail directory: {e}"))?;
        let candidate = thumbnail_root.join(relative);
        let full_path = match fs::canonicalize(&candidate) {
            Ok(path) if path.starts_with(&thumbnail_root) => path,
            Ok(_) => return Err("Thumbnail path escaped its thumbnail directory.".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("Could not access thumbnail: {error}")),
        };
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

pub(crate) fn civil_date(days: i64) -> (i64, i64, i64) {
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

#[cfg(test)]
mod tests;
