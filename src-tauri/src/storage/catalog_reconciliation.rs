use rusqlite::{params, OptionalExtension, Transaction};

use super::db_error;

pub(super) struct ReconciledDocument {
    pub(super) document_id: String,
    pub(super) inserted: bool,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn reconcile_document(
    transaction: &Transaction<'_>,
    root_id: &str,
    relative_path: &str,
    name: &str,
    format_id: &str,
    size_bytes: i64,
    now: &str,
    scan_marker: &str,
) -> Result<Option<ReconciledDocument>, String> {
    let existing: Option<(String, Option<String>)> = transaction
        .query_row(
            "SELECT id, excluded_at FROM documents WHERE root_id = ?1 AND relative_path = ?2",
            params![root_id, relative_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;

    if let Some((document_id, excluded_at)) = existing {
        if excluded_at.is_some() {
            // OD-1: Excluded document stays excluded across future scans
            transaction
                .execute(
                    "UPDATE documents SET last_seen_scan = ?1, availability = 'present' WHERE id = ?2",
                    params![scan_marker, document_id],
                )
                .map_err(db_error)?;
            return Ok(None);
        }

        transaction
            .execute(
                "UPDATE documents
                 SET name = ?1, format_id = ?2, size_bytes = ?3, updated_at = ?4,
                     last_seen_scan = ?5, availability = 'present'
                 WHERE id = ?6",
                params![name, format_id, size_bytes, now, scan_marker, document_id],
            )
            .map_err(db_error)?;
        return Ok(Some(ReconciledDocument {
            document_id,
            inserted: false,
        }));
    }

    let document_id = uuid::Uuid::new_v4().to_string();
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
                format_id,
                size_bytes,
                now,
                now,
                scan_marker
            ],
        )
        .map_err(db_error)?;
    Ok(Some(ReconciledDocument {
        document_id,
        inserted: true,
    }))
}

pub(super) fn reconcile_missing_documents(
    transaction: &Transaction<'_>,
    root_id: &str,
    scope_path: Option<&str>,
    scan_marker: &str,
    now: &str,
) -> Result<i64, String> {
    if let Some(scope_path) = scope_path {
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

    if let Some(scope_path) = scope_path {
        transaction
            .query_row(
                "SELECT COUNT(*) FROM documents
                 WHERE root_id = ?1 AND availability = 'missing' AND excluded_at IS NULL
                   AND (relative_path = ?2 OR substr(relative_path, 1, length(?2) + 1) = ?2 || '/')",
                params![root_id, scope_path],
                |row| row.get(0),
            )
            .map_err(db_error)
    } else {
        transaction
            .query_row(
                "SELECT COUNT(*) FROM documents WHERE root_id = ?1 AND availability = 'missing' AND excluded_at IS NULL",
                [root_id],
                |row| row.get(0),
            )
            .map_err(db_error)
    }
}
