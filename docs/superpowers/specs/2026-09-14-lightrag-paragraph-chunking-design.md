# Native LightRAG paragraph chunking

Date: 2026-09-14

Status: Plugin implementation is complete in the `feat/native-paragraph-chunking` feature worktree. Bounded Sol lifecycle/integration closeouts and the final source gates passed: 21 suites/328 tests, production build with TypeScript, zero-warning ESLint across all 21 changed TS/TSX files, and scoped Prettier. Separately, native paragraph ingestion remains blocked in production because no approved upstream LightRAG release has passed the content-preservation gate.

Historical design baseline: `07ab696` (`revert: keep LightRAG binary uploads as basenames`) against released LightRAG v1.5.7. Current implementation baseline: the uncommitted feature worktree described above; no release version is assigned by this specification.

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

## 2. Evidence, historical baseline, and current integration

### 2.1 Upstream contract evidence

LightRAG's paragraph strategy (`P`) consumes parser-generated `.blocks.jsonl`. It uses heading hierarchy, table-row boundaries, paragraph anchors, and hierarchy-aware merging. It can merge small sections and split large ones; it is not one paragraph per chunk. The chunking algorithm does not itself require embedding or LLM calls, although downstream graph extraction and embedding still do. Missing structural blocks cause recursive-character (`R`) fallback. [1][2]

The released text API accepts `chunking.strategy="paragraph_semantic"`, but enqueues raw text without structural parser input. Selecting P on that route therefore does not deliver native paragraph semantics. The upload route accepts a multipart file, resolves parser directives, and can produce the required blocks. Native parsing supports Markdown and DOCX; Markdown defaults to legacy parsing unless native is explicitly selected. [1][3]

The upload endpoint has no separate logical source-path or parser-settings body field. It rejects directory separators in filenames. Document identity and deduplication use canonical basenames, stripping recognized parser hints. Text-source normalization also canonicalizes basenames. A client sending a vault path does not establish that LightRAG preserves it. [1][3]

### 2.2 Historical plugin baseline at approval

The following table records the `07ab696` state used to design the feature. It is historical evidence, not a description of the current feature worktree.

| Area | Historical behavior at `07ab696` |
| --- | --- |
| `src/core/rag/ragEngine.ts` | `insertDocument()` posted raw text to `/documents/texts`; `uploadDocument()` uploaded `file.name`, not `file.path`. |
| `RAGEngine.ingestFile()` | Read Markdown, prepended the existing `Title:` preamble, and used the text route. |
| `src/main.ts` | Current-file and folder ingestion duplicated preparation instead of consistently calling `ingestFile()`. |
| `RAGEngine.reindexFile()` | Requested deletion and immediately reinserted, ignoring the deletion outcome. |
| `src/core/rag/docIndexService.ts` | Stored status, document ID and modification time; reconciliation was watched-folder scoped and included ambiguous basename matching. |
| `src/views/NativeGraphView.ts` | Used backend source fields to display and open vault files. |
| Settings | `lightRagChunkSize` and `lightRagChunkOverlap` defaulted to 1200/100 and fed generated local `.env`; `ragOptions.chunkSize` was a separate legacy setting. |
| Settings migration | The schema version was 15 and used the existing ordered migration pipeline. |

LightRAG deletion is asynchronous. A successful HTTP response may carry `busy` (nothing scheduled) or `deletion_started` (not yet complete). Reprocessing configuration is captured at enqueue time; retrying a failed document does not automatically adopt new settings. [1][3]

### 2.3 Current feature-worktree implementation

The feature worktree supersedes that historical baseline without modifying LightRAG:

