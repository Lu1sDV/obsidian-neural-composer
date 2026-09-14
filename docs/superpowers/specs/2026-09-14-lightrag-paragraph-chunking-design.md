# Native LightRAG paragraph chunking

Date: 2026-09-14

Status: Approved architecture consolidated for written-specification review. Implementation is not authorized by this document alone.

Repository baseline: `07ab696` (`revert: keep LightRAG binary uploads as basenames`). Backend contract baseline: released LightRAG v1.5.7.

## 1. Goal and approved decisions

Expose LightRAG's native paragraph-semantic chunking through Neural Composer without modifying LightRAG or implementing a second chunker in TypeScript.

The user approved:

- An unmodified LightRAG backend with plugin-owned source mapping.
- Deterministic source identities using native Web Crypto SHA-256.
- Explicit policy migration: ordinary edits retain a document's recorded policy; changing settings affects new documents, not existing graph entries.
- Recoverable, non-atomic replacement of existing documents.
- Honest treatment of unknown legacy policies, including pausing automatic replacement until explicit policy adoption.
- Disabled external-image downloading as a prerequisite for native paragraph ingestion.

Success means actual parser-backed paragraph chunking, correct Obsidian source resolution, and safe lifecycle behavior across desktop, remote servers, mobile, and plugin reloads. An accepted HTTP request carrying a paragraph selector is not sufficient.

## 2. Evidence and current integration

LightRAG's paragraph strategy (`P`) consumes parser-generated `.blocks.jsonl`. It uses heading hierarchy, table-row boundaries, paragraph anchors, and hierarchy-aware merging. It can merge small sections and split large ones; it is not one paragraph per chunk. The chunking algorithm does not itself require embedding or LLM calls, although downstream graph extraction and embedding still do. Missing structural blocks cause recursive-character (`R`) fallback. [1][2]

The released text API accepts `chunking.strategy="paragraph_semantic"`, but enqueues raw text without structural parser input. Selecting P on that route therefore does not deliver native paragraph semantics. The upload route accepts a multipart file, resolves parser directives, and can produce the required blocks. Native parsing supports Markdown and DOCX; Markdown defaults to legacy parsing unless native is explicitly selected. [1][3]

The upload endpoint has no separate logical source-path or parser-settings body field. It rejects directory separators in filenames. Document identity and deduplication use canonical basenames, stripping recognized parser hints. Text-source normalization also canonicalizes basenames. A client sending a vault path does not establish that LightRAG preserves it. [1][3]

Current plugin boundaries:

| Area | Existing behavior and consequence |
| --- | --- |
| `src/core/rag/ragEngine.ts` | `insertDocument()` posts raw text to `/documents/texts`; `uploadDocument()` currently uploads `file.name`, not `file.path`. |
| `RAGEngine.ingestFile()` | Reads Markdown, prepends the existing `Title:` preamble, and uses the text route. |
| `src/main.ts` | Current-file and folder ingestion duplicate preparation instead of consistently calling `ingestFile()`. |
| `RAGEngine.reindexFile()` | Requests deletion and immediately reinserts, ignoring the deletion outcome. |
| `src/core/rag/docIndexService.ts` | Stores status, document ID and modification time; reconciliation is watched-folder scoped and includes ambiguous basename matching. |
| `src/views/NativeGraphView.ts` | Uses backend source fields to display and open vault files. |
| Settings | `lightRagChunkSize` and `lightRagChunkOverlap` default to 1200/100 and feed generated local `.env`; `ragOptions.chunkSize` is a separate legacy setting. |
| Settings migration | Current schema version is 15; use the existing ordered migration pipeline. |

LightRAG deletion is asynchronous. A successful HTTP response may carry `busy` (nothing scheduled) or `deletion_started` (not yet complete). Reprocessing configuration is captured at enqueue time; retrying a failed document does not automatically adopt new settings. [1][3]

## 3. Scope and ownership

The plugin owns selection, safe transport identity, submission tracking, source resolution, and explicit replacement. LightRAG owns parsing, tokenization, chunking, embeddings, and graph extraction.

Native paragraph processing applies to Markdown and native-capable DOCX. A request to use it for unsupported formats is reported as unsupported or skipped in a batch, never silently advertised as P while taking R fallback. Existing ingestion behavior remains available for other formats. PDF paragraph processing requires a suitable external parser and is not added by this change.

Non-goals:

