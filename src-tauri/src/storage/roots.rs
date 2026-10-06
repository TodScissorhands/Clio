use super::rows::{root_from_row, RootRow};
use super::*;

impl LibraryDb {
    pub(super) fn root(&self, root_id: &str) -> Result<Option<RootRow>, String> {
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

    pub(super) fn raw_roots(&self) -> Result<Vec<RootRow>, String> {
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
}
