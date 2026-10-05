use super::{
    AnnotationDto, BookmarkDto, CollectionDto, DocumentDto, FormatCapabilitiesDto, FormatId,
    LibraryDb, LibraryRootDto, LibraryScanResultDto, ReadingPosition, ReadingState,
};
use crate::metadata::DocumentMetadata;
use tauri::State;

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
pub fn library_folder_scan(
    db: State<'_, LibraryDb>,
    root_id: String,
    relative_path: String,
) -> Result<LibraryScanResultDto, String> {
    db.scan_folder(&root_id, &relative_path)
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
pub fn library_document_path(
    db: State<'_, LibraryDb>,
    document_id: String,
) -> Result<String, String> {
    db.document_path(&document_id)
}
#[tauri::command]
pub fn library_document_remove(
    db: State<'_, LibraryDb>,
    document_id: String,
) -> Result<(), String> {
    db.remove_document(&document_id)
}
#[tauri::command]
pub fn library_document_relink(
    db: State<'_, LibraryDb>,
    document_id: String,
    new_path: String,
) -> Result<DocumentDto, String> {
    db.relink_document(&document_id, &new_path)
}
#[tauri::command]
pub fn library_document_add_external(
    db: State<'_, LibraryDb>,
    file_path: String,
) -> Result<DocumentDto, String> {
    db.add_external_document_to_library(&file_path)
}

#[tauri::command]
pub fn reading_state_get(
    db: State<'_, LibraryDb>,
    document_id: String,
) -> Result<Option<ReadingState>, String> {
    db.get_reading_state(&document_id)
}
#[tauri::command]
pub fn reading_state_list(db: State<'_, LibraryDb>) -> Result<Vec<ReadingState>, String> {
    db.list_reading_states()
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
pub fn annotation_update(
    db: State<'_, LibraryDb>,
    annotation_id: String,
    note: Option<String>,
) -> Result<AnnotationDto, String> {
    db.update_annotation(&annotation_id, note.as_deref())
}

#[tauri::command]
pub fn annotation_delete(db: State<'_, LibraryDb>, annotation_id: String) -> Result<(), String> {
    db.delete_annotation(&annotation_id)
}

#[tauri::command]
pub fn library_collection_create(
    db: State<'_, LibraryDb>,
    name: String,
    description: Option<String>,
) -> Result<CollectionDto, String> {
    db.create_collection(&name, description.as_deref())
}

#[tauri::command]
pub fn library_collection_list(db: State<'_, LibraryDb>) -> Result<Vec<CollectionDto>, String> {
    db.list_collections()
}

#[tauri::command]
pub fn library_collection_rename(
    db: State<'_, LibraryDb>,
    id: String,
    name: String,
) -> Result<CollectionDto, String> {
    db.rename_collection(&id, &name)
}

#[tauri::command]
pub fn library_collection_delete(db: State<'_, LibraryDb>, id: String) -> Result<(), String> {
    db.delete_collection(&id)
}

#[tauri::command]
pub fn library_collection_add_document(
    db: State<'_, LibraryDb>,
    collection_id: String,
    document_id: String,
) -> Result<(), String> {
    db.add_document_to_collection(&collection_id, &document_id)
}

#[tauri::command]
pub fn library_collection_remove_document(
    db: State<'_, LibraryDb>,
    collection_id: String,
    document_id: String,
) -> Result<(), String> {
    db.remove_document_from_collection(&collection_id, &document_id)
}

#[tauri::command]
pub fn library_collection_list_documents(
    db: State<'_, LibraryDb>,
    collection_id: String,
) -> Result<Vec<DocumentDto>, String> {
    db.list_collection_documents(&collection_id)
}

#[tauri::command]
pub fn library_thumbnail_get(
    db: State<'_, LibraryDb>,
    document_id: String,
) -> Result<Option<String>, String> {
    db.get_thumbnail_data_url(&document_id)
}

#[tauri::command]
pub fn library_metadata_get(
    db: State<'_, LibraryDb>,
    document_id: String,
) -> Result<Option<DocumentMetadata>, String> {
    db.get_metadata(&document_id)
}

#[tauri::command]
pub fn library_metadata_update(
    db: State<'_, LibraryDb>,
    document_id: String,
    metadata: DocumentMetadata,
) -> Result<DocumentMetadata, String> {
    db.update_metadata(&document_id, metadata)
}

#[tauri::command]
pub fn library_document_collections_list(
    db: State<'_, LibraryDb>,
    document_id: String,
) -> Result<Vec<String>, String> {
    db.list_document_collections(&document_id)
}

#[tauri::command]
pub fn format_capabilities_get(format: String) -> Result<FormatCapabilitiesDto, String> {
    let normalized = crate::conversion::normalize_format(&format);
    let format_id = match normalized.as_str() {
        "pdf" => FormatId::Pdf,
        "epub" => FormatId::Epub,
        "docx" => FormatId::Docx,
        "odt" => FormatId::Odt,
        "rtf" => FormatId::Rtf,
        "html" => FormatId::Html,
        "md" => FormatId::Md,
        "txt" => FormatId::Txt,
        _ => return Err(format!("Unsupported format '{format}'.")),
    };
    Ok(format_id.capabilities())
}