- A backend fork, companion service, or new backend HTTP endpoint.
- Client-side paragraph splitting or submitting each chunk as a separate document.
- Per-folder profiles, arbitrary parser-rule editing, vector-semantic chunking, or reference-removal controls.
- Attachment upload, transclusion expansion, linked-note traversal, or automatic vision processing.
- A client-side approximation presented as a native chunk preview.
- A retrieval-algorithm rewrite, unrelated database repair, or general-purpose job scheduler.

Global retrieval stays on `/query`. Explicit file-scoped retrieval continues reading vault files directly.

## 4. Source identity

### 4.1 Three distinct identities

- **Vault path:** user-facing, vault-relative path.
- **Transport source:** safe basename used by LightRAG.
- **Server document ID:** authoritative identifier for exact server lifecycle operations.

For a managed document, calculate:

```text
sourceKey = lowercaseHex(SHA-256(UTF8(JSON.stringify([vaultNamespace, vaultPath]))))
canonicalTransportName = "nc-" + sourceKey + "." + extension
```

Use `globalThis.crypto.subtle.digest('SHA-256', ...)`, already used by `src/core/llm/modelCatalog.ts`. Do not add an MD5 library or depend on Node crypto. Compute identities when registering a path or handling a rename, not on every query or content edit.

Generate `vaultNamespace` once and persist it with plugin settings. Devices sharing the same vault and graph must share that value. Separate vaults use different values. Document-index records are additionally scoped to their backend connection; a transport key is not proof of which backend owns a record.

Use Obsidian's vault-relative path with its case and Unicode preserved. Do not lowercase paths or flatten separators. Use the full SHA-256 digest. File content and processing parameters are not identity inputs.

Content edits and chunk-setting changes retain identity. A rename or move creates a new path-derived identity and explicitly retires the old server document. Distinct folders containing `Overview.md` remain distinct. If a stored identity unexpectedly resolves to a different known vault path, stop instead of treating it as the same document.

### 4.2 Filename hints

A Markdown paragraph upload uses a generated basename such as:

```text
nc-<sourceKey>.[native-P(chunk_ts=1200,chunk_ol=100,drop_rf=false)].md
```

The example is illustrative; size and overlap come from the operation's captured policy. Parser hints are documented upstream and stripped for canonical-name matching. [1]

Keep the filename ASCII, bounded, and generated from validated fields only. Never insert a user title into the multipart header or parse an arbitrary user filename as plugin-controlled directives. The real vault file is never renamed. Changing the hint alone is not a replacement mechanism: canonical identity remains the same.

Paragraph Markdown uploads preserve the source Markdown without a synthetic heading or the legacy text route's title preamble. Do not expand Obsidian links or alter heading levels. Legacy text ingestion retains its existing content preparation. Native DOCX must not implicitly enable optional smart-heading LLM processing; explicitly opt out where server defaults could otherwise enable it.

## 5. Processing policy and settings

Add a Document processing group to the shared Neural settings surface, outside local-only server controls:

| Control | Contract |
| --- | --- |
| Processing mode | Existing behavior or Native paragraph; existing behavior remains the migration default. |
| Maximum chunk tokens | Finite positive integer. |
| Overlap tokens | Finite non-negative integer smaller than maximum chunk tokens. |
| Compatibility | Supported, Unsupported, or Not verified. |

Reuse the existing LightRAG size/overlap settings; do not use `ragOptions.chunkSize`. Preserve customized values. Invalid inherited values must be surfaced for correction before submission, not silently replaced during an operation.

The selected policy applies to new documents and explicit **Reprocess with current settings** actions. Existing managed documents use their recorded policy during ordinary synchronization. An operation freezes parser, strategy, size, overlap, and reference-retention behavior before submission. Changes to settings during a batch do not affect that batch.

For P, explicitly request `drop_references=false`. Do not inherit a server reference-removal default. Sizes and overlap travel in the request hint, so selecting these values does not require modifying a remote `.env` or restarting a server. Existing local environment management remains separate and does not override explicit operation parameters.

UI explanation:

> Applies to newly ingested documents. Existing documents keep their processing settings until explicitly reprocessed.

**Retry failed processing** retains the original operation policy. It is not an alias for reprocessing with current settings.

A policy record describes ingestion settings, not a frozen copy of every backend model, tokenizer implementation, or deployment setting. Do not imply reproducibility across arbitrary backend upgrades.

## 6. Document index and source resolution

Extend `DocIndexService` rather than adding another database. It must cover all plugin-ingested documents, including manual ingestion outside the watched folder.

Separate the last indexed document from an unfinished operation:

| Record | Required information |
| --- | --- |
| Indexed document | Backend scope, vault path, transport source, server document ID, last completed policy when known, indexed modification time, existing document status. |
| Pending operation | Captured backend target, source identity, operation kind and stage, captured policy, source revision, tracking ID when known, last error. |

