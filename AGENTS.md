# Repository guidance

## RULES

1. Create branches in worktrees, not the main repository. Use descriptive names, e.g., `fix/bug-1234` or `feature/xyz`. Avoid `main` or `master` for development.
2. Create well thought tests for every change. Tests should be deterministic, fast, and cover edge cases. TDD must be used for new features. For existing code, add tests for any uncovered behavior you touch.


## Behavioral rules

These bias toward caution over speed. For trivial tasks, use judgment.

Each rule below carries **antirationales** — the seductive excuse you'll tell yourself to skip the rule, and the reality that defeats it. When you catch yourself thinking the left column, stop.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.** State assumptions explicitly; if multiple interpretations exist, present them — don't pick silently. If something is unclear, stop, name it, ask.

| Antirationale | Reality |
| ------------- | ------- |
| "I'm pretty sure I know what they meant." | Pretty sure isn't sure. A 10-second question beats an hour rebuilding the wrong thing. |
| "Asking will make me look like I didn't understand." | Silent wrong guesses look far worse. Surfacing the fork is the competent move. |

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.** No features beyond what was asked, no abstractions for single-use code, no error handling for impossible states. If 200 lines could be 50, rewrite.

| Antirationale | Reality |
| ------------- | ------- |
| "Adding this config/flag now makes it future-proof." | Unrequested flexibility is dead weight you'll maintain forever for a future that may never arrive. YAGNI. |
| "This abstraction is cleaner." | Cleaner for whom? One caller doesn't need an interface. Three similar lines beat a premature framework. |

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.** Don't refactor what isn't broken, match existing style even if you'd do it differently, and remove only the orphans *your* changes created.

| Antirationale | Reality |
| ------------- | ------- |
| "While I'm here I'll just tidy this up." | "While I'm here" is how a one-line fix becomes an unreviewable diff and a hidden regression. |
| "This dead code is obviously useless, I'll delete it." | Obvious to you now, load-bearing to someone else. Mention it; don't delete unless asked. |

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.** Turn "fix the bug" into "write a test that reproduces it, then make it pass." State a brief plan with a verify step per item. Strong criteria let you loop independently; weak ones ("make it work") force constant clarification.

| Antirationale | Reality |
| ------------- | ------- |
| "It looks right, I don't need to run it." | "Looks right" is a guess, not evidence. Run the check before you claim done. |
| "Writing the test first slows me down." | Skipping the test means you don't actually know when you're finished — you just *feel* finished. |

## Project and scope

Neural Composer is an Obsidian plugin: TypeScript, React 18, and an external
LightRAG Python server for graph-based retrieval. This repository contains the
plugin, not the LightRAG backend. The plugin ID is `neural-composer`; the minimum
Obsidian version is 1.7.2. Desktop and mobile are supported, with mobile using a
remote backend.

Prefer the current code, `package.json`, and `.github/workflows/ci.yml` over older
instructions. `CONTRIBUTING.md` still contains Smart Composer names and outdated
migration/release instructions. `README.md` and `wiki/` cover user-facing setup.
Keep changes scoped; do not repair unrelated legacy code as part of another task.

## Development and verification

Use npm and the committed `package-lock.json`. CI and releases use Node 22;
`.nvmrc` still specifies 20.13. Use Node 22 when reproducing CI.

```sh
npm ci
npm run dev          # esbuild watch; does not type-check
npm run type:check   # TypeScript check
npm test -- --runInBand
npm run build        # TypeScript check, then production bundle
```

CI additionally runs these checks; warnings fail ESLint:

```sh
npx prettier --check .
npx eslint . --max-warnings 0
```

`npm run lint:check` combines Prettier and ESLint but does not include CI's
zero-warning flag. `npm run lint:fix` rewrites the whole repository; prefer
formatting/fixing changed files to avoid unrelated churn.

Tests are colocated `*.test.ts` files, using Jest with `ts-jest` in a Node
environment. `__mocks__/obsidian.ts` is a minimal mock, not a real Obsidian runtime.
For a targeted check, use `npm test -- --runInBand <path-to-test>`.
Add focused regression coverage for changed behavior, following nearby tests.

For runtime/UI changes, build and exercise the plugin in a disposable Obsidian
vault, then reload the plugin or use Hot Reload. Verify the affected chat,
settings, graph, or ingestion flow; unit tests cannot establish Obsidian/mobile
compatibility. State exactly what was checked and any unavailable runtime.
Documentation-only changes need content/path checks, not the application suite.

The build writes `main.js`; production also writes `meta.json`. Both are ignored
build outputs, not source. Release assets are `main.js`, `manifest.json`, and
`styles.css`. Do not bump versions or run release automation unless requested.

## Architecture map

