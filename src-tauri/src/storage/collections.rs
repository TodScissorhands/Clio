use super::document_read_context::DocumentReadContext;
use super::*;

impl LibraryDb {
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
        let mut read_context = DocumentReadContext::load(&connection)?;
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
        rows.map(|row| {
            let doc = row.map_err(db_error)?;
            Ok(read_context.attach(doc))
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
}
