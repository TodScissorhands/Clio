mod conversion;
pub mod metadata;
mod storage;
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
use uuid::Uuid;

use storage::{LibraryDb, ReaderOpen};

const SUPPORTED: &[&str] = &[
    "pdf", "epub", "docx", "odt", "rtf", "html", "htm", "md", "txt",
];

const READER_AUTHORIZATION_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentInfo {
    path: String,
    name: String,
    extension: String,
    size: u64,
    supported: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReaderAuthorization {
    token: String,
    path: String,
    name: String,
    extension: String,
    size: u64,
    supported: bool,
}

#[derive(Clone)]
struct ReaderAuthorizationEntry {
    path: PathBuf,
    expires_at: Instant,
}

static READER_AUTHORIZATIONS: LazyLock<Mutex<HashMap<String, ReaderAuthorizationEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn reader_authorizations() -> &'static Mutex<HashMap<String, ReaderAuthorizationEntry>> {
    &READER_AUTHORIZATIONS
}

fn canonical_regular_file(path: &str) -> Result<PathBuf, String> {
    let document =
        fs::canonicalize(path).map_err(|error| format!("Could not read document: {error}"))?;
    let metadata =
        fs::metadata(&document).map_err(|error| format!("Could not read document: {error}"))?;
    if !metadata.is_file() {
        return Err("Please choose a file, not a folder.".into());
    }
    Ok(document)
}

fn authorized_document_metadata(document: &Path) -> Result<(String, String, u64, bool), String> {
    let metadata =
        fs::metadata(document).map_err(|error| format!("Could not read document: {error}"))?;
    if !metadata.is_file() {
        return Err("Please choose a file, not a folder.".into());
    }
    let extension = extension(document);
    let name = document
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled document")
        .to_string();
    Ok((
        name,
        extension.clone(),
        metadata.len(),
        SUPPORTED.contains(&extension.as_str()),
    ))
}

