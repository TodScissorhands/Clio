# Clio Product Design Contract

**Status:** Authoritative product-design foundation for future implementation. The overall direction is chosen; this document consolidates it into product and interaction rules.<br>
**Direction:** **Balanced Hybrid** — quiet precision, restrained editorial warmth, local-source orientation, content-first reading, and contextual controls. This is the approved direction, not an open selection question.<br>
**Implementation authority:** Documentation only; this contract does not authorize production changes.<br>
**Evidence labels:** **Current** = verified in source; **Decision** = approved design direction/default; **Implementation guidance** = practical translation; **Known limitation** = behavior not established; **Proposal** = future capability, not current functionality.

## 1. Authority and decision order

This contract supersedes earlier open design questions where it states a decision. The selected direction is D — Balanced Hybrid Contextual Model. A and B are historical comparison cases, not live alternatives to choose again. Prior audits and prototypes remain evidence for constraints and trade-offs, not proof of production behavior.

When details conflict, use this order:

1. Product invariants and architectural boundaries here.
2. Settled design decisions and practical defaults here.
3. Current implementation behavior where the contract does not change it.
4. Local implementation judgment for flexible details.

This is a shared foundation, not a pixel-perfect prescription. Improve routine details when concrete evidence shows a clearer, more accessible, maintainable, or better-performing solution. Reopen a settled rule only for new technical evidence, an accessibility need, or a demonstrated usability failure—not because another aesthetic alternative is possible.

### Repository baseline and verification status

The contract was prepared against Clio's production `main` source. Its prior audit baseline was `ae8f0fff756b3d9dcfb6d224ba2d656a1e3252000`; this tracked contract is a design decision record, not a claim that the source still matches that historical state. Check the current checkout and applicable source before implementation. No build, test, GUI/runtime, contrast, accessibility, or performance validation is claimed by this contract. Do not treat prototype walkthroughs or static inspection as production evidence.

## 2. Product principles and architecture

### Product principles

1. **Local documents remain central.** User-selected filesystem roots are authoritative for document bytes. Library organization and reader state help find and resume local documents; they imply neither cloud ownership nor accounts.
2. **Orientation where it matters; quietness where it matters.** Library keeps understandable source and collection navigation. A ready PDF prioritizes its page. EPUB keeps comfortable, discoverable controls for reflowable reading.
3. **One interaction language, not one layout.** Navigation, focus, selection, controls, dialogs, spacing, and theme semantics should feel related. Library, PDF, EPUB, and tools remain task-specific compositions.
4. **Visible paths for essential actions.** Shortcuts and any future command surface supplement visible controls; they do not replace pointer/touch access.
5. **Context beats permanent clutter.** Put document details/actions near a focused or selected object when useful. Use overlays for reader navigation rather than permanently shrinking the page.
6. **Truthful state and capability.** Distinguish loading, empty, error, and no-results. Never present proposed, simulated, or unsupported functionality as implemented.
7. **Preserve working infrastructure.** Keep the Tauri 2, React/TypeScript, Rust, and SQLite architecture; format-neutral reader boundary; PDF.js and Foliate.js engines; and locally maintained shadcn-style/Radix/Tailwind/Lucide component system. Replace only for a concrete evidenced limitation and separate approval.

### Ownership boundaries

- `App` owns route composition, application theme, app-level menus, and opening Library/tools/reader surfaces.
- `LibraryView` and its children own catalog presentation and Library interactions. Native filesystem operations remain behind Rust/native services. SQLite stores catalog and user-state data, not user document bytes.
- `ReaderShell` owns shared reader chrome, Find, navigation panels, reader-level state, keyboard handling, bookmarks, and annotation-list interaction. `ReaderEngineHandle` is the format-neutral command boundary.
- `PdfEngine` owns PDF.js loading, page rendering, PDF navigation, and text geometry. `EpubEngine` owns Foliate pagination, TOC/CFI, EPUB display behavior, and EPUB-specific overlays.
- Keep PDF.js and Foliate implementation types out of the shared shell. New PDF-only capabilities use a narrow engine capability/adapter, not a universal document model.
- Keep filesystem access, native dialogs, and conversion execution behind Rust/Tauri and current capability boundaries. Do not add a database, schema migration, format, framework, or dependency as a styling shortcut.

