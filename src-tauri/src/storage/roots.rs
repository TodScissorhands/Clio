use super::rows::{root_from_row, RootRow};
use super::*;
use rusqlite::{Transaction, TransactionBehavior};

impl LibraryDb {
    pub(super) fn root(&self, root_id: &str) -> Result<Option<RootRow>, String> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT id, label, locator_kind, locator_value, attachment_state, last_scanned_at, created_at, updated_at
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
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;

        validate_attached_root_overlap(&transaction, &directory, None)?;

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
            attachment_state: "attached".to_string(),
            last_scanned_at: None,
            created_at: now.clone(),
            updated_at: now,
        };
        transaction
            .execute(
                "INSERT INTO library_roots
                     (id, label, locator_kind, locator_value, attachment_state,
                      last_scanned_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'attached', ?5, ?6, ?7)",
                params![
                    root.id,
                    root.label,
                    root.locator_kind,
                    root.locator_value,
                    root.last_scanned_at,
                    root.created_at,
                    root.updated_at
                ],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        Ok(root.into_dto())
    }

    pub fn list_roots(&self) -> Result<Vec<LibraryRootDto>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT id, label, locator_kind, locator_value, attachment_state, last_scanned_at, created_at, updated_at
                 FROM library_roots ORDER BY label COLLATE NOCASE, id",
            )
            .map_err(db_error)?;
        let rows = statement.query_map([], root_from_row).map_err(db_error)?;
        rows.map(|row| row.map_err(db_error).map(RootRow::into_dto))
            .collect()
    }

    pub(super) fn raw_roots(&self) -> Result<Vec<RootRow>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT id, label, locator_kind, locator_value, attachment_state, last_scanned_at, created_at, updated_at
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
}

pub(super) fn paths_overlap(path_a: &Path, path_b: &Path) -> bool {
    path_a.starts_with(path_b) || path_b.starts_with(path_a)
}

pub(super) fn validate_attached_root_overlap(
    transaction: &Transaction<'_>,
    new_canonical_path: &Path,
    exclude_root_id: Option<&str>,
) -> Result<(), String> {
    let mut statement = transaction
        .prepare(
            "SELECT id, locator_value
             FROM library_roots
             WHERE locator_kind = 'filesystem-directory' AND attachment_state = 'attached'
               AND (?1 IS NULL OR id != ?1)",
        )
        .map_err(db_error)?;

    let rows = statement
        .query_map([exclude_root_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?;

    for row in rows {
        let (_id, locator_value) = row.map_err(db_error)?;
        let existing_path = match fs::canonicalize(&locator_value) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let stored_path = Path::new(&locator_value);
                let safely_comparable = stored_path.is_absolute()
                    && stored_path.components().all(|component| {
                        !matches!(
                            component,
                            std::path::Component::CurDir | std::path::Component::ParentDir
                        )
                    });
                if !safely_comparable {
                    return Err(format!(
                        "Could not validate missing library root path '{locator_value}': stored path is not absolute and normalized."
                    ));
                }
                stored_path.to_path_buf()
            }
            Err(error) => {
                return Err(format!(
                    "Could not validate existing library root '{locator_value}': {error}"
                ));
            }
        };

        if paths_overlap(new_canonical_path, &existing_path) {
            return Err("This directory overlaps with an existing library root.".to_string());
        }
    }

    Ok(())
}
