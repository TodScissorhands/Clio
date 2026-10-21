# Superseded Product Implementation Plan — Historical Acceptance Record

**Disposition:** Superseded as a forward-looking plan by [Clio Roadmap](roadmap.md). This document is retained to preserve its acceptance criteria and design sequencing history. It does not describe current implementation status, authorize work, or provide a second roadmap. Use [Current Status](status/current.md) for implementation and recorded verification.

When this plan was active, a stage was considered complete only after its acceptance criteria, relevant regressions, and required runtime verification were met—not merely after compilation. The criteria below remain useful references, but their current disposition is recorded in the canonical roadmap and current status.

## Historical stage sequence

| # | Stage | Dependencies | High-level completion criteria |
|---|---|---|---|
| 1 | **Shared visual foundation** | None; preserve existing Tauri/React/Rust/SQLite and component boundaries. | Coherent semantic roles and paired light/dark themes; shared focus/control conventions; no PDF page effects; actual surface review. |
| 2 | **Application shell and Library** | Stage 1. | Route/theme conventions and Library hierarchy work across source navigation, scope/search, Continue, grid/list, selection, loading/empty/error, and narrow layouts; existing workflows regress. |
| 3 | **PDF reader controls and navigation** | Stage 1; existing reader progress/navigation contracts. | Content-first PDF ready state, discoverable transient controls, ordered Escape, non-dimming Navigator, page/zoom/fit navigation, bounded lazy thumbnails, and actual PDF page-integrity/runtime verification. |
| 4 | **EPUB reader ergonomics** | Stages 1 and 3 shared shell behavior. | Compact persistent EPUB controls; Contents, Find, progress, typography/theme remain accessible and EPUB-specific; CFI restore/highlights and actual Foliate runtime behavior verified. |
| 5 | **Dialogs, tools, and operation feedback** | Stages 1–3 shared surfaces and interaction conventions. | Dialog focus/close/return behavior, cancellation/selection preservation, overwrite handling, responsive tools, honest progress/errors/recovery, and real conversion workflows verified. |
| 6 | **PDF.js TextLayer and search geometry** | Stage 3 PDF surface; engine boundary retained. | Real text selection/copy and correctly aligned search geometry across relevant layout/render cases; lifecycle cleanup/cancellation; geometry verified in actual WebView. No persistence/restoration in this stage. |
| 7 | **Durable PDF annotation restoration** | Stage 6 geometry **and explicit approval of the locator contract**. Schema migration additionally requires separate explicit approval if evidence shows one is needed. | Same-source annotations restore; changed-source geometry fails closed; legacy records remain readable; close/reopen and actual WebView behavior demonstrated. No implementation before locator approval. |
| 8 | **Product-wide integration and regression** *(proposed completion plan)* | Stages 1–7 completed and individually validated; explicit Stage 7 gate satisfied before its scope. | Cross-surface theme, keyboard, focus, selection, navigation, dialog, and operation flows work together; full affected regression suite and integrated runtime walkthrough pass without claiming prototype evidence as production. |
| 9 | **Reliability, security, and performance** *(proposed completion plan)* | Stage 8 integrated baseline; threat/performance scope reviewed. | Relevant hostile-input boundaries, lifecycle/error recovery, accessibility, and resource/performance behavior are exercised and measured. Record untested areas as risks; do not infer guarantees, including child-frame isolation, from experiments that did not test them. |
| 10 | **Release readiness** *(proposed completion plan)* | Stages 8–9 accepted; release packaging/platform criteria explicitly defined. | Release build and supported-platform smoke checks pass; dependencies/capabilities and known limitations are documented; release checks and user-facing behavior are accurate. |

## Historical controls retained as decisions

- The former plan required each then-defined stage to be implemented, reviewed, and validated before progression. Its acceptance criteria remain historical evidence, not current sequencing.
- Preserve existing capabilities and format-specific ownership. This document does not authorize framework, database, schema, renderer, security-policy, or dependency changes.
- The Stage 7 locator approval gate remains in force as restated in the canonical roadmap. Durable PDF locator/restoration work requires explicit approval of locator semantics; any schema migration requires separate approval.
- Stages 8–10 were proposed product-completion sequencing, never approved commitments. Their inclusion is not evidence that work started or passed validation.
- Routine details could be improved from implementation evidence without reopening Balanced Hybrid. Genuine architectural changes and named approval gates remain binding.

The [Clio Roadmap](roadmap.md) is the only forward-looking plan. The [Product Design Contract](product-design-contract.md) retains normative interaction, visual, architecture, and evidence constraints; this file remains only as a historical acceptance record. Its proposed stages 8–10 were never approved commitments.