## 3. Balanced Hybrid visual system

### Identity and materials

**Decision:** Evolve Clio's identity rather than replacing it. Use warm blue as the principal interactive accent, graphite/navy as a dark-shell direction, calm light application surfaces, and restrained editorial warmth. Develop light and dark as paired themes; do not mechanically invert one palette into the other.

- Use blue for meaningful interaction—primary action, selected navigation, links, and focus relationships—not ambient decoration. Keep warning, error, success, and format/status colors semantically distinct.
- Use precise sans-serif UI typography; editorial serif for reading content where appropriate, especially EPUB; monospace for paths, page counts, shortcut labels, and terse technical metadata. Do not make all reader chrome serif or all tools monospace.
- Prefer clear alignment, compact grouping, deliberate small radii, thin boundaries, and restrained shadows. Avoid giant cards, excessive pills, thick outlines, ornamental gradients/glows, gratuitous animation, and generic glassmorphism.
- Solid surfaces are the default for menus, dialogs, navigation panels, and controls over variable document content. Translucency is not required and must not composite over or alter PDF pixels.
- Preserve useful existing geometry and conventions; do not block implementation over marginal color, font, radius, or pixel-value disagreements.

### Tokens and components

Use `src/index.css` semantic variables as the canonical color/font/radius map. Keep `src/App.css` legacy aliases as compatibility mappings while touched components migrate; it also contains active type/radius/shadow/status scales. Keep intentional reader-specific roles scoped in `src/reader/ReaderShell.css`, but avoid a third competing global palette.

Reuse existing `src/components/ui/` Button, Input, DropdownMenu, Sheet, Sidebar, Tooltip, Separator, and Tailwind/Radix/Lucide components where they fit. Standardize newly touched common controls incrementally; do not mass-convert local markup or custom Library icons. Reconcile one-off reader glyphs/styles only when their surface is changed.

Do not finalize numeric colors, a packaged font, blur/opacity/shadow values, or a new token ladder here. Use the existing 4px-oriented spacing vocabulary and existing type/control/radius roles as starting points. Essential labels must remain legible; smallest text is for secondary technical metadata, not primary actions or progress.

### Theme boundaries — binding

- **Application theme** controls Library, menus, dialogs, tools, shared reader chrome, and surrounding application surfaces. System/light/dark remain application-level choices.
- **EPUB reading theme** is a separate content preference: light/sepia/dark applies to the reflowable EPUB reading surface, not the application shell. EPUB font, size, line height, paragraph spacing, and content width remain EPUB-specific controls.
- **PDF** application theme may change surrounding shell and reader controls only. The rendered PDF page/canvas is immutable with respect to shell theme and overlay style.
- Future preferences stay scoped: global appearance/accessibility at app level; reading typography/theme near EPUB. There is no active Settings screen; do not create one as part of this contract.

**PDF page-integrity invariant:** Never tint, invert, filter, blur, dim, or change opacity of the PDF page/canvas. Do not apply a translucent scrim over it. Controls may sit on solid bounded surfaces at the page edge, but cannot apply an effect to the page. A blocking PDF-reader dialog must not darken the page through a scrim; use solid/opaque modal backing that covers rather than composites with the page, or present it outside the document surface.

## 4. Cross-application interaction contract

### Action placement and discovery

Organize actions by intent: location/navigation (Library scope/source tree, Reader Back, PDF page, EPUB chapter/CFI, TOC/bookmarks/notes); current-view controls (Library sort/layout, PDF zoom/page display, EPUB typography/theme, tool mode/inputs); object/context actions (properties, locate/reveal, collection membership, conversion, merge/extract, bookmark, selected-text actions); global discovery (app menu, current Library-scoped Quick Open, shortcut help, any future command palette).

Keep common actions visible or one clearly labeled action away. Context menus and shortcuts are alternatives, not the only paths. Quick Open remains Library-scoped with fixed actions; it is not a global reader command registry. A full command palette is not required for workflows in this contract.

### Focus, selection, keyboard, and touch