Keep selected, submitted, completed, and server-reported policies conceptually distinct. Processing success does not prove P avoided its internal fallback. A selected P label must not be presented as independent structural verification.

Persist operation intent before its external mutation. Persist each stage transition before scheduling the next destructive step. Identity and operation records are durable data, not a disposable cache: validate/version their storage and retain recoverable prior data during migration and replacement. A read or parse failure must not trigger overwriting the store with an empty object. Do not store API keys in record identities or logs.

Deterministic keys allow reconstruction for surviving paths under the same namespace; they cannot reconstruct historical operation outcomes or unknown completed policies. Keep unresolved records for reconciliation. Do not permanently copy every note into the plugin's data store.

One shared source resolver is consumed by chat references, graph source links, document reconciliation, folder membership, exclusions, rename, deletion, and reprocessing. Match exact known transport identities or server IDs. Unknown sources remain unresolved. Never choose a first matching basename when multiple notes could match.

Preserve old source-to-path associations as migration/history data when a rename is confirmed, so plugin-managed historical references can resolve to the known new location. Do not rewrite arbitrary model prose or claim that external WebUI references will be translated. LightRAG's WebUI may display transport names, and generated prose may mention them.

## 7. Ingestion and replacement lifecycle

All file-ingestion callers converge on `RAGEngine.ingestFile()`: current-file commands, folder ingestion, watched-folder events, manual reprocessing, and explicit rechunking. Keep watched-folder, extension, hidden-file, and exclusion eligibility checks appropriate to each caller and enforce exclusions centrally.

### 7.1 New ingestion

```text
Prepare → Submit → Track → Complete
```

1. Check compatibility and eligibility, read the source, capture its revision and policy, and persist intent.
2. Submit using the policy's route. Return a structured acknowledgement, retaining tracking information rather than only a boolean.
3. Poll the specific submission/document to a terminal outcome through the existing HTTP adapters.
4. Commit server ID, completed policy and indexed revision only after confirmed document success.

Check the source modification time around reading. If it changes during preparation, reread before submission. If it changes after the accepted snapshot, successful completion applies only to that snapshot; the newer revision remains eligible for synchronization.

HTTP acceptance is not processing completion. Global pipeline idle is not document success. An error must not mark an unprocessed replacement as current.

### 7.2 Existing-document replacement

```text
Prepare → Wait for deletion availability → Delete → Confirm removal
        → Submit → Track → Complete
```

Before deletion, resolve the exact server ID, verify the replacement source is readable, capture policy and source revision, and persist the operation.

Interpret response bodies, not only HTTP status. `busy` means no deletion scheduled. `deletion_started` means wait. Confirm removal through successful authoritative document reads, covering pagination where required. Network errors, authorization failures, partial listings, or timeouts are unknown outcomes, never proof of absence.

Retain the source file and operation record throughout. After deletion the old graph contribution is unavailable until reinsertion succeeds. This is recoverable replacement, not an atomic transaction or exact graph rollback. Warn about the retrieval gap and ingestion cost. Recommend a separately backed-up or separate target graph for large migrations; do not implement automatic backend backup or deployment management here.

Shared deletion semantics must also be respected by rename, explicit removal and exclusions. Do not mark removal complete merely because the server accepted or refused a deletion request.

### 7.3 Recovery and cancellation

| Event | Required response |
| --- | --- |
| Lost deletion acknowledgement | Reconcile the exact document before retrying or inserting. |
| Lost upload acknowledgement | Reconcile exact transport identity, captured policy and document status before resubmission; an existing mismatched record is a conflict. |
| Plugin reload | Load unfinished operations and reconcile them before scheduling writes. |
| Backend processing failure | Retain the failed operation and its policy; make retry explicit. |
| Source changed after reload | Reread and expose the revision change; do not claim the older operation indexed newer content. |
| Source missing or newly excluded | Do not resurrect it from stale intent; pause replacement and reconcile any already accepted work. |
| Backend connection changed | Pause old-target operations; never redirect them to the new connection. |
| Cancellation before mutation | Stop scheduling; old graph data remains. |
| Cancellation after accepted mutation | Stop scheduling further stages and reconcile accepted work; do not promise rollback. |

The Obsidian request adapter does not guarantee aborting an accepted backend operation. Cancellation semantics must reflect that limitation. Dispose polling and listeners on unload; persist intent so reload can resume reconciliation.

### 7.4 Batches