| Area | Current implementation |
| --- | --- |
| Processing and transport | New settings default to **Existing behavior**. Native Markdown and DOCX preparation uses original bytes, deterministic `nc-<sha256>` source basenames and explicit native-P hints; DOCX disables smart heading. The production compatibility gate blocks every currently known upstream release. |
| Policy and actions | Settings apply to new documents. Ordinary synchronization pins the last known completed policy; **Reprocess with current settings**, **Retry failed processing**, **Remove from graph**, **Re-add to graph**, and exact legacy mapping are explicit actions. |
| Lifecycle and recovery | Replacement persists operation intent and proceeds through delete, authoritative absence confirmation, upload, per-document tracking and completion. Pending work is backend-scoped, reload-recoverable and cancellation-aware; accepted remote work is reconciled rather than declared rolled back. |
| Identity and source resolution | Web Crypto hashes the shared vault namespace and exact vault path. Chat and graph navigation share exact mappings, retain raw graph provenance, and do not guess ambiguous basenames. |
| Compatibility and privacy | Every measured release (LightRAG 1.5.4 through 1.5.7) is hard-blocked for the pipe-table-header defect and unreleased `main` shares it; 1.5.0 through 1.5.3 lack a native Markdown engine. Unmeasured releases stay Not verified. Native mode also requires backend-scoped operator confirmation that external-image downloading is disabled. |
| Local/remote ownership | Desktop can configure and restart a managed local server for the image prerequisite. Remote and mobile paths require the operator to configure the server host. Connection changes rotate backend ownership and clear prior confirmation. |

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

LightRAG v1.5.7 was the initial historical contract, not an assertion that all v1.5 or future versions are compatible. The preservation corpus was run against every published release and against unreleased upstream `main`. Releases 1.5.0 through 1.5.3 cannot be evaluated at all: their native engine parses only DOCX, so the existing native-file-type check already classifies them Unsupported. Releases 1.5.4, 1.5.5, 1.5.6 and 1.5.7 each reported the same **12 PASS / 1 FAIL**, and unreleased `main` repeated it. No available version can be marked Supported, and version selection cannot clear the gate. [3][4]

Unknown or unsupported servers retain existing behavior. Native paragraph submissions are blocked rather than silently downgraded, and there is no production bypass. Runtime evidence must establish native parser support and content preservation before a release can be marked Supported.

Scope capability state and durable operations to the backend connection. Invalidate capability confidence when connection configuration changes. Credentials remain in the existing settings path, not duplicated into operation records. Changes of credentials or backend graph identity require reconciliation; do not treat matching URLs alone as proof of continued ownership. If a deployment cannot report graph identity changes behind an unchanged URL, document this detection limit and require revalidation after operator-reported replacement.

### 8.2 External images

Native Markdown downloads external image URLs by default, even when image analysis was not enabled. Standalone remote Markdown cannot resolve arbitrary vault-relative image assets. [1]

Require `NATIVE_MD_IMAGE_DOWNLOAD_ENABLED=false` before enabling paragraph ingestion:

- Managed local: the explicit **Configure & restart** action writes a verified Neural Composer-managed `.env` block while preserving content outside that block, then requests a restart without another regeneration pass. Ordinary generated updates replace only the managed block. The operator must still confirm the effective running setting.
- Remote: provide operator instructions and require acknowledgement scoped to that connection; the plugin cannot read or modify the remote filesystem.
- Without a backend-readable effective value, show **Operator-confirmed**, not **Verified**. A local generated file alone is also not proof of running configuration.

The managed-local merge preserves unrelated hand-edited content, existing CRLF/LF style, Unicode and multiline values outside the managed markers. Malformed or ambiguous markers, backend/path changes and external file changes stop the write without treating the old content as disposable.

This is an operator-enforced prerequisite where the released API cannot report or control it per request. The plugin must not claim a hard local or remote runtime-enforcement guarantee. Invalidate confirmation when connection configuration changes; require reconfirmation after known backend reconfiguration.

Do not strip image references using ad hoc text rewriting, fetch assets in the plugin, expand links/transclusions, or enable additional analysis modalities. Requests use native paragraph options without `i/t/e` or `!`; ordinary graph extraction remains enabled.