- Keyboard focus and document selection are different states. Show distinct visual and semantic states; expose selection counts/actions explicitly.
- Use `:focus-visible` or equivalent, meaningful labels, predictable tab order, and a visible route to reveal hidden reader controls. Hover is supplementary only.
- Reader shortcuts must not consume keystrokes from inputs, textareas, selects, editable content, or an active dialog. Keep the input guard and update shortcut reference when behavior changes.
- Transient reader controls must not auto-hide while focus, pointer interaction, an open menu/panel, Find, text selection, or note editing remains active. Restart hide timer only after interaction ends.
- Provide click/tap alternatives for edge-reveal behavior. Keep coarse-pointer targets comfortably reachable, preserving existing 40px convention where applicable; this is a design target, not a claim of WCAG compliance.
- **Escape:** dismiss only the topmost active layer/state first. Within a panel, close active edit/input before its parent. Dialog/menu/panel closes before reader chrome. A subsequent Escape may hide transient PDF controls; Escape never navigates Back or silently clears unrelated Library selection. Restore focus to invoking control if it exists.
- Cancelling a dialog preserves the Library selection and search/scope state that opened it.

### Surfaces, loading, and feedback

Use solid theme-aware elevated surfaces with restrained boundaries/shadows for popovers, dialogs, Navigator panels, and transient controls. A non-modal reader Navigator must not resize or dim the PDF page. Blocking task dialogs and non-modal navigation panels are different interactions; do not make every panel modal.

Keep loading, genuine empty, filtered no-results, missing-source, error, success, and disabled states distinct. Communicate state changes with text/status, not color alone. Preserve `prefers-reduced-motion`; avoid layout-shifting controls and broad-area filters/animation. Reduced motion must suppress smooth scrolling where it conflicts with preference. Check contrast and control visibility over light, dark, and visually busy content; no accessibility or performance result is presumed here.

## 5. Screen-by-screen requirements

### 5.1 Application shell

**Decision:** Quiet and comprehensible, not a persistent command center. Keep the current Library/document route model and clear path back to Library. Keep application appearance, open-document, shortcut-help, tools, and About actions in the app menu or current appropriate surfaces.

Preserve shell route/local-state responsibilities; use a shared title/location hierarchy and consistent menus, focus, and theme tokens. Keep Quick Open's scope explicit. Do not add dashboard tabs, workspaces, cloud/account affordances, or Settings route.

**Acceptance:** route/back behavior intact; app theme understandable; route/document context not duplicated across headings; global actions keyboard and pointer/touch accessible; light/dark shell coherent.

### 5.2 Library

**Decision — hierarchy and defaults:**

1. Source navigation expanded on desktop; roots/folders, All Documents, and Collections remain distinct. Narrow windows use a source drawer with visible open/close control. When collapsed, selected folder/collection and search scope remain understandable and the tree is directly restorable.
2. Continue Reading compact and subordinate to results. Keep title, author, chapter/position, progress, and Resume understandable; do not displace most results vertically.
3. Keep search and active source/scope visible. Label current behavior as document metadata/path search, never body/full-text search. A future full-text index is outside this contract.
4. Retain grid/list, sorting, scope, and existing actions. Distinguish keyboard/pointer focus from selection. Multi-select activates explicit action bar; selection is not inferred from focus.
5. Show path, metadata, reading position, and relevant actions contextually on focus/selection or via Properties/context menu. Do not make a permanent inspector the default. Preserve document menus and direct keyboard path.

**Known limitation:** `useLibraryCatalog` currently distinguishes loading, ready, and error states. The earlier empty-array/initial-loading concern is superseded by the implemented state model; native runtime behavior must be judged from the verification evidence in current status, not inferred from source alone. Library cover thumbnails are not PDF page thumbnails.

**Acceptance:** initial loading is not presented as confirmed empty; zero roots, empty folder/collection, filtered no-results, and initial-load failure have different useful messages/actions; scope remains visible when navigation collapses; metadata/path scope is explicit; focus and selection differ; dialog cancel preserves selection; compact Continue and grid/list retain essential metadata; narrow mode has no clipped source/search/action controls.

### 5.3 PDF reader

**Decision — ready state and controls:** open into content-first ready state after document loading and position restoration; no delayed permanent toolbar on first open. Use **solid transient controls** and a visible, keyboard-focusable **Show controls** affordance outside the hidden toolbar, plus pointer-edge and documented keyboard reveal routes. Shortcut/palette alone is insufficient. When no layer is open, Escape reveals hidden controls; after closing a topmost layer, a later Escape may hide visible controls.

