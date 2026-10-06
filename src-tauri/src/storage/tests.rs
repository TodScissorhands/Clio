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
    assert_eq!(version, 5);
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

    let roots = db.list_roots().expect("list roots");
    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].id, root.id);

    db.remove_root(&root.id).expect("remove root");
    let roots_after = db.list_roots().expect("list roots after remove");
    assert!(roots_after.is_empty());

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
        .open_library_document(doc_id, |path| {
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

    let missing_open = db.open_library_document("nonexistent-id", |_| Ok("token".to_string()));
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
fn test_bookmark_crud_validation_and_cascade_delete() {
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

    // 10. Cascade delete on document/root deletion
    db.remove_root(&root.id).expect("remove root");
    let after_cascade = db.list_bookmarks(&doc_id).expect("list after cascade");
    assert!(after_cascade.is_empty());

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_annotation_crud_and_cascade_delete() {
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

    // 8. Cascade delete: removing root deletes annotations.
    db.remove_root(&root.id).expect("remove root");
    let after_cascade = db.list_annotations(&doc_id).expect("list after cascade");
    assert!(after_cascade.is_empty());

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

    // 6. Delete document (via root remove): membership cleaned up, collection intact
    db.remove_root(&root.id).expect("remove root");
    assert_eq!(db.list_documents(None, false).expect("list").len(), 0);
    let c1_after_root_delete = db.list_collections().expect("list cols");
    assert_eq!(c1_after_root_delete[0].document_count, 0);

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_document_read_context_preserves_listing_semantics() {
    let temp_dir = std::env::temp_dir().join(format!("clio-read-context-{}", Uuid::new_v4()));
    let other_dir = temp_dir.join("other-root");
    fs::create_dir_all(&other_dir).expect("create other root");
    fs::write(temp_dir.join("missing.txt"), b"missing").expect("write missing document");
    fs::write(temp_dir.join("excluded.txt"), b"excluded").expect("write excluded document");
    fs::write(temp_dir.join("rich.txt"), b"rich").expect("write rich document");
    fs::write(temp_dir.join("plain.txt"), b"plain").expect("write plain document");
    fs::write(other_dir.join("other.txt"), b"other").expect("write other document");

    let db = LibraryDb::open_in_memory().expect("open db");
    let root = db
        .add_root(&temp_dir.to_string_lossy(), Some("Primary"))
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

    fs::remove_file(temp_dir.join("missing.txt")).expect("remove missing document");
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