## 9. Migration and user actions

The feature worktree adds the ordered settings migration from schema 15 to 16. It preserves provider/model configuration, chunk values and exclusions, defaults processing to existing behavior, and establishes the vault namespace before managed submission. Devices sharing a vault and graph must use the same namespace.

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

### 11.1 Evidence recorded to date

#### Historical contract analysis

Repository tracing and a static AST audit of the released document API and paragraph implementation established the request-field and fallback contracts. A design-level filename calculation produced distinct 123-byte example transport names for same-basename notes in different folders. That historical static evidence did not establish end-to-end compatibility or retrieval improvement.

#### Reproducible upstream preservation gate

Run the parser-only corpus with the Python interpreter from the installed backend environment:

```bash
/path/to/lightrag-venv/bin/python scripts/verify-paragraph-backend.py
```

The script uses a temporary synthetic corpus and makes no server, vault, LLM or embedding calls. Against unmodified LightRAG 1.5.7 it reported **12 PASS and 1 FAIL**. Native parsing, heading-aware output, token cap, frontmatter, fenced-code pseudo-headings, literal wikilinks/transclusions, table rows, HTML tables, oversized-section retention, blank-note handling, absence of image sidecar artifacts and unchanged source all passed. **Markdown pipe-table headers retained in chunk text** failed. The script exits nonzero on this defect, so v1.5.7 remains hard-blocked in production.

Every candidate was installed into its own isolated virtual environment together with the parser dependencies a `lightrag-server` deployment installs (`python-docx`, `defusedxml`, `langchain-text-splitters`):

| Candidate | Result |
| --- | --- |
| 1.5.0, 1.5.1, 1.5.2, 1.5.3 | Native engine supports only DOCX: `error: engine 'native' does not support .md files (supported: docx)`. Not evaluable, and already Unsupported by the advertised-file-type check. |
| 1.5.4, 1.5.5, 1.5.6, 1.5.7 | 12 PASS / 1 FAIL, identical failure set. |
| `main` (unreleased HEAD) | 12 PASS / 1 FAIL, identical failure set. |

The defect sits upstream of chunking and is unchanged on `main`. For a Markdown pipe table the native parser relocates the header row into the table sidecar and omits it from the block content the chunker consumes. For the two-row corpus table the sidecar records `table_header: [["component_header_contract", "limit_header_contract"]]` and `dimension: [2, 2]`, while the block content and every resulting chunk carry only `<table format="json">[["Widget", "10"], ["Sensor", "20"]]</table>`. HTML tables keep their `<th>` cells inline in the same block, which is why that check passes. A chunker cannot recover a header that never reaches it, so no plugin-side change can satisfy this contract without modifying the backend or reimplementing the parser.

#### Real integration evidence

The following observations came from a disposable Obsidian 1.13.7 vault and an unmodified LightRAG 1.5.7 backend. Native lifecycle experiments used an in-memory compatibility override in the disposable renderer only; no source or persisted configuration bypass was added, and the default gate was separately observed to pause without creating a new record.