Hide only after deliberate idle interval when focus, hover/pointer, Find, Navigator, menu, selection, note editor, and other active accessibility interaction are absent. Show readable page progress/navigation with controls. **Initial progress default:** no always-visible strip/edge indicator in ready state; expose `current / total` with revealed controls and keep programmatic progress status. If implementation testing demonstrates lost orientation, make one targeted adjustment without reopening product direction. Group document/back/actions, Find, Navigator/outline, page/zoom, and display; use compact grouping/overflow rather than clipping.

**Loading concern:** source suggests engine loading after position restoration may lack visible progress; this is not a confirmed runtime defect. Stage 3 verifies transition through engine `ready` or `error` and truthful loading state.

The design decision remains a floating solid Navigator overlay; it does not reserve width, change page layout, or dim the page. Contents/outline, Bookmarks, and Notes stay distinct. **Current implementation discrepancy:** Stage 3 worktree currently uses a docked workspace. This conflict is unresolved and requires explicit product approval; do not treat the implementation as an approved design change.

Direct page entry, Fit Width/Fit Page, and bounded page-thumbnail rendering are present in the current Stage 3 worktree. Their acceptance remains incomplete; see [Current Status](status/current.md). Thumbnails must be lazy, bounded, cancellable, and must not render/cache every page at full size.

**Current limits:** outline/TOC navigation, page turns, manual zoom, page-level search/counts, bookmarks, and annotation/note-list UI exist. PDF search has no in-page match geometry. The legacy selection pathway uses a temporary text preview, but that preview is suppressed; actual PDF text selection/copy is not currently provided by it, and PDF.js TextLayer is not integrated. `pdf-page-text` stores page plus selected text and is non-durable. `PdfEngine` receives annotations but does not render them. Do not claim stored PDF highlights restore visually.

**Acceptance:** page unobstructed by permanent chrome; explicit reveal works keyboard and pointer/touch; hidden controls discoverable; focus/hover/open-layer prevents premature hiding; Escape follows stack; Find/Navigator do not move page; page pixels unaffected by theme/overlays; progress available to assistive tech and after reveal; existing outline, position restore, page turns, bookmarks, errors remain usable.

### 5.4 EPUB reader

**Decision:** share Reader Back, Find, Navigator, focus, Escape, menu, and visual conventions, but keep format-specific control profile. Start with a **compact persistent EPUB toolbar/affordance** for chapter position/progress, Contents, Find, and Display. Typography/theme controls are explicitly discoverable in labeled Display surface. At narrow widths adapt/overflow without dropping essential action or forcing PDF controls into layout.

Keep Foliate reflowable/paginated model and CFI progress/annotation semantics. Contents is chapter navigation, not page-thumbnail rail. Font family/size, line height, paragraph spacing, content width, and light/sepia/dark theme are EPUB-specific. Do not hide EPUB controls merely because PDF controls are transient. Compact toolbar placement can be adjusted for concrete width/focus/discoverability problem; format distinction remains settled.

**Current:** Foliate TOC, relocation/CFI, display settings, Find, and CFI-backed annotation overlays exist. Current status records a prior native exercise of EPUB theme/font/Find/selection/restore; this contract has not independently revalidated that evidence. Cross-surface theme/background integration remains a candidate for the consolidated UI consistency review in the canonical roadmap.

**Acceptance:** Contents, Find, chapter/progress, typography/theme are pointer/keyboard/narrow-window accessible; EPUB theme changes content only, not shell or PDF; CFI position and stored CFI highlights restore; settings are not confused with PDF page numbers; no Foliate loading/security/iframe boundary changes in visual work.

### 5.5 Document actions and tools

ConversionWorkspace supports conversion, PDF merge, and page extraction with idle/converting/done/error states, capability-aware choices, overwrite handling, and native save dialogs. Poppler/Pandoc and native operations remain supported capability boundary; tools may be modal, not a separate active route.

Keep tools denser than Library/reading. Align typography, controls, focus, separators, dialogs, status, responsive behavior without making tools look like a document page. State source, output, format/capability, destructive/overwrite effect, result, and recovery action clearly. Never imply unsupported operation.

Show only progress the native operation reports; otherwise honest indeterminate working state. Current UI does not establish safe in-flight cancellation. A pre-execution cancel/close path remains where available; do not add fake Cancel button. In-flight cancellation requires explicit native cancellation contract and observable stopped state.

