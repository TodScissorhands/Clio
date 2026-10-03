use crate::metadata::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;
use uuid::Uuid;

const SUPPORTED_FORMATS: &[&str] = &[
    "pdf", "epub", "docx", "odt", "rtf", "html", "htm", "md", "markdown", "txt",
];
const SCHEMA_VERSION: i64 = 5;

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
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(db_error)?;
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(db_error)?;
        if version >= SCHEMA_VERSION {
            return Ok(());
        }
        if version < 1 {
            let transaction = connection.transaction().map_err(db_error)?;
            // Databases created by the prototype used a schema_migrations table and a
            // document_sources join table. Keep their data when upgrading, but never
            // use either table in the fixed catalog.
            let old_roots = table_exists(&transaction, "library_roots")?;
            let old_documents = table_exists(&transaction, "documents")?;
            let old_sources = table_exists(&transaction, "document_sources")?;
            let old_reading_states = table_exists(&transaction, "reading_states")?;
            if old_roots {
                transaction
                    .execute_batch("ALTER TABLE library_roots RENAME TO library_roots_legacy;")
                    .map_err(db_error)?;
            }
            if old_documents {
                transaction
                    .execute_batch("ALTER TABLE documents RENAME TO documents_legacy;")
                    .map_err(db_error)?;
            }
            if old_sources {
                transaction
                    .execute_batch(
                        "ALTER TABLE document_sources RENAME TO document_sources_legacy;",
                    )
                    .map_err(db_error)?;
            }
            if old_reading_states {
                transaction
                    .execute_batch("ALTER TABLE reading_states RENAME TO reading_states_legacy;")
                    .map_err(db_error)?;
            }
            transaction
            .execute_batch(
                "DROP TABLE IF EXISTS schema_migrations;
                 CREATE TABLE IF NOT EXISTS library_roots (
                     id TEXT PRIMARY KEY NOT NULL,
                     label TEXT NOT NULL,
                     locator_kind TEXT NOT NULL,
                     locator_value TEXT NOT NULL UNIQUE,
                     last_scanned_at TEXT,
                     created_at TEXT NOT NULL,
                     updated_at TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS documents (
                     id TEXT PRIMARY KEY NOT NULL,
                     root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
                     relative_path TEXT NOT NULL,
                     name TEXT NOT NULL,
                     format_id TEXT NOT NULL,
                     size_bytes INTEGER NOT NULL,
                     first_seen_at TEXT NOT NULL,
                     updated_at TEXT NOT NULL,
                     last_seen_scan TEXT NOT NULL,
                     availability TEXT NOT NULL DEFAULT 'missing'
                         CHECK (availability IN ('present', 'missing')),
                     UNIQUE(root_id, relative_path)
                 );
                 CREATE INDEX IF NOT EXISTS idx_documents_root_id ON documents(root_id);
                 CREATE INDEX IF NOT EXISTS idx_documents_availability ON documents(availability);
                 CREATE INDEX IF NOT EXISTS idx_documents_format_id ON documents(format_id);
                 CREATE INDEX IF NOT EXISTS idx_documents_last_seen_scan ON documents(last_seen_scan);
                 CREATE TABLE IF NOT EXISTS reading_state (
                     document_id TEXT PRIMARY KEY NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                     position_kind TEXT NOT NULL,
                     page INTEGER,
                     cfi TEXT,
                     progression REAL,
                     last_opened_at TEXT NOT NULL,
                     updated_at TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_reading_state_updated_at ON reading_state(updated_at);
                 CREATE INDEX IF NOT EXISTS idx_reading_state_position_kind ON reading_state(position_kind);
                 PRAGMA user_version = 1;",
            )
            .map_err(db_error)?;

            if old_roots {
                transaction
                .execute(
                    "INSERT OR IGNORE INTO library_roots
                         (id, label, locator_kind, locator_value, last_scanned_at, created_at, updated_at)
                     SELECT id, label, 'filesystem-directory', path, NULL, created_at, updated_at
                     FROM library_roots_legacy",
                    [],
                )
                .map_err(db_error)?;
            }
            if old_documents && old_sources {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO documents
                         (id, root_id, relative_path, name, format_id, size_bytes,
                          first_seen_at, updated_at, last_seen_scan, availability)
                     SELECT d.id, s.root_id, s.relative_path, d.name, d.format, d.size_bytes,
                            d.first_seen_at, d.updated_at, s.last_seen_at,
                            CASE WHEN s.present <> 0 THEN 'present' ELSE 'missing' END
                     FROM documents_legacy d JOIN document_sources_legacy s ON s.document_id = d.id
                     JOIN library_roots r ON r.id = s.root_id",
                        [],
                    )
                    .map_err(db_error)?;
            }
            if old_reading_states {
                transaction
                .execute(
                    "INSERT OR IGNORE INTO reading_state
                         (document_id, position_kind, page, cfi, progression, last_opened_at, updated_at)
                     SELECT document_id, position_kind, page, cfi, progression, last_opened_at, updated_at
                     FROM reading_states_legacy",
                    [],
                )
                .map_err(db_error)?;
            }
            transaction.commit().map_err(db_error)?;
        }

        if version < 2 {
            let transaction = connection.transaction().map_err(db_error)?;
            transaction
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS bookmarks (
                         id TEXT PRIMARY KEY NOT NULL,
                         document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                         position_kind TEXT NOT NULL,
                         page INTEGER,
                         cfi TEXT,
                         progression REAL,
                         title TEXT,
                         created_at TEXT NOT NULL,
                         updated_at TEXT NOT NULL
                     );
                     CREATE INDEX IF NOT EXISTS idx_bookmarks_document_id ON bookmarks(document_id);
                     CREATE INDEX IF NOT EXISTS idx_bookmarks_document_created ON bookmarks(document_id, created_at);

                     CREATE TABLE IF NOT EXISTS annotations (
                         id TEXT PRIMARY KEY NOT NULL,
                         document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                         kind TEXT NOT NULL,
                         position_kind TEXT NOT NULL,
                         page INTEGER,
                         cfi TEXT,
                         progression REAL,
                         selected_text TEXT,
                         note TEXT,
                         created_at TEXT NOT NULL,
                         updated_at TEXT NOT NULL
                     );
                     CREATE INDEX IF NOT EXISTS idx_annotations_document_id ON annotations(document_id);
                     CREATE INDEX IF NOT EXISTS idx_annotations_document_created ON annotations(document_id, created_at);

                     PRAGMA user_version = 2;",
                )
                .map_err(db_error)?;
            transaction.commit().map_err(db_error)?;
        }

        if version < 3 {
            let transaction = connection.transaction().map_err(db_error)?;
            transaction
                .execute_batch(
                    "ALTER TABLE annotations ADD COLUMN locator TEXT;
                     PRAGMA user_version = 3;",
                )
                .map_err(db_error)?;
            transaction.commit().map_err(db_error)?;
        }

        if version < 4 {
            let transaction = connection.transaction().map_err(db_error)?;
            transaction
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS document_metadata (
                         document_id TEXT PRIMARY KEY NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                         title TEXT,
                         authors TEXT NOT NULL DEFAULT '[]',
                         publisher TEXT,
                         published_date TEXT,
                         description TEXT,
                         language TEXT,
                         identifiers TEXT NOT NULL DEFAULT '[]',
                         provenance TEXT NOT NULL DEFAULT 'fallback' CHECK (provenance IN ('embedded', 'fallback')),
                         thumbnail_path TEXT,
                         updated_at TEXT NOT NULL
                     );
                     CREATE INDEX IF NOT EXISTS idx_document_metadata_doc_id ON document_metadata(document_id);
                     CREATE INDEX IF NOT EXISTS idx_document_metadata_title ON document_metadata(title COLLATE NOCASE);

                     CREATE TABLE IF NOT EXISTS collections (
                         id TEXT PRIMARY KEY NOT NULL,
                         name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                         description TEXT,
                         created_at TEXT NOT NULL,
                         updated_at TEXT NOT NULL
                     );
                     CREATE INDEX IF NOT EXISTS idx_collections_name ON collections(name);

                     CREATE TABLE IF NOT EXISTS document_collections (
                         collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                         document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                         added_at TEXT NOT NULL,
                         PRIMARY KEY (collection_id, document_id)
                     );
                     CREATE INDEX IF NOT EXISTS idx_doc_col_collection ON document_collections(collection_id);
                     CREATE INDEX IF NOT EXISTS idx_doc_col_document ON document_collections(document_id);

                     PRAGMA user_version = 4;",
                )
                .map_err(db_error)?;
            transaction.commit().map_err(db_error)?;
        }
        if version < 5 {
            let transaction = connection.transaction().map_err(db_error)?;
            transaction
                .execute_batch(
                    "ALTER TABLE documents ADD COLUMN excluded_at TEXT;
                     CREATE INDEX IF NOT EXISTS idx_documents_excluded_at ON documents(excluded_at);
                     PRAGMA user_version = 5;",
                )
                .map_err(db_error)?;
            transaction.commit().map_err(db_error)?;
        }
        Ok(())
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

        let mut files = Vec::new();
        let mut errors = Vec::new();
        collect_files(&root_path, &root_path, &mut files, &mut errors);
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
        transaction
            .execute(
                "UPDATE documents SET availability = 'missing'
                 WHERE root_id = ?1 AND (last_seen_scan IS NULL OR last_seen_scan <> ?2)",
                params![root_id, scan_marker],
            )
            .map_err(db_error)?;
        let missing: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM documents WHERE root_id = ?1 AND availability = 'missing' AND excluded_at IS NULL",
                [root_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        transaction
            .execute(
                "UPDATE library_roots SET last_scanned_at = ?1, updated_at = ?1 WHERE id = ?2",
                params![now, root_id],
            )
            .map_err(db_error)?;
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

#[tauri::command]
pub fn library_root_add(
    db: State<'_, LibraryDb>,
    path: String,
    label: Option<String>,
) -> Result<LibraryRootDto, String> {
    db.add_root(&path, label.as_deref())
}

#[tauri::command]
pub fn library_root_list(db: State<'_, LibraryDb>) -> Result<Vec<LibraryRootDto>, String> {
    db.list_roots()
}

#[tauri::command]
pub fn library_root_remove(db: State<'_, LibraryDb>, root_id: String) -> Result<(), String> {
    db.remove_root(&root_id)
}

#[tauri::command]
pub fn library_root_scan(
    db: State<'_, LibraryDb>,
    root_id: String,
) -> Result<LibraryScanResultDto, String> {
    db.scan_root(&root_id)
}

#[tauri::command]
pub fn library_document_list(
    db: State<'_, LibraryDb>,
    root_id: Option<String>,
    include_missing: Option<bool>,
) -> Result<Vec<DocumentDto>, String> {
    db.list_documents(root_id.as_deref(), include_missing.unwrap_or(false))
}
#[tauri::command]
pub fn library_document_path(
    db: State<'_, LibraryDb>,
    document_id: String,
) -> Result<String, String> {
    db.document_path(&document_id)
}
#[tauri::command]
pub fn library_document_remove(
    db: State<'_, LibraryDb>,
    document_id: String,
) -> Result<(), String> {
    db.remove_document(&document_id)
}
#[tauri::command]
pub fn library_document_relink(
    db: State<'_, LibraryDb>,
    document_id: String,
    new_path: String,
) -> Result<DocumentDto, String> {
    db.relink_document(&document_id, &new_path)
}
#[tauri::command]
pub fn library_document_add_external(
    db: State<'_, LibraryDb>,
    file_path: String,
) -> Result<DocumentDto, String> {
    db.add_external_document_to_library(&file_path)
}

#[tauri::command]
pub fn reading_state_get(
    db: State<'_, LibraryDb>,
    document_id: String,
) -> Result<Option<ReadingState>, String> {
    db.get_reading_state(&document_id)
}
#[tauri::command]
pub fn reading_state_list(db: State<'_, LibraryDb>) -> Result<Vec<ReadingState>, String> {
    db.list_reading_states()
}

#[tauri::command]
pub fn reading_state_set(db: State<'_, LibraryDb>, state: ReadingState) -> Result<(), String> {
    db.set_reading_state(state)
}

#[tauri::command]
pub fn bookmark_create(
    db: State<'_, LibraryDb>,
    document_id: String,
    position: ReadingPosition,
    title: Option<String>,
) -> Result<BookmarkDto, String> {
    db.create_bookmark(&document_id, position, title.as_deref())
}

#[tauri::command]
pub fn bookmark_list(
    db: State<'_, LibraryDb>,
    document_id: String,
) -> Result<Vec<BookmarkDto>, String> {
    db.list_bookmarks(&document_id)
}

#[tauri::command]
pub fn bookmark_delete(db: State<'_, LibraryDb>, bookmark_id: String) -> Result<(), String> {
    db.delete_bookmark(&bookmark_id)
}

#[tauri::command]
pub fn annotation_create(
    db: State<'_, LibraryDb>,
    document_id: String,
    kind: String,
    position: ReadingPosition,
    selected_text: Option<String>,
    note: Option<String>,
    locator: Option<String>,
) -> Result<AnnotationDto, String> {
    db.create_annotation(
        &document_id,
        &kind,
        position,
        selected_text.as_deref(),
        note.as_deref(),
        locator.as_deref(),
    )
}

#[tauri::command]
pub fn annotation_list(
    db: State<'_, LibraryDb>,
    document_id: String,
) -> Result<Vec<AnnotationDto>, String> {
    db.list_annotations(&document_id)
}

#[tauri::command]
pub fn annotation_update(
    db: State<'_, LibraryDb>,
    annotation_id: String,
    note: Option<String>,
) -> Result<AnnotationDto, String> {
    db.update_annotation(&annotation_id, note.as_deref())
}

#[tauri::command]
pub fn annotation_delete(db: State<'_, LibraryDb>, annotation_id: String) -> Result<(), String> {
    db.delete_annotation(&annotation_id)
}

#[tauri::command]
pub fn library_collection_create(
    db: State<'_, LibraryDb>,
    name: String,
    description: Option<String>,
) -> Result<CollectionDto, String> {
    db.create_collection(&name, description.as_deref())
}

#[tauri::command]
pub fn library_collection_list(db: State<'_, LibraryDb>) -> Result<Vec<CollectionDto>, String> {
    db.list_collections()
}

#[tauri::command]
pub fn library_collection_rename(
    db: State<'_, LibraryDb>,
    id: String,
    name: String,
) -> Result<CollectionDto, String> {
    db.rename_collection(&id, &name)
}

#[tauri::command]
pub fn library_collection_delete(db: State<'_, LibraryDb>, id: String) -> Result<(), String> {
    db.delete_collection(&id)
}

#[tauri::command]
pub fn library_collection_add_document(
    db: State<'_, LibraryDb>,
    collection_id: String,
    document_id: String,
) -> Result<(), String> {
    db.add_document_to_collection(&collection_id, &document_id)
}

#[tauri::command]
pub fn library_collection_remove_document(
    db: State<'_, LibraryDb>,
    collection_id: String,
    document_id: String,
) -> Result<(), String> {
    db.remove_document_from_collection(&collection_id, &document_id)
}

#[tauri::command]
pub fn library_collection_list_documents(
    db: State<'_, LibraryDb>,
    collection_id: String,
) -> Result<Vec<DocumentDto>, String> {
    db.list_collection_documents(&collection_id)
}

#[tauri::command]
pub fn library_thumbnail_get(
    db: State<'_, LibraryDb>,
    document_id: String,
) -> Result<Option<String>, String> {
    db.get_thumbnail_data_url(&document_id)
}

#[tauri::command]
pub fn library_metadata_get(
    db: State<'_, LibraryDb>,
    document_id: String,
) -> Result<Option<DocumentMetadata>, String> {
    db.get_metadata(&document_id)
}

#[tauri::command]
pub fn library_metadata_update(
    db: State<'_, LibraryDb>,
    document_id: String,
    metadata: DocumentMetadata,
) -> Result<DocumentMetadata, String> {
    db.update_metadata(&document_id, metadata)
}

#[tauri::command]
pub fn library_document_collections_list(
    db: State<'_, LibraryDb>,
    document_id: String,
) -> Result<Vec<String>, String> {
    db.list_document_collections(&document_id)
}

#[tauri::command]
pub fn format_capabilities_get(format: String) -> Result<FormatCapabilitiesDto, String> {
    let normalized = crate::conversion::normalize_format(&format);
    let format_id = match normalized.as_str() {
        "pdf" => FormatId::Pdf,
        "epub" => FormatId::Epub,
        "docx" => FormatId::Docx,
        "odt" => FormatId::Odt,
        "rtf" => FormatId::Rtf,
        "html" => FormatId::Html,
        "md" => FormatId::Md,
        "txt" => FormatId::Txt,
        _ => return Err(format!("Unsupported format '{format}'.")),
    };
    Ok(format_id.capabilities())
}
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

fn table_exists(connection: &Connection, name: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [name],
            |row| row.get(0),
        )
        .map_err(db_error)
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
mod tests {
    use super::*;
    use crate::conversion::is_tool_installed;
    use std::process::Command;
    #[test]
    fn test_schema_migration_and_idempotence() {
        let db = LibraryDb::open_in_memory().expect("open in-memory db");
        db.migrate()
            .expect("second migrate call must be idempotent");
        let connection = db.lock().expect("lock connection");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("query user_version");
        assert_eq!(version, 5);
    }

    #[test]
    fn test_library_root_crud() {
        let temp_dir = std::env::temp_dir().join(format!("clio-test-root-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp root");
        let db = LibraryDb::open_in_memory().expect("open db");

        let root = db
            .add_root(&temp_dir.to_string_lossy(), Some("Test Root"))
            .expect("add root");
        assert_eq!(root.label, "Test Root");
        assert_eq!(root.kind, "filesystem-directory");
        assert_eq!(root.status, "active");

        let roots = db.list_roots().expect("list roots");
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].id, root.id);

        db.remove_root(&root.id).expect("remove root");
        let roots_after = db.list_roots().expect("list roots after remove");
        assert!(roots_after.is_empty());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_scanner_discovery_and_normalization() {
        let temp_dir = std::env::temp_dir().join(format!("clio-test-scan-{}", Uuid::new_v4()));
        let sub_dir = temp_dir.join("sub");
        fs::create_dir_all(&sub_dir).expect("create sub dir");

        fs::write(temp_dir.join("book.pdf"), b"%PDF-1.4 test").expect("write pdf");
        fs::write(temp_dir.join("novel.epub"), b"PK epub test").expect("write epub");
        fs::write(temp_dir.join("page.htm"), b"<html>test</html>").expect("write htm");
        fs::write(temp_dir.join("ignored.xyz"), b"ignore me").expect("write ignored");
        fs::write(sub_dir.join("notes.md"), b"# Notes").expect("write md");

        #[cfg(unix)]
        let symlink_path = temp_dir.join("symlink_book.pdf");
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(temp_dir.join("book.pdf"), &symlink_path);

        let db = LibraryDb::open_in_memory().expect("open db");
        let root = db
            .add_root(&temp_dir.to_string_lossy(), None)
            .expect("add root");

        let result = db.scan_root(&root.id).expect("scan root");
        assert_eq!(result.scanned, 4); // pdf, epub, htm, md (symlink and .xyz skipped)
        assert_eq!(result.inserted, 4);
        assert_eq!(result.missing, 0);
        assert!(result.errors.is_empty());

        let docs = db.list_documents(Some(&root.id), false).expect("list docs");
        assert_eq!(docs.len(), 4);

        let htm_doc = docs
            .iter()
            .find(|d| d.name == "page.htm")
            .expect("find page.htm");
        assert_eq!(htm_doc.format, FormatId::Html);

        let rescan = db.scan_root(&root.id).expect("rescan root");
        assert_eq!(rescan.scanned, 4);
        assert_eq!(rescan.inserted, 0);
        assert_eq!(rescan.updated, 4);

        let docs_rescan = db
            .list_documents(Some(&root.id), false)
            .expect("list docs after rescan");
        assert_eq!(docs_rescan.len(), 4);
        for doc in &docs {
            let matching = docs_rescan
                .iter()
                .find(|d| d.id == doc.id)
                .expect("doc id stable");
            assert_eq!(matching.relative_path, doc.relative_path);
        }

        let _ = fs::remove_file(temp_dir.join("novel.epub"));
        let rescan_missing = db.scan_root(&root.id).expect("scan after delete");
        assert_eq!(rescan_missing.scanned, 3);
        assert_eq!(rescan_missing.missing, 1);

        let present_docs = db
            .list_documents(Some(&root.id), false)
            .expect("list present docs");
        assert_eq!(present_docs.len(), 3);
        let all_docs = db
            .list_documents(Some(&root.id), true)
            .expect("list all docs");
        assert_eq!(all_docs.len(), 4);
        let missing_doc = all_docs
            .iter()
            .find(|d| d.name == "novel.epub")
            .expect("find missing");
        assert_eq!(missing_doc.availability, "missing");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_open_library_document_and_direct_open() {
        let temp_dir = std::env::temp_dir().join(format!("clio-test-open-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");
        let book_path = temp_dir.join("guide.pdf");
        fs::write(&book_path, b"%PDF sample").expect("write file");

        let db = LibraryDb::open_in_memory().expect("open db");
        let root = db
            .add_root(&temp_dir.to_string_lossy(), None)
            .expect("add root");
        db.scan_root(&root.id).expect("scan");

        let docs = db.list_documents(Some(&root.id), false).expect("list");
        assert_eq!(docs.len(), 1);
        let doc_id = &docs[0].id;

        let opened = db
            .open_library_document(doc_id, |path| {
                assert_eq!(
                    fs::canonicalize(path).unwrap(),
                    fs::canonicalize(&book_path).unwrap()
                );
                Ok("fake-token-123".to_string())
            })
            .expect("open document");
        assert_eq!(opened.record.name, "guide.pdf");
        assert_eq!(opened.locator.kind, "desktop-token");
        assert_eq!(opened.locator.value, "fake-token-123");

        let missing_open = db.open_library_document("nonexistent-id", |_| Ok("token".to_string()));
        assert!(missing_open.is_err());

        let direct = direct_open(book_path.to_string_lossy().into_owned(), |_| {
            Ok("token-direct".to_string())
        })
        .expect("direct open");
        assert_eq!(direct.record.name, "guide.pdf");
        assert_eq!(direct.locator.value, "token-direct");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_reading_state_roundtrip_and_validation() {
        let temp_dir = std::env::temp_dir().join(format!("clio-test-state-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");
        fs::write(temp_dir.join("test.pdf"), b"%PDF sample").expect("write file");

        let db = LibraryDb::open_in_memory().expect("open db");
        let root = db
            .add_root(&temp_dir.to_string_lossy(), None)
            .expect("add root");
        db.scan_root(&root.id).expect("scan");
        let docs = db.list_documents(Some(&root.id), false).expect("list");
        let doc_id = docs[0].id.clone();
        // Missing document state returns None cleanly
        assert!(db
            .get_reading_state(&doc_id)
            .expect("query state")
            .is_none());

        // 1. PDF reading-state roundtrip
        let valid_pdf_state = ReadingState {
            document_id: doc_id.clone(),
            position: ReadingPosition::PdfPage {
                page: 5,
                progression: Some(0.5),
            },
            last_opened_at: "2026-10-01T12:00:00Z".to_string(),
            updated_at: "2026-10-01T12:00:00Z".to_string(),
        };
        db.set_reading_state(valid_pdf_state)
            .expect("set pdf reading state");

        let retrieved_pdf = db
            .get_reading_state(&doc_id)
            .expect("get reading state")
            .expect("some state");
        assert_eq!(retrieved_pdf.document_id, doc_id);
        let pdf_position_json =
            serde_json::to_value(&retrieved_pdf.position).expect("serialize pdf position");
        assert_eq!(pdf_position_json["kind"].as_str(), Some("pdf-page"));
        assert_eq!(pdf_position_json["progression"].as_f64(), Some(0.5));
        let legacy_pdf_position: ReadingPosition = serde_json::from_value(serde_json::json!({
            "kind": "pdf-page",
            "page": 5,
        }))
        .expect("deserialize PDF position without progression");
        assert!(matches!(
            legacy_pdf_position,
            ReadingPosition::PdfPage {
                page: 5,
                progression: None
            }
        ));
        match retrieved_pdf.position {
            ReadingPosition::PdfPage { page, progression } => {
                assert_eq!(page, 5);
                assert_eq!(progression, Some(0.5));
            }
            _ => panic!("expected pdf-page"),
        }

        // 2. EPUB reading-state roundtrip
        let valid_epub_state = ReadingState {
            document_id: doc_id.clone(),
            position: ReadingPosition::EpubCfi {
                cfi: "epubcfi(/6/4[chap01]!/4/2/10)".to_string(),
                progression: Some(0.42),
            },
            last_opened_at: "2026-10-01T13:00:00Z".to_string(),
            updated_at: "2026-10-01T13:00:00Z".to_string(),
        };
        db.set_reading_state(valid_epub_state)
            .expect("set epub reading state");

        let retrieved_epub = db
            .get_reading_state(&doc_id)
            .expect("get epub state")
            .expect("some state");
        assert_eq!(retrieved_epub.document_id, doc_id);
        match retrieved_epub.position {
            ReadingPosition::EpubCfi { cfi, progression } => {
                assert_eq!(cfi, "epubcfi(/6/4[chap01]!/4/2/10)");
                assert_eq!(progression, Some(0.42));
            }
            _ => panic!("expected epub-cfi"),
        }
        let invalid_page_state = ReadingState {
            document_id: doc_id.clone(),
            position: ReadingPosition::PdfPage {
                page: 0,
                progression: None,
            },
            last_opened_at: "2026-10-01T12:00:00Z".to_string(),
            updated_at: "2026-10-01T12:00:00Z".to_string(),
        };
        assert!(db.set_reading_state(invalid_page_state).is_err());

        let invalid_pdf_progression_state = ReadingState {
            document_id: doc_id.clone(),
            position: ReadingPosition::PdfPage {
                page: 2,
                progression: Some(1.5),
            },
            last_opened_at: "2026-10-01T12:00:00Z".to_string(),
            updated_at: "2026-10-01T12:00:00Z".to_string(),
        };
        assert!(db.set_reading_state(invalid_pdf_progression_state).is_err());

        let invalid_progression_state = ReadingState {
            document_id: doc_id.clone(),
            position: ReadingPosition::EpubCfi {
                cfi: "epubcfi(/6/2)".to_string(),
                progression: Some(1.5),
            },
            last_opened_at: "2026-10-01T12:00:00Z".to_string(),
            updated_at: "2026-10-01T12:00:00Z".to_string(),
        };
        assert!(db.set_reading_state(invalid_progression_state).is_err());

        let unknown_doc_state = ReadingState {
            document_id: "unknown-uuid".to_string(),
            position: ReadingPosition::PdfPage {
                page: 1,
                progression: None,
            },
            last_opened_at: "2026-10-01T12:00:00Z".to_string(),
            updated_at: "2026-10-01T12:00:00Z".to_string(),
        };
        assert!(db.set_reading_state(unknown_doc_state).is_err());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_bookmark_crud_validation_and_cascade_delete() {
        let temp_dir = std::env::temp_dir().join(format!("clio-test-bm-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");
        fs::write(temp_dir.join("book.pdf"), b"%PDF sample").expect("write file");

        let db = LibraryDb::open_in_memory().expect("open db");
        let root = db
            .add_root(&temp_dir.to_string_lossy(), None)
            .expect("add root");
        db.scan_root(&root.id).expect("scan");
        let docs = db.list_documents(Some(&root.id), false).expect("list");
        let doc_id = docs[0].id.clone();

        // 1. Initial list is empty
        let bookmarks = db.list_bookmarks(&doc_id).expect("list bookmarks");
        assert!(bookmarks.is_empty());

        // 2. Create PDF bookmark
        let bm1 = db
            .create_bookmark(
                &doc_id,
                ReadingPosition::PdfPage {
                    page: 12,
                    progression: None,
                },
                Some("Chapter 2"),
            )
            .expect("create bookmark 1");
        assert_eq!(bm1.document_id, doc_id);
        assert_eq!(bm1.title, Some("Chapter 2".to_string()));
        match bm1.position {
            ReadingPosition::PdfPage { page, .. } => assert_eq!(page, 12),
            _ => panic!("expected pdf-page"),
        }

        // 3. Create EPUB bookmark with fallback title
        let bm2 = db
            .create_bookmark(
                &doc_id,
                ReadingPosition::EpubCfi {
                    cfi: "epubcfi(/6/6)".to_string(),
                    progression: Some(0.55),
                },
                None, // Fallback title should be "55%"
            )
            .expect("create bookmark 2");
        assert_eq!(bm2.title, Some("55%".to_string()));

        // 4. List bookmarks returns both (order is created_at ASC, id ASC; both may share
        //    the same timestamp in tests so only assert presence, not position).
        let listed = db.list_bookmarks(&doc_id).expect("list bookmarks");
        assert_eq!(listed.len(), 2);
        let ids: Vec<&str> = listed.iter().map(|b| b.id.as_str()).collect();
        assert!(ids.contains(&bm1.id.as_str()), "bm1 must be listed");
        assert!(ids.contains(&bm2.id.as_str()), "bm2 must be listed");

        // 5. Validation: Reject invalid page 0
        assert!(db
            .create_bookmark(
                &doc_id,
                ReadingPosition::PdfPage {
                    page: 0,
                    progression: None
                },
                None
            )
            .is_err());

        // 6. Validation: Reject empty CFI
        assert!(db
            .create_bookmark(
                &doc_id,
                ReadingPosition::EpubCfi {
                    cfi: "".to_string(),
                    progression: None,
                },
                None,
            )
            .is_err());

        // 7. Validation: Reject invalid progression
        assert!(db
            .create_bookmark(
                &doc_id,
                ReadingPosition::EpubCfi {
                    cfi: "epubcfi(/6/2)".to_string(),
                    progression: Some(1.2),
                },
                None,
            )
            .is_err());

        // 8. Validation: Reject unknown document ID
        assert!(db
            .create_bookmark(
                "unknown-doc",
                ReadingPosition::PdfPage {
                    page: 1,
                    progression: None
                },
                None
            )
            .is_err());

        // 9. Delete bookmark
        db.delete_bookmark(&bm1.id).expect("delete bm1");
        let after_delete = db.list_bookmarks(&doc_id).expect("list after delete");
        assert_eq!(after_delete.len(), 1);
        assert_eq!(after_delete[0].id, bm2.id);

        // 10. Cascade delete on document/root deletion
        db.remove_root(&root.id).expect("remove root");
        let after_cascade = db.list_bookmarks(&doc_id).expect("list after cascade");
        assert!(after_cascade.is_empty());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_annotation_crud_and_cascade_delete() {
        let temp_dir = std::env::temp_dir().join(format!("clio-test-ann-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");
        fs::write(temp_dir.join("book.pdf"), b"%PDF sample").expect("write file");

        let db = LibraryDb::open_in_memory().expect("open db");
        let root = db
            .add_root(&temp_dir.to_string_lossy(), None)
            .expect("add root");
        db.scan_root(&root.id).expect("scan");
        let docs = db.list_documents(Some(&root.id), false).expect("list");
        let doc_id = docs[0].id.clone();

        let ann = db
            .create_annotation(
                &doc_id,
                "highlight",
                ReadingPosition::PdfPage {
                    page: 3,
                    progression: None,
                },
                Some("Important sentence"),
                Some("Check reference later"),
                None,
            )
            .expect("create annotation");
        assert_eq!(ann.document_id, doc_id);
        assert_eq!(ann.kind, "highlight");
        assert_eq!(ann.selected_text, Some("Important sentence".to_string()));
        assert_eq!(ann.note, Some("Check reference later".to_string()));
        assert_eq!(ann.locator, None);

        let listed = db.list_annotations(&doc_id).expect("list annotations");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, ann.id);

        // Validation: reject empty kind
        assert!(db
            .create_annotation(
                &doc_id,
                "",
                ReadingPosition::PdfPage {
                    page: 3,
                    progression: None
                },
                None,
                None,
                None,
            )
            .is_err());

        // Delete annotation
        db.delete_annotation(&ann.id).expect("delete annotation");
        assert!(db
            .list_annotations(&doc_id)
            .expect("list after delete")
            .is_empty());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_annotation_locator_crud_and_schema_v3() {
        let temp_dir = std::env::temp_dir().join(format!("clio-test-loc-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");
        fs::write(temp_dir.join("book.epub"), b"PK epub").expect("write epub");

        let db = LibraryDb::open_in_memory().expect("open db");
        // Verify schema is v3.
        {
            let connection = db.lock().expect("lock");
            let version: i64 = connection
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .expect("user_version");
            assert!(version >= 3, "schema must be at least version 3");
        }

        let root = db
            .add_root(&temp_dir.to_string_lossy(), None)
            .expect("add root");
        db.scan_root(&root.id).expect("scan");
        let docs = db.list_documents(Some(&root.id), false).expect("list");
        let doc_id = docs[0].id.clone();

        // 1. Create annotation with EPUB range CFI locator.
        let epub_locator = r#"{"kind":"epub-cfi-range","cfi":"epubcfi(/6/4!/4,/2/1:0,/2/1:22)"}"#;
        let ann_epub = db
            .create_annotation(
                &doc_id,
                "highlight",
                ReadingPosition::EpubCfi {
                    cfi: "epubcfi(/6/4!/4/2)".to_string(),
                    progression: Some(0.25),
                },
                Some("Selected EPUB text"),
                None,
                Some(epub_locator),
            )
            .expect("create epub annotation with locator");
        assert_eq!(ann_epub.locator.as_deref(), Some(epub_locator));
        assert_eq!(
            ann_epub.selected_text.as_deref(),
            Some("Selected EPUB text")
        );

        // 2. Create annotation with PDF page-text locator.
        let pdf_locator = r#"{"kind":"pdf-page-text","page":5,"selectedText":"Some text"}"#;
        let ann_pdf = db
            .create_annotation(
                &doc_id,
                "highlight",
                ReadingPosition::PdfPage {
                    page: 5,
                    progression: None,
                },
                Some("Some text"),
                None,
                Some(pdf_locator),
            )
            .expect("create pdf annotation with locator");
        assert_eq!(ann_pdf.locator.as_deref(), Some(pdf_locator));

        // 3. Create annotation without locator (null).
        let ann_no_loc = db
            .create_annotation(
                &doc_id,
                "note",
                ReadingPosition::PdfPage {
                    page: 1,
                    progression: None,
                },
                None,
                Some("A plain note"),
                None,
            )
            .expect("create annotation without locator");
        assert_eq!(ann_no_loc.locator, None);

        // 4. Empty-string locator is normalized to NULL.
        let ann_empty = db
            .create_annotation(
                &doc_id,
                "note",
                ReadingPosition::PdfPage {
                    page: 2,
                    progression: None,
                },
                None,
                None,
                Some(""),
            )
            .expect("empty locator normalized to null");
        assert_eq!(ann_empty.locator, None);

        // 5. Non-JSON locator is rejected.
        assert!(db
            .create_annotation(
                &doc_id,
                "highlight",
                ReadingPosition::PdfPage {
                    page: 1,
                    progression: None
                },
                Some("text"),
                None,
                Some("not-json-at-all"),
            )
            .is_err());

        // 6. List annotations: all four valid annotations returned; locators preserved.
        let listed = db.list_annotations(&doc_id).expect("list");
        assert_eq!(listed.len(), 4);
        let with_locator: Vec<_> = listed.iter().filter(|a| a.locator.is_some()).collect();
        assert_eq!(with_locator.len(), 2, "two annotations have locators");
        let without_locator: Vec<_> = listed.iter().filter(|a| a.locator.is_none()).collect();
        assert_eq!(without_locator.len(), 2, "two annotations have no locator");

        // 7. Document isolation: annotations only returned for their document.
        let other_listed = db
            .list_annotations("non-existent-doc-id")
            .expect("list other");
        assert!(other_listed.is_empty());

        // 8. Cascade delete: removing root deletes annotations.
        db.remove_root(&root.id).expect("remove root");
        let after_cascade = db.list_annotations(&doc_id).expect("list after cascade");
        assert!(after_cascade.is_empty());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_annotation_update_and_deletion_failure() {
        let temp_dir = std::env::temp_dir().join(format!("clio-test-ann-upd-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");
        fs::write(temp_dir.join("book.epub"), b"PK epub content").expect("write epub");

        let db = LibraryDb::open_in_memory().expect("open db");
        let root = db
            .add_root(&temp_dir.to_string_lossy(), None)
            .expect("add root");
        db.scan_root(&root.id).expect("scan");
        let docs = db.list_documents(Some(&root.id), false).expect("list");
        let doc_id = docs[0].id.clone();

        let locator = r#"{"kind":"epub-cfi-range","cfi":"epubcfi(/6/4!/4,/2/1:0,/2/1:10)"}"#;
        let ann = db
            .create_annotation(
                &doc_id,
                "highlight",
                ReadingPosition::EpubCfi {
                    cfi: "epubcfi(/6/4!/4/2)".to_string(),
                    progression: Some(0.1),
                },
                Some("Initial highlight excerpt"),
                Some("Initial note"),
                Some(locator),
            )
            .expect("create annotation");

        assert_eq!(ann.note.as_deref(), Some("Initial note"));
        assert_eq!(ann.locator.as_deref(), Some(locator));
        assert_eq!(
            ann.selected_text.as_deref(),
            Some("Initial highlight excerpt")
        );

        // 1. Update note: note is updated, locator and other fields preserved
        let updated = db
            .update_annotation(&ann.id, Some("Updated note content"))
            .expect("update note");
        assert_eq!(updated.id, ann.id);
        assert_eq!(updated.document_id, doc_id);
        assert_eq!(updated.kind, "highlight");
        assert_eq!(updated.note.as_deref(), Some("Updated note content"));
        assert_eq!(updated.locator.as_deref(), Some(locator));
        assert_eq!(
            updated.selected_text.as_deref(),
            Some("Initial highlight excerpt")
        );
        match updated.position {
            ReadingPosition::EpubCfi { cfi, progression } => {
                assert_eq!(cfi, "epubcfi(/6/4!/4/2)");
                assert_eq!(progression, Some(0.1));
            }
            _ => panic!("position must remain epub-cfi"),
        }

        // 2. Clear note: passing None or empty string stores NULL
        let cleared = db
            .update_annotation(&ann.id, Some("   "))
            .expect("clear note");
        assert_eq!(cleared.note, None);
        assert_eq!(cleared.locator.as_deref(), Some(locator));

        // 3. Update non-existent annotation fails
        let bad_update = db.update_annotation("non-existent-ann-id", Some("note"));
        assert!(
            bad_update.is_err(),
            "updating non-existent annotation must return Err"
        );

        // 4. Deleting non-existent annotation fails
        let bad_delete = db.delete_annotation("non-existent-ann-id");
        assert!(
            bad_delete.is_err(),
            "deleting non-existent annotation must return Err"
        );

        // 5. Deleting existing annotation succeeds
        db.delete_annotation(&ann.id)
            .expect("delete existing annotation");
        assert!(db.list_annotations(&doc_id).expect("list").is_empty());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_schema_v4_tables_and_metadata_persistence() {
        let temp_dir = std::env::temp_dir().join(format!("clio-test-meta-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");
        fs::write(temp_dir.join("sample.txt"), b"plain text").expect("write txt");

        let db = LibraryDb::open_in_memory().expect("open db");
        // Verify tables exist in schema v4
        {
            let conn = db.lock().expect("lock");
            let meta_exists = table_exists(&conn, "document_metadata").expect("table check");
            let col_exists = table_exists(&conn, "collections").expect("table check");
            let doc_col_exists = table_exists(&conn, "document_collections").expect("table check");
            assert!(meta_exists, "document_metadata table must exist");
            assert!(col_exists, "collections table must exist");
            assert!(doc_col_exists, "document_collections table must exist");
        }

        let root = db
            .add_root(&temp_dir.to_string_lossy(), None)
            .expect("add root");
        db.scan_root(&root.id).expect("scan root");

        let docs = db.list_documents(Some(&root.id), false).expect("list docs");
        assert_eq!(docs.len(), 1);
        let doc_id = &docs[0].id;

        // Fallback metadata was generated and saved
        let meta = db
            .get_metadata(doc_id)
            .expect("get metadata")
            .expect("meta exists");
        assert_eq!(meta.provenance, MetadataProvenance::Fallback);

        // Update metadata manually
        let custom_meta = DocumentMetadata {
            title: Some("My Custom Document".to_string()),
            authors: vec!["Alice Author".to_string(), "Bob Coauthor".to_string()],
            publisher: Some("Independent Press".to_string()),
            published_date: Some("2026-10-02".to_string()),
            description: Some("A rich description of the document.".to_string()),
            language: Some("en".to_string()),
            identifiers: vec!["isbn:1234567890".to_string()],
            provenance: MetadataProvenance::Embedded,
            thumbnail_path: None,
        };
        let saved = db
            .update_metadata(doc_id, custom_meta.clone())
            .expect("update metadata");
        assert_eq!(saved.title, Some("My Custom Document".to_string()));
        assert_eq!(saved.authors.len(), 2);

        // Verify list_documents reflects updated metadata
        let docs_updated = db.list_documents(Some(&root.id), false).expect("list docs");
        let doc_with_meta = &docs_updated[0];
        assert_eq!(
            doc_with_meta.metadata.as_ref().unwrap().title,
            Some("My Custom Document".to_string())
        );
        assert_eq!(
            doc_with_meta.metadata.as_ref().unwrap().authors,
            vec!["Alice Author", "Bob Coauthor"]
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_collections_crud_and_membership_cascades() {
        let temp_dir = std::env::temp_dir().join(format!("clio-test-col-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");
        fs::write(temp_dir.join("doc1.txt"), b"doc 1").expect("write doc1");
        fs::write(temp_dir.join("doc2.txt"), b"doc 2").expect("write doc2");

        let db = LibraryDb::open_in_memory().expect("open db");
        let root = db
            .add_root(&temp_dir.to_string_lossy(), None)
            .expect("add root");
        db.scan_root(&root.id).expect("scan root");
        let docs = db.list_documents(Some(&root.id), false).expect("list docs");
        assert_eq!(docs.len(), 2);
        let id1 = &docs[0].id;
        let id2 = &docs[1].id;

        // 1. Create collection
        let c1 = db
            .create_collection("Fiction", Some("Favorite novels"))
            .expect("create c1");
        assert_eq!(c1.name, "Fiction");
        assert_eq!(c1.description.as_deref(), Some("Favorite novels"));
        assert_eq!(c1.document_count, 0);

        // Duplicate name rejection
        assert!(
            db.create_collection("Fiction", None).is_err(),
            "duplicate collection name must fail"
        );
        assert!(
            db.create_collection("fiction", None).is_err(),
            "case-insensitive duplicate name must fail"
        );

        let c2 = db.create_collection("To Read", None).expect("create c2");

        // 2. Add document membership
        db.add_document_to_collection(&c1.id, id1)
            .expect("add id1 to c1");
        db.add_document_to_collection(&c1.id, id2)
            .expect("add id2 to c1");
        db.add_document_to_collection(&c2.id, id1)
            .expect("add id1 to c2");

        // Adding duplicate membership is safe / idempotent
        assert!(db.add_document_to_collection(&c1.id, id1).is_ok());

        // Verify document counts
        let cols = db.list_collections().expect("list cols");
        let c1_listed = cols.iter().find(|c| c.id == c1.id).expect("find c1");
        let c2_listed = cols.iter().find(|c| c.id == c2.id).expect("find c2");
        assert_eq!(c1_listed.document_count, 2);
        assert_eq!(c2_listed.document_count, 1);

        // Verify list_collection_documents
        let c1_docs = db.list_collection_documents(&c1.id).expect("list c1 docs");
        assert_eq!(c1_docs.len(), 2);
        let c2_docs = db.list_collection_documents(&c2.id).expect("list c2 docs");
        assert_eq!(c2_docs.len(), 1);
        assert_eq!(c2_docs[0].id, *id1);

        // Verify list_documents includes collection IDs
        let all_docs = db.list_documents(Some(&root.id), false).expect("list all");
        let d1 = all_docs.iter().find(|d| d.id == *id1).expect("find d1");
        assert_eq!(d1.collections.len(), 2);
        assert!(d1.collections.contains(&c1.id));
        assert!(d1.collections.contains(&c2.id));

        // 3. Rename collection
        let renamed = db
            .rename_collection(&c1.id, "Classic Fiction")
            .expect("rename");
        assert_eq!(renamed.name, "Classic Fiction");
        assert_eq!(renamed.document_count, 2);

        // Rename with duplicate name rejected
        assert!(db.rename_collection(&c2.id, "Classic Fiction").is_err());

        // 4. Remove document from collection
        db.remove_document_from_collection(&c1.id, id2)
            .expect("remove id2 from c1");
        let c1_docs_after = db.list_collection_documents(&c1.id).expect("list c1 docs");
        assert_eq!(c1_docs_after.len(), 1);

        // 5. Delete collection: collection deleted, membership deleted, DOCUMENTS INTACT
        db.delete_collection(&c2.id).expect("delete c2");
        assert_eq!(db.list_collections().expect("list cols").len(), 1);
        // Documents still exist
        let docs_still_here = db.list_documents(Some(&root.id), false).expect("list docs");
        assert_eq!(docs_still_here.len(), 2);

        // 6. Delete document (via root remove): membership cleaned up, collection intact
        db.remove_root(&root.id).expect("remove root");
        assert_eq!(db.list_documents(None, false).expect("list").len(), 0);
        let c1_after_root_delete = db.list_collections().expect("list cols");
        assert_eq!(c1_after_root_delete[0].document_count, 0);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_thumbnail_data_url_generation() {
        let temp_dir = std::env::temp_dir().join(format!("clio-test-thumb-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");
        fs::write(temp_dir.join("sample.txt"), b"sample").expect("write sample");

        let db = LibraryDb::open_in_memory().expect("open db");
        let root = db
            .add_root(&temp_dir.to_string_lossy(), None)
            .expect("add root");
        db.scan_root(&root.id).expect("scan root");
        let docs = db.list_documents(Some(&root.id), false).expect("list docs");
        let doc_id = &docs[0].id;

        // 1. Initially fallback metadata has no thumbnail -> returns None
        assert_eq!(db.get_thumbnail_data_url(doc_id).unwrap(), None);

        // 2. Put a real dummy thumbnail in thumbnail_dir
        let thumb_filename = format!("{doc_id}.png");
        let thumb_path = db.thumbnail_dir.join(&thumb_filename);
        let png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRtest";
        fs::write(&thumb_path, png_bytes).expect("write thumb");

        // Save metadata with thumbnail path
        let mut meta = DocumentMetadata::fallback();
        meta.thumbnail_path = Some(thumb_filename);
        db.update_metadata(doc_id, meta).expect("save meta");

        // 3. get_thumbnail_data_url returns data:image/png;base64,...
        let data_url = db
            .get_thumbnail_data_url(doc_id)
            .unwrap()
            .expect("data url");
        assert!(data_url.starts_with("data:image/png;base64,"));
        assert!(data_url.len() > 25);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_live_metadata_extraction_and_collections_workflow() {
        let temp_dir = std::env::temp_dir().join(format!("clio-live-meta-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");

        // 1. Create a real EPUB with metadata and a cover
        let epub_dir = temp_dir.join("epub_build");
        let meta_inf = epub_dir.join("META-INF");
        let oebps = epub_dir.join("OEBPS");
        let oebps_img = oebps.join("images");
        fs::create_dir_all(&meta_inf).expect("create meta-inf");
        fs::create_dir_all(&oebps_img).expect("create oebps img");

        fs::write(epub_dir.join("mimetype"), b"application/epub+zip").expect("write mimetype");
        fs::write(
            meta_inf.join("container.xml"),
            r#"<?xml version="1.0"?>
            <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
              <rootfiles>
                <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
              </rootfiles>
            </container>"#,
        )
        .expect("write container");

        fs::write(
            oebps.join("content.opf"),
            r#"<?xml version="1.0" encoding="utf-8"?>
            <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
              <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                <dc:title>Moby Dick</dc:title>
                <dc:creator>Herman Melville</dc:creator>
                <dc:publisher>Harper &amp; Brothers</dc:publisher>
                <dc:date>1851-10-18</dc:date>
                <dc:language>en</dc:language>
                <dc:description>Captain Ahab quest.</dc:description>
                <dc:identifier>isbn:9780142437247</dc:identifier>
              </metadata>
              <manifest>
                <item id="cov" href="images/cover.png" media-type="image/png" properties="cover-image"/>
              </manifest>
            </package>"#,
        )
        .expect("write opf");

        // Valid 1x1 PNG bytes for cover
        let png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82";
        fs::write(oebps_img.join("cover.png"), png_bytes).expect("write cover png");

        // Package into real test.epub using system zip CLI if available
        let epub_path = temp_dir.join("book.epub");
        let zip_res = Command::new("zip")
            .current_dir(&epub_dir)
            .args(["-0", "-X"])
            .arg(&epub_path)
            .arg("mimetype")
            .output();
        if let Ok(z) = zip_res {
            if z.status.success() {
                let _ = Command::new("zip")
                    .current_dir(&epub_dir)
                    .args(["-r"])
                    .arg(&epub_path)
                    .arg("META-INF")
                    .arg("OEBPS")
                    .output();
            }
        }
        let _ = fs::remove_dir_all(&epub_dir);

        // 2. Create a PDF with Info metadata
        let pdf_path = temp_dir.join("paper.pdf");
        let pdf_bytes = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\n4 0 obj<</Title (Rust Systems)/Author (Ferris)/Subject (Systems Programming)>>endobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \n0000000159 00000 n \ntrailer<</Size 5/Root 1 0 R/Info 4 0 R>>\nstartxref\n260\n%%EOF\n";
        fs::write(&pdf_path, pdf_bytes).expect("write pdf");

        // 3. Create a plain text file (fallback metadata)
        let txt_path = temp_dir.join("notes.txt");
        fs::write(&txt_path, b"Some plain text notes.").expect("write txt");

        // 4. Scan using LibraryDb
        let db = LibraryDb::open_in_memory().expect("open db");
        let root = db
            .add_root(&temp_dir.to_string_lossy(), None)
            .expect("add root");
        let scan = db.scan_root(&root.id).expect("scan");
        assert_eq!(scan.missing, 0);
        assert!(scan.scanned >= 2); // pdf + txt (+ epub if zip was installed)

        let docs = db.list_documents(Some(&root.id), false).expect("list docs");
        assert!(docs.len() >= 2);

        // Verify PDF metadata
        let pdf_doc = docs
            .iter()
            .find(|d| d.name == "paper.pdf")
            .expect("find pdf");
        if let Some(meta) = &pdf_doc.metadata {
            if is_tool_installed("pdfinfo") {
                assert_eq!(meta.provenance, MetadataProvenance::Embedded);
                assert_eq!(meta.title.as_deref(), Some("Rust Systems"));
                assert!(meta.authors.contains(&"Ferris".to_string()));
            }
        }

        // Verify TXT metadata (fallback)
        let txt_doc = docs
            .iter()
            .find(|d| d.name == "notes.txt")
            .expect("find txt");
        let txt_meta = txt_doc.metadata.as_ref().expect("txt meta exists");
        assert_eq!(txt_meta.provenance, MetadataProvenance::Fallback);
        assert_eq!(txt_meta.title, None);
        assert!(txt_meta.authors.is_empty());

        // Verify EPUB metadata if epub was created
        if epub_path.exists() && is_tool_installed("unzip") {
            let epub_doc = docs
                .iter()
                .find(|d| d.name == "book.epub")
                .expect("find epub");
            let epub_meta = epub_doc.metadata.as_ref().expect("epub meta exists");
            assert_eq!(epub_meta.provenance, MetadataProvenance::Embedded);
            assert_eq!(epub_meta.title.as_deref(), Some("Moby Dick"));
            assert_eq!(epub_meta.authors, vec!["Herman Melville".to_string()]);
            assert_eq!(epub_meta.publisher.as_deref(), Some("Harper & Brothers"));
            assert_eq!(epub_meta.published_date.as_deref(), Some("1851-10-18"));

            // Verify thumbnail was extracted
            if let Some(thumb_data) = db.get_thumbnail_data_url(&epub_doc.id).expect("get thumb") {
                assert!(thumb_data.starts_with("data:image/"));
            }
        }

        // 5. Test Collection operations on scanned documents
        let col = db
            .create_collection("Important", Some("Key docs"))
            .expect("create col");
        db.add_document_to_collection(&col.id, &pdf_doc.id)
            .expect("add pdf to col");
        db.add_document_to_collection(&col.id, &txt_doc.id)
            .expect("add txt to col");

        let col_docs = db
            .list_collection_documents(&col.id)
            .expect("list col docs");
        assert_eq!(col_docs.len(), 2);

        let pdf_cols = db.list_document_collections(&pdf_doc.id).expect("pdf cols");
        assert!(pdf_cols.contains(&col.id));

        db.remove_document_from_collection(&col.id, &pdf_doc.id)
            .expect("remove pdf");
        assert_eq!(
            db.list_collection_documents(&col.id)
                .expect("list col docs")
                .len(),
            1
        );

        db.delete_collection(&col.id).expect("delete col");
        assert_eq!(
            db.list_documents(Some(&root.id), false)
                .expect("list docs")
                .len(),
            docs.len()
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_format_capabilities() {
        let pdf_caps = FormatId::Pdf.capabilities();
        assert!(pdf_caps.read);
        assert!(pdf_caps.search);
        assert!(pdf_caps.toc);
        assert!(pdf_caps.thumbnail);
        assert!(pdf_caps.convert);

        let epub_caps = FormatId::Epub.capabilities();
        assert!(epub_caps.read);
        assert!(epub_caps.search);
        assert!(epub_caps.toc);
        assert!(epub_caps.thumbnail);

        let txt_caps = FormatId::Txt.capabilities();
        assert!(txt_caps.read);
        assert!(txt_caps.search);
        assert!(!txt_caps.toc);
        assert!(!txt_caps.thumbnail);

        let md_caps = FormatId::Md.capabilities();
        assert!(md_caps.read);
        assert!(md_caps.search);
        assert!(md_caps.toc);

        let docx_caps = FormatId::Docx.capabilities();
        assert!(!docx_caps.read);
        assert!(docx_caps.convert);
        assert!(docx_caps.metadata);

        let odt_caps = FormatId::Odt.capabilities();
        assert!(!odt_caps.read);
        assert!(odt_caps.convert);
        assert!(odt_caps.thumbnail);

        let html_caps = FormatId::Html.capabilities();
        assert!(!html_caps.read);
        assert!(html_caps.convert);

        let rtf_caps = FormatId::Rtf.capabilities();
        assert!(!rtf_caps.read);
        assert!(rtf_caps.convert);
    }

    #[test]
    fn test_text_scroll_reading_position_roundtrip_and_validation() {
        // 1. Validation
        let valid_pos = ReadingPosition::TextScroll { progression: 0.65 };
        assert!(valid_pos.validate().is_ok());

        let invalid_neg = ReadingPosition::TextScroll { progression: -0.1 };
        assert!(invalid_neg.validate().is_err());

        let invalid_over = ReadingPosition::TextScroll { progression: 1.1 };
        assert!(invalid_over.validate().is_err());

        let invalid_nan = ReadingPosition::TextScroll {
            progression: f64::NAN,
        };
        assert!(invalid_nan.validate().is_err());

        // 2. Roundtrip through reading_state table in SQLite
        let temp_dir = std::env::temp_dir().join(format!("clio-pos-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");
        fs::write(temp_dir.join("text.txt"), b"Hello world text").expect("write text");

        let db = LibraryDb::open_in_memory().expect("open db");
        let root = db
            .add_root(&temp_dir.to_string_lossy(), None)
            .expect("add root");
        db.scan_root(&root.id).expect("scan");
        let docs = db.list_documents(Some(&root.id), false).expect("list");
        let doc_id = &docs[0].id;

        let state = ReadingState {
            document_id: doc_id.clone(),
            position: valid_pos,
            last_opened_at: "2026-10-02T12:00:00Z".to_string(),
            updated_at: "2026-10-02T12:00:00Z".to_string(),
        };

        db.set_reading_state(state).expect("set reading state");

        let retrieved = db
            .get_reading_state(doc_id)
            .expect("get state")
            .expect("exists");
        match retrieved.position {
            ReadingPosition::TextScroll { progression } => {
                assert!((progression - 0.65).abs() < 1e-6);
            }
            _ => panic!("Expected TextScroll position"),
        }

        // 3. Bookmark creation with text scroll position
        let bookmark = db
            .create_bookmark(
                doc_id,
                ReadingPosition::TextScroll { progression: 0.65 },
                None,
            )
            .expect("create bookmark");
        assert_eq!(bookmark.title.as_deref(), Some("65%"));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_source_ref_serialization_camel_case() {
        let source = SourceRef::Library {
            root_id: "root-123".to_string(),
            relative_path: "docs/guide.pdf".to_string(),
        };
        let json = serde_json::to_string(&source).expect("serialize source");
        assert!(json.contains("\"kind\":\"library\""));
        assert!(json.contains("\"rootId\":\"root-123\""));
        assert!(json.contains("\"relativePath\":\"docs/guide.pdf\""));
        assert!(!json.contains("root_id"));
        assert!(!json.contains("relative_path"));
    }

    #[test]
    fn test_document_path_resolution_and_validation() {
        let temp_dir = std::env::temp_dir().join(format!("clio-path-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");
        let file_path = temp_dir.join("test.pdf");
        fs::write(&file_path, b"%PDF sample").expect("write file");

        let db = LibraryDb::open_in_memory().expect("open db");
        let root = db
            .add_root(&temp_dir.to_string_lossy(), None)
            .expect("add root");
        db.scan_root(&root.id).expect("scan");
        let docs = db.list_documents(Some(&root.id), false).expect("list");
        assert_eq!(docs.len(), 1);

        let resolved_path = db.document_path(&docs[0].id).expect("resolve path");
        assert_eq!(Path::new(&resolved_path), file_path.canonicalize().unwrap());

        // Non-existent document
        assert!(db.document_path("invalid-doc-id").is_err());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_non_catalog_document_bookmark_and_annotation_error() {
        let db = LibraryDb::open_in_memory().expect("open db");
        let bm_err = db.create_bookmark(
            "non-catalog-doc",
            ReadingPosition::PdfPage {
                page: 1,
                progression: None,
            },
            None,
        );
        assert!(bm_err.is_err());
        assert!(bm_err
            .unwrap_err()
            .contains("Bookmarks are only supported for catalog documents"));

        let ann_err = db.create_annotation(
            "non-catalog-doc",
            "highlight",
            ReadingPosition::PdfPage {
                page: 1,
                progression: None,
            },
            Some("text"),
            None,
            None,
        );
        assert!(ann_err.is_err());
        assert!(ann_err
            .unwrap_err()
            .contains("Annotations are only supported for catalog documents"));
    }

    #[test]
    fn test_milestone_13_complete_end_to_end_reliability() {
        let temp_dir = std::env::temp_dir().join(format!("clio-m13-e2e-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");
        let db_path = temp_dir.join("library.sqlite3");
        let docs_dir = temp_dir.join("library_files");
        fs::create_dir_all(&docs_dir).expect("create docs dir");

        // 1. Multi-format documents
        let pdf_file = docs_dir.join("sample.pdf");
        let epub_file = docs_dir.join("sample.epub");
        let txt_file = docs_dir.join("sample.txt");
        let md_file = docs_dir.join("sample.md");
        let malformed_epub = docs_dir.join("corrupt.epub");
        let malformed_pdf = docs_dir.join("corrupt.pdf");
        let unsupported_file = docs_dir.join("archive.xyz");

        fs::write(&pdf_file, b"%PDF-1.4 sample content").expect("write pdf");
        fs::write(&epub_file, b"PK\x03\x04 fake epub minimal").expect("write epub");
        fs::write(&txt_file, b"Simple text content").expect("write txt");
        fs::write(&md_file, b"# Markdown Header\n\nContent").expect("write md");
        fs::write(&malformed_epub, b"NOT A ZIP AT ALL").expect("write corrupt epub");
        fs::write(&malformed_pdf, b"NOT A PDF HEADER").expect("write corrupt pdf");
        fs::write(&unsupported_file, b"some unsupported bytes").expect("write xyz");

        // 2. Open DB, add root, scan
        let (doc_pdf_id, doc_epub_id, doc_txt_id, _doc_md_id, root_id) = {
            let db = LibraryDb::open(&db_path).expect("open db session 1");
            let root = db
                .add_root(&docs_dir.to_string_lossy(), Some("E2E Test Root"))
                .expect("add root");
            let scan = db.scan_root(&root.id).expect("scan");
            // 6 supported files found (sample.pdf, sample.epub, sample.txt, sample.md, corrupt.epub, corrupt.pdf); archive.xyz ignored
            assert_eq!(scan.scanned, 6);
            assert_eq!(scan.inserted, 6);
            assert_eq!(scan.missing, 0);

            let docs = db.list_documents(Some(&root.id), false).expect("list docs");
            assert_eq!(docs.len(), 6);

            let p_id = docs
                .iter()
                .find(|d| d.name == "sample.pdf")
                .unwrap()
                .id
                .clone();
            let e_id = docs
                .iter()
                .find(|d| d.name == "sample.epub")
                .unwrap()
                .id
                .clone();
            let t_id = docs
                .iter()
                .find(|d| d.name == "sample.txt")
                .unwrap()
                .id
                .clone();
            let m_id = docs
                .iter()
                .find(|d| d.name == "sample.md")
                .unwrap()
                .id
                .clone();

            // 3. Reading state writes in session 1 for all 3 locators
            db.set_reading_state(ReadingState {
                document_id: p_id.clone(),
                position: ReadingPosition::PdfPage {
                    page: 17,
                    progression: None,
                },
                last_opened_at: "2026-10-02T16:00:00Z".to_string(),
                updated_at: "2026-10-02T16:00:00Z".to_string(),
            })
            .expect("set pdf state");

            db.set_reading_state(ReadingState {
                document_id: e_id.clone(),
                position: ReadingPosition::EpubCfi {
                    cfi: "/6/4[chap1]!/4/2/1:0".to_string(),
                    progression: Some(0.42),
                },
                last_opened_at: "2026-10-02T16:05:00Z".to_string(),
                updated_at: "2026-10-02T16:05:00Z".to_string(),
            })
            .expect("set epub state");

            db.set_reading_state(ReadingState {
                document_id: t_id.clone(),
                position: ReadingPosition::TextScroll { progression: 0.78 },
                last_opened_at: "2026-10-02T16:10:00Z".to_string(),
                updated_at: "2026-10-02T16:10:00Z".to_string(),
            })
            .expect("set txt state");
            // 4. Bookmarks and annotations isolated on PDF document
            let bm = db
                .create_bookmark(
                    &p_id,
                    ReadingPosition::PdfPage {
                        page: 17,
                        progression: None,
                    },
                    Some("Important Section"),
                )
                .expect("create bookmark");
            assert_eq!(bm.title.as_deref(), Some("Important Section"));

            let ann = db
                .create_annotation(
                    &p_id,
                    "highlight",
                    ReadingPosition::PdfPage {
                        page: 17,
                        progression: None,
                    },
                    Some("highlighted text"),
                    Some("my note"),
                    Some("{\"page\":17}"),
                )
                .expect("create annotation");
            assert_eq!(ann.selected_text.as_deref(), Some("highlighted text"));

            // Confirm EPUB and TXT documents have ZERO bookmarks/annotations (isolation)
            assert!(db.list_bookmarks(&e_id).unwrap().is_empty());
            assert!(db.list_bookmarks(&t_id).unwrap().is_empty());
            assert!(db.list_annotations(&e_id).unwrap().is_empty());
            assert!(db.list_annotations(&t_id).unwrap().is_empty());

            // 5. Canonical document path resolution for tools
            let resolved_pdf_path = db.document_path(&p_id).expect("resolve pdf path");
            assert_eq!(
                Path::new(&resolved_pdf_path),
                pdf_file.canonicalize().unwrap()
            );

            (p_id, e_id, t_id, m_id, root.id)
        }; // db session 1 dropped / closed here

        // 6. SIMULATED RESTART: Reopen DB from disk in session 2
        {
            let db2 = LibraryDb::open(&db_path).expect("open db session 2 (after restart)");

            // Verify reading states survived restart exactly
            let p_state = db2
                .get_reading_state(&doc_pdf_id)
                .unwrap()
                .expect("pdf state");
            match p_state.position {
                ReadingPosition::PdfPage { page, .. } => assert_eq!(page, 17),
                _ => panic!("Expected PdfPage"),
            }

            let e_state = db2
                .get_reading_state(&doc_epub_id)
                .unwrap()
                .expect("epub state");
            match e_state.position {
                ReadingPosition::EpubCfi { cfi, progression } => {
                    assert_eq!(cfi, "/6/4[chap1]!/4/2/1:0");
                    assert!((progression.unwrap() - 0.42).abs() < 1e-6);
                }
                _ => panic!("Expected EpubCfi"),
            }

            let t_state = db2
                .get_reading_state(&doc_txt_id)
                .unwrap()
                .expect("txt state");
            match t_state.position {
                ReadingPosition::TextScroll { progression } => {
                    assert!((progression - 0.78).abs() < 1e-6);
                }
                _ => panic!("Expected TextScroll"),
            }

            // Verify bookmarks & annotations survived restart
            let bms = db2.list_bookmarks(&doc_pdf_id).unwrap();
            assert_eq!(bms.len(), 1);
            assert_eq!(bms[0].title.as_deref(), Some("Important Section"));

            let anns = db2.list_annotations(&doc_pdf_id).unwrap();
            assert_eq!(anns.len(), 1);
            assert_eq!(anns[0].note.as_deref(), Some("my note"));

            // 7. Delete source file & rescan -> missing reconciliation
            fs::remove_file(&pdf_file).expect("remove pdf");
            let rescan = db2.scan_root(&root_id).expect("rescan after delete");
            assert_eq!(rescan.scanned, 5);
            assert_eq!(rescan.missing, 1);

            let missing_docs = db2.list_documents(Some(&root_id), true).unwrap();
            let p_doc = missing_docs.iter().find(|d| d.id == doc_pdf_id).unwrap();
            assert_eq!(p_doc.availability, "missing");

            // Document path fails safely when missing
            assert!(db2.document_path(&doc_pdf_id).is_err());
        }

        // Clean up
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_document_remove_catalog_only_and_batched_reading_states() {
        let temp_dir =
            std::env::temp_dir().join(format!("clio-doc-remove-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");
        let file_path = temp_dir.join("book.pdf");
        fs::write(&file_path, b"%PDF sample file bytes").expect("write file");

        let db = LibraryDb::open_in_memory().expect("open db");
        let root = db
            .add_root(&temp_dir.to_string_lossy(), None)
            .expect("add root");
        db.scan_root(&root.id).expect("scan");

        let docs = db.list_documents(Some(&root.id), false).expect("list");
        assert_eq!(docs.len(), 1);
        let doc_id = &docs[0].id;

        // Set reading state
        db.set_reading_state(ReadingState {
            document_id: doc_id.clone(),
            position: ReadingPosition::PdfPage {
                page: 5,
                progression: None,
            },
            last_opened_at: "2026-10-03T10:00:00Z".to_string(),
            updated_at: "2026-10-03T10:00:00Z".to_string(),
        })
        .expect("set state");

        // Verify batched reading_state query
        let all_states = db.list_reading_states().expect("list reading states");
        assert_eq!(all_states.len(), 1);
        assert_eq!(all_states[0].document_id, *doc_id);

        // Verify list_documents returns reading_state attached directly (no N+1)
        let docs_with_state = db.list_documents(Some(&root.id), false).expect("list");
        assert!(docs_with_state[0].reading_state.is_some());
        match docs_with_state[0].reading_state.as_ref().unwrap().position {
            ReadingPosition::PdfPage { page, .. } => assert_eq!(page, 5),
            _ => panic!("Expected PdfPage"),
        }

        // Remove document from catalog
        db.remove_document(doc_id).expect("remove doc from library");

        // Catalog now has 0 documents
        let docs_after = db.list_documents(Some(&root.id), false).expect("list");
        assert_eq!(docs_after.len(), 0);

        // OD-1: Reading state is PRESERVED, not destroyed!
        let states_after = db.list_reading_states().expect("list states");
        assert_eq!(states_after.len(), 1);
        assert_eq!(states_after[0].document_id, *doc_id);

        // OD-1: Rescan does not re-add the excluded document!
        let scan_result = db.scan_root(&root.id).expect("rescan");
        assert_eq!(scan_result.inserted, 0);
        let docs_after_rescan = db.list_documents(Some(&root.id), false).expect("list");
        assert_eq!(docs_after_rescan.len(), 0);
        // CRUCIAL: Underlying filesystem file MUST still exist!
        assert!(file_path.exists());
        assert_eq!(fs::read(&file_path).unwrap(), b"%PDF sample file bytes");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_relink_document_preserves_state() {
        let temp_dir = std::env::temp_dir().join(format!("clio-relink-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create dir");
        let root_dir = temp_dir.join("library");
        fs::create_dir_all(&root_dir).expect("create root dir");

        let old_file = root_dir.join("old_name.pdf");
        fs::write(&old_file, b"%PDF sample file").expect("write file");

        let db = LibraryDb::open_in_memory().expect("open db");
        db.migrate().expect("migrate");

        let root = db
            .add_root(&root_dir.to_string_lossy(), Some("Books"))
            .expect("add root");
        db.scan_root(&root.id).expect("scan root");

        let docs = db.list_documents(Some(&root.id), false).expect("list");
        assert_eq!(docs.len(), 1);
        let doc_id = docs[0].id.clone();

        // Add reading state to the document
        db.set_reading_state(ReadingState {
            document_id: doc_id.clone(),
            position: ReadingPosition::PdfPage {
                page: 12,
                progression: None,
            },
            last_opened_at: timestamp(),
            updated_at: timestamp(),
        })
        .expect("set reading state");

        // Simulate moving the file externally
        let new_file = root_dir.join("new_renamed.pdf");
        fs::rename(&old_file, &new_file).expect("rename file");

        // Scan marks old document missing
        db.scan_root(&root.id).expect("scan after move");
        let missing_docs = db
            .list_documents(Some(&root.id), true)
            .expect("list missing");
        let missing_target = missing_docs.iter().find(|d| d.id == doc_id).unwrap();
        assert_eq!(missing_target.availability, "missing");

        // Relink the missing document to the new file
        let relinked = db
            .relink_document(&doc_id, &new_file.to_string_lossy())
            .expect("relink document");
        assert_eq!(relinked.id, doc_id);
        assert_eq!(relinked.availability, "present");
        assert_eq!(relinked.relative_path, "new_renamed.pdf");

        // Reading state was preserved across relink
        assert!(relinked.reading_state.is_some());
        match relinked.reading_state.unwrap().position {
            ReadingPosition::PdfPage { page, .. } => assert_eq!(page, 12),
            _ => panic!("Expected PdfPage 12"),
        }

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