- Real graph extraction and answers used Z.ai `glm-5.3-flash` through the Coding Plan API with low reasoning. Real embeddings used local `jina-v5-nano-retrieval:q8` at 768 dimensions. No synthetic completion was substituted.
- Native Markdown and DOCX reached the native parser with `paragraph_semantic` and the requested size, overlap and `drop_references=false`; DOCX produced three chunks at 160/20 with `smart_heading=false`.
- A real query answered Alpha=blue and Beta=red with the two folder-specific sources mapped correctly. A graph-source click opened the root `Overview.md` from its raw hashed source while ambiguous `Overview.md` basename resolution correctly returned no match.
- An ordinary edit retained 160/20 after the selected controls changed to 220/20. Current-file ingestion did not migrate the registered document; explicit confirmed reprocessing did. A mapped legacy document recovered exact 1200/100 metadata, while an unknown historical policy paused synchronization.
- Folder ingestion processed supported Markdown and skipped an unsupported text file in paragraph mode. A loopback collector observed zero external-image requests, one external image was reported dropped, and literal wikilinks/transclusion remained unchanged; the plugin discovered or uploaded no attachments.
- Cancellation at persisted `delete_confirmed` left the deleted server document absent and another document unchanged. Reload then resumed the captured legacy 900/90 policy and completed with real model processing. A later real folder rename plus edit retained the original 900/90 policy, retired the old record, processed the new hashed source and kept the old source as an alias.
- Desktop settings, settings popout and reload were exercised. The mobile surface was tested only through 430x932 emulation: it stayed remote-only, loaded no Node modules, exposed labeled controls, rejected zero chunk size and had no horizontal overflow. No physical mobile device was tested.

These observations demonstrate parser transport, lifecycle behavior and source resolution on the exercised corpus. They do **not** demonstrate a general retrieval-quality improvement.

#### Corrective implementation closeout evidence

The completed source corrections received bounded PASS verdicts from both Sol lifecycle and integration closeout reviews. Focused real evidence added after the earlier observations includes:

- Expired-track recovery completed in 60.537 seconds with the captured legacy 800/80 policy and exact document/source identity even though server metadata omitted `source_file`; it did not replay the upload.
- Corrected rename-plus-modify, folder removal, folder exclusion and startup recovery of a pending-less removal all completed against the real backend. The sequence made four GLM-backed uploads total and no additional upload after either recovery.
- A real 17-node graph remained visible past an older render's deadline, stopped at its own deadline, and cancelled a stale zero-width deferred render; the final surface was visually confirmed.
- Native-provider fallback aliases were empty where required. Re-including an excluded path reported that removed documents stay removed, and the removed document did not resurrect.
- Real filesystem and UI review of the managed `.env` merge preserved CRLF, Unicode and multiline content and cleared both persisted and engine-visible operator acknowledgement. The final stale-snapshot check refused the save, made no restart call or temporary files, preserved the externally changed bytes and kept the modal open; reopening from fresh bytes saved successfully, requested one restart with regeneration skipped, and closed the modal. The restart callback was guarded/stubbed for safety, so this evidence does not claim that an actual managed server process restarted.
- Final unload exposed and corrected an unsafe existing port/name-based shutdown fallback. The real remote backend survived plugin unload after the fix. A separate, non-LLM Python parent/child fixture launched through the plugin received its own POSIX process group; shutdown terminated both owned processes and their listener while leaving the independent LightRAG backend healthy. Windows PID-tree targeting and stale-child callbacks received focused regression coverage; no Windows runtime was exercised.

#### Controlled diagnostic comparison

Main completed one fixed-order run over four synthetic Markdown documents and four queries. Both isolated LightRAG 1.5.7 backends used real Z.ai `glm-5.3-flash`, real local `jina-v5-nano-retrieval:q8` embeddings at 768 dimensions, chunk size 160 and overlap 20. Legacy used its real Title-preamble text route; paragraph used original Markdown bytes through native P. The comparison was independently reviewed against the result, usage, chunk and document-status artifacts.

| Measured result | Existing behavior | Native paragraph |
| --- | ---: | ---: |
| Persisted chunks | 9 | 10 |
| Persisted chunk token-counter sum | 969 | 969 |
| Sequential ingestion wall-time total | 161.542 s | 160.041 s |
| Query wall-time total | 20.260 s | 30.566 s |
| Proxy-observed ingestion LLM tokens | 54,281 | 57,830 |
| Proxy-observed query LLM tokens | 11,921 | 12,477 |
| Requested facts answered (Sol assessment) | 4/4 | 3/4 |
| Clean structured citations | 3/4 | 3/4 |
| Expected source retrieved | 4/4 | 4/4 |