**Acceptance:** conversion/merge/extract and overwrite confirmation intact; failures visible/recoverable; native dialog cancellation starts no operation; no false determinate progress/cancellation; results identify output and source impact; narrow forms usable.

### 5.6 Dialogs, menus, contextual surfaces

Keep dialogs task-specific but align surface, title/body/footer hierarchy, boundaries, focus, close behavior, and theme. Use existing Radix wrappers where appropriate; no blanket rewrite/general Dialog abstraction requirement.

Dialogs have useful title/description, move focus in, contain modal focus, close via explicit control and Escape where safe, and return focus to opener. Innermost confirmation/editor closes first. Destructive remove/overwrite clearly names affected documents. Cancel executes nothing and preserves Library selection/scope/search. Menus are keyboard navigable and dismiss predictably; essential actions are not hover-only. Non-modal Navigator is not a dialog and has no modal focus/scrim. Blocking reader task obeys PDF page-integrity rule.

**Known limitation:** dialogs mix feature-local markup and shared modal CSS. Static review did not establish consistent focus trap/initial-focus/return-focus; validate before deciding whether shared primitive infrastructure is needed.

**Acceptance:** active dialogs have visible focus, title/description, keyboard actions, ordered Escape, focus return, narrow fit/scroll, and cancel preservation; menus/panels do not clear unrelated state; PDF is not dimmed by scrim.

### 5.7 Settings and preferences

There is **no active Settings screen or route**. `.settings-view` CSS is not proof of a rendered page. App appearance is in app menu; reader display preferences in Reader Display. Do not create a Settings page in visual pass. Keep app theme global and EPUB reading theme/typography reader-specific. Any later authorized Settings surface must not duplicate reader-owned controls or create another source of truth. No preference persistence model is authorized here.

## 6. Capability truth table

| Capability | Current status | Contract treatment |
|---|---|---|
| Tauri 2, React/TypeScript, Rust, SQLite; shared reader shell/engine boundary | Existing | Preserve; no framework/database/universal renderer replacement. |
| Library roots/folders, collections, grid/list, sorting, metadata/path search, Continue, selection/context | Existing | Preserve behavior; refine hierarchy/state. Search is not body search. |
| Library initial loading distinct from empty | Implemented state model | `useLibraryCatalog` tracks loading/ready/error; preserve truthful messages and refer to current status for recorded runtime evidence. |
| App System/Light/Dark theme | Existing | App-level; owns application/shared chrome under target theme contract. |
| Reader Display theme and EPUB typography | Existing, separately scoped in source | Keep EPUB content theme independent from app chrome; reconcile reader-chrome coupling during implementation. |
| Quick Open/shortcut reference | Existing, Library-scoped | Keep scope honest; no full reader-wide command palette implied. |
| PDF outline, page turns, manual zoom, progress, page-level Find count | Existing | Retain; present appropriately in controls/Navigator. |
| PDF direct page field, Fit Width/Fit Page, bounded page thumbnails | Present in current Stage 3 worktree; acceptance incomplete | Verify per current status; preserve one-page main renderer and bounded/cancellable thumbnails. |
| PDF.js TextLayer, selectable page text, geometry search marks | Absent | Separate future capability; current temporary text preview is suppressed. |
| PDF stored notes/annotations | Partial | Records/list/note operations exist; visible highlight restore is not durable or implemented. Preserve truth/legacy notes. |
| EPUB TOC, CFI progress/selection/annotation overlay, Find, display settings | Existing | Preserve Foliate/CFI; align presentation only. |
| Global palette, custom shortcut registry, Settings page | Absent/future | Not required; essential workflows remain visible. |
| Conversion, PDF merge, extraction | Existing | Preserve supported operations/errors; no safe cancellation claim without native support. |
| Prototype-only controls/data | Synthetic | Design evidence only; not production functionality. |

## 7. Historical implementation acceptance criteria

The following stage criteria are retained as historical acceptance records, not as a current sequence or a second roadmap. Use [Clio Roadmap](roadmap.md) for forward-looking commitments and [Current Status](status/current.md) for implementation and verification evidence.

### Stage 1 — Shared visual foundation

