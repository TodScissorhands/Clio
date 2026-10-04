# Storage Core Architecture

Storage Core owns durable document metadata and the boundary between a source coordinate and a runtime read capability. Its catalog includes explicit desktop roots and scans, document/source metadata, collections, reading state, bookmarks, and annotations. It does not own document bytes, EPUB/PDF parsing, or conversion.

The frontend domain types, command adapters, and native Rust backend implementation are integrated into Tauri. The frontend adapts native DTOs into the domain types in `src/storage/domain.ts`; reader engines consume the resulting document record and ephemeral bytes.

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

SQLite schema version 5 stores library roots, document/source metadata, availability, collection membership, reading state, bookmarks, annotations, and metadata. It never stores document bytes or runtime reader tokens. Reading state and reader artifacts are keyed by opaque document IDs.

Scans are explicit, scoped to a selected root, and reconcile the catalog with the observed filesystem. A missing root is an observation, not a catalog mutation. Files absent from an existing scanned root are marked missing; missing records retain their metadata and reading state. “Remove from Library” excludes a record from active catalog views without deleting the source file, and later scans keep it excluded. Removing a document from a collection removes only that membership.

The current domain model represents reading positions as PDF page positions, EPUB CFI positions, or text scroll positions, with last-opened and update timestamps. It does not introduce a universal document AST or format-specific content database.

## Native command surface

The frontend adapters call Rust command contracts for root management and scans, document listing/opening/removal/relinking, collection workflows, metadata and thumbnails, reading state, bookmarks, annotations, and reader authorization. The registered command handlers are the native source of truth for exact DTO and error details.

Desktop Library roots are explicitly selected filesystem directories. The reader opens a catalog document through a session-only `StorageLocator`; `read_document_bytes` accepts its expiring token and not a raw path. Directly selected reader files use a separate native-open authorization path.

## Explicit non-goals

Storage Core does not add filesystem watchers, mobile content providers, cloud synchronization, or a conversion redesign. It does not store document bytes in SQLite or treat a raw path as document identity. Large-file streaming and range transport remain separate reader/storage follow-up work.