| Area | Entry points and responsibilities |
| --- | --- |
| Plugin lifecycle | `src/main.ts`: settings, views/commands, manager initialization, local server management, vault synchronization, and unload cleanup. |
| Obsidian views | `src/ChatView.tsx` mounts the React chat with its context providers; `src/ApplyView.tsx` receives review/apply state through workspace view state. Both unmount their React roots on close. |
| Chat flow | `src/components/chat-view/Chat.tsx`, `src/components/chat-view/useChatStreamManager.ts`, and `src/utils/chat/`: prompt construction, retrieval context, streaming responses, tool turns, history, and apply handoff. |
| LLM providers | `src/core/llm/base.ts` defines response/stream/embedding contracts; `src/core/llm/manager.ts` resolves models and dispatches providers. Shared contracts live in `src/types/`. |
| MCP clients | `src/core/mcp/mcpManager.ts`: connection lifecycle, transport selection, tool discovery, approval, execution, and cancellation. `src/core/mcp/tool-name-utils.ts` owns qualified tool names. |
| Retrieval and synchronization | `src/core/rag/ragEngine.ts` talks to LightRAG; `src/core/rag/docIndexService.ts` persists document status. Vault event orchestration is in `src/main.ts`. |
| Graph visualization | `src/views/NativeGraphView.ts`: LightRAG graph API, Sigma 2D rendering, lazy-loaded 3D rendering, and graph editing. |
| Settings | `src/settings/schema/setting.types.ts`, `src/settings/schema/settings.ts`, and `src/settings/schema/migrations/`: Zod schemas, defaults, parsing, and version migration. UI is in `src/settings/SettingTab.tsx` and `src/components/settings/`. |
| Persistence | `src/database/json/`: chat/template repositories and legacy migration. `src/database/DatabaseManager.ts`, `src/database/schema.ts`, and `src/database/modules/`: legacy PGlite/Drizzle storage. |
| Shared UI | `src/contexts/`, `src/hooks/`, `src/components/common/`, and `styles.css`. Reuse existing contexts and components rather than introducing parallel state paths. |

### Important current-state caveats

- The presence of PGlite code does not mean it is the active retrieval path.
  `src/main.ts:getDbManager()` currently returns an empty cast object, and
  `getRAGEngine()` supplies an empty cast `VectorManager`. Do not add callers
  assuming either is a functioning database manager without addressing that wiring.
- Global retrieval uses LightRAG's `/query` endpoint. Explicit file-scoped
  retrieval reads vault files directly. Preserve both paths when changing RAG.
- LightRAG local and remote modes share HTTP APIs but differ in ownership:
  mobile forces remote mode and disables local auto-start. Do not spawn, stop,
  or access local backend files in remote-only flows.

## Implementation conventions

- Follow `.prettierrc`: two spaces, no semicolons, single quotes, trailing commas.
  Follow existing import groups; ESLint enforces alphabetical declarations and
  sorted import members. TypeScript checks implicit `any` and nullability.
- Respect Obsidian 1.7.2 compatibility rather than assuming that APIs in the
  installed `obsidian` typings are available to users.
- Keep user-visible text sentence case. Do not suppress Obsidian review rules.
  Destructive buttons use `.addClass('mod-destructive')`, not `.setDestructive()`.
  Use `console.debug`, `console.warn`, or `console.error`, not `console.log`.
- Keep Node-only facilities behind `Platform.isDesktop` checks and lazy loading.
  CI explicitly forbids disabling `import/no-nodejs-modules`. Local processes
  and MCP stdio must not execute on mobile; use remote HTTP where supported.
- Preserve the CommonJS build's PGlite and `import.meta.url` shims in
  `esbuild.config.mjs` and `import-meta-url-shim.js`. The PGlite `process` shim
  is scoped to dependency files; the older development doc describes a different
  approach. Dependency changes need desktop/mobile runtime consideration.
- Add icons to the curated `src/utils/icons.ts` barrel and import from it.
  Do not introduce direct imports from the full `lucide-react` barrel; esbuild
  redirects bare imports to the curated module to limit bundle size.
- Reuse the network adapters appropriate to each path.
  `src/utils/fetch-utils.ts:obsidianRequestUrlFetch` uses Obsidian `requestUrl`
  to avoid renderer CORS/CSP restrictions, but buffers responses and ignores
  `AbortSignal`. It is not a replacement for true streaming/cancellation.
- Preserve stream abort handling and tool approval boundaries in
  `src/utils/chat/responseGenerator.ts` and the MCP manager. Qualified MCP tools
  use `server__tool`; server names must not contain `__`.
- Register lifecycle resources with Obsidian or dispose them explicitly. Clean up
  listeners, timers, polling, processes, MCP clients, and graph/React renderers
  on unload/close. Plugin reload is an important smoke-check scenario.

## Settings and persistent data

- Change settings through the schema/defaults, parsing/migration pipeline, and
  plugin `setSettings` path so validation, persistence, listeners, and RAG updates
  remain aligned. Add a versioned migration when changing persisted semantics;
  inspect existing migration tests and preserve user-customized values.
- `src/constants.ts` requires a settings migration when adding default providers
  or models. Updating the default list alone does not migrate existing users.
- JSON chat/template filenames contain schema-version metadata. Changing their
  format or version requires a reader/migration strategy; do not make older
  records disappear from repository listings.
- For legacy SQL changes, keep `src/database/schema.ts`, new SQL under `drizzle/`,
  migration metadata, and `src/database/migrations.json` consistent. Run
  `npm run migrate:compile` after changing migrations: runtime consumes the JSON,
  not the SQL directory. Preserve already-shipped migrations.
- `drizzle.config.ts` is entirely commented out. Do not assume the migration
  generation command in `CONTRIBUTING.md` works without configuring the installed
  Drizzle Kit version first.
- Legacy vector queries must constrain both embedding model and dimension;
  indexed dimensions are restricted by the schema. Do not mix vectors merely
  because they share a table.
- Treat migration, reset, deletion, and database recovery as data-loss-sensitive.
  Test on copies, retain sources until destination writes are verified, and do
  not interpret a read/network failure as permission to overwrite user data.
- Preserve watched-folder, extension, hidden-file, and exclusion checks during
  graph sync. Reuse `src/utils/glob-utils.ts`. Preserve offline status caches and
  distinguish intentionally removed documents from unknown/unprocessed ones.
- Never commit credentials, real vault contents, `.env` files, plugin `data.json`,
  `.neural_memory/`, `graph_data/`, database dumps, or document-status caches.
  Do not log API keys or send private notes to providers/backends during checks
  without permission. Use disposable data and explicit test endpoints.
