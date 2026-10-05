use super::*;
pub(super) struct RootRow {
    pub(super) id: String,
    pub(super) label: String,
    pub(super) locator_kind: String,
    pub(super) locator_value: String,
    pub(super) last_scanned_at: Option<String>,
    pub(super) created_at: String,
    pub(super) updated_at: String,
}

impl RootRow {
    pub(super) fn into_dto(self) -> LibraryRootDto {
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

pub(super) struct DocumentRow {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) format: FormatId,
    pub(super) size_bytes: i64,
    pub(super) first_seen_at: String,
    pub(super) updated_at: String,
    pub(super) root_id: String,
    pub(super) relative_path: String,
    pub(super) availability: String,
    pub(super) metadata: Option<DocumentMetadata>,
}

impl DocumentRow {
    pub(super) fn into_dto(
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

pub(super) struct OpenDocument {
    pub(super) record: ReaderRecord,
    pub(super) root_id: String,
    pub(super) relative_path: String,
    pub(super) root_locator: String,
    pub(super) availability: String,
}

pub(super) fn root_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RootRow> {
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

pub(super) fn document_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocumentRow> {
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

pub(super) fn open_document_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OpenDocument> {
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

pub(super) fn reading_state_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReadingState> {
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

pub(super) fn bookmark_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BookmarkDto> {
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

pub(super) fn annotation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AnnotationDto> {
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