Allow one explicit replacement batch per backend connection, with sequential replacements. Pause automatic submissions from this plugin while the batch owns the ingestion flow, retaining changed paths for subsequent reconciliation under their recorded policies. Do not drop modification events or accidentally resurrect intentionally removed files.

External clients can still operate on the backend. Respect busy responses and conflicts rather than assuming a plugin-local guard is a server-wide lock. Stop the batch on unresolved identity or deletion outcome. Cancellation prevents scheduling further documents and leaves per-document outcomes visible.

## 8. Compatibility and privacy

### 8.1 Backend support

Use LightRAG v1.5.7 as the initial tested contract, not an assertion that all v1.5 or future versions are compatible. Establish runtime version and native parser support; missing information stays Not verified. Supported file types help establish parser availability but do not prove a document produced structural blocks. [3][4]

Unknown/unsupported servers retain existing behavior; block native paragraph submissions rather than silently downgrading them. Native paragraph acceptance requires runtime evidence in the validation environment, not an undocumented endpoint or a guessed capability flag.

Scope capability state and durable operations to the backend connection. Invalidate capability confidence when connection configuration changes. Credentials remain in the existing settings path, not duplicated into operation records. Changes of credentials or backend graph identity require reconciliation; do not treat matching URLs alone as proof of continued ownership. If a deployment cannot report graph identity changes behind an unchanged URL, document this detection limit and require revalidation after operator-reported replacement.

### 8.2 External images

Native Markdown downloads external image URLs by default, even when image analysis was not enabled. Standalone remote Markdown cannot resolve arbitrary vault-relative image assets. [1]

Require `NATIVE_MD_IMAGE_DOWNLOAD_ENABLED=false` before enabling paragraph ingestion:

- Managed local: offer an explicit configuration action and necessary restart. Preserve unrelated custom environment values. Conflicting overrides prevent claiming the prerequisite is satisfied.
- Remote: provide operator instructions and require acknowledgement scoped to that connection.
- Without a backend-readable effective value, show **Operator-confirmed**, not **Verified**. A local generated file alone is also not proof of running configuration.

This is an operator-enforced prerequisite where the released API cannot report or control it per request. The plugin must not claim a hard remote enforcement guarantee. Invalidate confirmation when connection configuration changes; require reconfirmation after known backend reconfiguration.

Do not strip image references using ad hoc text rewriting, fetch assets in the plugin, expand links/transclusions, or enable additional analysis modalities. Requests use native paragraph options without `i/t/e` or `!`; ordinary graph extraction remains enabled.

## 9. Migration and user actions

Add a versioned settings migration from the current version 15, rebasing its version if repository evolution requires it. Preserve provider/model configuration, chunk values and exclusions. Default to existing behavior. Establish and persist the vault namespace before managed submission; devices must use the same namespace for a shared vault.

Migrate the existing document-index format conservatively, preserving source records and intentional-removal state. Recover historical policy only when server metadata is sufficient. Otherwise label **Historical processing settings unknown** and require explicit policy adoption before automatic replacement. Existing graph entries remain queryable, but automatic synchronization can pause for these records; explain that consequence.

Provide **Reprocess with current settings** for a file or folder. Confirmation shows eligible count, skipped unsupported/excluded/intentionally removed files, captured parser/strategy/size/overlap, expected ingestion cost and non-atomic replacement warning. Excluded and intentionally removed files are not silently included in a bulk migration. Explicit re-add remains a separate user action.

Never delete ambiguous legacy basename records automatically. Require explicit mapping to an exact server document before a destructive migration. Changing settings, upgrading the plugin, or opening a vault must not trigger graph migration.

## 10. Implementation boundaries

| Component | Required change |
| --- | --- |
| Settings schema/defaults/migrations | Mode, namespace, preserved numeric settings, validation and migration. |
| `NeuralSection.tsx` | Shared document-processing controls, compatibility and migration explanation; preserve mobile layout conventions. |
| Existing server configuration flow | Explicit local image-download prerequisite; truthful custom-env and restart state. |
| `RAGEngine` | Shared preparation, native upload hints, exact identity, tracking-aware acknowledgements, replacement completion semantics. |
| `main.ts` | Migrate every affected ingestion/deletion caller; coordinate explicit batches and retained automatic changes. |
| `DocIndexService` | Durable backend-scoped identities, policies, unfinished operations and shared resolution for all ingested notes. |
| `NativeGraphView.ts` and chat references | Resolve transport sources before display/navigation; do not guess ambiguous paths. |
| Setup and feature documentation | Supported contract, shared namespace, external-image prerequisite, explicit migration and external-WebUI limitations. |

