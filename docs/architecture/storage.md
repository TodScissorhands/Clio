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

Scans are explicit, scoped to a selected root, and reconcile the catalog with the observed filesystem. Attached nested roots are ownership boundaries: whole-root scans prune their directories, and folder scans whose canonical start path is inside another attached root are rejected. A scan that reports filesystem observation errors reconciles only successfully observed files; it skips missing-document reconciliation, preserves unobserved document state, and does not advance the root's `last_scanned_at`. Missing roots are observations, not catalog mutations. Files absent from a complete observation of an existing scanned root are marked missing; missing records retain their metadata and reading state. “Remove from Library” excludes a record from active catalog views without deleting the source file, and later scans keep it excluded. Removing a document from a collection removes only that membership.

Detaching a root changes its attachment state without deleting the root, documents, source coordinates, exclusions, collection memberships, reading state, bookmarks, annotations, or physical files. Detached roots remain visible in root management with no availability; they are excluded from scans, active document and collection browsing, and library-path/reader authorization. Operations that explicitly list or scan a detached root reject it. Detach also revokes all library-issued reader tokens associated with that root; directly opened tokens are independent and are not revoked by root detachment. The reader authorization registry lock serializes library-token minting and reads with detachment: when Detach returns, no later read can use a revoked library token, while a read that acquired the lock first may complete before Detach returns. Locate Root provides a read-only preview and a confirmation that rechecks eligibility and overlaps in an immediate transaction, then updates only the existing root's locator, attachment state, and update timestamp. Successful confirmation also revokes tokens issued for the old root location under the same registry lock; direct-open tokens remain independent, and any in-flight read holding the lock completes before confirmation returns. It accepts detached or attached-missing roots; attached, available roots must first be detached. Purge is available only for detached roots: preview reports counts for root documents, reading states, bookmarks, annotations, metadata, and collection memberships. Execution rechecks attachment state in an immediate transaction, cascades database-owned document state, preserves collection records, and leaves physical source and thumbnail files untouched. It waits for the existing scan lock and revokes root-associated library tokens under the reader authorization lock; reads already holding that lock finish before Purge returns, and subsequent reads with revoked tokens fail. Filesystem changes cannot be serialized with SQLite.
Library path resolution holds the same reader-authorization registry lock as Detach through active-document lookup and canonical path resolution. This orders concurrent resolution with Detach but cannot revoke a raw path already returned. ConversionWorkspace marks library-origin conversion inputs with their document IDs; native execution rechecks each ID-to-path mapping under that registry lock and holds it through conversion, so Detach waits for an already-running library-backed conversion. Direct-path conversion inputs remain independent.


Relink selects destinations only from attached filesystem roots. When legacy attached roots overlap, Relink and external add select the deepest canonical component-contained root, with root ID as a deterministic tie-breaker. Existing roots and document ownership are not merged or automatically reassigned. Relink preserves the document's exclusion state, which remains keyed to its stable document ID.

The current domain model represents reading positions as PDF page positions, EPUB CFI positions, or text scroll positions, with last-opened and update timestamps. It does not introduce a universal document AST or format-specific content database.

## Native command surface

The frontend adapters call Rust command contracts for root management and scans, document listing/opening/removal/relinking, collection workflows, metadata and thumbnails, reading state, bookmarks, annotations, and reader authorization. Locate Root is exposed through the registered `library_root_locate_preview` and `library_root_locate_confirm` commands; Purge uses `library_root_purge_preview` and `library_root_purge`. Previews are informational, and execution revalidates current backend state.

Desktop Library roots are explicitly selected filesystem directories. The reader opens a catalog document through a session-only `StorageLocator`; `read_document_bytes` accepts its expiring token and not a raw path. Directly selected reader files use a separate native-open authorization path.

## Explicit non-goals

Storage Core does not add filesystem watchers, mobile content providers, cloud synchronization, or a conversion redesign. It does not store document bytes in SQLite or treat a raw path as document identity. Large-file streaming and range transport remain separate reader/storage follow-up work.