Consolidate semantic color/surface, typography, spacing, radius, boundary, focus, icon, control, and status roles using current CSS-variable/component system; develop light/dark together; start warm-blue/graphite-navy direction without locking numeric values absent implementation/contrast evidence. No new design framework/font dependency, glass default, bulk CSS rewrite, or feature changes. Inspect `src/index.css`, `src/App.css`, `src/reader/ReaderShell.css`, `src/components/ui/`, and Library styles/icons.

**Acceptance/checks:** one clear semantic role per shared surface/state; aliases compatible and no competing palette; light/dark text, selected/disabled/status/focus coherent; PDF unfiltered; reuse shared controls when touched; no arbitrary token expansion. Run frontend type/build/tests as appropriate; visually inspect app, Library, dialogs, tools, PDF/EPUB chrome in light/dark; keyboard focus, reduced motion, contrast. The source audit performed none. Respect independent app/EPUB themes.

### Stage 2 — Application shell and Library hierarchy

Apply foundation to shell/Library; desktop source navigation expanded and narrow drawer; visible search/scope; compact Continue; contextual details; grid/list; clear focus/selection/batch actions. Add initial loading/error only after confirming catalog IPC completion contract. No full-text indexing, permanent inspector, route redesign, cloud/workspaces, or Settings. Inspect `src/App.tsx`, navigation and Library components/catalog hook.

**Acceptance/checks:** roots/folders/collections, search, sorting, grid/list, selection/actions work; collapsed source preserves scope and restore path; metadata/path search explicit; Continue compact and complete; focus differs from selection; initial load, true/scoped empty, no results, load error distinguishable; cancel preserves state; narrow layout reachable. Targeted tests and manual root/folder/collection/search/sort/view/selection/context, IPC success/failure/empty, narrow layout. Do not call loading a defect before reproducing. Depends on Stage 1; no schema change.

### Stage 3 — PDF reader shell and navigation controls

Implement content-first ready state, solid transient toolbar, visible reveal, keyboard/pointer/touch paths, focus/hover holds, deterministic Escape, floating non-dimming Navigator; progress in controls by default. Add direct page input, actual-size/fit modes, `current / total`, lazy PDF Pages thumbnails through narrow engine-neutral APIs. Retain outline/bookmarks/notes. No continuous scroll, engine replacement, TextLayer/search geometry, annotation restoration, page filters, or Acrobat parity.

**Acceptance/checks:** restored PDF opens without toolbar/always-on progress strip; visible focusable reveal without hover/shortcut; no hiding during active interactions; correct Escape; no page shift/dim/theme effect; invalid/out-of-range page rejected and correction announced; fit respects rotation/viewport; thumbnails lazy/bounded/cancelled/current-page-aware; 100% actual size and one-page rendering remain; existing functionality regresses cleanly. Focused tests for bounds, zoom/modes, fit, cancellation, Escape/visibility; actual Tauri/WebView wide/narrow, keyboard/pointer/coarse-pointer, light/dark/busy-page smoke; inspect screenshots and page pixels. Measure performance. Depends on Stage 1 and existing progress/navigation contracts; optional paginated capability only, never expose PDF.js objects to shell. Verify loading through engine ready/error.

### Stage 4 — EPUB reading ergonomics

Align shared tokens/interactions; compact persistent EPUB affordance for chapter/progress, Contents, Find, Display. Preserve distinct typography/theme, CFI position, pagination, selection, annotations. No PDF page/zoom controls, Foliate replacement, containment/security/lifecycle change, account/cloud.

**Acceptance/checks:** compact discoverable controls; EPUB typography and light/sepia/dark affect content only; Find/Contents/progress/keyboard/selection at narrow width; CFI position/highlights restore; shell theme independent; PDF unchanged. Reader tests and actual Foliate WebView smoke for open/restore, TOC, Find, display, selection/highlight, Escape/focus, narrow window. No security experiment/renderer-policy change in visual acceptance. Depends on Stage 1 and Stage 3 common shell behavior.

### Stage 5 — Dialogs, menus, tools, operation feedback

Align modal/popover surfaces, hierarchy, focus management, Escape, focus return, responsive layout, tool status/error/recovery/overwrite. Reconcile one-off styling only on touched surfaces. Preserve conversion/merge/extract. No new operations, engine changes, fake progress/cancellation, or blanket workflow redesign.

