use rusqlite::{Connection, TransactionBehavior};

const SCHEMA_VERSION: i64 = 6;

pub(super) fn run(connection: &mut Connection) -> Result<(), String> {
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(super::db_error)?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(super::db_error)?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    if version < 1 {
        let transaction = connection.transaction().map_err(super::db_error)?;
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
                .map_err(super::db_error)?;
        }
        if old_documents {
            transaction
                .execute_batch("ALTER TABLE documents RENAME TO documents_legacy;")
                .map_err(super::db_error)?;
        }
        if old_sources {
            transaction
                .execute_batch("ALTER TABLE document_sources RENAME TO document_sources_legacy;")
                .map_err(super::db_error)?;
        }
        if old_reading_states {
            transaction
                .execute_batch("ALTER TABLE reading_states RENAME TO reading_states_legacy;")
                .map_err(super::db_error)?;
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
            .map_err(super::db_error)?;

        if old_roots {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO library_roots
                         (id, label, locator_kind, locator_value, last_scanned_at, created_at, updated_at)
                     SELECT id, label, 'filesystem-directory', path, NULL, created_at, updated_at
                     FROM library_roots_legacy",
                    [],
                )
                .map_err(super::db_error)?;
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
                .map_err(super::db_error)?;
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
                .map_err(super::db_error)?;
        }
        transaction.commit().map_err(super::db_error)?;
    }

    if version < 2 {
        let transaction = connection.transaction().map_err(super::db_error)?;
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
            .map_err(super::db_error)?;
        transaction.commit().map_err(super::db_error)?;
    }

    if version < 3 {
        let transaction = connection.transaction().map_err(super::db_error)?;
        transaction
            .execute_batch(
                "ALTER TABLE annotations ADD COLUMN locator TEXT;
                     PRAGMA user_version = 3;",
            )
            .map_err(super::db_error)?;
        transaction.commit().map_err(super::db_error)?;
    }

    if version < 4 {
        let transaction = connection.transaction().map_err(super::db_error)?;
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
            .map_err(super::db_error)?;
        transaction.commit().map_err(super::db_error)?;
    }
    if version < 5 {
        let transaction = connection.transaction().map_err(super::db_error)?;
        transaction
            .execute_batch(
                "ALTER TABLE documents ADD COLUMN excluded_at TEXT;
                     CREATE INDEX IF NOT EXISTS idx_documents_excluded_at ON documents(excluded_at);
                     PRAGMA user_version = 5;",
            )
            .map_err(super::db_error)?;
        transaction.commit().map_err(super::db_error)?;
    }
    if version < 6 {
        let foreign_key_violations = connection
            .prepare("PRAGMA foreign_key_check")
            .and_then(|mut statement| {
                let mut rows = statement.query([])?;
                let mut count = 0;
                while rows.next()?.is_some() {
                    count += 1;
                }
                Ok(count)
            })
            .map_err(super::db_error)?;
        if foreign_key_violations != 0 {
            return Err(format!(
                "Cannot migrate schema with {foreign_key_violations} foreign-key violations."
            ));
        }

        connection
            .execute_batch("PRAGMA foreign_keys = OFF;")
            .map_err(super::db_error)?;
        let foreign_keys_disabled: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .map_err(super::db_error)?;
        if foreign_keys_disabled != 0 {
            let _ = connection.execute_batch("PRAGMA foreign_keys = ON;");
            return Err(
                "Could not disable SQLite foreign-key enforcement for schema migration."
                    .to_string(),
            );
        }

        let migration_result: Result<bool, rusqlite::Error> = (|| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute_batch(
                "CREATE TABLE library_roots_new (
                     id TEXT PRIMARY KEY NOT NULL,
                     label TEXT NOT NULL,
                     locator_kind TEXT NOT NULL,
                     locator_value TEXT NOT NULL,
                     attachment_state TEXT NOT NULL
                         CHECK (attachment_state IN ('attached', 'detached')),
                     last_scanned_at TEXT,
                     created_at TEXT NOT NULL,
                     updated_at TEXT NOT NULL
                 );
                 INSERT INTO library_roots_new
                     (id, label, locator_kind, locator_value, attachment_state,
                      last_scanned_at, created_at, updated_at)
                 SELECT id, label, locator_kind, locator_value, 'attached',
                        last_scanned_at, created_at, updated_at
                 FROM library_roots;
                 DROP TABLE library_roots;
                 ALTER TABLE library_roots_new RENAME TO library_roots;
                 CREATE UNIQUE INDEX idx_library_roots_attached_locator
                     ON library_roots(locator_kind, locator_value)
                     WHERE attachment_state = 'attached';",
            )?;

            let mut statement = transaction.prepare("PRAGMA foreign_key_check")?;
            let mut rows = statement.query([])?;
            let has_foreign_key_violation = rows.next()?.is_some();
            drop(rows);
            drop(statement);
            if has_foreign_key_violation {
                return Ok(false);
            }

            transaction.execute_batch("PRAGMA user_version = 6;")?;
            transaction.commit()?;
            Ok(true)
        })();

        match migration_result {
            Ok(true) => {}
            Ok(false) => {
                if let Err(error) = connection.execute_batch("PRAGMA foreign_keys = ON;") {
                    return Err(format!(
                        "Schema migration produced foreign-key violations, and restoring SQLite foreign-key enforcement failed: {error}"
                    ));
                }
                return Err("Schema migration produced foreign-key violations.".to_string());
            }
            Err(error) => {
                if let Err(restore_error) = connection.execute_batch("PRAGMA foreign_keys = ON;") {
                    return Err(format!(
                        "{}; restoring SQLite foreign-key enforcement failed: {restore_error}",
                        super::db_error(error)
                    ));
                }
                return Err(super::db_error(error));
            }
        }

        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(super::db_error)?;
        let foreign_keys_enabled: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .map_err(super::db_error)?;
        if foreign_keys_enabled != 1 {
            return Err(
                "Could not restore SQLite foreign-key enforcement after schema migration."
                    .to_string(),
            );
        }

        let foreign_key_violations = connection
            .prepare("PRAGMA foreign_key_check")
            .and_then(|mut statement| {
                let mut rows = statement.query([])?;
                let mut count = 0;
                while rows.next()?.is_some() {
                    count += 1;
                }
                Ok(count)
            })
            .map_err(super::db_error)?;
        if foreign_key_violations != 0 {
            return Err(format!(
                "Post-migration foreign-key check found {foreign_key_violations} violations."
            ));
        }

        connection
            .execute_batch("PRAGMA integrity_check;")
            .map_err(super::db_error)?;
        let integrity: String = connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(super::db_error)?;
        if integrity != "ok" {
            return Err(format!(
                "Post-migration integrity check failed: {integrity}"
            ));
        }
    }

    Ok(())
}

pub(super) fn table_exists(connection: &Connection, name: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [name],
            |row| row.get(0),
        )
        .map_err(super::db_error)
}
