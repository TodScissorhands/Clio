use super::rows::{reading_state_from_row, DocumentRow};
use super::*;
use rusqlite::Connection;
use std::collections::HashMap;

pub(super) struct DocumentReadContext {
    collections: HashMap<String, Vec<String>>,
    reading_states: HashMap<String, ReadingState>,
}

impl DocumentReadContext {
    pub(super) fn load(connection: &Connection) -> Result<Self, String> {
        let mut collection_statement = connection
            .prepare("SELECT document_id, collection_id FROM document_collections")
            .map_err(db_error)?;
        let mut collections = HashMap::new();
        let collection_rows = collection_statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?;
        for row in collection_rows {
            let (document_id, collection_id) = row.map_err(db_error)?;
            collections
                .entry(document_id)
                .or_insert_with(Vec::new)
                .push(collection_id);
        }

        let mut reading_state_statement = connection
            .prepare("SELECT document_id, position_kind, page, cfi, progression, last_opened_at, updated_at FROM reading_state")
            .map_err(db_error)?;
        let mut reading_states = HashMap::new();
        let reading_state_rows = reading_state_statement
            .query_map([], reading_state_from_row)
            .map_err(db_error)?;
        for row in reading_state_rows {
            let state = row.map_err(db_error)?;
            reading_states.insert(state.document_id.clone(), state);
        }

        Ok(Self {
            collections,
            reading_states,
        })
    }

    pub(super) fn attach(&mut self, document: DocumentRow) -> DocumentDto {
        let collections = self
            .collections
            .get(&document.id)
            .cloned()
            .unwrap_or_default();
        let reading_state = self.reading_states.remove(&document.id);
        document.into_dto(collections, reading_state)
    }
}