**Acceptance/checks:** active modals accessible name/description, initial/contained/visible focus, ordered Escape, focus return, narrow behavior; cancel retains selection and starts no operation; overwrite explicit; tool states retained; cancellation only with safe native support; PDF never dimmed by scrim. Keyboard walkthrough every active dialog/menu; cancel/selection, overwrite, operations success/failure, narrow/theme; regression tests for consumer-visible transitions. Depends on shared roles/Escape model; current focus consistency and safe native cancellation unverified.

### Stage 6 — PDF.js TextLayer, selection, search geometry

Add scoped PDF.js TextLayer aligned to single-page canvas; replace preview as selection substrate; map search matches to page-local geometry; keep selection, Find, stored annotation overlays independent. Capture page plus selection geometry for later locator gate. No persisted/restored PDF highlights, full viewer, continuous scroll, renderer replacement, or schema change.

**Acceptance/checks:** select/copy real PDF text; map offsets across items, normalized whitespace, ligatures, line breaks/hyphenation, rotation/crop/zoom/resize; distinguish active match; same-page cycling updates geometry; clearing Find removes only search overlays; saved selection uses captured page; stale/cancelled work cannot replace current layers; clean page/document/unmount; canvas remains single-page/unfiltered. Synthetic-PDF tests for these boundaries/cases plus actual Tauri WebView selection/copy/keyboard smoke and geometry inspection at multiple sizes. No extra dependency expected; verify public PDF.js API/WebView, avoid full viewer CSS and PDF.js types crossing engine boundary.

### Stage 7 — PDF locator decision gate and durable restoration

**Explicit approval gate:** before any durable PDF locator/annotation restoration implementation, explicitly approve revision-aware locator contract, validation bounds, coordinate convention, source identity, stale-source UX, and legacy handling. A `pdf-page-region` + exact-source digest + normalized quads approach from prior PDF specification is a candidate only, not approved by mention here. Persist/render same-source marks only after approval and separate implementation authorization.

**Non-goals:** schema migration unless new evidence requires it and it receives separate explicit approval; silent migration of `pdf-page-text`; automatic text re-anchoring on changed source; annotation export/filter/editor features.

**Acceptance after approval:** same bytes restore across zoom/window/rotation/crop; changed bytes never show stale geometry and show unresolved state; legacy/null `pdf-page-text` remains readable but unpainted; selected text/note remain accessible; search and annotation geometry separate; no claim of durability until close/reopen demonstrated. Test validation/serialization, invalid bounds, same-source close/reopen, changed-source fail-closed, legacy records, rotation/crop, zoom/resize/lifecycle and actual PDF WebView. Measure hashing; verify Web Crypto availability/byte ownership before digest. Candidate shape does not require a schema migration, but proposal is neither accepted nor implemented. Depends on Stage 6 and explicit locator approval; until then PDF annotations are stored text/notes with non-restorable locations. EPUB CFI persistence stays separate.

## 8. Verification requirements and evidence limits

**No validation is claimed by this contract.** Future implementation must verify:

- Visual states: shell/Library light/dark, loading/empty/error/no-results/selection/dialogs; PDF ready/revealed/Find/Navigator/progress/selection; EPUB reading/Contents/Display/Find; tools idle/running/success/error/overwrite.
- Theme boundaries: app theme affects shell; EPUB theme affects EPUB content; PDF page unchanged across theme, zoom, Navigator, Find, dialogs. Capture page pixels and inspect CSS filters/opacity/tint/blur/scrim.
- Keyboard/focus: tab order, focus-visible/restore, shortcut input guards, focus holds, open menu/panel, Escape ordering, selection preservation, hidden-toolbar keyboard reveal.
- Pointer/touch/responsive: pointer-edge and visible reveal, touch/click, coarse hit areas, 640px and smaller, unclipped controls, drawer/overlay reachability.
- Accessibility: names/status announcements, reduced motion including smooth scrolling, forced colors where supported, text/non-text contrast and focus. Do not claim WCAG conformance absent real audit.
- Regression: Library navigation/search/sort/grid/list/Continue/selection/context; PDF open/restore/outline/pages/zoom/search/bookmarks; EPUB CFI/TOC/theme/search/annotations; dialogs/cancel/overwrite; conversion/merge/extract.
- Runtime/performance: actual supported Tauri WebView (Linux WebKitGTK at audit time), not only browser prototype. Measure thumbnail concurrency, fit canvas allocation, hashing, blur, animation. Prototype walkthrough is not production evidence.

