# Product Implementation Roadmap

**Status:** Working plan. No stage below is claimed as implemented by this roadmap. The seven product-design stages are defined in the [authoritative Balanced Hybrid contract](product-design-contract.md); stages 8–10 below are a proposed product-completion plan, not stages validated by that contract.

Implement and validate each stage before progressing. A stage's completion means its acceptance criteria are met, relevant regressions pass, and actual runtime behavior is verified where the surface requires it—not merely that code compiles. Routine implementation details may improve without reopening settled design decisions. Architectural changes and explicit approval gates remain binding.

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

## Stage discipline

- Each stage must be implemented, reviewed, and validated before progressing. If validation finds a blocker, resolve it or revise the plan explicitly; do not mark the stage complete by narrowing its criteria.
- Preserve existing capabilities and format-specific ownership. Do not treat this roadmap as permission for a framework, database, schema, renderer, security-policy, or dependency change.
- Stage 7 is an approval gate, not automatic authorization. Durable PDF locator/restoration work must wait for explicit approval of locator semantics; any schema migration for it needs its own explicit approval.
- Stages 8–10 are proposed product-completion sequencing. Their inclusion is not evidence that work has started, passed validation, or was covered by the design contract's seven-stage plan.
- Routine details can be improved from implementation evidence without reopening Balanced Hybrid. Genuine architectural changes and named approval gates remain binding.

See [Product Design Contract](product-design-contract.md) for approved interaction, visual, architecture, format-specific, and evidence constraints. The existing [project roadmap](roadmap.md) records broader product history and capabilities; this document is the staged roadmap for the design-contract implementation work, not a replacement for that history.