fn verify_authorized_path(path: &Path) -> Result<(), String> {
    let current = fs::canonicalize(path)
        .map_err(|error| format!("Could not validate reader document: {error}"))?;
    if current != path {
        return Err("Reader document authorization no longer matches this file.".into());
    }
    let _ = authorized_document_metadata(path)?;
    Ok(())
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

#[tauri::command]
fn inspect_document(path: String) -> Result<DocumentInfo, String> {
    let document = Path::new(&path);
    let metadata =
        fs::metadata(document).map_err(|error| format!("Could not read document: {error}"))?;
    if !metadata.is_file() {
        return Err("Please choose a file, not a folder.".into());
    }
    let ext = extension(document);
    let name = document
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled document")
        .to_string();
    Ok(DocumentInfo {
        path,
        name,
        extension: ext.clone(),
        size: metadata.len(),
        supported: SUPPORTED.contains(&ext.as_str()),
    })
}

fn mint_reader_token(document: &Path) -> Result<String, String> {
    let mut authorizations = reader_authorizations()
        .lock()
        .map_err(|_| "Reader authorization registry is unavailable.".to_string())?;
    loop {
        let candidate = Uuid::new_v4().to_string();
        if !authorizations.contains_key(&candidate) {
            authorizations.insert(
                candidate.clone(),
                ReaderAuthorizationEntry {
                    path: document.to_path_buf(),
                    expires_at: Instant::now() + READER_AUTHORIZATION_TTL,
                },
            );
            return Ok(candidate);
        }
    }
}

#[tauri::command]
fn library_document_open(
    db: tauri::State<'_, LibraryDb>,
    document_id: String,
) -> Result<ReaderOpen, String> {
    db.open_library_document(&document_id, mint_reader_token)
}

#[tauri::command]
fn reader_open_selected(path: String) -> Result<ReaderOpen, String> {
    storage::direct_open(path, mint_reader_token)
}

#[tauri::command]
fn authorize_reader_document(path: String) -> Result<ReaderAuthorization, String> {
    let document = canonical_regular_file(&path)?;
    let (name, extension, size, supported) = authorized_document_metadata(&document)?;
    let token = mint_reader_token(&document)?;
    Ok(ReaderAuthorization {
        token,
        path: document.to_string_lossy().into_owned(),
        name,
        extension,
        size,
        supported,
    })
}

#[tauri::command]
fn read_document_bytes(token: String) -> Result<Vec<u8>, String> {
    let entry = {
        let mut authorizations = reader_authorizations()
            .lock()
            .map_err(|_| "Reader authorization registry is unavailable.".to_string())?;
        match authorizations.get(&token) {
            Some(entry) if entry.expires_at > Instant::now() => Some(entry.clone()),
            Some(_) => {
                authorizations.remove(&token);
                None
            }
            None => None,
        }
    }
    .ok_or_else(|| "Reader authorization token is invalid or expired.".to_string())?;

    verify_authorized_path(&entry.path)?;
    fs::read(&entry.path).map_err(|error| format!("Could not read document bytes: {error}"))
}

// Conversion commands and capability registry are implemented in crate::conversion

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().map_err(|error| {
                std::io::Error::other(format!(
                    "Could not determine application data directory: {error}"
                ))
            })?;
            fs::create_dir_all(&data_dir).map_err(|error| {
                std::io::Error::other(format!(
                    "Could not create application data directory: {error}"
                ))
            })?;
            let database =
                LibraryDb::open(data_dir.join("library.sqlite3")).map_err(std::io::Error::other)?;
            app.manage(database);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            inspect_document,
            authorize_reader_document,
            read_document_bytes,
            conversion::convert_document,
            conversion::conversion_capabilities,
            conversion::conversion_plan_job,
            conversion::conversion_plan_merge_job,
            conversion::conversion_plan_extract_pages_job,
            conversion::conversion_parse_page_selection,
            conversion::conversion_pdf_page_count,
            conversion::conversion_execute_job,
            library_document_open,
            reader_open_selected,
            storage::library_root_add,
            storage::library_root_list,
            storage::library_root_remove,
            storage::library_root_scan,
            storage::library_document_list,
            storage::library_document_path,
            storage::library_document_remove,
            storage::reading_state_get,
            storage::reading_state_set,
            storage::reading_state_list,
            storage::bookmark_create,
            storage::bookmark_list,
            storage::bookmark_delete,
            storage::annotation_create,
            storage::annotation_update,
            storage::annotation_list,
            storage::annotation_delete,
            storage::library_collection_create,
            storage::library_collection_list,
            storage::library_collection_rename,
            storage::library_collection_delete,
            storage::library_collection_add_document,
            storage::library_collection_remove_document,
            storage::library_collection_list_documents,
            storage::library_thumbnail_get,
            storage::library_metadata_get,
            storage::library_metadata_update,
            storage::library_document_collections_list,
            storage::format_capabilities_get
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_authorization_is_token_only_and_revalidates_the_file() {
        let path = std::env::temp_dir().join(format!("clio-reader-auth-{}", Uuid::new_v4()));
        fs::write(&path, b"reader authorization test").expect("create test document");
        let path_string = path.to_string_lossy().into_owned();

        let authorization =
            authorize_reader_document(path_string.clone()).expect("authorize test document");
        assert_eq!(
            read_document_bytes(authorization.token.clone()).expect("read authorized document"),
            b"reader authorization test"
        );
        assert!(read_document_bytes(path_string).is_err());

        fs::remove_file(&path).expect("remove test document");
        assert!(read_document_bytes(authorization.token).is_err());
    }

    #[test]
    fn end_to_end_library_scan_persistence_and_reader_authorization() {
        let test_dir = std::env::temp_dir().join(format!("clio-e2e-{}", Uuid::new_v4()));
        let books_dir = test_dir.join("Books");
        fs::create_dir_all(&books_dir).expect("create books dir");

        let pdf_path = books_dir.join("document.pdf");
        let epub_path = books_dir.join("story.epub");
        fs::write(&pdf_path, b"%PDF-1.4 sample pdf content").expect("write pdf");
        fs::write(&epub_path, b"PK sample epub content").expect("write epub");

        let db_path = test_dir.join("library.sqlite3");

        // Step 1 & 2: Open DB on disk, configure library root
        let root_id = {
            let db = LibraryDb::open(&db_path).expect("open library db on disk");
            let root = db
                .add_root(&books_dir.to_string_lossy(), Some("My Books"))
                .expect("add library root");
            assert_eq!(root.label, "My Books");

            // Step 3 & 4: Scan and confirm documents appear in catalog
            let scan_result = db.scan_root(&root.id).expect("scan library root");
            assert_eq!(scan_result.scanned, 2);
            assert_eq!(scan_result.inserted, 2);
            assert_eq!(scan_result.missing, 0);

            let docs = db.list_documents(Some(&root.id), false).expect("list docs");
            assert_eq!(docs.len(), 2);
            root.id
        }; // db is closed here

        // Step 5 & 6: Reopen DB, confirm catalog state persists across restarts
        let db_reopened = LibraryDb::open(&db_path).expect("reopen library db from disk");
        let roots_persisted = db_reopened.list_roots().expect("list roots after restart");
        assert_eq!(roots_persisted.len(), 1);
        assert_eq!(roots_persisted[0].id, root_id);

        let docs_persisted = db_reopened
            .list_documents(Some(&root_id), false)
            .expect("list docs after restart");
        assert_eq!(docs_persisted.len(), 2);

        let pdf_doc = docs_persisted
            .iter()
            .find(|d| d.name == "document.pdf")
            .expect("find pdf doc");
        let epub_doc = docs_persisted
            .iter()
            .find(|d| d.name == "story.epub")
            .expect("find epub doc");

        // Step 7 & 8: Open PDF and EPUB through storage boundary
        let pdf_open = db_reopened
            .open_library_document(&pdf_doc.id, mint_reader_token)
            .expect("open library pdf");
        assert_eq!(pdf_open.record.name, "document.pdf");
        assert_eq!(pdf_open.locator.kind, "desktop-token");

        let epub_open = db_reopened
            .open_library_document(&epub_doc.id, mint_reader_token)
            .expect("open library epub");
        assert_eq!(epub_open.record.name, "story.epub");
        assert_eq!(epub_open.locator.kind, "desktop-token");

        // Step 9: Confirm reader bytes load through authorized tokens
        let pdf_bytes = read_document_bytes(pdf_open.locator.value).expect("read pdf bytes");
        assert_eq!(pdf_bytes, b"%PDF-1.4 sample pdf content");

        let epub_bytes = read_document_bytes(epub_open.locator.value).expect("read epub bytes");
        assert_eq!(epub_bytes, b"PK sample epub content");

        // Step 10: Confirm raw arbitrary-path reads are rejected
        assert!(read_document_bytes(pdf_path.to_string_lossy().into_owned()).is_err());
        assert!(read_document_bytes(epub_path.to_string_lossy().into_owned()).is_err());
        assert!(read_document_bytes("/etc/passwd".to_string()).is_err());

        let _ = fs::remove_dir_all(&test_dir);
    }
}
