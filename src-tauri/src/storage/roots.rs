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

    pub(crate) fn root_authorizes_path(
        &self,
        root_id: &str,
        document_path: &Path,
    ) -> Result<bool, String> {
        let Some(root) = self.root(root_id)? else {
            return Ok(false);
        };
        if root.attachment_state != "attached" {
            return Ok(false);
        }
        let root_path = canonical_directory(&root.locator_value)?;
        Ok(document_path.starts_with(&root_path))
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

    pub fn preview_locate_root(
        &self,
        root_id: &str,
        candidate_path: &str,
    ) -> Result<LocateRootPreviewDto, String> {
        let candidate = canonical_directory(candidate_path)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction().map_err(db_error)?;
        let root = transaction
            .query_row(
                "SELECT id, label, locator_kind, locator_value, attachment_state, last_scanned_at, created_at, updated_at
                 FROM library_roots WHERE id = ?1",
                [root_id],
                root_from_row,
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Library root was not found.".to_string())?;
        ensure_root_can_be_located(&root)?;
        validate_attached_root_overlap(&transaction, &candidate, Some(root_id))?;
        let document_count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM documents WHERE root_id = ?1",
                [root_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let availability = if root.attachment_state == "attached" {
            Some(
                if directory_exists(&root.locator_value) {
                    "available"
                } else {
                    "missing"
                }
                .to_string(),
            )
        } else {
            None
        };
        Ok(LocateRootPreviewDto {
            root_id: root.id,
            label: root.label,
            current_locator: root.locator_value,
            attachment_state: root.attachment_state,
            availability,
            updated_at: root.updated_at,
            candidate_locator: candidate.to_string_lossy().into_owned(),
            document_count: document_count.max(0) as u64,
        })
    }

    pub fn confirm_locate_root(
        &self,
        preview: &LocateRootPreviewDto,
    ) -> Result<LibraryRootDto, String> {
        let scan_guard = self
            .scan_lock
            .lock()
            .map_err(|_| "Library scanner is busy.".to_string())?;
        self.confirm_locate_root_with_scan_guard(preview, scan_guard)
    }

    #[cfg(test)]
    pub(crate) fn confirm_locate_root_with_lock_attempt_hook<F>(
        &self,
        preview: &LocateRootPreviewDto,
        on_lock_attempt: F,
    ) -> Result<LibraryRootDto, String>
    where
        F: FnOnce(bool),
    {
        let scan_guard = self
            .scan_lock
            .lock_with_attempt_hook(on_lock_attempt)
            .map_err(|_| "Library scanner is busy.".to_string())?;
        self.confirm_locate_root_with_scan_guard(preview, scan_guard)
    }

    fn confirm_locate_root_with_scan_guard(
        &self,
        preview: &LocateRootPreviewDto,
        scan_guard: ScanGuard<'_>,
    ) -> Result<LibraryRootDto, String> {
        let _scan_guard = scan_guard;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let mut root = transaction
            .query_row(
                "SELECT id, label, locator_kind, locator_value, attachment_state, last_scanned_at, created_at, updated_at
                 FROM library_roots WHERE id = ?1",
                [&preview.root_id],
                root_from_row,
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Library root was not found.".to_string())?;
        if root.label != preview.label
            || root.locator_value != preview.current_locator
            || root.attachment_state != preview.attachment_state
            || root.updated_at != preview.updated_at
        {
            return Err(
                "Library root changed since Locate Root preview. Preview again.".to_string(),
            );
        }
        let document_count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM documents WHERE root_id = ?1",
                [&preview.root_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if document_count.max(0) as u64 != preview.document_count {
            return Err(
                "Library root catalog changed since Locate Root preview. Preview again."
                    .to_string(),
            );
        }
        ensure_root_can_be_located(&root)?;
        let candidate = canonical_directory(&preview.candidate_locator)?;
        if candidate.to_string_lossy() != preview.candidate_locator {
            return Err(
                "Proposed library directory changed since Locate Root preview. Preview again."
                    .to_string(),
            );
        }
        validate_attached_root_overlap(&transaction, &candidate, Some(&preview.root_id))?;
        ensure_root_can_be_located(&root)?;
        let current_candidate = canonical_directory(&preview.candidate_locator)?;
        if current_candidate != candidate {
            return Err(
                "Proposed library directory changed since Locate Root preview. Preview again."
                    .to_string(),
            );
        }
        let updated_at = timestamp();
        let updated = transaction
            .execute(
                "UPDATE library_roots
                 SET locator_value = ?1, attachment_state = 'attached', updated_at = ?2
                 WHERE id = ?3 AND label = ?7 AND locator_value = ?4 AND attachment_state = ?5 AND updated_at = ?6",
                params![
                    candidate.to_string_lossy(),
                    updated_at,
                    preview.root_id,
                    preview.current_locator,
                    preview.attachment_state,
                    preview.updated_at,
                    preview.label
                ],
            )
            .map_err(db_error)?;
        if updated != 1 {
            return Err(
                "Library root changed since Locate Root preview. Preview again.".to_string(),
            );
        }
        root.locator_value = candidate.to_string_lossy().into_owned();
        root.attachment_state = "attached".to_string();
        root.updated_at = updated_at;
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
        let _scan_guard = self
            .scan_lock
            .lock()
            .map_err(|_| "Library scanner is busy.".to_string())?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        transaction
            .execute(
                "UPDATE library_roots
                 SET attachment_state = 'detached', updated_at = ?1
                 WHERE id = ?2 AND attachment_state = 'attached'",
                params![timestamp(), root_id],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)
    }

    pub fn preview_purge_root(&self, root_id: &str) -> Result<PurgeRootPreviewDto, String> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction().map_err(db_error)?;
        let preview = transaction
            .query_row(
                "SELECT id, label, locator_value, attachment_state,
                        (SELECT COUNT(*) FROM documents WHERE root_id = library_roots.id),
                        (SELECT COUNT(*) FROM reading_state s
                         JOIN documents d ON d.id = s.document_id
                         WHERE d.root_id = library_roots.id),
                        (SELECT COUNT(*) FROM bookmarks b
                         JOIN documents d ON d.id = b.document_id
                         WHERE d.root_id = library_roots.id),
                        (SELECT COUNT(*) FROM annotations a
                         JOIN documents d ON d.id = a.document_id
                         WHERE d.root_id = library_roots.id),
                        (SELECT COUNT(*) FROM document_metadata m
                         JOIN documents d ON d.id = m.document_id
                         WHERE d.root_id = library_roots.id),
                        (SELECT COUNT(*) FROM document_collections c
                         JOIN documents d ON d.id = c.document_id
                         WHERE d.root_id = library_roots.id)
                 FROM library_roots WHERE id = ?1",
                [root_id],
                |row| {
                    Ok(PurgeRootPreviewDto {
                        root_id: row.get(0)?,
                        label: row.get(1)?,
                        locator_value: row.get(2)?,
                        attachment_state: row.get(3)?,
                        document_count: row.get::<_, i64>(4)?.max(0) as u64,
                        reading_state_count: row.get::<_, i64>(5)?.max(0) as u64,
                        bookmark_count: row.get::<_, i64>(6)?.max(0) as u64,
                        annotation_count: row.get::<_, i64>(7)?.max(0) as u64,
                        metadata_count: row.get::<_, i64>(8)?.max(0) as u64,
                        collection_membership_count: row.get::<_, i64>(9)?.max(0) as u64,
                    })
                },
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "Library root was not found.".to_string())?;
        if preview.attachment_state != "detached" {
            return Err("Only detached library roots can be purged.".to_string());
        }
        Ok(preview)
    }

    pub fn purge_root(&self, root_id: &str) -> Result<(), String> {
        let _scan_guard = self
            .scan_lock
            .lock()
            .map_err(|_| "Library scanner is busy.".to_string())?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let attachment_state: Option<String> = transaction
            .query_row(
                "SELECT attachment_state FROM library_roots WHERE id = ?1",
                [root_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        let attachment_state =
            attachment_state.ok_or_else(|| "Library root was not found.".to_string())?;
        if attachment_state != "detached" {
            return Err("Only detached library roots can be purged.".to_string());
        }
        let deleted = transaction
            .execute(
                "DELETE FROM library_roots WHERE id = ?1 AND attachment_state = 'detached'",
                [root_id],
            )
            .map_err(db_error)?;
        if deleted != 1 {
            return Err("Library root changed before Purge could complete.".to_string());
        }
        transaction.commit().map_err(db_error)
    }
}

fn ensure_root_can_be_located(root: &RootRow) -> Result<(), String> {
    if root.locator_kind != "filesystem-directory" {
        return Err("This library root is not a filesystem directory.".to_string());
    }
    if root.attachment_state == "attached" && directory_exists(&root.locator_value) {
        return Err(
            "Library root is already attached and available; detach it before locating."
                .to_string(),
        );
    }
    Ok(())
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