### Phase 5.4 security experiment limitation

The Phase 5.4 experiment did **not** test child-frame isolation. This is a limit of the evidence, not evidence that child frames are isolated. Do not claim or imply a security guarantee from that experiment. More broadly, hostile EPUB containment, blob-origin/Tauri ACL/native-command reachability, sanitizer/CSP defense-in-depth, and renderer isolation must be described only to the extent actually tested; missing evidence remains unverified risk. Visual work must not change Foliate loading/security/iframe boundaries.

## 9. Approved decisions, proposals, limitations, and risks

- **Approved decisions:** Balanced Hybrid is selected; warm blue interaction accent direction, paired light/dark development, solid surfaces, content-first PDF controls with explicit reveal, compact persistent EPUB controls, scoped themes, PDF page-integrity invariant, engine ownership boundaries, and the PDF locator approval gate. A/B/D is not an open selection question.
- **Proposed improvements, not existing functionality:** PDF.js TextLayer/geometry search, durable PDF restoration after locator approval. Global command palette, custom shortcut registry, Settings page, full-text index, and new preference persistence are not required or authorized here.
- **Known limitations:** PDF `pdf-page-text` locator is non-durable and PDF annotations are not visually restored; PDF search has counts but no in-page match geometry; dialog focus behavior is not established by static review; the Navigator currently docks despite the floating-overlay design decision, and the conflict is unresolved; Stage 3 acceptance is incomplete.
- **Unverified risks:** contrast/accessibility/performance results, Tauri WebView behaviors not actually smoke-tested, exact theme combinations, focus trapping/restoration, and security boundaries without direct experiment. Never present unverified as guaranteed.

## 10. Flexibility and change policy

Flexible details include exact warm-blue hue, graphite/navy balance, neutral warmth, role font sizes, spacing/radius/icon/shadow values; toolbar grouping/overflow while essential actions remain discoverable and PDF stays content-first; small progress/EPUB toolbar adjustments after concrete checks; shared component versus local markup where behavior/tokens remain coherent; and whether a specific dialog is consolidated based on focus/maintenance evidence.

Routine refinements need no new design-selection round. Keep changes reviewable, preserve current capabilities, and document evidence behind meaningful deviations. Do not restart broad inspiration research or compare A/B/D absent concrete failure. Any deviation touching PDF page integrity, engine boundary, data contract, accessibility behavior, or unsupported operation requires appropriate review/authorization.

## 11. Reconciled history and repository references

This contract resolves prior differences: the Linear-reference study/prototype compared A/B/D without selection; the product owner direction now selects Balanced Hybrid. PDF UX's persistent PDF-only second row is superseded by content-first transient controls with visible reveal. Theme relationship, accent direction, PDF progress default, and compact persistent EPUB affordance are settled here; exact values remain flexible. Preserve Library behavior, not a frozen hierarchy. PDF direct page entry, fit modes, and bounded thumbnails are present in the current Stage 3 worktree but not yet accepted. TextLayer, geometry highlights, and durable PDF restoration remain future; see the canonical roadmap for current commitments and candidate design-review work.

Useful tracked references:

- [Current product status](status/current.md)
- [Reader foundation architecture](architecture/reader-foundation.md)
- [Reader hardening investigation](research/reader-hardening-investigation.md)
- [PDF operations investigation](research/pdf-operations-investigation.md)
- [Documentation roadmap](roadmap.md)

Implementation source boundaries: `src/App.tsx`; `src/navigation/navigation.ts`; `src/library/LibraryView.tsx`, `src/library/useLibraryCatalog.ts`; `src/reader/ReaderShell.tsx`, `src/reader/ReaderShell.css`, `src/reader/types.ts`, `src/reader/PdfEngine.tsx`, `src/reader/EpubEngine.tsx`; `src/storage/domain.ts`; `src/tools/ConversionWorkspace.tsx`; `src/index.css`, `src/App.css`, `src/components/ui/`.

---

**End state:** Balanced Hybrid is the chosen design contract. No production implementation is authorized by this document. Review it before opening a separate implementation task.
