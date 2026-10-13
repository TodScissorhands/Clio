use super::*;
use crate::conversion::is_tool_installed;
use std::process::Command;
#[test]
fn test_schema_migration_and_idempotence() {
    let db = LibraryDb::open_in_memory().expect("open in-memory db");
    db.migrate()
        .expect("second migrate call must be idempotent");
    let connection = db.lock().expect("lock connection");
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("query user_version");
    assert_eq!(version, 6);
}

#[test]
fn test_library_root_crud() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-root-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create temp root");
    let db = LibraryDb::open_in_memory().expect("open db");

    let root = db
        .add_root(&temp_dir.to_string_lossy(), Some("Test Root"))
        .expect("add root");
    assert_eq!(root.label, "Test Root");
    assert_eq!(root.kind, "filesystem-directory");
    assert_eq!(root.status, "active");
    assert_eq!(root.attachment_state, "attached");
    assert_eq!(root.availability.as_deref(), Some("available"));
    let roots = db.list_roots().expect("list roots");
    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].id, root.id);

    db.remove_root(&root.id).expect("detach root");
    let roots_after = db.list_roots().expect("list roots after detach");
    assert_eq!(roots_after.len(), 1);
    assert_eq!(roots_after[0].id, root.id);
    assert_eq!(roots_after[0].attachment_state, "detached");
    assert_eq!(roots_after[0].availability, None);

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_scanner_discovery_and_normalization() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-scan-{}", Uuid::new_v4()));
    let sub_dir = temp_dir.join("sub");
    fs::create_dir_all(&sub_dir).expect("create sub dir");

    fs::write(temp_dir.join("book.pdf"), b"%PDF-1.4 test").expect("write pdf");
    fs::write(temp_dir.join("novel.epub"), b"PK epub test").expect("write epub");
    fs::write(temp_dir.join("page.htm"), b"<html>test</html>").expect("write htm");
    fs::write(temp_dir.join("ignored.xyz"), b"ignore me").expect("write ignored");
    fs::write(sub_dir.join("notes.md"), b"# Notes").expect("write md");

    #[cfg(unix)]
    let symlink_path = temp_dir.join("symlink_book.pdf");
    #[cfg(unix)]
    let _ = std::os::unix::fs::symlink(temp_dir.join("book.pdf"), &symlink_path);

    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");

    let result = db.scan_root(&root.id).expect("scan root");
    assert_eq!(result.scanned, 4); // pdf, epub, htm, md (symlink and .xyz skipped)
    assert_eq!(result.inserted, 4);
    assert_eq!(result.missing, 0);
    assert!(result.errors.is_empty());

    let docs = db.list_documents(Some(&root.id), false).expect("list docs");
    assert_eq!(docs.len(), 4);

    let htm_doc = docs
        .iter()
        .find(|d| d.name == "page.htm")
        .expect("find page.htm");
    assert_eq!(htm_doc.format, FormatId::Html);

    let rescan = db.scan_root(&root.id).expect("rescan root");
    assert_eq!(rescan.scanned, 4);
    assert_eq!(rescan.inserted, 0);
    assert_eq!(rescan.updated, 4);

    let docs_rescan = db
        .list_documents(Some(&root.id), false)
        .expect("list docs after rescan");
    assert_eq!(docs_rescan.len(), 4);
    for doc in &docs {
        let matching = docs_rescan
            .iter()
            .find(|d| d.id == doc.id)
            .expect("doc id stable");
        assert_eq!(matching.relative_path, doc.relative_path);
    }

    let _ = fs::remove_file(temp_dir.join("novel.epub"));
    let rescan_missing = db.scan_root(&root.id).expect("scan after delete");
    assert_eq!(rescan_missing.scanned, 3);
    assert_eq!(rescan_missing.missing, 1);

    let present_docs = db
        .list_documents(Some(&root.id), false)
        .expect("list present docs");
    assert_eq!(present_docs.len(), 3);
    let all_docs = db
        .list_documents(Some(&root.id), true)
        .expect("list all docs");
    assert_eq!(all_docs.len(), 4);
    let missing_doc = all_docs
        .iter()
        .find(|d| d.name == "novel.epub")
        .expect("find missing");
    assert_eq!(missing_doc.availability, "missing");

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_scanner_folder_scope_preserves_other_root_documents() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-folder-scan-{}", Uuid::new_v4()));
    let nested = temp_dir.join("plays");
    fs::create_dir_all(&nested).expect("create nested folder");
    fs::write(temp_dir.join("readme.txt"), b"root document").expect("write root document");
    fs::write(nested.join("play.md"), b"# Play").expect("write nested document");

    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");
    db.scan_root(&root.id).expect("initial scan");
    let documents = db
        .list_documents(Some(&root.id), true)
        .expect("list documents");
    let root_doc_id = documents
        .iter()
        .find(|document| document.relative_path == "readme.txt")
        .expect("root document")
        .id
        .clone();

    fs::remove_file(nested.join("play.md")).expect("remove nested document");
    let scoped = db
        .scan_folder(&root.id, "plays")
        .expect("scan nested folder");
    assert_eq!(scoped.scanned, 0);
    assert_eq!(scoped.missing, 1);
    assert!(db.scan_folder(&root.id, "../").is_err());
    assert!(db.scan_folder(&root.id, "missing").is_err());

    let updated = db
        .list_documents(Some(&root.id), true)
        .expect("list after scoped scan");
    let root_doc = updated
        .iter()
        .find(|document| document.id == root_doc_id)
        .expect("root document remains cataloged");
    assert_eq!(root_doc.availability, "present");
    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_open_library_document_and_direct_open() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-open-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");
    let book_path = temp_dir.join("guide.pdf");
    fs::write(&book_path, b"%PDF sample").expect("write file");

    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");
    db.scan_root(&root.id).expect("scan");

    let docs = db.list_documents(Some(&root.id), false).expect("list");
    assert_eq!(docs.len(), 1);
    let doc_id = &docs[0].id;

    let opened = db
        .open_library_document(doc_id, |path, _root_id| {
            assert_eq!(
                fs::canonicalize(path).unwrap(),
                fs::canonicalize(&book_path).unwrap()
            );
            Ok("fake-token-123".to_string())
        })
        .expect("open document");
    assert_eq!(opened.record.name, "guide.pdf");
    assert_eq!(opened.locator.kind, "desktop-token");
    assert_eq!(opened.locator.value, "fake-token-123");

    let missing_open = db.open_library_document("nonexistent-id", |_, _| Ok("token".to_string()));
    assert!(missing_open.is_err());

    let direct = direct_open(book_path.to_string_lossy().into_owned(), |_| {
        Ok("token-direct".to_string())
    })
    .expect("direct open");
    assert_eq!(direct.record.name, "guide.pdf");
    assert_eq!(direct.locator.value, "token-direct");

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_reading_state_roundtrip_and_validation() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-state-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");
    fs::write(temp_dir.join("test.pdf"), b"%PDF sample").expect("write file");

    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");
    db.scan_root(&root.id).expect("scan");
    let docs = db.list_documents(Some(&root.id), false).expect("list");
    let doc_id = docs[0].id.clone();
    // Missing document state returns None cleanly
    assert!(db
        .get_reading_state(&doc_id)
        .expect("query state")
        .is_none());

    // 1. PDF reading-state roundtrip
    let valid_pdf_state = ReadingState {
        document_id: doc_id.clone(),
        position: ReadingPosition::PdfPage {
            page: 5,
            progression: Some(0.5),
        },
        last_opened_at: "2026-10-01T12:00:00Z".to_string(),
        updated_at: "2026-10-01T12:00:00Z".to_string(),
    };
    db.set_reading_state(valid_pdf_state)
        .expect("set pdf reading state");

    let retrieved_pdf = db
        .get_reading_state(&doc_id)
        .expect("get reading state")
        .expect("some state");
    assert_eq!(retrieved_pdf.document_id, doc_id);
    let pdf_position_json =
        serde_json::to_value(&retrieved_pdf.position).expect("serialize pdf position");
    assert_eq!(pdf_position_json["kind"].as_str(), Some("pdf-page"));
    assert_eq!(pdf_position_json["progression"].as_f64(), Some(0.5));
    let legacy_pdf_position: ReadingPosition = serde_json::from_value(serde_json::json!({
        "kind": "pdf-page",
        "page": 5,
    }))
    .expect("deserialize PDF position without progression");
    assert!(matches!(
        legacy_pdf_position,
        ReadingPosition::PdfPage {
            page: 5,
            progression: None
        }
    ));
    match retrieved_pdf.position {
        ReadingPosition::PdfPage { page, progression } => {
            assert_eq!(page, 5);
            assert_eq!(progression, Some(0.5));
        }
        _ => panic!("expected pdf-page"),
    }

    // 2. EPUB reading-state roundtrip
    let valid_epub_state = ReadingState {
        document_id: doc_id.clone(),
        position: ReadingPosition::EpubCfi {
            cfi: "epubcfi(/6/4[chap01]!/4/2/10)".to_string(),
            progression: Some(0.42),
        },
        last_opened_at: "2026-10-01T13:00:00Z".to_string(),
        updated_at: "2026-10-01T13:00:00Z".to_string(),
    };
    db.set_reading_state(valid_epub_state)
        .expect("set epub reading state");

    let retrieved_epub = db
        .get_reading_state(&doc_id)
        .expect("get epub state")
        .expect("some state");
    assert_eq!(retrieved_epub.document_id, doc_id);
    match retrieved_epub.position {
        ReadingPosition::EpubCfi { cfi, progression } => {
            assert_eq!(cfi, "epubcfi(/6/4[chap01]!/4/2/10)");
            assert_eq!(progression, Some(0.42));
        }
        _ => panic!("expected epub-cfi"),
    }
    let invalid_page_state = ReadingState {
        document_id: doc_id.clone(),
        position: ReadingPosition::PdfPage {
            page: 0,
            progression: None,
        },
        last_opened_at: "2026-10-01T12:00:00Z".to_string(),
        updated_at: "2026-10-01T12:00:00Z".to_string(),
    };
    assert!(db.set_reading_state(invalid_page_state).is_err());

    let invalid_pdf_progression_state = ReadingState {
        document_id: doc_id.clone(),
        position: ReadingPosition::PdfPage {
            page: 2,
            progression: Some(1.5),
        },
        last_opened_at: "2026-10-01T12:00:00Z".to_string(),
        updated_at: "2026-10-01T12:00:00Z".to_string(),
    };
    assert!(db.set_reading_state(invalid_pdf_progression_state).is_err());

    let invalid_progression_state = ReadingState {
        document_id: doc_id.clone(),
        position: ReadingPosition::EpubCfi {
            cfi: "epubcfi(/6/2)".to_string(),
            progression: Some(1.5),
        },
        last_opened_at: "2026-10-01T12:00:00Z".to_string(),
        updated_at: "2026-10-01T12:00:00Z".to_string(),
    };
    assert!(db.set_reading_state(invalid_progression_state).is_err());

    let unknown_doc_state = ReadingState {
        document_id: "unknown-uuid".to_string(),
        position: ReadingPosition::PdfPage {
            page: 1,
            progression: None,
        },
        last_opened_at: "2026-10-01T12:00:00Z".to_string(),
        updated_at: "2026-10-01T12:00:00Z".to_string(),
    };
    assert!(db.set_reading_state(unknown_doc_state).is_err());

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_bookmark_crud_validation_and_detach_preservation() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-bm-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");
    fs::write(temp_dir.join("book.pdf"), b"%PDF sample").expect("write file");

    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");
    db.scan_root(&root.id).expect("scan");
    let docs = db.list_documents(Some(&root.id), false).expect("list");
    let doc_id = docs[0].id.clone();

    // 1. Initial list is empty
    let bookmarks = db.list_bookmarks(&doc_id).expect("list bookmarks");
    assert!(bookmarks.is_empty());

    // 2. Create PDF bookmark
    let bm1 = db
        .create_bookmark(
            &doc_id,
            ReadingPosition::PdfPage {
                page: 12,
                progression: None,
            },
            Some("Chapter 2"),
        )
        .expect("create bookmark 1");
    assert_eq!(bm1.document_id, doc_id);
    assert_eq!(bm1.title, Some("Chapter 2".to_string()));
    match bm1.position {
        ReadingPosition::PdfPage { page, .. } => assert_eq!(page, 12),
        _ => panic!("expected pdf-page"),
    }

    // 3. Create EPUB bookmark with fallback title
    let bm2 = db
        .create_bookmark(
            &doc_id,
            ReadingPosition::EpubCfi {
                cfi: "epubcfi(/6/6)".to_string(),
                progression: Some(0.55),
            },
            None, // Fallback title should be "55%"
        )
        .expect("create bookmark 2");
    assert_eq!(bm2.title, Some("55%".to_string()));

    // 4. List bookmarks returns both (order is created_at ASC, id ASC; both may share
    //    the same timestamp in tests so only assert presence, not position).
    let listed = db.list_bookmarks(&doc_id).expect("list bookmarks");
    assert_eq!(listed.len(), 2);
    let ids: Vec<&str> = listed.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&bm1.id.as_str()), "bm1 must be listed");
    assert!(ids.contains(&bm2.id.as_str()), "bm2 must be listed");

    // 5. Validation: Reject invalid page 0
    assert!(db
        .create_bookmark(
            &doc_id,
            ReadingPosition::PdfPage {
                page: 0,
                progression: None
            },
            None
        )
        .is_err());

    // 6. Validation: Reject empty CFI
    assert!(db
        .create_bookmark(
            &doc_id,
            ReadingPosition::EpubCfi {
                cfi: "".to_string(),
                progression: None,
            },
            None,
        )
        .is_err());

    // 7. Validation: Reject invalid progression
    assert!(db
        .create_bookmark(
            &doc_id,
            ReadingPosition::EpubCfi {
                cfi: "epubcfi(/6/2)".to_string(),
                progression: Some(1.2),
            },
            None,
        )
        .is_err());

    // 8. Validation: Reject unknown document ID
    assert!(db
        .create_bookmark(
            "unknown-doc",
            ReadingPosition::PdfPage {
                page: 1,
                progression: None
            },
            None
        )
        .is_err());

    // 9. Delete bookmark
    db.delete_bookmark(&bm1.id).expect("delete bm1");
    let after_delete = db.list_bookmarks(&doc_id).expect("list after delete");
    assert_eq!(after_delete.len(), 1);
    assert_eq!(after_delete[0].id, bm2.id);

    // 10. Detaching the root preserves the document's remaining bookmark.
    db.remove_root(&root.id).expect("detach root");
    let after_detach = db.list_bookmarks(&doc_id).expect("list after detach");
    assert_eq!(after_detach.len(), 1);
    assert_eq!(after_detach[0].id, bm2.id);

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_annotation_crud_and_detach_preservation() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-ann-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");
    fs::write(temp_dir.join("book.pdf"), b"%PDF sample").expect("write file");

    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");
    db.scan_root(&root.id).expect("scan");
    let docs = db.list_documents(Some(&root.id), false).expect("list");
    let doc_id = docs[0].id.clone();

    let ann = db
        .create_annotation(
            &doc_id,
            "highlight",
            ReadingPosition::PdfPage {
                page: 3,
                progression: None,
            },
            Some("Important sentence"),
            Some("Check reference later"),
            None,
        )
        .expect("create annotation");
    assert_eq!(ann.document_id, doc_id);
    assert_eq!(ann.kind, "highlight");
    assert_eq!(ann.selected_text, Some("Important sentence".to_string()));
    assert_eq!(ann.note, Some("Check reference later".to_string()));
    assert_eq!(ann.locator, None);

    let listed = db.list_annotations(&doc_id).expect("list annotations");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, ann.id);

    // Validation: reject empty kind
    assert!(db
        .create_annotation(
            &doc_id,
            "",
            ReadingPosition::PdfPage {
                page: 3,
                progression: None
            },
            None,
            None,
            None,
        )
        .is_err());

    // Delete annotation
    db.delete_annotation(&ann.id).expect("delete annotation");
    assert!(db
        .list_annotations(&doc_id)
        .expect("list after delete")
        .is_empty());

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_annotation_locator_crud_and_schema_v3() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-loc-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");
    fs::write(temp_dir.join("book.epub"), b"PK epub").expect("write epub");

    let db = LibraryDb::open_in_memory().expect("open db");
    // Verify schema is v3.
    {
        let connection = db.lock().expect("lock");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("user_version");
        assert!(version >= 3, "schema must be at least version 3");
    }

    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");
    db.scan_root(&root.id).expect("scan");
    let docs = db.list_documents(Some(&root.id), false).expect("list");
    let doc_id = docs[0].id.clone();

    // 1. Create annotation with EPUB range CFI locator.
    let epub_locator = r#"{"kind":"epub-cfi-range","cfi":"epubcfi(/6/4!/4,/2/1:0,/2/1:22)"}"#;
    let ann_epub = db
        .create_annotation(
            &doc_id,
            "highlight",
            ReadingPosition::EpubCfi {
                cfi: "epubcfi(/6/4!/4/2)".to_string(),
                progression: Some(0.25),
            },
            Some("Selected EPUB text"),
            None,
            Some(epub_locator),
        )
        .expect("create epub annotation with locator");
    assert_eq!(ann_epub.locator.as_deref(), Some(epub_locator));
    assert_eq!(
        ann_epub.selected_text.as_deref(),
        Some("Selected EPUB text")
    );

    // 2. Create annotation with PDF page-text locator.
    let pdf_locator = r#"{"kind":"pdf-page-text","page":5,"selectedText":"Some text"}"#;
    let ann_pdf = db
        .create_annotation(
            &doc_id,
            "highlight",
            ReadingPosition::PdfPage {
                page: 5,
                progression: None,
            },
            Some("Some text"),
            None,
            Some(pdf_locator),
        )
        .expect("create pdf annotation with locator");
    assert_eq!(ann_pdf.locator.as_deref(), Some(pdf_locator));

    // 3. Create annotation without locator (null).
    let ann_no_loc = db
        .create_annotation(
            &doc_id,
            "note",
            ReadingPosition::PdfPage {
                page: 1,
                progression: None,
            },
            None,
            Some("A plain note"),
            None,
        )
        .expect("create annotation without locator");
    assert_eq!(ann_no_loc.locator, None);

    // 4. Empty-string locator is normalized to NULL.
    let ann_empty = db
        .create_annotation(
            &doc_id,
            "note",
            ReadingPosition::PdfPage {
                page: 2,
                progression: None,
            },
            None,
            None,
            Some(""),
        )
        .expect("empty locator normalized to null");
    assert_eq!(ann_empty.locator, None);

    // 5. Non-JSON locator is rejected.
    assert!(db
        .create_annotation(
            &doc_id,
            "highlight",
            ReadingPosition::PdfPage {
                page: 1,
                progression: None
            },
            Some("text"),
            None,
            Some("not-json-at-all"),
        )
        .is_err());

    // 6. List annotations: all four valid annotations returned; locators preserved.
    let listed = db.list_annotations(&doc_id).expect("list");
    assert_eq!(listed.len(), 4);
    let with_locator: Vec<_> = listed.iter().filter(|a| a.locator.is_some()).collect();
    assert_eq!(with_locator.len(), 2, "two annotations have locators");
    let without_locator: Vec<_> = listed.iter().filter(|a| a.locator.is_none()).collect();
    assert_eq!(without_locator.len(), 2, "two annotations have no locator");

    // 7. Document isolation: annotations only returned for their document.
    let other_listed = db
        .list_annotations("non-existent-doc-id")
        .expect("list other");
    assert!(other_listed.is_empty());

    // 8. Detaching the root preserves its annotations.
    db.remove_root(&root.id).expect("detach root");
    let after_detach = db.list_annotations(&doc_id).expect("list after detach");
    assert_eq!(after_detach.len(), 4);

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_annotation_update_and_deletion_failure() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-ann-upd-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");
    fs::write(temp_dir.join("book.epub"), b"PK epub content").expect("write epub");

    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");
    db.scan_root(&root.id).expect("scan");
    let docs = db.list_documents(Some(&root.id), false).expect("list");
    let doc_id = docs[0].id.clone();

    let locator = r#"{"kind":"epub-cfi-range","cfi":"epubcfi(/6/4!/4,/2/1:0,/2/1:10)"}"#;
    let ann = db
        .create_annotation(
            &doc_id,
            "highlight",
            ReadingPosition::EpubCfi {
                cfi: "epubcfi(/6/4!/4/2)".to_string(),
                progression: Some(0.1),
            },
            Some("Initial highlight excerpt"),
            Some("Initial note"),
            Some(locator),
        )
        .expect("create annotation");

    assert_eq!(ann.note.as_deref(), Some("Initial note"));
    assert_eq!(ann.locator.as_deref(), Some(locator));
    assert_eq!(
        ann.selected_text.as_deref(),
        Some("Initial highlight excerpt")
    );

    // 1. Update note: note is updated, locator and other fields preserved
    let updated = db
        .update_annotation(&ann.id, Some("Updated note content"))
        .expect("update note");
    assert_eq!(updated.id, ann.id);
    assert_eq!(updated.document_id, doc_id);
    assert_eq!(updated.kind, "highlight");
    assert_eq!(updated.note.as_deref(), Some("Updated note content"));
    assert_eq!(updated.locator.as_deref(), Some(locator));
    assert_eq!(
        updated.selected_text.as_deref(),
        Some("Initial highlight excerpt")
    );
    match updated.position {
        ReadingPosition::EpubCfi { cfi, progression } => {
            assert_eq!(cfi, "epubcfi(/6/4!/4/2)");
            assert_eq!(progression, Some(0.1));
        }
        _ => panic!("position must remain epub-cfi"),
    }

    // 2. Clear note: passing None or empty string stores NULL
    let cleared = db
        .update_annotation(&ann.id, Some("   "))
        .expect("clear note");
    assert_eq!(cleared.note, None);
    assert_eq!(cleared.locator.as_deref(), Some(locator));

    // 3. Update non-existent annotation fails
    let bad_update = db.update_annotation("non-existent-ann-id", Some("note"));
    assert!(
        bad_update.is_err(),
        "updating non-existent annotation must return Err"
    );

    // 4. Deleting non-existent annotation fails
    let bad_delete = db.delete_annotation("non-existent-ann-id");
    assert!(
        bad_delete.is_err(),
        "deleting non-existent annotation must return Err"
    );

    // 5. Deleting existing annotation succeeds
    db.delete_annotation(&ann.id)
        .expect("delete existing annotation");
    assert!(db.list_annotations(&doc_id).expect("list").is_empty());

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_schema_v4_tables_and_metadata_persistence() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-meta-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");
    fs::write(temp_dir.join("sample.txt"), b"plain text").expect("write txt");

    let db = LibraryDb::open_in_memory().expect("open db");
    // Verify tables exist in schema v4
    {
        let conn = db.lock().expect("lock");
        let meta_exists = table_exists(&conn, "document_metadata").expect("table check");
        let col_exists = table_exists(&conn, "collections").expect("table check");
        let doc_col_exists = table_exists(&conn, "document_collections").expect("table check");
        assert!(meta_exists, "document_metadata table must exist");
        assert!(col_exists, "collections table must exist");
        assert!(doc_col_exists, "document_collections table must exist");
    }

    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");
    db.scan_root(&root.id).expect("scan root");

    let docs = db.list_documents(Some(&root.id), false).expect("list docs");
    assert_eq!(docs.len(), 1);
    let doc_id = &docs[0].id;

    // Fallback metadata was generated and saved
    let meta = db
        .get_metadata(doc_id)
        .expect("get metadata")
        .expect("meta exists");
    assert_eq!(meta.provenance, MetadataProvenance::Fallback);

    // Update metadata manually
    let custom_meta = DocumentMetadata {
        title: Some("My Custom Document".to_string()),
        authors: vec!["Alice Author".to_string(), "Bob Coauthor".to_string()],
        publisher: Some("Independent Press".to_string()),
        published_date: Some("2026-10-02".to_string()),
        description: Some("A rich description of the document.".to_string()),
        language: Some("en".to_string()),
        identifiers: vec!["isbn:1234567890".to_string()],
        provenance: MetadataProvenance::Embedded,
        thumbnail_path: None,
    };
    let saved = db
        .update_metadata(doc_id, custom_meta.clone())
        .expect("update metadata");
    assert_eq!(saved.title, Some("My Custom Document".to_string()));
    assert_eq!(saved.authors.len(), 2);

    // Verify list_documents reflects updated metadata
    let docs_updated = db.list_documents(Some(&root.id), false).expect("list docs");
    let doc_with_meta = &docs_updated[0];
    assert_eq!(
        doc_with_meta.metadata.as_ref().unwrap().title,
        Some("My Custom Document".to_string())
    );
    assert_eq!(
        doc_with_meta.metadata.as_ref().unwrap().authors,
        vec!["Alice Author", "Bob Coauthor"]
    );

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_collections_crud_and_membership_cascades() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-col-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");
    fs::write(temp_dir.join("doc1.txt"), b"doc 1").expect("write doc1");
    fs::write(temp_dir.join("doc2.txt"), b"doc 2").expect("write doc2");

    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");
    db.scan_root(&root.id).expect("scan root");
    let docs = db.list_documents(Some(&root.id), false).expect("list docs");
    assert_eq!(docs.len(), 2);
    let id1 = &docs[0].id;
    let id2 = &docs[1].id;

    // 1. Create collection
    let c1 = db
        .create_collection("Fiction", Some("Favorite novels"))
        .expect("create c1");
    assert_eq!(c1.name, "Fiction");
    assert_eq!(c1.description.as_deref(), Some("Favorite novels"));
    assert_eq!(c1.document_count, 0);

    // Duplicate name rejection
    assert!(
        db.create_collection("Fiction", None).is_err(),
        "duplicate collection name must fail"
    );
    assert!(
        db.create_collection("fiction", None).is_err(),
        "case-insensitive duplicate name must fail"
    );

    let c2 = db.create_collection("To Read", None).expect("create c2");

    // 2. Add document membership
    db.add_document_to_collection(&c1.id, id1)
        .expect("add id1 to c1");
    db.add_document_to_collection(&c1.id, id2)
        .expect("add id2 to c1");
    db.add_document_to_collection(&c2.id, id1)
        .expect("add id1 to c2");

    // Adding duplicate membership is safe / idempotent
    assert!(db.add_document_to_collection(&c1.id, id1).is_ok());

    // Verify document counts
    let cols = db.list_collections().expect("list cols");
    let c1_listed = cols.iter().find(|c| c.id == c1.id).expect("find c1");
    let c2_listed = cols.iter().find(|c| c.id == c2.id).expect("find c2");
    assert_eq!(c1_listed.document_count, 2);
    assert_eq!(c2_listed.document_count, 1);

    // Verify list_collection_documents
    let c1_docs = db.list_collection_documents(&c1.id).expect("list c1 docs");
    assert_eq!(c1_docs.len(), 2);
    let c2_docs = db.list_collection_documents(&c2.id).expect("list c2 docs");
    assert_eq!(c2_docs.len(), 1);
    assert_eq!(c2_docs[0].id, *id1);

    // Verify list_documents includes collection IDs
    let all_docs = db.list_documents(Some(&root.id), false).expect("list all");
    let d1 = all_docs.iter().find(|d| d.id == *id1).expect("find d1");
    assert_eq!(d1.collections.len(), 2);
    assert!(d1.collections.contains(&c1.id));
    assert!(d1.collections.contains(&c2.id));

    // 3. Rename collection
    let renamed = db
        .rename_collection(&c1.id, "Classic Fiction")
        .expect("rename");
    assert_eq!(renamed.name, "Classic Fiction");
    assert_eq!(renamed.document_count, 2);

    // Rename with duplicate name rejected
    assert!(db.rename_collection(&c2.id, "Classic Fiction").is_err());

    // 4. Remove document from collection
    db.remove_document_from_collection(&c1.id, id2)
        .expect("remove id2 from c1");
    let c1_docs_after = db.list_collection_documents(&c1.id).expect("list c1 docs");
    assert_eq!(c1_docs_after.len(), 1);

    // 5. Delete collection: collection deleted, membership deleted, DOCUMENTS INTACT
    db.delete_collection(&c2.id).expect("delete c2");
    assert_eq!(db.list_collections().expect("list cols").len(), 1);
    // Documents still exist
    let docs_still_here = db.list_documents(Some(&root.id), false).expect("list docs");
    assert_eq!(docs_still_here.len(), 2);

    // 6. Detaching hides root-owned documents without deleting their catalog records.
    db.remove_root(&root.id).expect("detach root");
    assert!(db
        .list_documents(None, false)
        .expect("list active docs")
        .is_empty());
    assert!(db
        .list_documents(Some(&root.id), false)
        .unwrap_err()
        .contains("detached"));
    assert!(db
        .list_collection_documents(&c1.id)
        .expect("list active collection docs")
        .is_empty());
    let c1_after_detach = db
        .list_collections()
        .expect("list collections after detach");
    assert_eq!(c1_after_detach[0].document_count, 0);
    let connection = db.lock().expect("lock database");
    let document_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM documents WHERE root_id = ?1",
            [&root.id],
            |row| row.get(0),
        )
        .expect("count preserved documents");
    let membership_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM document_collections WHERE collection_id = ?1",
            [&c1.id],
            |row| row.get(0),
        )
        .expect("count preserved memberships");
    assert_eq!(document_count, 2);
    assert_eq!(membership_count, 1);

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_document_read_context_preserves_listing_semantics() {
    let temp_dir = std::env::temp_dir().join(format!("clio-read-context-{}", Uuid::new_v4()));
    let primary_dir = temp_dir.join("primary");
    let other_dir = temp_dir.join("other-root");
    fs::create_dir_all(&primary_dir).expect("create primary root");
    fs::create_dir_all(&other_dir).expect("create other root");
    fs::write(primary_dir.join("missing.txt"), b"missing").expect("write missing document");
    fs::write(primary_dir.join("excluded.txt"), b"excluded").expect("write excluded document");
    fs::write(primary_dir.join("rich.txt"), b"rich").expect("write rich document");
    fs::write(primary_dir.join("plain.txt"), b"plain").expect("write plain document");
    fs::write(other_dir.join("other.txt"), b"other").expect("write other document");

    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&primary_dir.to_string_lossy(), Some("Primary"))
        .expect("add primary root");
    let other_root = db
        .add_root(&other_dir.to_string_lossy(), Some("Other"))
        .expect("add other root");
    db.scan_root(&root.id).expect("scan primary root");
    db.scan_root(&other_root.id).expect("scan other root");

    let primary_documents = db
        .list_documents(Some(&root.id), true)
        .expect("list primary documents");
    let document_id = |name: &str| {
        primary_documents
            .iter()
            .find(|document| document.name == name)
            .map(|document| document.id.clone())
            .expect("find document")
    };
    let missing_id = document_id("missing.txt");
    let excluded_id = document_id("excluded.txt");
    let rich_id = document_id("rich.txt");
    let plain_id = document_id("plain.txt");

    let first_collection = db
        .create_collection("First", None)
        .expect("create first collection");
    let second_collection = db
        .create_collection("Second", None)
        .expect("create second collection");
    db.add_document_to_collection(&first_collection.id, &missing_id)
        .expect("add missing document to first collection");
    db.add_document_to_collection(&first_collection.id, &excluded_id)
        .expect("add excluded document to first collection");
    db.add_document_to_collection(&second_collection.id, &excluded_id)
        .expect("add excluded document to second collection");
    db.add_document_to_collection(&first_collection.id, &rich_id)
        .expect("add rich document to first collection");
    db.add_document_to_collection(&second_collection.id, &rich_id)
        .expect("add rich document to second collection");
    db.add_document_to_collection(&first_collection.id, &plain_id)
        .expect("add plain document to first collection");

    fs::remove_file(primary_dir.join("missing.txt")).expect("remove missing document");
    db.scan_root(&root.id).expect("rescan primary root");
    db.remove_document(&excluded_id)
        .expect("exclude document from library");

    let mut rich_metadata = DocumentMetadata::fallback();
    rich_metadata.title = Some("Rich document".to_string());
    rich_metadata.authors = vec!["Author".to_string()];
    db.update_metadata(&rich_id, rich_metadata)
        .expect("restore rich metadata after scan");
    db.set_reading_state(ReadingState {
        document_id: rich_id.clone(),
        position: ReadingPosition::TextScroll { progression: 0.5 },
        last_opened_at: "2026-10-06T10:00:00Z".to_string(),
        updated_at: "2026-10-06T10:00:00Z".to_string(),
    })
    .expect("restore rich reading state after scan");
    {
        let connection = db.lock().expect("lock database");
        connection
            .execute(
                "DELETE FROM document_metadata WHERE document_id = ?1",
                [&plain_id],
            )
            .expect("remove plain metadata after scan");
    }

    let present_documents = db
        .list_documents(Some(&root.id), false)
        .expect("list present primary documents");
    assert!(!present_documents
        .iter()
        .any(|document| document.id == missing_id));
    assert!(!present_documents
        .iter()
        .any(|document| document.id == excluded_id));

    let all_documents = db
        .list_documents(Some(&root.id), true)
        .expect("list all primary documents");
    assert!(all_documents
        .iter()
        .any(|document| document.id == missing_id));
    assert!(!all_documents
        .iter()
        .any(|document| document.id == excluded_id));

    let first_documents = db
        .list_collection_documents(&first_collection.id)
        .expect("list first collection documents");
    assert!(first_documents
        .iter()
        .any(|document| document.id == missing_id));
    assert!(first_documents
        .iter()
        .any(|document| document.id == rich_id));
    assert!(first_documents
        .iter()
        .any(|document| document.id == plain_id));
    assert!(!first_documents
        .iter()
        .any(|document| document.id == excluded_id));

    let second_documents = db
        .list_collection_documents(&second_collection.id)
        .expect("list second collection documents");
    assert!(second_documents
        .iter()
        .any(|document| document.id == rich_id));
    assert!(!second_documents
        .iter()
        .any(|document| document.id == excluded_id));
    assert_eq!(
        db.list_document_collections(&excluded_id)
            .expect("list excluded document collections")
            .len(),
        2
    );

    let rich_from_library = present_documents
        .iter()
        .find(|document| document.id == rich_id)
        .expect("find rich document in library listing");
    let rich_from_collection = first_documents
        .iter()
        .find(|document| document.id == rich_id)
        .expect("find rich document in collection listing");
    for rich_document in [rich_from_library, rich_from_collection] {
        assert_eq!(
            rich_document
                .metadata
                .as_ref()
                .and_then(|meta| meta.title.as_deref()),
            Some("Rich document")
        );
        assert_eq!(
            rich_document
                .metadata
                .as_ref()
                .map(|meta| meta.authors.as_slice()),
            Some(["Author".to_string()].as_slice())
        );
        assert_eq!(rich_document.collections.len(), 2);
        assert!(rich_document.collections.contains(&first_collection.id));
        assert!(rich_document.collections.contains(&second_collection.id));
        assert!(matches!(
            rich_document.reading_state.as_ref().map(|state| &state.position),
            Some(ReadingPosition::TextScroll { progression }) if (*progression - 0.5).abs() < f64::EPSILON
        ));
    }

    let plain_from_library = present_documents
        .iter()
        .find(|document| document.id == plain_id)
        .expect("find plain document in library listing");
    let plain_from_collection = first_documents
        .iter()
        .find(|document| document.id == plain_id)
        .expect("find plain document in collection listing");
    assert!(plain_from_library.metadata.is_none());
    assert!(plain_from_library.reading_state.is_none());
    assert!(plain_from_collection.metadata.is_none());
    assert!(plain_from_collection.reading_state.is_none());

    let other_documents = db
        .list_documents(Some(&other_root.id), false)
        .expect("list other root documents");
    assert_eq!(other_documents.len(), 1);
    assert_eq!(other_documents[0].name, "other.txt");
    assert_eq!(
        db.list_collection_documents(&first_collection.id)
            .unwrap()
            .len(),
        3
    );

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_thumbnail_data_url_generation() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-thumb-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");
    fs::write(temp_dir.join("sample.txt"), b"sample").expect("write sample");

    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");
    db.scan_root(&root.id).expect("scan root");
    let docs = db.list_documents(Some(&root.id), false).expect("list docs");
    let doc_id = &docs[0].id;

    // 1. Initially fallback metadata has no thumbnail -> returns None
    assert_eq!(db.get_thumbnail_data_url(doc_id).unwrap(), None);

    // 2. Put a real dummy thumbnail in thumbnail_dir
    let thumb_filename = format!("{doc_id}.png");
    let thumb_path = db.thumbnail_dir.join(&thumb_filename);
    let png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRtest";
    fs::write(&thumb_path, png_bytes).expect("write thumb");

    // Save metadata with thumbnail path
    let mut meta = DocumentMetadata::fallback();
    meta.thumbnail_path = Some(thumb_filename);
    db.update_metadata(doc_id, meta).expect("save meta");

    // 3. get_thumbnail_data_url returns data:image/png;base64,...
    let data_url = db
        .get_thumbnail_data_url(doc_id)
        .unwrap()
        .expect("data url");
    assert!(data_url.starts_with("data:image/png;base64,"));
    assert!(data_url.len() > 25);

    let outside_path = temp_dir.join("outside.png");
    fs::write(&outside_path, b"outside").expect("write outside thumbnail");
    let mut malicious_meta = DocumentMetadata::fallback();
    malicious_meta.thumbnail_path = Some("../outside.png".to_string());
    db.update_metadata(doc_id, malicious_meta)
        .expect("save malicious thumbnail metadata");
    assert!(db.get_thumbnail_data_url(doc_id).is_err());

    let mut absolute_meta = DocumentMetadata::fallback();
    absolute_meta.thumbnail_path = Some(outside_path.to_string_lossy().into_owned());
    db.update_metadata(doc_id, absolute_meta)
        .expect("save absolute thumbnail metadata");
    assert!(db.get_thumbnail_data_url(doc_id).is_err());
    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_thumbnail_directory_creation_errors_are_propagated() {
    let temp_dir = std::env::temp_dir().join(format!("clio-thumb-dir-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create temp dir");
    let blocker = temp_dir.join("not-a-directory");
    fs::write(&blocker, b"blocker").expect("write blocker");

    let result = LibraryDb::open_with_thumbnail_dir(
        temp_dir.join("library.sqlite3"),
        blocker.join("thumbnails"),
    );
    assert!(result.is_err());

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_live_metadata_extraction_and_collections_workflow() {
    let temp_dir = std::env::temp_dir().join(format!("clio-live-meta-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");

    // 1. Create a real EPUB with metadata and a cover
    let epub_dir = temp_dir.join("epub_build");
    let meta_inf = epub_dir.join("META-INF");
    let oebps = epub_dir.join("OEBPS");
    let oebps_img = oebps.join("images");
    fs::create_dir_all(&meta_inf).expect("create meta-inf");
    fs::create_dir_all(&oebps_img).expect("create oebps img");

    fs::write(epub_dir.join("mimetype"), b"application/epub+zip").expect("write mimetype");
    fs::write(
        meta_inf.join("container.xml"),
        r#"<?xml version="1.0"?>
            <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
              <rootfiles>
                <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
              </rootfiles>
            </container>"#,
    )
    .expect("write container");

    fs::write(
            oebps.join("content.opf"),
            r#"<?xml version="1.0" encoding="utf-8"?>
            <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
              <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                <dc:title>Moby Dick</dc:title>
                <dc:creator>Herman Melville</dc:creator>
                <dc:publisher>Harper &amp; Brothers</dc:publisher>
                <dc:date>1851-10-18</dc:date>
                <dc:language>en</dc:language>
                <dc:description>Captain Ahab quest.</dc:description>
                <dc:identifier>isbn:9780142437247</dc:identifier>
              </metadata>
              <manifest>
                <item id="cov" href="images/cover.png" media-type="image/png" properties="cover-image"/>
              </manifest>
            </package>"#,
        )
        .expect("write opf");

    // Valid 1x1 PNG bytes for cover
    let png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82";
    fs::write(oebps_img.join("cover.png"), png_bytes).expect("write cover png");

    // Package into real test.epub using system zip CLI if available
    let epub_path = temp_dir.join("book.epub");
    let zip_res = Command::new("zip")
        .current_dir(&epub_dir)
        .args(["-0", "-X"])
        .arg(&epub_path)
        .arg("mimetype")
        .output();
    if let Ok(z) = zip_res {
        if z.status.success() {
            let _ = Command::new("zip")
                .current_dir(&epub_dir)
                .args(["-r"])
                .arg(&epub_path)
                .arg("META-INF")
                .arg("OEBPS")
                .output();
        }
    }
    let _ = fs::remove_dir_all(&epub_dir);

    // 2. Create a PDF with Info metadata
    let pdf_path = temp_dir.join("paper.pdf");
    let pdf_bytes = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\n4 0 obj<</Title (Rust Systems)/Author (Ferris)/Subject (Systems Programming)>>endobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \n0000000159 00000 n \ntrailer<</Size 5/Root 1 0 R/Info 4 0 R>>\nstartxref\n260\n%%EOF\n";
    fs::write(&pdf_path, pdf_bytes).expect("write pdf");

    // 3. Create a plain text file (fallback metadata)
    let txt_path = temp_dir.join("notes.txt");
    fs::write(&txt_path, b"Some plain text notes.").expect("write txt");

    // 4. Scan using LibraryDb
    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");
    let scan = db.scan_root(&root.id).expect("scan");
    assert_eq!(scan.missing, 0);
    assert!(scan.scanned >= 2); // pdf + txt (+ epub if zip was installed)

    let docs = db.list_documents(Some(&root.id), false).expect("list docs");
    assert!(docs.len() >= 2);

    // Verify PDF metadata
    let pdf_doc = docs
        .iter()
        .find(|d| d.name == "paper.pdf")
        .expect("find pdf");
    if let Some(meta) = &pdf_doc.metadata {
        if is_tool_installed("pdfinfo") {
            assert_eq!(meta.provenance, MetadataProvenance::Embedded);
            assert_eq!(meta.title.as_deref(), Some("Rust Systems"));
            assert!(meta.authors.contains(&"Ferris".to_string()));
        }
    }

    // Verify TXT metadata (fallback)
    let txt_doc = docs
        .iter()
        .find(|d| d.name == "notes.txt")
        .expect("find txt");
    let txt_meta = txt_doc.metadata.as_ref().expect("txt meta exists");
    assert_eq!(txt_meta.provenance, MetadataProvenance::Fallback);
    assert_eq!(txt_meta.title, None);
    assert!(txt_meta.authors.is_empty());

    // Verify EPUB metadata if epub was created
    if epub_path.exists() && is_tool_installed("unzip") {
        let epub_doc = docs
            .iter()
            .find(|d| d.name == "book.epub")
            .expect("find epub");
        let epub_meta = epub_doc.metadata.as_ref().expect("epub meta exists");
        assert_eq!(epub_meta.provenance, MetadataProvenance::Embedded);
        assert_eq!(epub_meta.title.as_deref(), Some("Moby Dick"));
        assert_eq!(epub_meta.authors, vec!["Herman Melville".to_string()]);
        assert_eq!(epub_meta.publisher.as_deref(), Some("Harper & Brothers"));
        assert_eq!(epub_meta.published_date.as_deref(), Some("1851-10-18"));

        // Verify thumbnail was extracted
        if let Some(thumb_data) = db.get_thumbnail_data_url(&epub_doc.id).expect("get thumb") {
            assert!(thumb_data.starts_with("data:image/"));
        }
    }

    // 5. Test Collection operations on scanned documents
    let col = db
        .create_collection("Important", Some("Key docs"))
        .expect("create col");
    db.add_document_to_collection(&col.id, &pdf_doc.id)
        .expect("add pdf to col");
    db.add_document_to_collection(&col.id, &txt_doc.id)
        .expect("add txt to col");

    let col_docs = db
        .list_collection_documents(&col.id)
        .expect("list col docs");
    assert_eq!(col_docs.len(), 2);

    let pdf_cols = db.list_document_collections(&pdf_doc.id).expect("pdf cols");
    assert!(pdf_cols.contains(&col.id));

    db.remove_document_from_collection(&col.id, &pdf_doc.id)
        .expect("remove pdf");
    assert_eq!(
        db.list_collection_documents(&col.id)
            .expect("list col docs")
            .len(),
        1
    );

    db.delete_collection(&col.id).expect("delete col");
    assert_eq!(
        db.list_documents(Some(&root.id), false)
            .expect("list docs")
            .len(),
        docs.len()
    );

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_format_capabilities() {
    let pdf_caps = FormatId::Pdf.capabilities();
    assert!(pdf_caps.read);
    assert!(pdf_caps.search);
    assert!(pdf_caps.toc);
    assert!(pdf_caps.thumbnail);
    assert!(pdf_caps.convert);

    let epub_caps = FormatId::Epub.capabilities();
    assert!(epub_caps.read);
    assert!(epub_caps.search);
    assert!(epub_caps.toc);
    assert!(epub_caps.thumbnail);

    let txt_caps = FormatId::Txt.capabilities();
    assert!(txt_caps.read);
    assert!(txt_caps.search);
    assert!(!txt_caps.toc);
    assert!(!txt_caps.thumbnail);

    let md_caps = FormatId::Md.capabilities();
    assert!(md_caps.read);
    assert!(md_caps.search);
    assert!(md_caps.toc);

    let docx_caps = FormatId::Docx.capabilities();
    assert!(!docx_caps.read);
    assert!(docx_caps.convert);
    assert!(docx_caps.metadata);

    let odt_caps = FormatId::Odt.capabilities();
    assert!(!odt_caps.read);
    assert!(odt_caps.convert);
    assert!(odt_caps.thumbnail);

    let html_caps = FormatId::Html.capabilities();
    assert!(!html_caps.read);
    assert!(html_caps.convert);

    let rtf_caps = FormatId::Rtf.capabilities();
    assert!(!rtf_caps.read);
    assert!(rtf_caps.convert);
}

#[test]
fn test_text_scroll_reading_position_roundtrip_and_validation() {
    // 1. Validation
    let valid_pos = ReadingPosition::TextScroll { progression: 0.65 };
    assert!(valid_pos.validate().is_ok());

    let invalid_neg = ReadingPosition::TextScroll { progression: -0.1 };
    assert!(invalid_neg.validate().is_err());

    let invalid_over = ReadingPosition::TextScroll { progression: 1.1 };
    assert!(invalid_over.validate().is_err());

    let invalid_nan = ReadingPosition::TextScroll {
        progression: f64::NAN,
    };
    assert!(invalid_nan.validate().is_err());

    // 2. Roundtrip through reading_state table in SQLite
    let temp_dir = std::env::temp_dir().join(format!("clio-pos-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");
    fs::write(temp_dir.join("text.txt"), b"Hello world text").expect("write text");

    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");
    db.scan_root(&root.id).expect("scan");
    let docs = db.list_documents(Some(&root.id), false).expect("list");
    let doc_id = &docs[0].id;

    let state = ReadingState {
        document_id: doc_id.clone(),
        position: valid_pos,
        last_opened_at: "2026-10-02T12:00:00Z".to_string(),
        updated_at: "2026-10-02T12:00:00Z".to_string(),
    };

    db.set_reading_state(state).expect("set reading state");

    let retrieved = db
        .get_reading_state(doc_id)
        .expect("get state")
        .expect("exists");
    match retrieved.position {
        ReadingPosition::TextScroll { progression } => {
            assert!((progression - 0.65).abs() < 1e-6);
        }
        _ => panic!("Expected TextScroll position"),
    }

    // 3. Bookmark creation with text scroll position
    let bookmark = db
        .create_bookmark(
            doc_id,
            ReadingPosition::TextScroll { progression: 0.65 },
            None,
        )
        .expect("create bookmark");
    assert_eq!(bookmark.title.as_deref(), Some("65%"));

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_source_ref_serialization_camel_case() {
    let source = SourceRef::Library {
        root_id: "root-123".to_string(),
        relative_path: "docs/guide.pdf".to_string(),
    };
    let json = serde_json::to_string(&source).expect("serialize source");
    assert!(json.contains("\"kind\":\"library\""));
    assert!(json.contains("\"rootId\":\"root-123\""));
    assert!(json.contains("\"relativePath\":\"docs/guide.pdf\""));
    assert!(!json.contains("root_id"));
    assert!(!json.contains("relative_path"));
}

#[test]
fn test_document_path_resolution_and_validation() {
    let temp_dir = std::env::temp_dir().join(format!("clio-path-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");
    let file_path = temp_dir.join("test.pdf");
    fs::write(&file_path, b"%PDF sample").expect("write file");

    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");
    db.scan_root(&root.id).expect("scan");
    let docs = db.list_documents(Some(&root.id), false).expect("list");
    assert_eq!(docs.len(), 1);

    let resolved_path = db.document_path(&docs[0].id).expect("resolve path");
    assert_eq!(Path::new(&resolved_path), file_path.canonicalize().unwrap());

    // Non-existent document
    assert!(db.document_path("invalid-doc-id").is_err());

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_excluded_document_cannot_be_resolved_by_id() {
    let temp_dir =
        std::env::temp_dir().join(format!("clio-excluded-resolution-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");
    let file_path = temp_dir.join("excluded.pdf");
    fs::write(&file_path, b"%PDF sample").expect("write file");

    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");
    db.scan_root(&root.id).expect("scan");
    let document_id = db.list_documents(Some(&root.id), false).unwrap()[0]
        .id
        .clone();

    db.remove_document(&document_id).expect("exclude document");
    assert!(db.document_path(&document_id).is_err());
    assert!(db
        .open_library_document(&document_id, |_, _| Ok("must-not-mint".to_string()))
        .is_err());

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_non_catalog_document_bookmark_and_annotation_error() {
    let db = LibraryDb::open_in_memory().expect("open db");
    let bm_err = db.create_bookmark(
        "non-catalog-doc",
        ReadingPosition::PdfPage {
            page: 1,
            progression: None,
        },
        None,
    );
    assert!(bm_err.is_err());
    assert!(bm_err
        .unwrap_err()
        .contains("Bookmarks are only supported for catalog documents"));

    let ann_err = db.create_annotation(
        "non-catalog-doc",
        "highlight",
        ReadingPosition::PdfPage {
            page: 1,
            progression: None,
        },
        Some("text"),
        None,
        None,
    );
    assert!(ann_err.is_err());
    assert!(ann_err
        .unwrap_err()
        .contains("Annotations are only supported for catalog documents"));
}

#[test]
fn test_milestone_13_complete_end_to_end_reliability() {
    let temp_dir = std::env::temp_dir().join(format!("clio-m13-e2e-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");
    let db_path = temp_dir.join("library.sqlite3");
    let docs_dir = temp_dir.join("library_files");
    fs::create_dir_all(&docs_dir).expect("create docs dir");

    // 1. Multi-format documents
    let pdf_file = docs_dir.join("sample.pdf");
    let epub_file = docs_dir.join("sample.epub");
    let txt_file = docs_dir.join("sample.txt");
    let md_file = docs_dir.join("sample.md");
    let malformed_epub = docs_dir.join("corrupt.epub");
    let malformed_pdf = docs_dir.join("corrupt.pdf");
    let unsupported_file = docs_dir.join("archive.xyz");

    fs::write(&pdf_file, b"%PDF-1.4 sample content").expect("write pdf");
    fs::write(&epub_file, b"PK\x03\x04 fake epub minimal").expect("write epub");
    fs::write(&txt_file, b"Simple text content").expect("write txt");
    fs::write(&md_file, b"# Markdown Header\n\nContent").expect("write md");
    fs::write(&malformed_epub, b"NOT A ZIP AT ALL").expect("write corrupt epub");
    fs::write(&malformed_pdf, b"NOT A PDF HEADER").expect("write corrupt pdf");
    fs::write(&unsupported_file, b"some unsupported bytes").expect("write xyz");

    // 2. Open DB, add root, scan
    let (doc_pdf_id, doc_epub_id, doc_txt_id, _doc_md_id, root_id) = {
        let db = LibraryDb::open(&db_path).expect("open db session 1");
        let root = db
            .add_root(&docs_dir.to_string_lossy(), Some("E2E Test Root"))
            .expect("add root");
        let scan = db.scan_root(&root.id).expect("scan");
        // 6 supported files found (sample.pdf, sample.epub, sample.txt, sample.md, corrupt.epub, corrupt.pdf); archive.xyz ignored
        assert_eq!(scan.scanned, 6);
        assert_eq!(scan.inserted, 6);
        assert_eq!(scan.missing, 0);

        let docs = db.list_documents(Some(&root.id), false).expect("list docs");
        assert_eq!(docs.len(), 6);

        let p_id = docs
            .iter()
            .find(|d| d.name == "sample.pdf")
            .unwrap()
            .id
            .clone();
        let e_id = docs
            .iter()
            .find(|d| d.name == "sample.epub")
            .unwrap()
            .id
            .clone();
        let t_id = docs
            .iter()
            .find(|d| d.name == "sample.txt")
            .unwrap()
            .id
            .clone();
        let m_id = docs
            .iter()
            .find(|d| d.name == "sample.md")
            .unwrap()
            .id
            .clone();

        // 3. Reading state writes in session 1 for all 3 locators
        db.set_reading_state(ReadingState {
            document_id: p_id.clone(),
            position: ReadingPosition::PdfPage {
                page: 17,
                progression: None,
            },
            last_opened_at: "2026-10-02T16:00:00Z".to_string(),
            updated_at: "2026-10-02T16:00:00Z".to_string(),
        })
        .expect("set pdf state");

        db.set_reading_state(ReadingState {
            document_id: e_id.clone(),
            position: ReadingPosition::EpubCfi {
                cfi: "/6/4[chap1]!/4/2/1:0".to_string(),
                progression: Some(0.42),
            },
            last_opened_at: "2026-10-02T16:05:00Z".to_string(),
            updated_at: "2026-10-02T16:05:00Z".to_string(),
        })
        .expect("set epub state");

        db.set_reading_state(ReadingState {
            document_id: t_id.clone(),
            position: ReadingPosition::TextScroll { progression: 0.78 },
            last_opened_at: "2026-10-02T16:10:00Z".to_string(),
            updated_at: "2026-10-02T16:10:00Z".to_string(),
        })
        .expect("set txt state");
        // 4. Bookmarks and annotations isolated on PDF document
        let bm = db
            .create_bookmark(
                &p_id,
                ReadingPosition::PdfPage {
                    page: 17,
                    progression: None,
                },
                Some("Important Section"),
            )
            .expect("create bookmark");
        assert_eq!(bm.title.as_deref(), Some("Important Section"));

        let ann = db
            .create_annotation(
                &p_id,
                "highlight",
                ReadingPosition::PdfPage {
                    page: 17,
                    progression: None,
                },
                Some("highlighted text"),
                Some("my note"),
                Some("{\"page\":17}"),
            )
            .expect("create annotation");
        assert_eq!(ann.selected_text.as_deref(), Some("highlighted text"));

        // Confirm EPUB and TXT documents have ZERO bookmarks/annotations (isolation)
        assert!(db.list_bookmarks(&e_id).unwrap().is_empty());
        assert!(db.list_bookmarks(&t_id).unwrap().is_empty());
        assert!(db.list_annotations(&e_id).unwrap().is_empty());
        assert!(db.list_annotations(&t_id).unwrap().is_empty());

        // 5. Canonical document path resolution for tools
        let resolved_pdf_path = db.document_path(&p_id).expect("resolve pdf path");
        assert_eq!(
            Path::new(&resolved_pdf_path),
            pdf_file.canonicalize().unwrap()
        );

        (p_id, e_id, t_id, m_id, root.id)
    }; // db session 1 dropped / closed here

    // 6. SIMULATED RESTART: Reopen DB from disk in session 2
    {
        let db2 = LibraryDb::open(&db_path).expect("open db session 2 (after restart)");

        // Verify reading states survived restart exactly
        let p_state = db2
            .get_reading_state(&doc_pdf_id)
            .unwrap()
            .expect("pdf state");
        match p_state.position {
            ReadingPosition::PdfPage { page, .. } => assert_eq!(page, 17),
            _ => panic!("Expected PdfPage"),
        }

        let e_state = db2
            .get_reading_state(&doc_epub_id)
            .unwrap()
            .expect("epub state");
        match e_state.position {
            ReadingPosition::EpubCfi { cfi, progression } => {
                assert_eq!(cfi, "/6/4[chap1]!/4/2/1:0");
                assert!((progression.unwrap() - 0.42).abs() < 1e-6);
            }
            _ => panic!("Expected EpubCfi"),
        }

        let t_state = db2
            .get_reading_state(&doc_txt_id)
            .unwrap()
            .expect("txt state");
        match t_state.position {
            ReadingPosition::TextScroll { progression } => {
                assert!((progression - 0.78).abs() < 1e-6);
            }
            _ => panic!("Expected TextScroll"),
        }

        // Verify bookmarks & annotations survived restart
        let bms = db2.list_bookmarks(&doc_pdf_id).unwrap();
        assert_eq!(bms.len(), 1);
        assert_eq!(bms[0].title.as_deref(), Some("Important Section"));

        let anns = db2.list_annotations(&doc_pdf_id).unwrap();
        assert_eq!(anns.len(), 1);
        assert_eq!(anns[0].note.as_deref(), Some("my note"));

        // 7. Delete source file & rescan -> missing reconciliation
        fs::remove_file(&pdf_file).expect("remove pdf");
        let rescan = db2.scan_root(&root_id).expect("rescan after delete");
        assert_eq!(rescan.scanned, 5);
        assert_eq!(rescan.missing, 1);

        let missing_docs = db2.list_documents(Some(&root_id), true).unwrap();
        let p_doc = missing_docs.iter().find(|d| d.id == doc_pdf_id).unwrap();
        assert_eq!(p_doc.availability, "missing");

        // Document path fails safely when missing
        assert!(db2.document_path(&doc_pdf_id).is_err());
    }

    // Clean up
    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_document_remove_catalog_only_and_batched_reading_states() {
    let temp_dir = std::env::temp_dir().join(format!("clio-doc-remove-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");
    let file_path = temp_dir.join("book.pdf");
    fs::write(&file_path, b"%PDF sample file bytes").expect("write file");

    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), None)
        .expect("add root");
    db.scan_root(&root.id).expect("scan");

    let docs = db.list_documents(Some(&root.id), false).expect("list");
    assert_eq!(docs.len(), 1);
    let doc_id = &docs[0].id;

    // Set reading state
    db.set_reading_state(ReadingState {
        document_id: doc_id.clone(),
        position: ReadingPosition::PdfPage {
            page: 5,
            progression: None,
        },
        last_opened_at: "2026-10-03T10:00:00Z".to_string(),
        updated_at: "2026-10-03T10:00:00Z".to_string(),
    })
    .expect("set state");

    // Verify batched reading_state query
    let all_states = db.list_reading_states().expect("list reading states");
    assert_eq!(all_states.len(), 1);
    assert_eq!(all_states[0].document_id, *doc_id);

    // Verify list_documents returns reading_state attached directly (no N+1)
    let docs_with_state = db.list_documents(Some(&root.id), false).expect("list");
    assert!(docs_with_state[0].reading_state.is_some());
    match docs_with_state[0].reading_state.as_ref().unwrap().position {
        ReadingPosition::PdfPage { page, .. } => assert_eq!(page, 5),
        _ => panic!("Expected PdfPage"),
    }

    // Remove document from catalog
    db.remove_document(doc_id).expect("remove doc from library");

    // Catalog now has 0 documents
    let docs_after = db.list_documents(Some(&root.id), false).expect("list");
    assert_eq!(docs_after.len(), 0);

    // OD-1: Reading state is PRESERVED, not destroyed!
    let states_after = db.list_reading_states().expect("list states");
    assert_eq!(states_after.len(), 1);
    assert_eq!(states_after[0].document_id, *doc_id);

    // OD-1: Rescan does not re-add the excluded document!
    let scan_result = db.scan_root(&root.id).expect("rescan");
    assert_eq!(scan_result.inserted, 0);
    let docs_after_rescan = db.list_documents(Some(&root.id), false).expect("list");
    assert_eq!(docs_after_rescan.len(), 0);
    // CRUCIAL: Underlying filesystem file MUST still exist!
    assert!(file_path.exists());
    assert_eq!(fs::read(&file_path).unwrap(), b"%PDF sample file bytes");

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_relink_document_preserves_state() {
    let temp_dir = std::env::temp_dir().join(format!("clio-relink-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create dir");
    let root_dir = temp_dir.join("library");
    fs::create_dir_all(&root_dir).expect("create root dir");

    let old_file = root_dir.join("old_name.pdf");
    fs::write(&old_file, b"%PDF sample file").expect("write file");

    let db = LibraryDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate");

    let root = db
        .add_root(&root_dir.to_string_lossy(), Some("Books"))
        .expect("add root");
    db.scan_root(&root.id).expect("scan root");

    let docs = db.list_documents(Some(&root.id), false).expect("list");
    assert_eq!(docs.len(), 1);
    let doc_id = docs[0].id.clone();

    // Add reading state to the document
    db.set_reading_state(ReadingState {
        document_id: doc_id.clone(),
        position: ReadingPosition::PdfPage {
            page: 12,
            progression: None,
        },
        last_opened_at: timestamp(),
        updated_at: timestamp(),
    })
    .expect("set reading state");

    // Simulate moving the file externally
    let new_file = root_dir.join("new_renamed.pdf");
    fs::rename(&old_file, &new_file).expect("rename file");

    // Scan marks old document missing
    db.scan_root(&root.id).expect("scan after move");
    let missing_docs = db
        .list_documents(Some(&root.id), true)
        .expect("list missing");
    let missing_target = missing_docs.iter().find(|d| d.id == doc_id).unwrap();
    assert_eq!(missing_target.availability, "missing");

    // Relink the missing document to the new file
    let relinked = db
        .relink_document(&doc_id, &new_file.to_string_lossy())
        .expect("relink document");
    assert_eq!(relinked.id, doc_id);
    assert_eq!(relinked.availability, "present");
    assert_eq!(relinked.relative_path, "new_renamed.pdf");

    // Reading state was preserved across relink
    assert!(relinked.reading_state.is_some());
    match relinked.reading_state.unwrap().position {
        ReadingPosition::PdfPage { page, .. } => assert_eq!(page, 12),
        _ => panic!("Expected PdfPage 12"),
    }

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn relink_rejects_detached_destination_without_mutating_catalog_state() {
    let temp_dir = std::env::temp_dir().join(format!("clio-relink-detached-{}", Uuid::new_v4()));
    let source_root_path = temp_dir.join("source");
    let destination_root_path = temp_dir.join("detached-destination");
    fs::create_dir_all(&source_root_path).expect("create source root");
    fs::create_dir_all(&destination_root_path).expect("create destination root");
    let old_file = source_root_path.join("old.pdf");
    let destination_file = destination_root_path.join("destination.pdf");
    fs::write(&old_file, b"%PDF source").expect("write source file");
    fs::write(&destination_file, b"%PDF destination").expect("write destination file");

    let db = LibraryDb::open_in_memory().expect("open database");
    let source_root = db
        .add_root(&source_root_path.to_string_lossy(), None)
        .expect("add source root");
    let destination_root = db
        .add_root(&destination_root_path.to_string_lossy(), None)
        .expect("add destination root");
    db.scan_root(&source_root.id).expect("scan source");
    db.scan_root(&destination_root.id)
        .expect("scan destination");
    let document_id = db
        .list_documents(Some(&source_root.id), false)
        .expect("list source")
        .into_iter()
        .next()
        .expect("source document")
        .id;
    db.set_reading_state(ReadingState {
        document_id: document_id.clone(),
        position: ReadingPosition::PdfPage {
            page: 7,
            progression: None,
        },
        last_opened_at: timestamp(),
        updated_at: timestamp(),
    })
    .expect("set reading state");

    fs::remove_file(&old_file).expect("remove old source file");
    db.scan_root(&source_root.id).expect("mark source missing");
    db.remove_document(&document_id)
        .expect("exclude source document");
    db.remove_root(&destination_root.id)
        .expect("detach destination root");

    let before: (String, String, String, Option<String>) = db
        .lock()
        .expect("lock database")
        .query_row(
            "SELECT root_id, relative_path, availability, excluded_at FROM documents WHERE id = ?1",
            [&document_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read source state before failed relink");
    let reading_state_before = db
        .get_reading_state(&document_id)
        .expect("read state")
        .expect("reading state exists");

    let error = db
        .relink_document(&document_id, &destination_file.to_string_lossy())
        .expect_err("detached destination must be rejected");
    assert!(error.contains("not inside any Library folder"));

    let after: (String, String, String, Option<String>) = db
        .lock()
        .expect("lock database")
        .query_row(
            "SELECT root_id, relative_path, availability, excluded_at FROM documents WHERE id = ?1",
            [&document_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read source state after failed relink");
    assert_eq!(after, before);
    let reading_state_after = db
        .get_reading_state(&document_id)
        .expect("read state after failed relink")
        .expect("reading state remains");
    assert_eq!(
        reading_state_after.document_id,
        reading_state_before.document_id
    );
    assert_eq!(
        reading_state_after.last_opened_at,
        reading_state_before.last_opened_at
    );
    assert_eq!(
        reading_state_after.updated_at,
        reading_state_before.updated_at
    );
    match reading_state_after.position {
        ReadingPosition::PdfPage { page, .. } => assert_eq!(page, 7),
        _ => panic!("reading position changed after failed relink"),
    }

    fs::remove_dir_all(temp_dir).expect("remove temporary directory");
}
#[test]
fn relink_rejects_root_rebound_after_destination_selection_without_mutation() {
    let temp_dir = std::env::temp_dir().join(format!("clio-relink-stale-root-{}", Uuid::new_v4()));
    let source_path = temp_dir.join("source");
    let old_destination_path = temp_dir.join("old-destination");
    let new_destination_path = temp_dir.join("new-destination");
    fs::create_dir_all(&source_path).expect("create source root");
    fs::create_dir_all(&old_destination_path).expect("create old destination root");
    let source_file = source_path.join("source.pdf");
    let old_destination_file = old_destination_path.join("target.pdf");
    fs::write(&source_file, b"%PDF source").expect("write source");
    fs::write(&old_destination_file, b"%PDF old target").expect("write old target");

    let db = LibraryDb::open_in_memory().expect("open database");
    let source_root = db
        .add_root(&source_path.to_string_lossy(), None)
        .expect("add source root");
    let destination_root = db
        .add_root(&old_destination_path.to_string_lossy(), None)
        .expect("add destination root");
    db.scan_root(&source_root.id).expect("scan source root");
    let document_id = db
        .list_documents(Some(&source_root.id), false)
        .expect("list source documents")
        .into_iter()
        .next()
        .expect("source document")
        .id;
    db.set_reading_state(ReadingState {
        document_id: document_id.clone(),
        position: ReadingPosition::PdfPage {
            page: 9,
            progression: None,
        },
        last_opened_at: timestamp(),
        updated_at: timestamp(),
    })
    .expect("set reading state");
    let collection = db
        .create_collection("Relink state", None)
        .expect("create collection");
    db.add_document_to_collection(&collection.id, &document_id)
        .expect("add collection membership");
    db.create_bookmark(
        &document_id,
        ReadingPosition::PdfPage {
            page: 9,
            progression: None,
        },
        Some("Keep this bookmark"),
    )
    .expect("create bookmark");
    db.remove_document(&document_id)
        .expect("exclude source document");

    let before: (String, String, String, Option<String>) = db
        .lock()
        .expect("lock database")
        .query_row(
            "SELECT root_id, relative_path, availability, excluded_at FROM documents WHERE id = ?1",
            [&document_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read source document before Relink");
    let reading_state_before = db
        .get_reading_state(&document_id)
        .expect("read reading state")
        .expect("reading state exists");
    let bookmark_ids_before: Vec<String> = db
        .list_bookmarks(&document_id)
        .expect("list bookmarks")
        .into_iter()
        .map(|bookmark| bookmark.id)
        .collect();
    let collections_before = db
        .list_document_collections(&document_id)
        .expect("list memberships");

    let error = db
        .relink_document_with_hook(
            &document_id,
            &old_destination_file.to_string_lossy(),
            || {
                db.remove_root(&destination_root.id)
                    .expect("detach selected destination");
                fs::remove_dir_all(&old_destination_path).expect("remove old destination");
                fs::create_dir_all(&new_destination_path).expect("create rebound destination");
                fs::write(new_destination_path.join("target.pdf"), b"%PDF replacement")
                    .expect("write replacement target");
                let preview = db
                    .preview_locate_root(
                        &destination_root.id,
                        &new_destination_path.to_string_lossy(),
                    )
                    .expect("preview destination rebind");
                db.confirm_locate_root(&preview)
                    .expect("rebind destination root");
            },
        )
        .expect_err("stale destination mapping must be rejected");
    assert!(error.contains("root changed while relinking"));
    assert_eq!(
        db.list_roots()
            .expect("list roots after rejected Relink")
            .into_iter()
            .find(|root| root.id == destination_root.id)
            .expect("destination root remains")
            .attachment_state,
        "attached"
    );
    let after: (String, String, String, Option<String>) = db
        .lock()
        .expect("lock database")
        .query_row(
            "SELECT root_id, relative_path, availability, excluded_at FROM documents WHERE id = ?1",
            [&document_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read source document after rejected Relink");
    assert_eq!(after, before);
    let reading_state_after = db
        .get_reading_state(&document_id)
        .expect("read reading state after Relink")
        .expect("reading state remains");
    assert_eq!(
        reading_state_after.last_opened_at,
        reading_state_before.last_opened_at
    );
    assert_eq!(
        reading_state_after.updated_at,
        reading_state_before.updated_at
    );
    let bookmark_ids_after: Vec<String> = db
        .list_bookmarks(&document_id)
        .expect("list bookmarks after Relink")
        .into_iter()
        .map(|bookmark| bookmark.id)
        .collect();
    assert_eq!(bookmark_ids_after, bookmark_ids_before);
    assert_eq!(
        db.list_document_collections(&document_id)
            .expect("list memberships after Relink"),
        collections_before
    );

    fs::remove_dir_all(temp_dir).expect("remove temporary directory");
}
#[test]
fn deepest_root_skips_not_found_roots_but_rejects_other_canonicalization_errors() {
    let temp_dir = std::env::temp_dir().join(format!("clio-root-canonicalize-{}", Uuid::new_v4()));
    let source_path = temp_dir.join("source");
    let library_path = temp_dir.join("Library");
    let missing_path = temp_dir.join("missing-root");
    fs::create_dir_all(&source_path).expect("create source root");
    fs::create_dir_all(library_path.join("Nested")).expect("create nested library root");
    fs::create_dir_all(&missing_path).expect("create missing root");
    let source_file = source_path.join("source.pdf");
    let target_file = library_path.join("Nested").join("target.pdf");
    fs::write(&source_file, b"%PDF source").expect("write source");
    fs::write(&target_file, b"%PDF target").expect("write target");

    let db = LibraryDb::open_in_memory().expect("open database");
    let source_root = db
        .add_root(&source_path.to_string_lossy(), None)
        .expect("add source root");
    let library_root = db
        .add_root(&library_path.to_string_lossy(), None)
        .expect("add library root");
    let missing_root = db
        .add_root(&missing_path.to_string_lossy(), None)
        .expect("add root that will become missing");
    db.scan_root(&source_root.id).expect("scan source");
    let document_id = db
        .list_documents(Some(&source_root.id), false)
        .expect("list source")
        .into_iter()
        .next()
        .expect("source document")
        .id;
    fs::remove_dir_all(&missing_path).expect("make attached root missing");

    let relinked = db
        .relink_document(&document_id, &target_file.to_string_lossy())
        .expect("NotFound root is not a matching active directory");
    assert_eq!(relinked.root_id, library_root.id);
    assert_eq!(relinked.relative_path, "Nested/target.pdf");
    assert!(db
        .list_roots()
        .expect("list roots")
        .iter()
        .any(|root| root.id == missing_root.id && root.attachment_state == "attached"));

    let invalid_root_id = Uuid::new_v4().to_string();
    db.lock()
        .expect("lock database")
        .execute(
            "INSERT INTO library_roots
                 (id, label, locator_kind, locator_value, attachment_state,
                  last_scanned_at, created_at, updated_at)
             VALUES (?1, 'Invalid locator', 'filesystem-directory', ?2, 'attached', NULL, ?3, ?3)",
            params![invalid_root_id, "invalid\0root", timestamp()],
        )
        .expect("insert invalid attached locator");
    let before: (String, String, String, Option<String>) = db
        .lock()
        .expect("lock database")
        .query_row(
            "SELECT root_id, relative_path, availability, excluded_at FROM documents WHERE id = ?1",
            [&document_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read document before invalid-root Relink");

    let error = db
        .relink_document(&document_id, &target_file.to_string_lossy())
        .expect_err("uncomparable attached root must not be silently skipped");
    assert!(error.contains("Could not validate attached library root"));
    let after: (String, String, String, Option<String>) = db
        .lock()
        .expect("lock database")
        .query_row(
            "SELECT root_id, relative_path, availability, excluded_at FROM documents WHERE id = ?1",
            [&document_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read document after invalid-root Relink");
    assert_eq!(after, before);

    fs::remove_dir_all(temp_dir).expect("remove temporary directory");
}

fn insert_root_for_ownership_test(
    db: &LibraryDb,
    path: &Path,
    label: &str,
    attachment_state: &str,
) -> String {
    let root_id = Uuid::new_v4().to_string();
    let locator = fs::canonicalize(path).expect("canonicalize legacy root");
    db.lock()
        .expect("lock database")
        .execute(
            "INSERT INTO library_roots
                 (id, label, locator_kind, locator_value, attachment_state,
                  last_scanned_at, created_at, updated_at)
             VALUES (?1, ?2, 'filesystem-directory', ?3, ?4, NULL, ?5, ?5)",
            params![
                root_id,
                label,
                locator.to_string_lossy(),
                attachment_state,
                timestamp()
            ],
        )
        .expect("insert legacy root");
    root_id
}

#[test]
fn external_add_uses_deepest_attached_root_and_preserves_legacy_records() {
    let temp_dir = std::env::temp_dir().join(format!("clio-external-deepest-{}", Uuid::new_v4()));
    let outer_path = temp_dir.join("Library");
    let nested_path = outer_path.join("Inner");
    let sibling_path = temp_dir.join("Library-copy");
    fs::create_dir_all(&nested_path).expect("create nested directory");
    fs::create_dir_all(&sibling_path).expect("create sibling directory");
    let nested_file = nested_path.join("nested.pdf");
    let detached_nested_file = nested_path.join("after-detach.pdf");
    let sibling_file = sibling_path.join("sibling.pdf");
    fs::write(&nested_file, b"%PDF nested").expect("write nested document");
    fs::write(&sibling_file, b"%PDF sibling").expect("write sibling document");

    let db = LibraryDb::open_in_memory().expect("open database");
    let outer_root = db
        .add_root(&outer_path.to_string_lossy(), Some("Outer"))
        .expect("add outer root");
    db.scan_root(&outer_root.id).expect("scan outer root");
    let original_outer_document = db
        .list_documents(Some(&outer_root.id), false)
        .expect("list outer documents")
        .into_iter()
        .find(|document| document.name == "nested.pdf")
        .expect("outer scan indexed nested file");
    let nested_root_id =
        insert_root_for_ownership_test(&db, &nested_path, "Legacy nested", "attached");

    let nested_document = db
        .add_external_document_to_library(&nested_file.to_string_lossy())
        .expect("add document through nested root");
    assert_eq!(nested_document.root_id, nested_root_id);
    assert_ne!(nested_document.id, original_outer_document.id);
    let outer_document_after = db
        .list_documents(Some(&outer_root.id), false)
        .expect("list preserved outer documents")
        .into_iter()
        .find(|document| document.id == original_outer_document.id)
        .expect("legacy outer document remains");
    assert_eq!(outer_document_after.root_id, outer_root.id);
    let roots = db.list_roots().expect("list overlapping roots");
    assert!(roots.iter().any(|root| root.id == outer_root.id));
    assert!(roots.iter().any(|root| root.id == nested_root_id));

    db.remove_root(&nested_root_id)
        .expect("detach deepest legacy root");
    fs::write(&detached_nested_file, b"%PDF parent-owned").expect("write after-detach file");
    let parent_owned = db
        .add_external_document_to_library(&detached_nested_file.to_string_lossy())
        .expect("use attached ancestor when deeper root is detached");
    assert_eq!(parent_owned.root_id, outer_root.id);
    let detached_root = db
        .list_roots()
        .expect("list roots after detach")
        .into_iter()
        .find(|root| root.id == nested_root_id)
        .expect("detached legacy root remains");
    assert_eq!(detached_root.attachment_state, "detached");

    let sibling_document = db
        .add_external_document_to_library(&sibling_file.to_string_lossy())
        .expect("add sibling path as its own root");
    assert_ne!(sibling_document.root_id, outer_root.id);
    let sibling_root = db
        .raw_roots()
        .expect("list stored roots")
        .into_iter()
        .find(|root| root.id == sibling_document.root_id)
        .expect("sibling root exists");
    assert_eq!(
        fs::canonicalize(&sibling_root.locator_value).expect("canonical sibling root"),
        fs::canonicalize(&sibling_path).expect("canonical sibling directory")
    );

    fs::remove_dir_all(temp_dir).expect("remove temporary directory");
}

#[test]
fn relink_uses_deepest_attached_root_and_rejects_sibling_prefix() {
    let temp_dir = std::env::temp_dir().join(format!("clio-relink-deepest-{}", Uuid::new_v4()));
    let outer_path = temp_dir.join("Library");
    let nested_path = outer_path.join("Inner");
    let source_path = temp_dir.join("Source");
    let detached_nested_path = outer_path.join("Detached-Inner");
    let sibling_path = temp_dir.join("Library-copy");
    fs::create_dir_all(&nested_path).expect("create nested directory");
    fs::create_dir_all(&source_path).expect("create source directory");
    fs::create_dir_all(&detached_nested_path).expect("create detached nested directory");
    fs::create_dir_all(&sibling_path).expect("create sibling directory");
    let nested_file = nested_path.join("target.pdf");
    let original_file = source_path.join("old.pdf");
    fs::write(&nested_file, b"%PDF nested target").expect("write nested target");
    fs::write(&original_file, b"%PDF original").expect("write source file");

    let db = LibraryDb::open_in_memory().expect("open database");
    let outer_root = db
        .add_root(&outer_path.to_string_lossy(), Some("Outer"))
        .expect("add outer root");
    let source_root = db
        .add_root(&source_path.to_string_lossy(), Some("Source"))
        .expect("add source root");
    db.scan_root(&outer_root.id).expect("scan outer root");
    db.scan_root(&source_root.id).expect("scan source root");
    let outer_document = db
        .list_documents(Some(&outer_root.id), false)
        .expect("list outer documents")
        .into_iter()
        .find(|document| document.name == "target.pdf")
        .expect("outer scan indexed target");
    let document_id = db
        .list_documents(Some(&source_root.id), false)
        .expect("list source documents")[0]
        .id
        .clone();
    let nested_root_id =
        insert_root_for_ownership_test(&db, &nested_path, "Legacy nested", "attached");

    let relinked = db
        .relink_document(&document_id, &nested_file.to_string_lossy())
        .expect("relink into deepest attached root");
    assert_eq!(relinked.root_id, nested_root_id);
    assert_eq!(relinked.relative_path, "target.pdf");
    let outer_document_after = db
        .list_documents(Some(&outer_root.id), false)
        .expect("list outer after relink")
        .into_iter()
        .find(|document| document.id == outer_document.id)
        .expect("existing outer record is not reassigned or merged");
    assert_eq!(outer_document_after.root_id, outer_root.id);

    let detached_file = detached_nested_path.join("target.pdf");
    fs::write(&detached_file, b"%PDF detached target").expect("write detached target");
    let detached_root_id =
        insert_root_for_ownership_test(&db, &detached_nested_path, "Detached nested", "detached");
    let relinked_to_parent = db
        .relink_document(&document_id, &detached_file.to_string_lossy())
        .expect("detached root must not be selected over attached ancestor");
    assert_eq!(relinked_to_parent.root_id, outer_root.id);

    let sibling_file = sibling_path.join("target.pdf");
    fs::write(&sibling_file, b"%PDF sibling target").expect("write sibling target");
    let before_failed_relink: (String, String, Option<String>) = db
        .lock()
        .expect("lock database")
        .query_row(
            "SELECT root_id, relative_path, excluded_at FROM documents WHERE id = ?1",
            [&document_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read state before sibling relink");
    assert!(db
        .relink_document(&document_id, &sibling_file.to_string_lossy())
        .unwrap_err()
        .contains("not inside any Library folder"));
    let after_failed_relink: (String, String, Option<String>) = db
        .lock()
        .expect("lock database")
        .query_row(
            "SELECT root_id, relative_path, excluded_at FROM documents WHERE id = ?1",
            [&document_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read state after sibling relink");
    assert_eq!(after_failed_relink, before_failed_relink);

    let roots = db.list_roots().expect("list legacy roots");
    assert!(roots.iter().any(|root| root.id == outer_root.id));
    assert!(roots.iter().any(|root| root.id == nested_root_id));
    assert!(roots.iter().any(|root| root.id == detached_root_id));
    assert_eq!(
        roots
            .iter()
            .find(|root| root.id == detached_root_id)
            .expect("detached root record remains")
            .attachment_state,
        "detached"
    );

    fs::remove_dir_all(temp_dir).expect("remove temporary directory");
}

#[test]
fn successful_relink_preserves_exclusion_and_non_exclusion_state() {
    let temp_dir = std::env::temp_dir().join(format!("clio-relink-excluded-{}", Uuid::new_v4()));
    let root_path = temp_dir.join("Library");
    fs::create_dir_all(&root_path).expect("create root");
    let old_file = root_path.join("old.pdf");
    let new_file = root_path.join("renamed.pdf");
    fs::write(&old_file, b"%PDF original").expect("write original");

    let db = LibraryDb::open_in_memory().expect("open database");
    let root = db
        .add_root(&root_path.to_string_lossy(), None)
        .expect("add root");
    db.scan_root(&root.id).expect("scan root");
    let document_id = db
        .list_documents(Some(&root.id), false)
        .expect("list initial document")
        .into_iter()
        .next()
        .expect("initial document")
        .id;
    db.set_reading_state(ReadingState {
        document_id: document_id.clone(),
        position: ReadingPosition::PdfPage {
            page: 4,
            progression: None,
        },
        last_opened_at: timestamp(),
        updated_at: timestamp(),
    })
    .expect("set reading state");

    fs::rename(&old_file, &new_file).expect("rename document");
    db.scan_root(&root.id).expect("record moved document");
    let non_excluded = db
        .relink_document(&document_id, &new_file.to_string_lossy())
        .expect("relink non-excluded document");
    assert_eq!(non_excluded.id, document_id);
    let excluded_before: Option<String> = db
        .lock()
        .expect("lock database")
        .query_row(
            "SELECT excluded_at FROM documents WHERE id = ?1",
            [&document_id],
            |row| row.get(0),
        )
        .expect("read non-excluded state");
    assert_eq!(excluded_before, None);

    db.remove_document(&document_id)
        .expect("exclude document before second move");
    let excluded_at_before: String = db
        .lock()
        .expect("lock database")
        .query_row(
            "SELECT excluded_at FROM documents WHERE id = ?1",
            [&document_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .expect("read excluded state")
        .expect("exclusion timestamp exists");
    let second_file = root_path.join("second-name.pdf");
    fs::rename(&new_file, &second_file).expect("rename excluded document");
    db.scan_root(&root.id)
        .expect("scan moved excluded document");

    let relinked_excluded = db
        .relink_document(&document_id, &second_file.to_string_lossy())
        .expect("relink excluded document");
    assert_eq!(relinked_excluded.id, document_id);
    assert_eq!(relinked_excluded.relative_path, "second-name.pdf");
    let excluded_at_after: Option<String> = db
        .lock()
        .expect("lock database")
        .query_row(
            "SELECT excluded_at FROM documents WHERE id = ?1",
            [&document_id],
            |row| row.get(0),
        )
        .expect("read exclusion after relink");
    assert_eq!(
        excluded_at_after.as_deref(),
        Some(excluded_at_before.as_str())
    );
    assert!(db
        .list_documents(None, true)
        .expect("list normal active documents")
        .iter()
        .all(|document| document.id != document_id));
    assert_eq!(
        db.get_reading_state(&document_id)
            .expect("get preserved reading state")
            .expect("reading state remains")
            .document_id,
        document_id
    );

    fs::remove_dir_all(temp_dir).expect("remove temporary directory");
}

fn migration_snapshot(connection: &rusqlite::Connection, query: &str) -> Vec<String> {
    let mut statement = connection
        .prepare(query)
        .expect("prepare migration snapshot");
    statement
        .query_map([], |row| row.get(0))
        .expect("query migration snapshot")
        .map(|row| row.expect("read migration snapshot row"))
        .collect()
}

fn downgrade_roots_to_v5(connection: &rusqlite::Connection) {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = OFF;
             BEGIN IMMEDIATE;
             CREATE TABLE library_roots_v5 (
                 id TEXT PRIMARY KEY NOT NULL,
                 label TEXT NOT NULL,
                 locator_kind TEXT NOT NULL,
                 locator_value TEXT NOT NULL UNIQUE,
                 last_scanned_at TEXT,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             INSERT INTO library_roots_v5
                 (id, label, locator_kind, locator_value, last_scanned_at, created_at, updated_at)
             SELECT id, label, locator_kind, locator_value, last_scanned_at, created_at, updated_at
             FROM library_roots;
             DROP TABLE library_roots;
             ALTER TABLE library_roots_v5 RENAME TO library_roots;
             PRAGMA user_version = 5;
             COMMIT;
             PRAGMA foreign_keys = ON;",
        )
        .expect("downgrade roots to v5");
}

#[test]
fn test_schema_v6_migration_preserves_populated_catalog() {
    let temp_dir = std::env::temp_dir().join(format!("clio-schema-v6-{}", Uuid::new_v4()));
    let root_dir = temp_dir.join("books");
    let nested_dir = root_dir.join("fiction");
    let missing_dir = temp_dir.join("missing-root");
    let db_path = temp_dir.join("library.sqlite3");
    fs::create_dir_all(&nested_dir).expect("create nested root");
    fs::create_dir_all(&missing_dir).expect("create missing root");
    fs::write(root_dir.join("present.txt"), b"present").expect("write present document");
    fs::write(root_dir.join("missing.txt"), b"missing").expect("write missing document");
    fs::write(root_dir.join("excluded.txt"), b"excluded").expect("write excluded document");
    fs::write(nested_dir.join("nested.txt"), b"nested").expect("write nested document");

    let db = LibraryDb::open(&db_path).expect("open database");
    let root = db
        .add_root(&root_dir.to_string_lossy(), Some("Books"))
        .expect("add primary root");
    let overlapping_root_id = Uuid::new_v4().to_string();
    let overlapping_locator = canonical_directory(&nested_dir.to_string_lossy())
        .unwrap()
        .to_string_lossy()
        .into_owned();
    {
        let connection = db.lock().expect("lock database");
        connection
            .execute(
                "INSERT INTO library_roots
                     (id, label, locator_kind, locator_value, attachment_state,
                      last_scanned_at, created_at, updated_at)
                 VALUES (?1, 'Fiction', 'filesystem-directory', ?2, 'attached', NULL, ?3, ?3)",
                params![overlapping_root_id, overlapping_locator, timestamp()],
            )
            .expect("insert legacy overlapping root directly");
    }
    let missing_root = db
        .add_root(&missing_dir.to_string_lossy(), Some("Missing"))
        .expect("add missing root");
    fs::remove_dir_all(&missing_dir).expect("remove missing root directory");

    db.scan_root(&root.id).expect("scan primary root");
    db.scan_root(&overlapping_root_id)
        .expect("scan overlapping root");

    let primary_documents = db
        .list_documents(Some(&root.id), true)
        .expect("list primary documents");
    let present_id = primary_documents
        .iter()
        .find(|document| document.name == "present.txt")
        .expect("find present document")
        .id
        .clone();
    let missing_id = primary_documents
        .iter()
        .find(|document| document.name == "missing.txt")
        .expect("find missing document")
        .id
        .clone();
    let excluded_id = primary_documents
        .iter()
        .find(|document| document.name == "excluded.txt")
        .expect("find excluded document")
        .id
        .clone();

    fs::remove_file(root_dir.join("missing.txt")).expect("remove document");
    db.scan_root(&root.id).expect("scan missing document");
    db.remove_document(&excluded_id).expect("exclude document");

    db.set_reading_state(ReadingState {
        document_id: present_id.clone(),
        position: ReadingPosition::TextScroll { progression: 0.42 },
        last_opened_at: "2026-10-06T12:00:00Z".to_string(),
        updated_at: "2026-10-06T12:01:00Z".to_string(),
    })
    .expect("set reading state");
    db.create_bookmark(
        &present_id,
        ReadingPosition::TextScroll { progression: 0.5 },
        Some("Important"),
    )
    .expect("create bookmark");
    db.create_annotation(
        &present_id,
        "highlight",
        ReadingPosition::TextScroll { progression: 0.55 },
        Some("Selected text"),
        Some("Note"),
        Some(r#"{"kind":"text-range","start":10,"end":20}"#),
    )
    .expect("create annotation");
    db.update_metadata(
        &present_id,
        DocumentMetadata {
            title: Some("Preserved title".to_string()),
            authors: vec!["Author".to_string()],
            publisher: Some("Publisher".to_string()),
            published_date: Some("2026-10-06".to_string()),
            description: Some("Description".to_string()),
            language: Some("en".to_string()),
            identifiers: vec!["id:123".to_string()],
            provenance: MetadataProvenance::Embedded,
            thumbnail_path: None,
        },
    )
    .expect("update metadata");
    let collection = db
        .create_collection("Preserved", Some("Collection"))
        .expect("create collection");
    db.add_document_to_collection(&collection.id, &present_id)
        .expect("add present membership");
    db.add_document_to_collection(&collection.id, &missing_id)
        .expect("add missing membership");

    let snapshot_queries = [
        "SELECT quote(id) || '|' || quote(label) || '|' || quote(locator_kind) || '|' || quote(locator_value) || '|' || coalesce(quote(last_scanned_at), 'NULL') || '|' || quote(created_at) || '|' || quote(updated_at) FROM library_roots ORDER BY id",
        "SELECT quote(id) || '|' || quote(root_id) || '|' || quote(relative_path) || '|' || quote(name) || '|' || quote(format_id) || '|' || quote(size_bytes) || '|' || quote(first_seen_at) || '|' || quote(updated_at) || '|' || quote(last_seen_scan) || '|' || quote(availability) || '|' || coalesce(quote(excluded_at), 'NULL') FROM documents ORDER BY id",
        "SELECT quote(document_id) || '|' || quote(position_kind) || '|' || coalesce(quote(page), 'NULL') || '|' || coalesce(quote(cfi), 'NULL') || '|' || coalesce(quote(progression), 'NULL') || '|' || quote(last_opened_at) || '|' || quote(updated_at) FROM reading_state ORDER BY document_id",
        "SELECT quote(id) || '|' || quote(document_id) || '|' || quote(position_kind) || '|' || coalesce(quote(page), 'NULL') || '|' || coalesce(quote(cfi), 'NULL') || '|' || coalesce(quote(progression), 'NULL') || '|' || coalesce(quote(title), 'NULL') || '|' || quote(created_at) || '|' || quote(updated_at) FROM bookmarks ORDER BY id",
        "SELECT quote(id) || '|' || quote(document_id) || '|' || quote(kind) || '|' || quote(position_kind) || '|' || coalesce(quote(page), 'NULL') || '|' || coalesce(quote(cfi), 'NULL') || '|' || coalesce(quote(progression), 'NULL') || '|' || coalesce(quote(selected_text), 'NULL') || '|' || coalesce(quote(note), 'NULL') || '|' || quote(created_at) || '|' || quote(updated_at) || '|' || coalesce(quote(locator), 'NULL') FROM annotations ORDER BY id",
        "SELECT quote(document_id) || '|' || coalesce(quote(title), 'NULL') || '|' || quote(authors) || '|' || coalesce(quote(publisher), 'NULL') || '|' || coalesce(quote(published_date), 'NULL') || '|' || coalesce(quote(description), 'NULL') || '|' || coalesce(quote(language), 'NULL') || '|' || quote(identifiers) || '|' || quote(provenance) || '|' || coalesce(quote(thumbnail_path), 'NULL') || '|' || quote(updated_at) FROM document_metadata ORDER BY document_id",
        "SELECT quote(id) || '|' || quote(name) || '|' || coalesce(quote(description), 'NULL') || '|' || quote(created_at) || '|' || quote(updated_at) FROM collections ORDER BY id",
        "SELECT quote(collection_id) || '|' || quote(document_id) || '|' || quote(added_at) FROM document_collections ORDER BY collection_id, document_id",
    ];
    let before: Vec<Vec<String>> = {
        let connection = db.lock().expect("lock database");
        snapshot_queries
            .iter()
            .map(|query| migration_snapshot(&connection, query))
            .collect()
    };

    {
        let connection = db.lock().expect("lock database");
        downgrade_roots_to_v5(&connection);
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read downgraded version");
        assert_eq!(version, 5);
    }
    drop(db);

    let migrated = LibraryDb::open(&db_path).expect("migrate database");
    let connection = migrated.lock().expect("lock migrated database");
    let after: Vec<Vec<String>> = snapshot_queries
        .iter()
        .map(|query| migration_snapshot(&connection, query))
        .collect();
    assert_eq!(before, after, "catalog rows changed during migration");

    let attachment_states: Vec<String> = migration_snapshot(
        &connection,
        "SELECT attachment_state FROM library_roots ORDER BY id",
    );
    assert!(
        attachment_states.iter().all(|state| state == "attached"),
        "migrated roots must be attached"
    );
    let root_ids: Vec<String> =
        migration_snapshot(&connection, "SELECT id FROM library_roots ORDER BY id");
    assert!(root_ids.contains(&root.id));
    assert!(root_ids.contains(&overlapping_root_id));
    assert!(root_ids.contains(&missing_root.id));

    let foreign_keys: i64 = connection
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .expect("read foreign_keys");
    assert_eq!(foreign_keys, 1);
    assert!(migration_snapshot(&connection, "PRAGMA foreign_key_check").is_empty());
    assert_eq!(
        connection
            .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .expect("run integrity_check"),
        "ok"
    );
    let attached_index: Option<String> = connection
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_library_roots_attached_locator'",
            [],
            |row| row.get(0),
        )
        .optional()
        .expect("find attached root index");
    assert_eq!(
        attached_index.as_deref(),
        Some("idx_library_roots_attached_locator")
    );

    drop(connection);
    drop(migrated);
    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_schema_v6_migration_rolls_back_on_attached_duplicate() {
    let temp_dir = std::env::temp_dir().join(format!("clio-schema-v6-fail-{}", Uuid::new_v4()));
    let db_path = temp_dir.join("library.sqlite3");
    fs::create_dir_all(&temp_dir).expect("create migration directory");
    let db = LibraryDb::open(&db_path).expect("open database");
    let first_path = temp_dir.join("first");
    let second_path = temp_dir.join("second");
    fs::create_dir_all(&first_path).expect("create first root");
    fs::create_dir_all(&second_path).expect("create second root");
    let first = db
        .add_root(&first_path.to_string_lossy(), Some("First"))
        .expect("add first root");
    let second = db
        .add_root(&second_path.to_string_lossy(), Some("Second"))
        .expect("add second root");
    {
        let connection = db.lock().expect("lock database");
        downgrade_roots_to_v5(&connection);
        connection
            .execute_batch(
                "PRAGMA foreign_keys = OFF;
                 BEGIN IMMEDIATE;
                 CREATE TABLE library_roots_duplicate (
                     id TEXT PRIMARY KEY NOT NULL,
                     label TEXT NOT NULL,
                     locator_kind TEXT NOT NULL,
                     locator_value TEXT NOT NULL,
                     last_scanned_at TEXT,
                     created_at TEXT NOT NULL,
                     updated_at TEXT NOT NULL
                 );
                 INSERT INTO library_roots_duplicate
                     (id, label, locator_kind, locator_value, last_scanned_at, created_at, updated_at)
                 SELECT id, label, locator_kind, '/duplicate', last_scanned_at, created_at, updated_at
                 FROM library_roots;
                 DROP TABLE library_roots;
                 ALTER TABLE library_roots_duplicate RENAME TO library_roots;
                 PRAGMA user_version = 5;
                 COMMIT;
                 PRAGMA foreign_keys = ON;",
            )
            .expect("create duplicate v5 roots");
    }
    drop(db);

    assert!(
        LibraryDb::open(&db_path).is_err(),
        "migration must reject duplicate attached locators"
    );
    let connection = rusqlite::Connection::open(&db_path).expect("reopen failed database");
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("read rollback version");
    assert_eq!(version, 5);
    let root_columns = migration_snapshot(
        &connection,
        "SELECT name FROM pragma_table_info('library_roots') ORDER BY cid",
    );
    assert!(
        !root_columns
            .iter()
            .any(|column| column == "attachment_state"),
        "failed migration must leave the v5 table"
    );
    let root_rows = migration_snapshot(&connection, "SELECT id FROM library_roots ORDER BY id");
    let mut expected_ids = vec![first.id, second.id];
    expected_ids.sort();
    assert_eq!(root_rows, expected_ids);
    drop(connection);
    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_root_attachment_and_availability_dto_mapping() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-root-dto-{}", Uuid::new_v4()));
    let existing_dir = temp_dir.join("existing");
    let missing_dir = temp_dir.join("missing");
    fs::create_dir_all(&existing_dir).expect("create existing root dir");
    fs::create_dir_all(&missing_dir).expect("create missing root dir");

    let db = LibraryDb::open_in_memory().expect("open db");

    let root_attached_avail = db
        .add_root(&existing_dir.to_string_lossy(), Some("Attached Available"))
        .expect("add attached available root");
    let root_attached_missing = db
        .add_root(&missing_dir.to_string_lossy(), Some("Attached Missing"))
        .expect("add attached missing root");

    // Remove the missing directory to simulate attached-missing
    fs::remove_dir_all(&missing_dir).expect("remove missing dir");

    // Verify attached available
    assert_eq!(root_attached_avail.attachment_state, "attached");
    assert_eq!(
        root_attached_avail.availability.as_deref(),
        Some("available")
    );
    assert_eq!(root_attached_avail.status, "active");

    // Verify attached missing via list_roots
    let roots = db.list_roots().expect("list roots");
    let listed_attached_missing = roots
        .iter()
        .find(|r| r.id == root_attached_missing.id)
        .expect("find attached missing root");
    assert_eq!(listed_attached_missing.attachment_state, "attached");
    assert_eq!(
        listed_attached_missing.availability.as_deref(),
        Some("missing")
    );
    assert_eq!(listed_attached_missing.status, "missing");

    // Detach roots via direct database update to verify detached roundtrip and DTO mapping
    {
        let conn = db.lock().expect("lock db");
        conn.execute(
            "UPDATE library_roots SET attachment_state = 'detached' WHERE id = ?1",
            [&root_attached_avail.id],
        )
        .expect("set detached on existing dir root");
        conn.execute(
            "UPDATE library_roots SET attachment_state = 'detached' WHERE id = ?1",
            [&root_attached_missing.id],
        )
        .expect("set detached on missing dir root");
    }

    let roots_detached = db.list_roots().expect("list roots after detach");
    let detached_existing = roots_detached
        .iter()
        .find(|r| r.id == root_attached_avail.id)
        .expect("find detached root with existing dir");
    assert_eq!(detached_existing.attachment_state, "detached");
    assert_eq!(detached_existing.availability, None);
    assert_eq!(detached_existing.status, "disabled");

    let detached_missing = roots_detached
        .iter()
        .find(|r| r.id == root_attached_missing.id)
        .expect("find detached root with missing dir");
    assert_eq!(detached_missing.attachment_state, "detached");
    assert_eq!(detached_missing.availability, None);
    assert_eq!(detached_missing.status, "disabled");

    // Serialization compatibility check
    let json = serde_json::to_value(detached_existing).expect("serialize detached root");
    assert_eq!(json["id"], root_attached_avail.id);
    assert_eq!(json["label"], "Attached Available");
    assert_eq!(json["kind"], "filesystem-directory");
    assert_eq!(json["status"], "disabled");
    assert_eq!(json["attachmentState"], "detached");
    assert!(json["availability"].is_null());
    assert!(json["createdAt"].is_string());
    assert!(json["updatedAt"].is_string());

    let json_attached =
        serde_json::to_value(listed_attached_missing).expect("serialize attached root");
    assert_eq!(json_attached["status"], "missing");
    assert_eq!(json_attached["attachmentState"], "attached");
    assert_eq!(json_attached["availability"], "missing");

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_paths_overlap_component_comparison() {
    let base = Path::new("/home/user/docs");
    let same = Path::new("/home/user/docs");
    let child = Path::new("/home/user/docs/nested");
    let parent = Path::new("/home/user");
    let sibling_similar = Path::new("/home/user/docs-old");
    let unrelated = Path::new("/var/log");

    assert!(roots::paths_overlap(base, same));
    assert!(roots::paths_overlap(same, base));
    assert!(roots::paths_overlap(base, child));
    assert!(roots::paths_overlap(child, base));
    assert!(roots::paths_overlap(base, parent));
    assert!(roots::paths_overlap(parent, base));

    assert!(!roots::paths_overlap(base, sibling_similar));
    assert!(!roots::paths_overlap(sibling_similar, base));
    assert!(!roots::paths_overlap(base, unrelated));
    assert!(!roots::paths_overlap(unrelated, base));
}

#[test]
fn test_attached_root_overlap_validation() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-overlap-{}", Uuid::new_v4()));
    let base_docs = temp_dir.join("docs");
    let sub_docs = base_docs.join("sub");
    let docs_old = temp_dir.join("docs-old");
    let detached_dir = temp_dir.join("detached");
    let detached_sub = detached_dir.join("sub");
    fs::create_dir_all(&sub_docs).expect("create sub_docs");
    fs::create_dir_all(&docs_old).expect("create docs_old");
    fs::create_dir_all(&detached_sub).expect("create detached_sub");

    let db = LibraryDb::open_in_memory().expect("open db");

    // 1. Initial attached root
    let root_docs = db
        .add_root(&base_docs.to_string_lossy(), Some("Docs"))
        .expect("add base docs root");

    // 2. Adding identical attached root must fail and leave database unchanged
    let roots_before = db.list_roots().expect("list roots");
    let err_identical = db.add_root(&base_docs.to_string_lossy(), Some("Docs Duplicate"));
    assert!(
        err_identical.is_err(),
        "Adding an identical attached root must be rejected"
    );
    assert!(err_identical.unwrap_err().contains("overlaps"));
    let roots_after_identical = db.list_roots().expect("list roots");
    assert_eq!(
        roots_before, roots_after_identical,
        "rejected operation must leave database unchanged"
    );

    // 3. Adding a descendant attached root must fail and leave database unchanged
    let err_descendant = db.add_root(&sub_docs.to_string_lossy(), Some("Sub Docs"));
    assert!(
        err_descendant.is_err(),
        "Adding a descendant attached root must be rejected"
    );
    assert!(err_descendant.unwrap_err().contains("overlaps"));
    let roots_after_descendant = db.list_roots().expect("list roots");
    assert_eq!(
        roots_before, roots_after_descendant,
        "rejected descendant operation must leave database unchanged"
    );

    // 4. Adding an ancestor attached root must fail and leave database unchanged
    let separate_parent = temp_dir.join("parent");
    let separate_child = separate_parent.join("child");
    fs::create_dir_all(&separate_child).expect("create child dir");
    let _child_root = db
        .add_root(&separate_child.to_string_lossy(), Some("Child"))
        .expect("add child root");

    let roots_before_ancestor = db.list_roots().expect("list roots");
    let err_ancestor = db.add_root(&separate_parent.to_string_lossy(), Some("Parent"));
    assert!(
        err_ancestor.is_err(),
        "Adding an ancestor attached root must be rejected"
    );
    assert!(err_ancestor.unwrap_err().contains("overlaps"));
    let roots_after_ancestor = db.list_roots().expect("list roots");
    assert_eq!(
        roots_before_ancestor, roots_after_ancestor,
        "rejected ancestor operation must leave database unchanged"
    );

    // 5. Accepting sibling/non-overlapping paths, including similarly prefixed names (`docs` and `docs-old`)
    let root_docs_old = db
        .add_root(&docs_old.to_string_lossy(), Some("Docs Old"))
        .expect("add sibling docs-old root");
    assert_eq!(root_docs_old.label, "Docs Old");
    assert_eq!(root_docs_old.attachment_state, "attached");
    let all_roots = db.list_roots().expect("list roots");
    assert!(all_roots.iter().any(|r| r.id == root_docs.id));
    assert!(all_roots.iter().any(|r| r.id == root_docs_old.id));

    // 6. Ignoring detached roots when checking overlap
    let detached_parent_dir = temp_dir.join("detached_parent");
    let detached_child_dir = detached_parent_dir.join("child");
    let detached_same_dir = temp_dir.join("detached_same");
    fs::create_dir_all(&detached_child_dir).expect("create detached child dir");
    fs::create_dir_all(&detached_same_dir).expect("create detached same dir");

    let detached_parent_root = db
        .add_root(
            &detached_parent_dir.to_string_lossy(),
            Some("Detached Parent"),
        )
        .expect("add parent to detach");
    let detached_same_root = db
        .add_root(&detached_same_dir.to_string_lossy(), Some("Detached Same"))
        .expect("add same to detach");
    {
        let conn = db.lock().expect("lock db");
        conn.execute(
            "UPDATE library_roots SET attachment_state = 'detached' WHERE id IN (?1, ?2)",
            params![detached_parent_root.id, detached_same_root.id],
        )
        .expect("set detached");
    }

    // Adding descendant of a detached root must succeed
    let attached_child = db
        .add_root(
            &detached_child_dir.to_string_lossy(),
            Some("Attached Child"),
        )
        .expect("adding child of detached root must succeed");
    assert_eq!(attached_child.attachment_state, "attached");

    // Adding same path as a detached root must also succeed as new attached root
    let new_attached_same_path = db
        .add_root(
            &detached_same_dir.to_string_lossy(),
            Some("New Attached Same Path"),
        )
        .expect("adding root at same path as detached root must succeed");
    assert_eq!(new_attached_same_path.attachment_state, "attached");
    // 7. Preserving pre-existing legacy overlaps without modifying or merging their records
    let legacy_nested = temp_dir.join("legacy_base");
    let legacy_inner = legacy_nested.join("inner");
    fs::create_dir_all(&legacy_inner).expect("create legacy inner");
    let legacy_outer_root = db
        .add_root(&legacy_nested.to_string_lossy(), Some("Legacy Outer"))
        .expect("add legacy outer");

    // Insert legacy inner directly via SQL to simulate pre-existing overlap
    let legacy_inner_id = Uuid::new_v4().to_string();
    let legacy_inner_canon = canonical_directory(&legacy_inner.to_string_lossy())
        .unwrap()
        .to_string_lossy()
        .into_owned();
    {
        let conn = db.lock().expect("lock db");
        conn.execute(
            "INSERT INTO library_roots
                 (id, label, locator_kind, locator_value, attachment_state,
                  last_scanned_at, created_at, updated_at)
             VALUES (?1, 'Legacy Inner', 'filesystem-directory', ?2, 'attached', NULL, ?3, ?3)",
            params![legacy_inner_id, legacy_inner_canon, timestamp()],
        )
        .expect("insert legacy overlapping root directly");
    }

    // Both legacy overlapping roots coexist in list_roots without modification or merging
    let roots_with_legacy = db.list_roots().expect("list roots with legacy overlap");
    let outer_found = roots_with_legacy
        .iter()
        .find(|r| r.id == legacy_outer_root.id)
        .expect("find legacy outer");
    let inner_found = roots_with_legacy
        .iter()
        .find(|r| r.id == legacy_inner_id)
        .expect("find legacy inner");
    assert_eq!(outer_found.label, "Legacy Outer");
    assert_eq!(inner_found.label, "Legacy Inner");
    assert_ne!(outer_found.id, inner_found.id);

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_add_root_handles_missing_attached_root_paths() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-missing-root-{}", Uuid::new_v4()));
    let missing_root_path = temp_dir.join("removed");
    let sibling_path = temp_dir.join("sibling");
    fs::create_dir_all(&missing_root_path).expect("create root directory");
    fs::create_dir_all(&sibling_path).expect("create sibling directory");

    let db = LibraryDb::open_in_memory().expect("open db");
    db.add_root(&missing_root_path.to_string_lossy(), Some("Removed"))
        .expect("add existing root");
    fs::remove_dir_all(&missing_root_path).expect("remove root directory");

    let sibling = db
        .add_root(&sibling_path.to_string_lossy(), Some("Sibling"))
        .expect("add non-overlapping sibling beside missing root");
    assert_eq!(sibling.label, "Sibling");

    let roots_before_overlap = db.list_roots().expect("list roots");
    let err = db.add_root(&temp_dir.to_string_lossy(), Some("Parent"));
    assert!(err.is_err(), "overlapping candidate must be rejected");
    assert!(err.unwrap_err().contains("overlaps"));
    assert_eq!(
        roots_before_overlap,
        db.list_roots().expect("list roots after rejection"),
        "rejected operation must leave database unchanged"
    );

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_add_root_rejects_unsafe_missing_attached_root_path() {
    let temp_dir = std::env::temp_dir().join(format!("clio-test-unsafe-root-{}", Uuid::new_v4()));
    let candidate_path = temp_dir.join("candidate");
    fs::create_dir_all(&candidate_path).expect("create candidate directory");

    let db = LibraryDb::open_in_memory().expect("open db");
    let unsafe_root_id = Uuid::new_v4().to_string();
    let unsafe_locator = format!("relative-{}/../unsafe", Uuid::new_v4());
    {
        let connection = db.lock().expect("lock db");
        connection
            .execute(
                "INSERT INTO library_roots
                     (id, label, locator_kind, locator_value, attachment_state,
                      last_scanned_at, created_at, updated_at)
                 VALUES (?1, 'Unsafe', 'filesystem-directory', ?2, 'attached', NULL, ?3, ?3)",
                params![unsafe_root_id, unsafe_locator, timestamp()],
            )
            .expect("insert unsafe root locator");
    }

    let roots_before = db.list_roots().expect("list roots");
    let err = db.add_root(&candidate_path.to_string_lossy(), Some("Candidate"));
    assert!(err.is_err(), "unsafe stored path must reject validation");
    assert!(err.unwrap_err().contains("not absolute and normalized"));
    assert_eq!(
        roots_before,
        db.list_roots().expect("list roots after rejection"),
        "validation failure must leave database unchanged"
    );

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_detaching_root_preserves_catalog_and_isolates_active_operations() {
    let temp_dir = std::env::temp_dir().join(format!("clio-detach-root-{}", Uuid::new_v4()));
    let detached_path = temp_dir.join("detached");
    let active_path = temp_dir.join("active");
    fs::create_dir_all(&detached_path).expect("create detached root directory");
    fs::create_dir_all(&active_path).expect("create active root directory");
    let document_path = detached_path.join("book.txt");
    let excluded_path = detached_path.join("excluded.txt");
    let active_document_path = active_path.join("active.txt");
    fs::write(&document_path, "book contents").expect("write book");
    fs::write(&excluded_path, "excluded contents").expect("write excluded document");
    fs::write(&active_document_path, "active contents").expect("write active document");

    let db = LibraryDb::open_in_memory().expect("open db");
    let detached_root = db
        .add_root(&detached_path.to_string_lossy(), Some("Detached"))
        .expect("add detached root");
    let active_root = db
        .add_root(&active_path.to_string_lossy(), Some("Active"))
        .expect("add active root");
    db.scan_root(&detached_root.id)
        .expect("scan detached candidate");
    db.scan_root(&active_root.id).expect("scan active root");

    let detached_documents = db
        .list_documents(Some(&detached_root.id), false)
        .expect("list attached root documents");
    let document_id = detached_documents
        .iter()
        .find(|document| document.name == "book.txt")
        .expect("find book")
        .id
        .clone();
    let excluded_id = detached_documents
        .iter()
        .find(|document| document.name == "excluded.txt")
        .expect("find excluded document")
        .id
        .clone();
    let active_documents = db
        .list_documents(Some(&active_root.id), false)
        .expect("list active root documents");
    assert_eq!(active_documents.len(), 1);
    let active_id = active_documents[0].id.clone();

    let collection = db
        .create_collection("Saved", None)
        .expect("create collection");
    db.add_document_to_collection(&collection.id, &document_id)
        .expect("add book to collection");
    let state = ReadingState {
        document_id: document_id.clone(),
        position: ReadingPosition::TextScroll { progression: 0.25 },
        last_opened_at: "2026-10-01T12:00:00Z".to_string(),
        updated_at: "2026-10-01T12:00:00Z".to_string(),
    };
    db.set_reading_state(state).expect("save reading state");
    db.create_bookmark(
        &document_id,
        ReadingPosition::TextScroll { progression: 0.25 },
        Some("Keep"),
    )
    .expect("create bookmark");
    db.create_annotation(
        &document_id,
        "note",
        ReadingPosition::TextScroll { progression: 0.25 },
        Some("Selected"),
        Some("Preserve this"),
        None,
    )
    .expect("create annotation");
    db.remove_document(&excluded_id)
        .expect("exclude document before detach");
    let excluded_at_before: Option<String> = db
        .lock()
        .expect("lock db")
        .query_row(
            "SELECT excluded_at FROM documents WHERE id = ?1",
            [&excluded_id],
            |row| row.get(0),
        )
        .expect("read excluded state");
    assert!(excluded_at_before.is_some());

    let root_locator_before = db
        .root(&detached_root.id)
        .expect("load root")
        .expect("root exists")
        .locator_value;
    let scan_time_before = db
        .root(&detached_root.id)
        .expect("load root")
        .expect("root exists")
        .last_scanned_at;
    db.remove_root(&detached_root.id).expect("detach root");
    db.remove_root(&detached_root.id)
        .expect("detaching an already detached root is idempotent");

    let listed_root = db
        .list_roots()
        .expect("list roots")
        .into_iter()
        .find(|root| root.id == detached_root.id)
        .expect("detached root record remains");
    assert_eq!(listed_root.attachment_state, "detached");
    assert_eq!(listed_root.availability, None);
    let detached_root_row = db
        .root(&detached_root.id)
        .expect("load detached root")
        .expect("detached root remains");
    assert_eq!(detached_root_row.last_scanned_at, scan_time_before);
    assert_eq!(detached_root_row.locator_value, root_locator_before);

    assert!(document_path.exists(), "detachment must not remove files");
    assert!(excluded_path.exists(), "detachment must not remove files");
    assert_eq!(
        db.list_documents(None, false)
            .expect("list active documents")
            .iter()
            .map(|document| document.id.as_str())
            .collect::<Vec<_>>(),
        vec![active_id.as_str()]
    );
    assert!(db
        .list_documents(Some(&detached_root.id), true)
        .unwrap_err()
        .contains("detached"));
    assert!(db.document_path(&document_id).is_err());
    let mut token_minted = false;
    assert!(db
        .open_library_document(&document_id, |_, _| {
            token_minted = true;
            Ok("unexpected-token".to_string())
        })
        .is_err());
    assert!(
        !token_minted,
        "detached document must not mint reader access"
    );
    assert!(db
        .add_document_to_collection(&collection.id, &document_id)
        .is_err());

    let roots_before_rejected_scan = db.list_roots().expect("roots before rejected scan");
    let documents_before_rejected_scan: Vec<String> = db
        .list_documents(None, true)
        .expect("active docs before scan")
        .into_iter()
        .map(|document| document.id)
        .collect();
    assert!(db.scan_root(&detached_root.id).is_err());
    assert_eq!(
        roots_before_rejected_scan,
        db.list_roots().expect("roots after rejected scan")
    );
    let documents_after_rejected_scan: Vec<String> = db
        .list_documents(None, true)
        .expect("active docs after scan")
        .into_iter()
        .map(|document| document.id)
        .collect();
    assert_eq!(
        documents_before_rejected_scan,
        documents_after_rejected_scan
    );

    let connection = db.lock().expect("lock db");
    let preserved_document: (String, String, Option<String>, String) = connection
        .query_row(
            "SELECT root_id, relative_path, excluded_at, availability
             FROM documents WHERE id = ?1",
            [&document_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read preserved document");
    assert_eq!(preserved_document.0, detached_root.id);
    assert_eq!(preserved_document.1, "book.txt");
    assert_eq!(preserved_document.2, None);
    assert_eq!(preserved_document.3, "present");
    let excluded_at_after: Option<String> = connection
        .query_row(
            "SELECT excluded_at FROM documents WHERE id = ?1",
            [&excluded_id],
            |row| row.get(0),
        )
        .expect("read preserved exclusion");
    assert_eq!(excluded_at_after, excluded_at_before);
    let document_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM documents WHERE root_id = ?1",
            [&detached_root.id],
            |row| row.get(0),
        )
        .expect("count preserved documents");
    assert_eq!(document_count, 2);
    let membership_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM document_collections WHERE document_id = ?1",
            [&document_id],
            |row| row.get(0),
        )
        .expect("count preserved memberships");
    assert_eq!(membership_count, 1);
    drop(connection);
    assert_eq!(
        db.get_reading_state(&document_id)
            .expect("get preserved reading state")
            .expect("reading state remains")
            .document_id,
        document_id
    );
    assert_eq!(
        db.list_bookmarks(&document_id)
            .expect("list bookmarks")
            .len(),
        1
    );
    assert_eq!(
        db.list_annotations(&document_id)
            .expect("list annotations")
            .len(),
        1
    );
    assert!(db
        .list_collection_documents(&collection.id)
        .expect("list active collection documents")
        .is_empty());
    assert_eq!(
        db.list_collections().expect("list collection counts")[0].document_count,
        0
    );

    let _ = fs::remove_dir_all(&temp_dir);
}

fn locate_root_snapshot(
    db: &LibraryDb,
    root_id: &str,
) -> (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    i64,
    String,
) {
    db.lock()
        .expect("lock database")
        .query_row(
            "SELECT id, label, locator_value, attachment_state, updated_at, last_scanned_at,
                    (SELECT COUNT(*) FROM documents WHERE root_id = library_roots.id), created_at
             FROM library_roots WHERE id = ?1",
            [root_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .expect("read root snapshot")
}

fn locate_document_snapshot(
    db: &LibraryDb,
    root_id: &str,
) -> Vec<(String, String, String, String, Option<String>)> {
    let connection = db.lock().expect("lock database");
    let mut statement = connection
        .prepare(
            "SELECT id, root_id, relative_path, availability, excluded_at
             FROM documents WHERE root_id = ?1 ORDER BY id",
        )
        .expect("prepare document snapshot");
    statement
        .query_map([root_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .expect("query document snapshot")
        .map(|row| row.expect("read document snapshot row"))
        .collect()
}

#[test]
fn locate_root_preview_reports_detached_and_missing_roots_without_mutation() {
    let temp_dir = std::env::temp_dir().join(format!("clio-locate-preview-{}", Uuid::new_v4()));
    let detached_path = temp_dir.join("detached");
    let missing_path = temp_dir.join("missing");
    let detached_candidate = temp_dir.join("detached-candidate");
    let missing_candidate = temp_dir.clone();
    fs::create_dir_all(&detached_path).expect("create detached root");
    fs::create_dir_all(&missing_path).expect("create root to remove");
    fs::create_dir_all(&detached_candidate).expect("create detached candidate");
    fs::write(detached_path.join("kept.txt"), b"kept").expect("write detached-root document");
    fs::write(missing_path.join("missing.txt"), b"missing").expect("write missing-root document");

    let db = LibraryDb::open_in_memory().expect("open database");
    let detached_root = db
        .add_root(&detached_path.to_string_lossy(), Some("Detached"))
        .expect("add detached candidate root");
    let missing_root = db
        .add_root(&missing_path.to_string_lossy(), Some("Missing"))
        .expect("add missing candidate root");
    db.scan_root(&detached_root.id)
        .expect("scan detached candidate root");
    db.scan_root(&missing_root.id)
        .expect("scan missing candidate root");
    db.remove_root(&detached_root.id).expect("detach root");
    fs::remove_dir_all(&missing_path).expect("remove attached root directory");

    let detached_before = locate_root_snapshot(&db, &detached_root.id);
    let missing_before = locate_root_snapshot(&db, &missing_root.id);
    let detached_documents_before = locate_document_snapshot(&db, &detached_root.id);
    let missing_documents_before = locate_document_snapshot(&db, &missing_root.id);

    let detached_preview = db
        .preview_locate_root(&detached_root.id, &detached_candidate.to_string_lossy())
        .expect("preview detached root");
    assert_eq!(detached_preview.root_id, detached_root.id);
    assert_eq!(detached_preview.label, "Detached");
    assert_eq!(detached_preview.attachment_state, "detached");
    assert_eq!(detached_preview.availability, None);
    assert_eq!(detached_preview.document_count, 1);
    assert_eq!(
        detached_preview.candidate_locator,
        fs::canonicalize(&detached_candidate)
            .expect("canonical detached candidate")
            .to_string_lossy()
    );

    let missing_preview = db
        .preview_locate_root(&missing_root.id, &missing_candidate.to_string_lossy())
        .expect("preview attached but missing root");
    assert_eq!(missing_preview.attachment_state, "attached");
    assert_eq!(missing_preview.availability.as_deref(), Some("missing"));
    assert_eq!(missing_preview.document_count, 1);

    assert_eq!(
        locate_root_snapshot(&db, &detached_root.id),
        detached_before
    );
    assert_eq!(locate_root_snapshot(&db, &missing_root.id), missing_before);
    assert_eq!(
        locate_document_snapshot(&db, &detached_root.id),
        detached_documents_before
    );
    assert_eq!(
        locate_document_snapshot(&db, &missing_root.id),
        missing_documents_before
    );
    let located_missing = db
        .confirm_locate_root(&missing_preview)
        .expect("locate missing root to its ancestor candidate");
    assert_eq!(located_missing.id, missing_root.id);
    assert_eq!(located_missing.attachment_state, "attached");
    assert_eq!(
        db.root(&missing_root.id)
            .expect("load located missing root")
            .expect("root remains")
            .locator_value,
        fs::canonicalize(&temp_dir)
            .expect("canonical ancestor candidate")
            .to_string_lossy()
    );
    assert_eq!(
        locate_document_snapshot(&db, &missing_root.id),
        missing_documents_before
    );
    fs::remove_dir_all(temp_dir).expect("remove temporary directory");
}

#[test]
fn locate_root_rebinds_in_place_and_preserves_catalog_user_state() {
    let temp_dir = std::env::temp_dir().join(format!("clio-locate-preserve-{}", Uuid::new_v4()));
    let old_path = temp_dir.join("old-library");
    let candidate_path = temp_dir.join("new-library");
    fs::create_dir_all(&old_path).expect("create old root");
    fs::create_dir_all(&candidate_path).expect("create new root");
    fs::write(old_path.join("kept.txt"), b"old bytes").expect("write old kept file");
    fs::write(old_path.join("excluded.txt"), b"old excluded bytes")
        .expect("write old excluded file");
    fs::write(candidate_path.join("kept.txt"), b"new bytes").expect("write candidate kept file");
    fs::write(candidate_path.join("excluded.txt"), b"new excluded bytes")
        .expect("write candidate excluded file");

    let db = LibraryDb::open_in_memory().expect("open database");
    let root = db
        .add_root(&old_path.to_string_lossy(), Some("Rebound"))
        .expect("add original root");
    db.scan_root(&root.id).expect("scan original root");
    let documents = db
        .list_documents(Some(&root.id), false)
        .expect("list original documents");
    let kept = documents
        .iter()
        .find(|document| document.name == "kept.txt")
        .expect("find kept document");
    let excluded = documents
        .iter()
        .find(|document| document.name == "excluded.txt")
        .expect("find excluded document");
    let kept_id = kept.id.clone();
    db.update_metadata(
        &kept_id,
        DocumentMetadata {
            title: Some("Catalog title".to_string()),
            authors: vec!["A. Author".to_string()],
            publisher: Some("Clio Press".to_string()),
            published_date: Some("2025-01-02".to_string()),
            description: Some("Preserve this catalog metadata.".to_string()),
            language: Some("en".to_string()),
            identifiers: vec!["test:locate".to_string()],
            provenance: MetadataProvenance::Fallback,
            thumbnail_path: None,
        },
    )
    .expect("set document metadata");
    let metadata_before = db
        .get_metadata(&kept_id)
        .expect("read metadata before locate")
        .expect("metadata exists");
    let excluded_id = excluded.id.clone();
    let collection = db
        .create_collection("Saved", None)
        .expect("create collection");
    db.add_document_to_collection(&collection.id, &kept_id)
        .expect("add collection membership");
    db.set_reading_state(ReadingState {
        document_id: kept_id.clone(),
        position: ReadingPosition::TextScroll { progression: 0.42 },
        last_opened_at: timestamp(),
        updated_at: timestamp(),
    })
    .expect("set reading state");
    db.create_bookmark(
        &kept_id,
        ReadingPosition::TextScroll { progression: 0.42 },
        Some("Saved position"),
    )
    .expect("create bookmark");
    db.create_annotation(
        &kept_id,
        "note",
        ReadingPosition::TextScroll { progression: 0.42 },
        Some("Saved selection"),
        Some("Preserve this note"),
        None,
    )
    .expect("create annotation");
    let reading_state_before = db
        .get_reading_state(&kept_id)
        .expect("read reading state before locate")
        .expect("reading state exists");
    let bookmarks_before = db
        .list_bookmarks(&kept_id)
        .expect("read bookmarks before locate");
    let annotations_before = db
        .list_annotations(&kept_id)
        .expect("read annotations before locate");
    db.remove_document(&excluded_id)
        .expect("exclude associated document");
    db.remove_root(&root.id).expect("detach original root");

    let root_before = locate_root_snapshot(&db, &root.id);
    let documents_before = locate_document_snapshot(&db, &root.id);
    let preview = db
        .preview_locate_root(&root.id, &candidate_path.to_string_lossy())
        .expect("preview rebind");
    assert_eq!(preview.document_count, 2);
    assert_eq!(locate_root_snapshot(&db, &root.id), root_before);
    assert_eq!(locate_document_snapshot(&db, &root.id), documents_before);

    let located = db
        .confirm_locate_root(&preview)
        .expect("confirm root location");
    let canonical_candidate =
        fs::canonicalize(&candidate_path).expect("canonical candidate location");
    assert_eq!(located.id, root.id);
    assert_eq!(located.label, "Rebound");
    assert_eq!(located.attachment_state, "attached");
    assert_eq!(located.availability.as_deref(), Some("available"));
    let root_after = db.root(&root.id).expect("load rebound root").unwrap();
    assert_eq!(
        root_after.locator_value,
        canonical_candidate.to_string_lossy()
    );
    assert_eq!(root_after.last_scanned_at, root_before.5);
    assert_eq!(root_after.created_at, root_before.7);
    assert_eq!(locate_document_snapshot(&db, &root.id), documents_before);
    assert_eq!(
        db.get_metadata(&kept_id)
            .expect("read metadata after locate")
            .expect("metadata preserved"),
        metadata_before
    );
    assert!(old_path.join("kept.txt").exists());
    assert!(candidate_path.join("kept.txt").exists());
    assert_eq!(
        db.document_path(&kept_id)
            .expect("resolve located document"),
        candidate_path
            .join("kept.txt")
            .canonicalize()
            .expect("canonical located document")
            .to_string_lossy()
    );
    let reading_state_after = db
        .get_reading_state(&kept_id)
        .expect("get reading state")
        .expect("reading state preserved");
    assert_eq!(
        serde_json::to_value(reading_state_after).expect("serialize reading state"),
        serde_json::to_value(reading_state_before).expect("serialize expected state")
    );
    let bookmarks_after = db
        .list_bookmarks(&kept_id)
        .expect("list bookmarks after locate");
    assert_eq!(
        serde_json::to_value(bookmarks_after).expect("serialize bookmarks"),
        serde_json::to_value(bookmarks_before).expect("serialize expected bookmarks")
    );
    let annotations_after = db
        .list_annotations(&kept_id)
        .expect("list annotations after locate");
    assert_eq!(
        serde_json::to_value(annotations_after).expect("serialize annotations"),
        serde_json::to_value(annotations_before).expect("serialize expected annotations")
    );
    assert_eq!(
        db.list_collection_documents(&collection.id)
            .expect("list preserved collection document")[0]
            .id,
        kept_id
    );
    assert!(db
        .list_documents(None, true)
        .expect("list active documents after locate")
        .iter()
        .all(|document| document.id != excluded_id));
    let excluded_at_after: Option<String> = db
        .lock()
        .expect("lock database")
        .query_row(
            "SELECT excluded_at FROM documents WHERE id = ?1",
            [&excluded_id],
            |row| row.get(0),
        )
        .expect("read preserved exclusion");
    assert!(excluded_at_after.is_some());
    fs::remove_dir_all(temp_dir).expect("remove temporary directory");
}

#[test]
fn locate_root_rejects_attached_available_roots_and_overlap_candidates() {
    let temp_dir = std::env::temp_dir().join(format!("clio-locate-overlap-{}", Uuid::new_v4()));
    let available_path = temp_dir.join("available");
    let target_path = temp_dir.join("target");
    let conflict_parent = temp_dir.join("conflicts");
    let conflict_path = conflict_parent.join("other");
    let descendant_path = conflict_path.join("child");
    fs::create_dir_all(&available_path).expect("create available root");
    fs::create_dir_all(&target_path).expect("create target root");
    fs::create_dir_all(&descendant_path).expect("create descendant candidate");

    let db = LibraryDb::open_in_memory().expect("open database");
    let available_root = db
        .add_root(&available_path.to_string_lossy(), None)
        .expect("add available root");
    let target_root = db
        .add_root(&target_path.to_string_lossy(), None)
        .expect("add target root");
    db.remove_root(&target_root.id).expect("detach target root");
    let available_before = locate_root_snapshot(&db, &available_root.id);
    assert!(db
        .preview_locate_root(&available_root.id, &target_path.to_string_lossy())
        .unwrap_err()
        .contains("already attached and available"));
    assert_eq!(
        locate_root_snapshot(&db, &available_root.id),
        available_before
    );

    let conflict_root = db
        .add_root(&conflict_path.to_string_lossy(), None)
        .expect("add attached conflict root");
    let target_before = locate_root_snapshot(&db, &target_root.id);
    for candidate in [&conflict_parent, &conflict_path, &descendant_path] {
        assert!(db
            .preview_locate_root(&target_root.id, &candidate.to_string_lossy())
            .unwrap_err()
            .contains("overlaps"));
        assert_eq!(locate_root_snapshot(&db, &target_root.id), target_before);
    }
    assert_eq!(
        db.list_roots()
            .expect("list roots after overlap rejection")
            .iter()
            .filter(|root| root.id == conflict_root.id)
            .count(),
        1
    );
    fs::remove_dir_all(temp_dir).expect("remove temporary directory");
}

#[test]
fn locate_root_allows_overlap_only_with_detached_roots() {
    let temp_dir = std::env::temp_dir().join(format!("clio-locate-detached-{}", Uuid::new_v4()));
    let old_path = temp_dir.join("old");
    let detached_overlap_path = temp_dir.join("detached-overlap");
    let candidate_path = detached_overlap_path.join("candidate");
    fs::create_dir_all(&old_path).expect("create old root");
    fs::create_dir_all(&candidate_path).expect("create nested candidate");

    let db = LibraryDb::open_in_memory().expect("open database");
    let target_root = db
        .add_root(&old_path.to_string_lossy(), Some("Target"))
        .expect("add target root");
    let overlap_root = db
        .add_root(
            &detached_overlap_path.to_string_lossy(),
            Some("Detached overlap"),
        )
        .expect("add overlapping root before detaching target");
    db.remove_root(&target_root.id).expect("detach target");
    db.remove_root(&overlap_root.id)
        .expect("detach overlapping root");

    let preview = db
        .preview_locate_root(&target_root.id, &candidate_path.to_string_lossy())
        .expect("detached roots do not block preview");
    let located = db
        .confirm_locate_root(&preview)
        .expect("detached roots do not block confirmation");
    assert_eq!(located.id, target_root.id);
    assert_eq!(
        fs::canonicalize(&candidate_path)
            .expect("canonical candidate")
            .to_string_lossy(),
        db.root(&target_root.id)
            .expect("load located root")
            .expect("located root remains")
            .locator_value
    );
    assert_eq!(
        db.list_roots()
            .expect("list roots after location")
            .into_iter()
            .find(|root| root.id == overlap_root.id)
            .expect("detached overlap remains")
            .attachment_state,
        "detached"
    );
    fs::remove_dir_all(temp_dir).expect("remove temporary directory");
}

#[test]
fn locate_root_rejects_invalid_candidates_and_stale_previews_without_mutation() {
    let temp_dir = std::env::temp_dir().join(format!("clio-locate-stale-{}", Uuid::new_v4()));
    let old_path = temp_dir.join("old");
    let candidate_path = temp_dir.join("candidate");
    let file_path = temp_dir.join("not-a-directory");
    let missing_path = temp_dir.join("missing-candidate");
    fs::create_dir_all(&old_path).expect("create old root");
    fs::create_dir_all(&candidate_path).expect("create candidate");
    fs::write(&file_path, b"not a directory").expect("create non-directory candidate");

    let db = LibraryDb::open_in_memory().expect("open database");
    let root = db
        .add_root(&old_path.to_string_lossy(), None)
        .expect("add root");
    db.remove_root(&root.id).expect("detach root");
    let before = locate_root_snapshot(&db, &root.id);
    assert!(db
        .preview_locate_root(&root.id, &file_path.to_string_lossy())
        .is_err());
    assert!(db
        .preview_locate_root(&root.id, &missing_path.to_string_lossy())
        .is_err());
    assert_eq!(locate_root_snapshot(&db, &root.id), before);

    let valid_preview = db
        .preview_locate_root(&root.id, &candidate_path.to_string_lossy())
        .expect("preview valid candidate");
    let mut invalid_confirmation = valid_preview.clone();
    invalid_confirmation.candidate_locator = missing_path.to_string_lossy().into_owned();
    assert!(db.confirm_locate_root(&invalid_confirmation).is_err());
    assert_eq!(locate_root_snapshot(&db, &root.id), before);

    let attached_missing_path = temp_dir.join("attached-missing");
    fs::create_dir_all(&attached_missing_path).expect("create attached root");
    let attached_missing = db
        .add_root(&attached_missing_path.to_string_lossy(), None)
        .expect("add attached root");
    fs::remove_dir_all(&attached_missing_path).expect("make root missing");
    let stale_state_preview = db
        .preview_locate_root(&attached_missing.id, &candidate_path.to_string_lossy())
        .expect("preview attached missing root");
    db.remove_root(&attached_missing.id)
        .expect("change root attachment after preview");
    let detached_state = locate_root_snapshot(&db, &attached_missing.id);
    assert!(db
        .confirm_locate_root(&stale_state_preview)
        .unwrap_err()
        .contains("changed since Locate Root preview"));
    assert_eq!(
        locate_root_snapshot(&db, &attached_missing.id),
        detached_state
    );

    let reappearing_path = temp_dir.join("reappearing");
    fs::create_dir_all(&reappearing_path).expect("create root that will disappear");
    let reappearing_root = db
        .add_root(&reappearing_path.to_string_lossy(), None)
        .expect("add reappearing root");
    fs::remove_dir_all(&reappearing_path).expect("make root missing");
    let reappearing_preview = db
        .preview_locate_root(&reappearing_root.id, &candidate_path.to_string_lossy())
        .expect("preview missing root");
    fs::create_dir_all(&reappearing_path).expect("make attached root available");
    let reappearing_before = locate_root_snapshot(&db, &reappearing_root.id);
    assert!(db
        .confirm_locate_root(&reappearing_preview)
        .unwrap_err()
        .contains("already attached and available"));
    assert_eq!(
        locate_root_snapshot(&db, &reappearing_root.id),
        reappearing_before
    );
    fs::remove_dir_all(temp_dir).expect("remove temporary directory");
}

#[test]
fn locate_root_confirmation_rechecks_new_attached_overlaps_atomically() {
    let temp_dir = std::env::temp_dir().join(format!("clio-locate-race-{}", Uuid::new_v4()));
    let old_path = temp_dir.join("old");
    let candidate_path = temp_dir.join("candidate");
    fs::create_dir_all(&old_path).expect("create old root");
    fs::create_dir_all(&candidate_path).expect("create candidate root");

    let db = LibraryDb::open_in_memory().expect("open database");
    let root = db
        .add_root(&old_path.to_string_lossy(), Some("Target"))
        .expect("add target root");
    db.remove_root(&root.id).expect("detach target root");
    let preview = db
        .preview_locate_root(&root.id, &candidate_path.to_string_lossy())
        .expect("preview non-overlapping candidate");
    let competing_root = db
        .add_root(&candidate_path.to_string_lossy(), Some("Competing"))
        .expect("add newly conflicting root");
    let before_confirmation = locate_root_snapshot(&db, &root.id);

    assert!(db
        .confirm_locate_root(&preview)
        .unwrap_err()
        .contains("overlaps"));
    assert_eq!(locate_root_snapshot(&db, &root.id), before_confirmation);
    assert_eq!(
        db.list_roots()
            .expect("list roots after rejected confirmation")
            .iter()
            .filter(|candidate| candidate.id == competing_root.id)
            .count(),
        1
    );
    fs::remove_dir_all(temp_dir).expect("remove temporary directory");
}
#[test]
fn locate_waits_for_scan_and_scan_commits_before_root_rebind() {
    let temp_dir = std::env::temp_dir().join(format!("clio-scan-locate-race-{}", Uuid::new_v4()));
    let old_path = temp_dir.join("old-root");
    let candidate_path = temp_dir.join("located-root");
    fs::create_dir_all(&old_path).expect("create original root");
    fs::create_dir_all(&candidate_path).expect("create candidate root");
    fs::write(old_path.join("book.txt"), "original content").expect("write original document");

    let db = LibraryDb::open_in_memory().expect("open database");
    let root = db
        .add_root(&old_path.to_string_lossy(), Some("Books"))
        .expect("add root");
    db.scan_root(&root.id).expect("initial scan");
    db.lock()
        .expect("lock database to set deterministic root version")
        .execute(
            "UPDATE library_roots SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
            [&root.id],
        )
        .expect("set deterministic root version");
    let original_locator = fs::canonicalize(&old_path)
        .expect("canonicalize original root")
        .to_string_lossy()
        .into_owned();
    let documents_before = locate_document_snapshot(&db, &root.id);
    assert_eq!(documents_before.len(), 1);
    let document_id = documents_before[0].0.clone();

    std::thread::scope(|scope| {
        let scan_db = db.clone();
        let scan_root_id = root.id.clone();
        let (observed_tx, observed_rx) = std::sync::mpsc::channel();
        let (release_scan_tx, release_scan_rx) = std::sync::mpsc::channel();
        let scan_thread = scope.spawn(move || {
            scan_db.scan_root_at_with_observation_hook(&scan_root_id, None, || {
                observed_tx.send(()).expect("signal filesystem observation");
                let _ = release_scan_rx.recv();
            })
        });
        observed_rx
            .recv()
            .expect("wait for scan filesystem observation");
        fs::remove_dir_all(&old_path).expect("make observed root missing");
        let preview = db
            .preview_locate_root(&root.id, &candidate_path.to_string_lossy())
            .expect("preview missing-root location");

        let locate_db = db.clone();
        let (lock_attempt_tx, lock_attempt_rx) = std::sync::mpsc::channel();
        let (locate_result_tx, locate_result_rx) = std::sync::mpsc::channel();
        let locate_thread = scope.spawn(move || {
            let result = crate::locate_library_root_with_lock_attempt_hook(
                &locate_db,
                &preview,
                |contended| {
                    let _ = lock_attempt_tx.send(contended);
                },
            );
            let _ = locate_result_tx.send(result);
        });
        let scan_lock_contended = lock_attempt_rx
            .recv()
            .expect("wait for Locate scan-lock acquisition attempt");
        let early_locate = locate_result_rx.try_recv();
        let locate_completed_early = early_locate.is_ok();
        let root_while_scan_paused = db
            .list_roots()
            .expect("list roots during scan")
            .into_iter()
            .find(|candidate| candidate.id == root.id)
            .expect("root remains present");
        let stored_locator: String = db
            .lock()
            .expect("lock database during paused scan")
            .query_row(
                "SELECT locator_value FROM library_roots WHERE id = ?1",
                [&root.id],
                |row| row.get(0),
            )
            .expect("read root locator while scan is paused");

        release_scan_tx
            .send(())
            .expect("release scan filesystem observation");
        let scan_result = scan_thread
            .join()
            .expect("join scan")
            .expect("scan completes against the original root");
        locate_thread.join().expect("join Locate confirmation");
        let locate_result = match early_locate {
            Ok(result) => result,
            Err(std::sync::mpsc::TryRecvError::Empty) => locate_result_rx
                .recv()
                .expect("receive concurrent Locate result"),
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                Err("Locate result channel disconnected.".to_string())
            }
        };

        assert!(scan_lock_contended, "Locate observed the held scan lock");
        assert!(
            !locate_completed_early,
            "Locate cannot complete while the scan holds the scan lock"
        );
        assert_eq!(
            root_while_scan_paused.availability.as_deref(),
            Some("missing")
        );
        assert_eq!(stored_locator, original_locator);
        assert_eq!(scan_result.missing, 1);
        assert!(locate_result
            .expect_err("scan updates make the original preview stale")
            .contains("Library root changed since Locate Root preview"));
    });

    let refreshed_preview = db
        .preview_locate_root(&root.id, &candidate_path.to_string_lossy())
        .expect("refresh preview after the completed scan");
    let located_root = crate::locate_library_root(&db, &refreshed_preview)
        .expect("confirm location after refreshing stale preview");
    assert_eq!(located_root.attachment_state, "attached");
    assert_eq!(located_root.availability.as_deref(), Some("available"));
    let final_documents = locate_document_snapshot(&db, &root.id);
    assert_eq!(final_documents.len(), 1);
    assert_eq!(final_documents[0].0, document_id);
    assert_eq!(final_documents[0].1, root.id);
    assert_eq!(final_documents[0].2, "book.txt");
    assert_eq!(final_documents[0].3, "missing");

    fs::remove_dir_all(temp_dir).expect("remove temporary directory");
}

fn purge_catalog_snapshot(db: &LibraryDb) -> Vec<Vec<String>> {
    let queries = [
        "SELECT quote(id) || '|' || quote(label) || '|' || quote(locator_value) || '|' || quote(attachment_state) FROM library_roots ORDER BY id",
        "SELECT quote(id) || '|' || quote(root_id) || '|' || quote(relative_path) || '|' || quote(name) || '|' || coalesce(quote(excluded_at), 'NULL') FROM documents ORDER BY id",
        "SELECT quote(document_id) || '|' || quote(position_kind) || '|' || quote(last_opened_at) FROM reading_state ORDER BY document_id",
        "SELECT quote(id) || '|' || quote(document_id) || '|' || quote(title) FROM bookmarks ORDER BY id",
        "SELECT quote(id) || '|' || quote(document_id) || '|' || quote(kind) || '|' || coalesce(quote(note), 'NULL') FROM annotations ORDER BY id",
        "SELECT quote(document_id) || '|' || coalesce(quote(thumbnail_path), 'NULL') FROM document_metadata ORDER BY document_id",
        "SELECT quote(id) || '|' || quote(name) FROM collections ORDER BY id",
        "SELECT quote(collection_id) || '|' || quote(document_id) FROM document_collections ORDER BY collection_id, document_id",
    ];
    let connection = db.lock().expect("lock database");
    queries
        .iter()
        .map(|query| migration_snapshot(&connection, query))
        .collect()
}

#[test]
fn purge_preview_reports_cascade_impact_and_is_read_only() {
    let temp_dir = std::env::temp_dir().join(format!("clio-purge-preview-{}", Uuid::new_v4()));
    let books_path = temp_dir.join("Books");
    let other_path = temp_dir.join("Other");
    fs::create_dir_all(&books_path).expect("create selected root");
    fs::create_dir_all(&other_path).expect("create unrelated root");
    let kept_path = books_path.join("kept.txt");
    let excluded_path = books_path.join("excluded.txt");
    let other_document_path = other_path.join("other.txt");
    fs::write(&kept_path, b"keep physical bytes").expect("write selected document");
    fs::write(&excluded_path, b"excluded physical bytes").expect("write excluded document");
    fs::write(&other_document_path, b"unrelated physical bytes").expect("write unrelated document");
    let thumbnail_path = temp_dir.join("selected-thumbnail.bin");
    fs::write(&thumbnail_path, b"thumbnail bytes").expect("write thumbnail artifact");

    let db = LibraryDb::open_in_memory().expect("open database");
    let root = db
        .add_root(&books_path.to_string_lossy(), Some("Selected"))
        .expect("add selected root");
    let other_root = db
        .add_root(&other_path.to_string_lossy(), Some("Unrelated"))
        .expect("add unrelated root");
    db.scan_root(&root.id).expect("scan selected root");
    db.scan_root(&other_root.id).expect("scan unrelated root");
    let selected_documents = db
        .list_documents(Some(&root.id), false)
        .expect("list selected documents");
    let kept_id = selected_documents
        .iter()
        .find(|document| document.name == "kept.txt")
        .expect("find selected document")
        .id
        .clone();
    let excluded_id = selected_documents
        .iter()
        .find(|document| document.name == "excluded.txt")
        .expect("find excluded document")
        .id
        .clone();
    let other_id = db
        .list_documents(Some(&other_root.id), false)
        .expect("list unrelated document")
        .into_iter()
        .next()
        .expect("unrelated document exists")
        .id;
    db.update_metadata(
        &kept_id,
        DocumentMetadata {
            title: Some("Selected metadata".to_string()),
            authors: vec!["A. Author".to_string()],
            publisher: None,
            published_date: None,
            description: None,
            language: None,
            identifiers: vec![],
            provenance: MetadataProvenance::Fallback,
            thumbnail_path: Some(thumbnail_path.to_string_lossy().into_owned()),
        },
    )
    .expect("set selected metadata");
    db.set_reading_state(ReadingState {
        document_id: kept_id.clone(),
        position: ReadingPosition::TextScroll { progression: 0.3 },
        last_opened_at: timestamp(),
        updated_at: timestamp(),
    })
    .expect("set selected reading state");
    db.set_reading_state(ReadingState {
        document_id: other_id.clone(),
        position: ReadingPosition::TextScroll { progression: 0.6 },
        last_opened_at: timestamp(),
        updated_at: timestamp(),
    })
    .expect("set unrelated reading state");
    db.create_bookmark(
        &kept_id,
        ReadingPosition::TextScroll { progression: 0.3 },
        Some("Selected bookmark"),
    )
    .expect("create selected bookmark");
    db.create_annotation(
        &kept_id,
        "note",
        ReadingPosition::TextScroll { progression: 0.3 },
        Some("Selected text"),
        Some("Selected annotation"),
        None,
    )
    .expect("create selected annotation");
    let collection = db
        .create_collection("Shared", Some("Contains selected and unrelated documents"))
        .expect("create shared collection");
    db.add_document_to_collection(&collection.id, &kept_id)
        .expect("add selected collection membership");
    db.add_document_to_collection(&collection.id, &excluded_id)
        .expect("add excluded collection membership");
    db.add_document_to_collection(&collection.id, &other_id)
        .expect("add unrelated collection membership");
    db.remove_document(&excluded_id)
        .expect("exclude selected document");
    db.remove_root(&root.id).expect("detach selected root");

    let before_preview = purge_catalog_snapshot(&db);
    let preview = db
        .preview_purge_root(&root.id)
        .expect("preview detached root purge");
    assert_eq!(preview.root_id, root.id);
    assert_eq!(preview.label, "Selected");
    assert_eq!(
        preview.locator_value,
        fs::canonicalize(&books_path).unwrap().to_string_lossy()
    );
    assert_eq!(preview.attachment_state, "detached");
    assert_eq!(preview.document_count, 2);
    assert_eq!(preview.reading_state_count, 1);
    assert_eq!(preview.bookmark_count, 1);
    assert_eq!(preview.annotation_count, 1);
    assert_eq!(preview.metadata_count, 2);
    assert_eq!(preview.collection_membership_count, 2);
    assert_eq!(purge_catalog_snapshot(&db), before_preview);

    db.purge_root(&root.id).expect("purge detached root");
    let after_purge = purge_catalog_snapshot(&db);
    assert_eq!(after_purge[0].len(), 1, "unrelated root remains");
    assert_eq!(after_purge[1].len(), 1, "only unrelated document remains");
    assert_eq!(after_purge[2].len(), 1, "unrelated reading state remains");
    assert!(after_purge[3].is_empty(), "selected bookmark cascades");
    assert!(after_purge[4].is_empty(), "selected annotation cascades");
    assert_eq!(after_purge[5].len(), 1, "unrelated metadata remains");
    assert_eq!(after_purge[6].len(), 1, "shared collection remains");
    assert_eq!(after_purge[7].len(), 1, "unrelated membership remains");
    assert!(db.purge_root(&root.id).unwrap_err().contains("not found"));
    assert_eq!(purge_catalog_snapshot(&db), after_purge);
    assert_eq!(
        fs::read(&kept_path).expect("selected source remains"),
        b"keep physical bytes"
    );
    assert_eq!(
        fs::read(&excluded_path).expect("excluded source remains"),
        b"excluded physical bytes"
    );
    assert_eq!(
        fs::read(&other_document_path).expect("unrelated source remains"),
        b"unrelated physical bytes"
    );
    assert_eq!(
        fs::read(&thumbnail_path).expect("thumbnail file remains"),
        b"thumbnail bytes"
    );
    assert_eq!(
        db.list_collection_documents(&collection.id)
            .expect("list surviving collection membership")
            .into_iter()
            .map(|document| document.id)
            .collect::<Vec<_>>(),
        vec![other_id]
    );
    let foreign_key_violations: i64 = db
        .lock()
        .expect("lock database")
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .expect("check foreign-key constraints");
    assert_eq!(foreign_key_violations, 0);
    fs::remove_dir_all(temp_dir).expect("remove test directory");
}

#[test]
fn purge_rejects_attached_and_missing_roots_without_mutation() {
    let temp_dir = std::env::temp_dir().join(format!("clio-purge-eligibility-{}", Uuid::new_v4()));
    let available_path = temp_dir.join("available");
    let missing_path = temp_dir.join("missing");
    fs::create_dir_all(&available_path).expect("create available root");
    fs::create_dir_all(&missing_path).expect("create root to remove");
    fs::write(available_path.join("available.txt"), b"available").expect("write available source");
    fs::write(missing_path.join("missing.txt"), b"missing").expect("write missing source");

    let db = LibraryDb::open_in_memory().expect("open database");
    let available_root = db
        .add_root(&available_path.to_string_lossy(), Some("Available"))
        .expect("add available root");
    let missing_root = db
        .add_root(&missing_path.to_string_lossy(), Some("Missing"))
        .expect("add root to make missing");
    db.scan_root(&available_root.id)
        .expect("scan available root");
    db.scan_root(&missing_root.id).expect("scan missing root");

    let before_available = purge_catalog_snapshot(&db);
    assert!(db
        .preview_purge_root(&available_root.id)
        .unwrap_err()
        .contains("Only detached"));
    assert!(db
        .purge_root(&available_root.id)
        .unwrap_err()
        .contains("Only detached"));
    assert_eq!(purge_catalog_snapshot(&db), before_available);
    assert!(available_path.join("available.txt").exists());

    fs::remove_dir_all(&missing_path).expect("remove attached root directory");
    let before_missing = purge_catalog_snapshot(&db);
    assert!(db
        .preview_purge_root(&missing_root.id)
        .unwrap_err()
        .contains("Only detached"));
    assert!(db
        .purge_root(&missing_root.id)
        .unwrap_err()
        .contains("Only detached"));
    assert_eq!(purge_catalog_snapshot(&db), before_missing);
    assert!(db
        .list_roots()
        .expect("list roots after rejected purge")
        .iter()
        .any(|root| root.id == missing_root.id && root.attachment_state == "attached"));

    let missing_root_id = Uuid::new_v4().to_string();
    assert!(db
        .preview_purge_root(&missing_root_id)
        .unwrap_err()
        .contains("not found"));
    assert!(db
        .purge_root(&missing_root_id)
        .unwrap_err()
        .contains("not found"));
    assert_eq!(purge_catalog_snapshot(&db), before_missing);
    fs::remove_dir_all(temp_dir).expect("remove test directory");
}

#[test]
fn stale_purge_preview_does_not_authorize_purge_after_root_reattaches() {
    let temp_dir = std::env::temp_dir().join(format!("clio-purge-stale-{}", Uuid::new_v4()));
    let old_path = temp_dir.join("old");
    let new_path = temp_dir.join("new");
    fs::create_dir_all(&old_path).expect("create original root");
    fs::create_dir_all(&new_path).expect("create new root location");
    fs::write(old_path.join("book.txt"), b"book").expect("write source");

    let db = LibraryDb::open_in_memory().expect("open database");
    let root = db
        .add_root(&old_path.to_string_lossy(), Some("Rebound"))
        .expect("add root");
    db.scan_root(&root.id).expect("scan root");
    db.remove_root(&root.id).expect("detach root");
    let preview = db
        .preview_purge_root(&root.id)
        .expect("preview detached root");
    assert_eq!(preview.attachment_state, "detached");
    let locate_preview = db
        .preview_locate_root(&root.id, &new_path.to_string_lossy())
        .expect("preview root reattachment");
    db.confirm_locate_root(&locate_preview)
        .expect("reattach root before purge");
    let before_rejected_purge = purge_catalog_snapshot(&db);

    assert!(db
        .purge_root(&preview.root_id)
        .unwrap_err()
        .contains("Only detached"));
    assert_eq!(purge_catalog_snapshot(&db), before_rejected_purge);
    assert!(db
        .list_roots()
        .expect("list roots after stale purge")
        .iter()
        .any(|current| current.id == root.id && current.attachment_state == "attached"));
    assert!(old_path.join("book.txt").exists());
    assert!(new_path.exists());
    fs::remove_dir_all(temp_dir).expect("remove test directory");
}

#[test]
fn purge_waits_for_existing_scan_lock() {
    let temp_dir = std::env::temp_dir().join(format!("clio-purge-scan-lock-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create root");
    let db = LibraryDb::open_in_memory().expect("open database");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), Some("Detached"))
        .expect("add root");
    db.remove_root(&root.id).expect("detach root");

    let scan_guard = db.scan_lock.lock().expect("hold active scan lock");
    let thread_db = db.clone();
    let thread_root_id = root.id.clone();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    let purge_thread = std::thread::spawn(move || {
        started_tx.send(()).expect("signal purge attempt");
        finished_tx
            .send(thread_db.purge_root(&thread_root_id))
            .expect("send purge result");
    });
    started_rx.recv().expect("wait for purge attempt");
    assert!(matches!(
        finished_rx.recv_timeout(std::time::Duration::from_millis(50)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout)
    ));
    assert!(db
        .list_roots()
        .expect("root remains while scan lock is held")
        .iter()
        .any(|current| current.id == root.id));

    drop(scan_guard);
    finished_rx
        .recv_timeout(std::time::Duration::from_secs(1))
        .expect("purge finishes after scan lock releases")
        .expect("purge succeeds after scan lock releases");
    purge_thread.join().expect("join purge thread");
    assert!(db.list_roots().expect("list purged roots").is_empty());
    assert!(temp_dir.exists(), "purge leaves filesystem untouched");
    fs::remove_dir_all(temp_dir).expect("remove test directory");
}
