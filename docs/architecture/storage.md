# Storage Core Architecture

Storage Core owns durable document metadata and the boundary between a source coordinate and a runtime read capability. It is deliberately small: desktop filesystem roots and scans, a minimal Library surface, tokenized reader opening, and durable reading state. It does not own document bytes, EPUB/PDF parsing, or conversion.

The frontend domain types, command adapters, and native Rust backend implementation are present and integrated into Tauri's builder setup and invoke handlers.
The frontend adapts native DTOs into the domain types in `src/storage/domain.ts`; reader engines consume only the resulting document record and ephemeral bytes.

```text
Library UI
   │
   ├── storage command adapters
   │
Rust Storage Core
   ├── SQLite metadata catalog
   ├── library roots and scans
   ├── DocumentRecord / SourceRef
   └── tokenized reader opening
          │
          └── StorageLocator → ephemeral Blob → ReaderShell/engine
```

## Identity and references

- `DocumentRecord.id` is an opaque UUID. It is stable catalog identity and is independent of a raw filesystem path, file size, or path/size combination.
- `DocumentRecord` contains metadata such as display name, normalized format, byte size, and timestamps. It does not contain document bytes or a reader token.
- `SourceRef` describes where a document comes from. A library source uses a root ID and root-relative path; a direct source may retain a platform source reference. A source coordinate is not a runtime authorization.
- `StorageLocator` is a runtime access capability. Desktop reader opening returns a session-only token; `read_document_bytes` accepts that token and not a raw path. Tokens are ephemeral and are never persisted in SQLite.
- A `StoredDocument` combines the record, source reference, and present/missing availability. A `LibraryRoot` identifies an explicitly opted-in desktop filesystem directory.

## Catalog boundary

SQLite stores document metadata, library-root metadata, source coordinates, availability-related catalog data, and reading state. It never stores document bytes, EPUB/PDF resources, or runtime reader tokens. Reading state is keyed by the opaque document ID. The catalog does not watch the filesystem: scans are explicit and reconcile the selected root.

The current domain model represents reading positions as PDF page positions or EPUB CFI positions (with optional progression), together with last-opened and update timestamps. It does not introduce a universal document AST or format-specific content database.

## Native command surface

The frontend adapters call the following Rust command contracts, which are implemented and registered in the native invoke handler:
| Command | Purpose |
| --- | --- |
| `library_root_add(path, label)` | Add or reopen an explicitly selected desktop directory. |
| `library_root_list()` | List configured library roots and their status. |
| `library_root_remove(rootId)` | Remove a root from the catalog. |
| `library_root_scan(rootId)` | Explicitly scan one root and reconcile document metadata. |
| `library_document_list(rootId, includeMissing)` | List catalog documents, optionally scoped to a root and including missing sources. |
| `library_document_open(documentId)` | Resolve a catalog document and issue a tokenized reader authorization. |
| `reader_open_selected(path)` | Authorize a directly selected reader file and issue a tokenized reader capability. |
| `read_document_bytes(token)` | Read bytes through an expiring token; raw filesystem paths are not accepted. |

The command names above are the frontend/native boundary. Their DTOs use camelCase at the Tauri boundary and are normalized by the frontend adapter; the native implementation remains the source of truth for schema and error details.

## Explicit non-goals

Storage Core does not add filesystem watchers, mobile content providers, collections, annotations, full-text search, cover caching, cloud synchronization, or a conversion redesign. It does not store document bytes in SQLite and does not make a raw path a document identity. Large-file streaming and range transport remain separate reader/storage follow-up work.