Use existing modules and installed dependencies. Small helpers are appropriate for shared identity and policy normalization; no new database or generic orchestration framework is required.

## 11. Verification and acceptance

### 11.1 Existing evidence

Repository tracing and a static AST audit of the released document API and paragraph implementation established the request-field and fallback contracts. A design-level filename calculation produced distinct 123-byte example transport names for same-basename notes in different folders.

No live parser, ingestion backend, private vault, mobile device or retrieval benchmark has been exercised for this design. Static evidence does not establish end-to-end compatibility or retrieval improvements.

### 11.2 Implementation acceptance gates

1. Synthetic Markdown is uploaded through native parsing and produces meaningful structural blocks and P chunks; raw-text P fallback is not accepted as proof.
2. Verify two same-basename files in different folders independently ingest and resolve to the correct vault files from chat and graph views.
3. Identity handles long paths, Unicode, case distinctions and filenames containing bracket-like text without leaking user strings into processing hints.
4. Identity and unfinished-operation records survive plugin reload. Corrupt or failed reads do not erase records or authorize deletion.
5. Ordinary edits preserve a known completed policy. Global setting changes initiate no replacement. Explicit reprocessing captures and applies the selected policy.
6. Unknown historical policies remain unknown; automatic replacement waits for explicit adoption. Ambiguous legacy sources cannot be deleted by a guessed match.
7. Busy deletion, accepted asynchronous deletion, pagination, lost acknowledgements and backend failures do not cause premature insertion or false completion.
8. Stop/reload after deletion leaves a recoverable operation and an honest retrieval-gap state. Accepted remote work is not falsely reported cancelled.
9. Exclusions, hidden files, supported extensions, watched-folder boundaries and intentionally removed status survive batching, rename and recovery.
10. Backend switches never redirect pending operations or reuse old capability confidence. Shared-vault desktop/mobile instances agree on namespace and path identities.
11. Markdown corpus covers frontmatter, ATX headings, fenced-code pseudo-headings, pipe/HTML tables, wikilinks, transclusions, blank notes and oversized sections. No silent content loss or false claim of Obsidian-specific expansion is acceptable.
12. Native DOCX respects paragraph selection without implicitly enabling smart-heading or modality analysis. Unsupported formats are explicitly reported rather than mislabeled.
13. External-image downloading is disabled in the disposable backend. The plugin performs no attachment discovery/upload or extra network requests for links.
14. Real Obsidian checks cover settings, current-file/folder ingestion, modification, rename, removal, source navigation and unload/reload. Exercise a remote-only path and mobile surface; report unavailable real-device verification explicitly.

Use existing Jest conventions and TDD for implementation, with focused regressions for the failure transitions and identity boundaries above. Tests must defend observable behavior, not implementation wiring. Run type checking/build and scoped formatting/linting after integration. No application suite is required merely to review this documentation.

Compare current and P processing on the same synthetic corpus and queries: heading-specific retrieval, neighboring-section confusion, table lookups and oversized prose. Record citation correctness, chunk distribution, latency and ingestion cost. Do not promise a retrieval-quality improvement without measurements.

## 12. Delivery sequence and review gate

Implement in dependency order after written-spec review and implementation-plan approval:

1. Source identity and durable records, including recovery-safe migrations.
2. Native parser-backed ingestion and exact source translation.
3. Shared deletion/replacement lifecycle and caller cutover.
4. Settings, explicit migration actions and privacy/compatibility gating.
5. End-to-end Obsidian and backend verification, focused regressions, user documentation and removal of throwaway verification artifacts.

These are acceptance stages of one feature, not permission to ship an incomplete lifecycle or a settings-only toggle. A runtime contract contradiction discovered during implementation must be brought back for a design decision, not concealed through a fallback.

Next gate: user reviews this written specification. Only after approval should implementation planning begin. No feature code is included in this document change.

## References

1. [LightRAG v1.5.7 file-processing specification](https://github.com/HKUDS/LightRAG/blob/v1.5.7/docs/FileProcessingPipeline.md)
2. [LightRAG v1.5.7 paragraph-semantic strategy](https://github.com/HKUDS/LightRAG/blob/v1.5.7/docs/ParagraphSemanticChunking.md) and [implementation](https://github.com/HKUDS/LightRAG/blob/v1.5.7/lightrag/chunker/paragraph_semantic.py)
3. [LightRAG v1.5.7 document HTTP API](https://github.com/HKUDS/LightRAG/blob/v1.5.7/lightrag/api/routers/document_routes.py)
4. [LightRAG v1.5.7 release](https://github.com/HKUDS/LightRAG/releases/tag/v1.5.7)
