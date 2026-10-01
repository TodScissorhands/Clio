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
    "pdf", "epub", "docx", "odt", "rtf", "html", "htm", "md", "txt",
];
const SCHEMA_VERSION: i64 = 3;

#[derive(Clone)]
pub struct LibraryDb {
    connection: Arc<Mutex<Connection>>,
    scan_lock: Arc<Mutex<()>>,
}

impl LibraryDb {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(db_error)?;
        let db = Self {
            connection: Arc::new(Mutex::new(connection)),
            scan_lock: Arc::new(Mutex::new(())),
        };
        db.migrate()?;
        Ok(db)
    }

    #[allow(dead_code)]
    pub fn open_in_memory() -> Result<Self, String> {
        let connection = Connection::open_in_memory().map_err(db_error)?;
        let db = Self {
            connection: Arc::new(Mutex::new(connection)),
            scan_lock: Arc::new(Mutex::new(())),
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
            let existing_id: Option<String> = transaction
                .query_row(
                    "SELECT id FROM documents WHERE root_id = ?1 AND relative_path = ?2",
                    params![root_id, relative_path],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)?;
            if let Some(document_id) = existing_id {
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
            }
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
                "SELECT COUNT(*) FROM documents WHERE root_id = ?1 AND availability = 'missing'",
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
                "SELECT COUNT(*) FROM documents WHERE root_id = ?1 AND availability = 'missing'",
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
        let mut statement = connection
            .prepare(
                "SELECT d.id, d.name, d.format_id, d.size_bytes, d.first_seen_at, d.updated_at,
                        d.root_id, d.relative_path, d.availability
                 FROM documents d
                 WHERE (?1 IS NULL OR d.root_id = ?1) AND (?2 OR d.availability = 'present')
                 ORDER BY d.name COLLATE NOCASE, d.id",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![root_id, include_missing], document_from_row)
            .map_err(db_error)?;
        rows.map(|row| row.map_err(db_error).map(DocumentRow::into_dto))
            .collect()
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
            return Err("Document was not found.".to_string());
        }
        let id = Uuid::new_v4().to_string();
        let now = timestamp();
        let (kind, page, cfi, progression) = position.columns()?;
        let fallback_title = match &position {
            ReadingPosition::PdfPage { page } => format!("Page {page}"),
            ReadingPosition::EpubCfi {
                progression: Some(p),
                ..
            } => format!("{}%", (p * 100.0).round()),
            ReadingPosition::EpubCfi { .. } => "Bookmark".to_string(),
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
            return Err("Document was not found.".to_string());
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

    pub fn delete_annotation(&self, annotation_id: &str) -> Result<(), String> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction().map_err(db_error)?;
        transaction
            .execute("DELETE FROM annotations WHERE id = ?1", [annotation_id])
            .map_err(db_error)?;
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

#[derive(Debug, Clone, Serialize)]
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
    Library {
        root_id: String,
        relative_path: String,
    },
    Direct {
        locator: StorageLocator,
    },
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
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReadingPosition {
    PdfPage {
        page: u64,
    },
    EpubCfi {
        cfi: String,
        progression: Option<f64>,
    },
}

impl ReadingPosition {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::PdfPage { page } if *page == 0 || i64::try_from(*page).is_err() => {
                Err("PDF page must be at least 1.".to_string())
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
            _ => Ok(()),
        }
    }

    #[allow(clippy::type_complexity)]
    fn columns(&self) -> Result<(&'static str, Option<i64>, Option<&str>, Option<f64>), String> {
        self.validate()?;
        match self {
            Self::PdfPage { page } => Ok((
                "pdf-page",
                Some(i64::try_from(*page).map_err(|_| "PDF page is too large.".to_string())?),
                None,
                None,
            )),
            Self::EpubCfi { cfi, progression } => {
                Ok(("epub-cfi", None, Some(cfi.as_str()), *progression))
            }
        }
    }
}

impl FormatId {
    fn as_str(&self) -> &'static str {
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

    fn from_path(path: &Path) -> Option<Self> {
        match extension(path).as_str() {
            "pdf" => Some(Self::Pdf),
            "epub" => Some(Self::Epub),
            "docx" => Some(Self::Docx),
            "odt" => Some(Self::Odt),
            "rtf" => Some(Self::Rtf),
            "html" | "htm" => Some(Self::Html),
            "md" => Some(Self::Md),
            "txt" => Some(Self::Txt),
            _ => None,
        }
    }
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
pub fn reading_state_get(
    db: State<'_, LibraryDb>,
    document_id: String,
) -> Result<Option<ReadingState>, String> {
    db.get_reading_state(&document_id)
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
pub fn annotation_delete(db: State<'_, LibraryDb>, annotation_id: String) -> Result<(), String> {
    db.delete_annotation(&annotation_id)
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
}

impl DocumentRow {
    fn into_dto(self) -> DocumentDto {
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
        },
        "epub-cfi" => ReadingPosition::EpubCfi {
            cfi: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            progression: row.get(4)?,
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
        },
        "epub-cfi" => ReadingPosition::EpubCfi {
            cfi: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            progression: row.get(5)?,
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
        },
        "epub-cfi" => ReadingPosition::EpubCfi {
            cfi: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            progression: row.get(6)?,
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
    match value.as_str() {
        "pdf" => Ok(FormatId::Pdf),
        "epub" => Ok(FormatId::Epub),
        "docx" => Ok(FormatId::Docx),
        "odt" => Ok(FormatId::Odt),
        "rtf" => Ok(FormatId::Rtf),
        "html" | "htm" => Ok(FormatId::Html),
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

    #[test]
    fn test_schema_migration_and_idempotence() {
        let db = LibraryDb::open_in_memory().expect("open in-memory db");
        db.migrate()
            .expect("second migrate call must be idempotent");
        let connection = db.lock().expect("lock connection");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("query user_version");
        assert_eq!(version, 3);
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
            position: ReadingPosition::PdfPage { page: 5 },
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
        match retrieved_pdf.position {
            ReadingPosition::PdfPage { page } => assert_eq!(page, 5),
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
            position: ReadingPosition::PdfPage { page: 0 },
            last_opened_at: "2026-10-01T12:00:00Z".to_string(),
            updated_at: "2026-10-01T12:00:00Z".to_string(),
        };
        assert!(db.set_reading_state(invalid_page_state).is_err());

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
            position: ReadingPosition::PdfPage { page: 1 },
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
                ReadingPosition::PdfPage { page: 12 },
                Some("Chapter 2"),
            )
            .expect("create bookmark 1");
        assert_eq!(bm1.document_id, doc_id);
        assert_eq!(bm1.title, Some("Chapter 2".to_string()));
        match bm1.position {
            ReadingPosition::PdfPage { page } => assert_eq!(page, 12),
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
            .create_bookmark(&doc_id, ReadingPosition::PdfPage { page: 0 }, None)
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
            .create_bookmark("unknown-doc", ReadingPosition::PdfPage { page: 1 }, None)
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
                ReadingPosition::PdfPage { page: 3 },
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
                ReadingPosition::PdfPage { page: 3 },
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
            assert_eq!(version, 3, "schema must be at version 3");
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
                ReadingPosition::PdfPage { page: 5 },
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
                ReadingPosition::PdfPage { page: 1 },
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
                ReadingPosition::PdfPage { page: 2 },
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
                ReadingPosition::PdfPage { page: 1 },
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
}
