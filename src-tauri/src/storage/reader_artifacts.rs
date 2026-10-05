use super::*;
impl LibraryDb {
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
}