All eight expected sources were retrieved. Both modes answered three requested facts correctly. Existing behavior also answered the pipe-table question correctly; native paragraph retrieved the table document but could not determine the Access-versus-Decoy relationship because v1.5.7 had removed the header labels. This was the only genuine unanswered native query and directly confirms the production blocker.

Raw substring checks are not semantic-quality scores: they rejected accurate answers that mentioned distractors only in a correct negated contrast and could accept a fact string inside an uncertain answer. Sol's semantic assessment is 4/4 versus 3/4, not the raw scripted score; this is model-assisted review, not human grading. Structured citation cleanliness was 3/4 for each mode.

These measurements are diagnostic, not a benchmark. The run was unreplicated and non-counterbalanced; mode order was fixed, the real transport inputs differed, and upstream cached-prompt usage was asymmetric. The native query total was dominated by the table response (15.113 s versus 5.027 s), whose longer reasoning/refusal accounts for most of the aggregate gap. The proxy observed chat-completion token counters only, not embedding usage or other backend work. Z.ai Coding Plan responses exposed no currency billing, so monetary cost is unknown. The run demonstrates no general quality, speed, token-cost or monetary-cost benefit for either mode and cannot authorize production use.

#### Evidence limitations

The final source gates passed with no remaining source defect found. The final rerun of the permanent Python preservation corpus again produced 12 passes and the pipe-table-header failure on unmodified LightRAG 1.5.7, exiting with code 1 and preserving the release block. Environment-helper/UI evidence used the real filesystem but a guarded/stubbed restart, not an actual managed-process restart. Physical mobile hardware was not exercised.

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

The final source gates passed 21/21 suites and 328/328 tests, the production build including TypeScript, zero-warning ESLint over all 21 changed TS/TSX files, and scoped Prettier. The final commands used an isolated synthetic environment. Tests continue to defend observable behavior rather than implementation wiring.

The controlled Existing-behavior-versus-P comparison above records citation correctness, chunk distribution, latency and proxy-observed LLM token use on its fixed corpus. Its limits remain part of the evidence: do not generalize retrieval quality, speed or cost from one fixed-order run.

## 12. Implemented sequence and current review gate

Implementation and evidence work followed the approved dependency order:

1. Source identity and durable records, including recovery-safe migrations.
2. Native parser-backed ingestion and exact source translation.
3. Shared deletion/replacement lifecycle and caller cutover.
4. Settings, explicit migration actions and privacy/compatibility gating.
5. End-to-end Obsidian/backend evidence, focused regressions, user documentation and the final preservation-corpus rerun.

These remain review layers of one feature, not permission to ship an incomplete lifecycle or a settings-only toggle. A runtime contract contradiction must be recorded and gated rather than concealed through a fallback.

Current gate: the plugin implementation, bounded lifecycle/integration closeouts and final source gates are complete. The independent backend release gate is separate: production native paragraph ingestion stays blocked until an upstream release passes the reproducible preservation corpus. LightRAG 1.5.7 remains Unsupported, every other version remains Not verified, and comparative evidence cannot override that block.

## References

1. [LightRAG v1.5.7 file-processing specification](https://github.com/HKUDS/LightRAG/blob/v1.5.7/docs/FileProcessingPipeline.md)
2. [LightRAG v1.5.7 paragraph-semantic strategy](https://github.com/HKUDS/LightRAG/blob/v1.5.7/docs/ParagraphSemanticChunking.md) and [implementation](https://github.com/HKUDS/LightRAG/blob/v1.5.7/lightrag/chunker/paragraph_semantic.py)
3. [LightRAG v1.5.7 document HTTP API](https://github.com/HKUDS/LightRAG/blob/v1.5.7/lightrag/api/routers/document_routes.py)
4. [LightRAG v1.5.7 release](https://github.com/HKUDS/LightRAG/releases/tag/v1.5.7)
