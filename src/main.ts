import {
  Editor,
  MarkdownView,
  Menu,
  Notice,
  Platform,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  requestUrl,
  setTooltip,
} from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import { ApplyView } from './ApplyView'
import { ChatView } from './ChatView'
import { ChatProps } from './components/chat-view/Chat'
import { ConfirmModal } from './components/modals/ConfirmModal'
import { GraphDocumentMappingModal } from './components/modals/GraphDocumentMappingModal'
import { APPLY_VIEW_TYPE, CHAT_VIEW_TYPE } from './constants'
import { ModelCatalog } from './core/llm/modelCatalog'
import { McpManager } from './core/mcp/mcpManager'
import { DocIndexService } from './core/rag/docIndexService'
import {
  ProcessingPolicy,
  documentSourceName,
  isParagraphFile,
  processingPolicy,
} from './core/rag/documentProcessing'
import {
  buildEntityTypeProfile,
  entityTypeNames,
  normalizeEntityTypeGuidance,
} from './core/rag/entityTypeGuidance'
import { FileExplorerDecorator } from './core/rag/fileExplorerDecorator'
import { RAGEngine } from './core/rag/ragEngine'
import { DatabaseManager } from './database/DatabaseManager'
import { VectorManager } from './database/modules/vector/VectorManager'
import {
  NeuralComposerSettings,
  NeuralComposerSettingsSchema,
} from './settings/schema/setting.types'
import { parseNeuralComposerSettings } from './settings/schema/settings'
import { NeuralComposerSettingTab } from './settings/SettingTab'
import {
  getExcludePatternForPath,
  isExcludedFromGraphSync,
} from './utils/glob-utils'
import { getMentionableBlockData } from './utils/obsidian'
import {
  NATIVE_GRAPH_VIEW_TYPE,
  NativeGraphView,
} from './views/NativeGraphView'

export const PLUGIN_NAME = 'Neural Composer'
export const BACKEND_NAME = 'LightRAG'
export const TERM_API = 'API'
export const TERM_LLM = 'LLM'
export const TERM_LLM_EMBED = 'LLM/Embed'
export const CMD_INGEST_FOLDER = 'Ingest folder into graph'
export const VAR_MAX_ASYNC = 'MAX_ASYNC' // Nombre de variable de entorno/configuración

const MANAGED_ENV_BEGIN = '# BEGIN NEURAL COMPOSER MANAGED ENV'
const MANAGED_ENV_END = '# END NEURAL COMPOSER MANAGED ENV'
const ENTITY_TYPE_PROFILE_NAME = 'neural-composer.yml'
// Complete native SDK endpoints; generated defaults bypass OpenAI /v1 normalization.
const NATIVE_PROVIDER_DEFAULT_HOSTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  ollama: 'http://localhost:11434',
}
const KNOWN_PROVIDER_BASE_URLS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com',
  mistral: 'https://api.mistral.ai/v1',
  perplexity: 'https://api.perplexity.ai',
  morph: 'https://api.morph.so/v1',
  'lm-studio': 'http://localhost:1234/v1',
}

function hasExplicitEnvValue(content: string, key: string): boolean {
  const prefix = `${key}=`
  return content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith(prefix)) return false
    const value = trimmed.slice(prefix.length).trim()
    return value !== '' && value !== "''" && value !== '""'
  })
}

// --- MASTER EXTENSION LIST ---
const SUPPORTED_EXTENSIONS = [
  'md',
  'txt',
  'docx',
  'pdf',
  'pptx',
  'xlsx',
  'rtf',
  'odt',
  'epub',
  'html',
  'htm',
  'xml',
  'json',
  'yaml',
  'yml',
  'csv',
  'tex',
  'log',
  'conf',
  'ini',
  'properties',
  'sql',
  'bat',
  'sh',
  'c',
  'cpp',
  'py',
  'java',
  'js',
  'ts',
  'swift',
  'go',
  'rb',
  'php',
  'css',
  'scss',
  'less',
]

// Definition for internal use, as 'Adapter' is not exported directly
type FileSystemAdapterWithBasePath = {
  getBasePath: () => string
}

// --- Minimal Node.js API surface used by this plugin -----------------------
// Node's built-in modules are loaded dynamically via `window.require` on
// desktop only (see onload()) so they never appear in the static import graph
// the Obsidian plugin linter rejects. We deliberately describe only the exact
// shapes this file (and NativeGraphView, which reuses these instances via
// `plugin._nodeFs` / `plugin._nodePath`) calls at runtime, rather than typing
// these fields as `typeof import('fs')` / `typeof import('child_process')` /
// etc. Those ambient-module type references depend on @types/node resolving
// identically across every TypeScript/tooling environment this plugin is
// built or linted in; when that resolution fails or differs, they silently
// degrade to `any` instead of producing a type error. Local interfaces make
// the types explicit and environment-independent.

/** A Node Buffer, described only by the capability actually used here. */
type BufferLike = {
  toString(encoding?: string): string
}

type NodeFsLike = {
  existsSync(path: string): boolean
  mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined
  writeFileSync(path: string, data: string, options?: { mode?: number }): void
  readFileSync(path: string, encoding: string): string
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
}

type NodePathLike = {
  join(...paths: string[]): string
}

export type EnvEditorSnapshot = {
  content: string
  backendIdentity: string
  envPath: string
  originalContent: string
  originalExists: boolean
}

type EnvFileSource = Omit<EnvEditorSnapshot, 'content'>

type LightRagHealthResult =
  | { kind: 'healthy'; busy: boolean; version?: string; elapsedMs: number }
  | { kind: 'http'; status: number }
  | { kind: 'network' }
  | { kind: 'timeout' }
  | { kind: 'invalid' }
  | { kind: 'stale' }

type PendingLightRagHealth = {
  invalidate: () => void
  promise: Promise<LightRagHealthResult>
  timeoutId: number
}

type NodeReadableStreamLike = {
  on(
    event: 'data',
    listener: (chunk: BufferLike | string) => void,
  ): NodeReadableStreamLike
}

type NodeChildProcessLike = {
  readonly pid: number
  readonly stdout: NodeReadableStreamLike | null
  readonly stderr: NodeReadableStreamLike | null
  kill(signal?: string): boolean
  on(
    event: 'close',
    listener: (code: number | null) => void,
  ): NodeChildProcessLike
  on(event: 'error', listener: (err: Error) => void): NodeChildProcessLike
}

type NodeSpawnOptions = {
  cwd?: string
  detached?: boolean
  shell?: boolean
  env?: Record<string, string | undefined>
}

type NodeExecSyncOptions = {
  stdio?: 'ignore' | 'inherit' | 'pipe'
}

type NodeChildProcessModuleLike = {
  spawn(
    command: string,
    args: string[],
    options?: NodeSpawnOptions,
  ): NodeChildProcessLike
  execSync(command: string, options?: NodeExecSyncOptions): BufferLike | string
}

type NodeSocketLike = {
  setTimeout(ms: number): NodeSocketLike
  once(event: 'error' | 'timeout', listener: () => void): NodeSocketLike
  connect(port: number, host: string, listener: () => void): NodeSocketLike
  destroy(): void
}

type NodeNetModuleLike = {
  Socket: new () => NodeSocketLike
}

type NodeProcessLike = {
  kill(pid: number, signal?: string): boolean
  platform: string
  env: Record<string, string | undefined>
}

/** Minimal shape of Node's global `process`, used only for the platform name
 *  and the environment variable map. Declared locally (shadowing the ambient
 *  @types/node global within this module only) for the same reason as the
 *  interfaces above — it keeps this file's typing independent of whether
 *  @types/node resolves in a given build environment. This has no runtime
 *  effect: `process` still resolves to the real global object. */
declare const process: NodeProcessLike | undefined

export default class NeuralComposerPlugin extends Plugin {
  settings: NeuralComposerSettings
  modelCatalog: ModelCatalog
  initialChatProps?: ChatProps
  settingsChangeListeners: ((newSettings: NeuralComposerSettings) => void)[] =
    []
  mcpManager: McpManager | null = null
  dbManager: DatabaseManager | null = null
  ragEngine: RAGEngine | null = null

  private dbManagerInitPromise: Promise<DatabaseManager> | null = null
  private docIndexLoadPromise: Promise<DocIndexService> | null = null
  private ragEngineInitPromise: Promise<RAGEngine> | null = null

  private timeoutIds: number[] = []
  private pendingLightRagHealth: PendingLightRagHealth | null = null
  private modifyDebounceMap: Map<string, number> = new Map()
  private serverProcess: NodeChildProcessLike | null = null
  private lastErrorTime: number = 0
  public docIndexService: DocIndexService | null = null
  private fileExplorerDecorator: FileExplorerDecorator | null = null
  private lastServerStatus: 'online' | 'offline' | 'busy' = 'offline'
  /** True once the doc-status index has been loaded from disk. Prevents vault
   *  events that fire during Obsidian startup from re-submitting already-ingested files. */
  private docIndexReady = false
  private graphBatchAbort: AbortController | null = null
  private graphSyncTail: Promise<void> = Promise.resolve()
  private graphDisposed = false
  private deferredGraphChanges = new Map<
    string,
    { path: string; previousPath?: string; remove: boolean }
  >()

  /** Detected LightRAG core version (from GET /health → core_version). Null when offline or not yet checked. */
  public lightRagServerVersion: string | null = null
  /** True once at least one health check has completed (distinguishes "not yet checked" from "offline"). */
  public lightRagServerChecked = false

  private ingestedFolderPaths: Set<string> = new Set()
  private ingestedFolderPathsLoaded = false

  private versionChangeListeners: Set<
    (info: { version: string | null; checked: boolean }) => void
  > = new Set()

  /** Subscribe to LightRAG server version/status changes. Returns an unsubscribe fn. */
  addVersionChangeListener(
    fn: (info: { version: string | null; checked: boolean }) => void,
  ): () => void {
    this.versionChangeListeners.add(fn)
    return () => this.versionChangeListeners.delete(fn)
  }

  private setServerVersion(v: string | null): void {
    const wasChecked = this.lightRagServerChecked
    this.lightRagServerChecked = true
    // Notify if: first health check (checked state just flipped) OR version changed
    if (!wasChecked || v !== this.lightRagServerVersion) {
      this.lightRagServerVersion = v
      this.versionChangeListeners.forEach((fn) =>
        fn({ version: v, checked: true }),
      )
    }
  }

  // Node.js modules — loaded lazily on desktop only, always null on mobile.
  // fs/path are public so views (e.g. NativeGraphView) can reuse them instead
  // of importing Node built-ins themselves.
  _nodeFs: NodeFsLike | null = null
  _nodePath: NodePathLike | null = null
  private _nodeChildProcess: NodeChildProcessModuleLike | null = null
  private _nodeNet: NodeNetModuleLike | null = null

  // --- STATUS BAR PROPERTIES ---
  private statusBarEl: HTMLElement
  private statusDotEl: HTMLElement
  private heartbeatInterval: number

  /** Returns true if the user has enabled remote server mode. */
  isRemoteServer(): boolean {
    return this.settings.lightRagUseRemote
  }

  /** Extracts the port number from the configured server URL, with safe fallback. */
  private getServerPort(): number {
    try {
      return parseInt(new URL(this.settings.lightRagServerUrl).port) || 9621
    } catch {
      return 9621
    }
  }

  /** Returns headers for LightRAG API calls, including auth if configured. */
  private getLightRagHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.settings.lightRagApiKey) {
      headers['X-API-Key'] = this.settings.lightRagApiKey
    }
    return headers
  }

  private getSafeLightRagEndpoint(): string {
    try {
      const endpoint = new URL(this.settings.lightRagServerUrl)
      endpoint.username = ''
      endpoint.password = ''
      endpoint.search = ''
      endpoint.hash = ''
      return endpoint.toString().replace(/\/$/, '')
    } catch {
      return 'the configured endpoint'
    }
  }

  async onload() {
    await this.loadSettings()
    this.modelCatalog = new ModelCatalog(this)

    // Load Node.js built-ins once at startup — desktop only, never on mobile.
    // Obsidian desktop exposes Node's `require` on the window object. Calling
    // it as a member (`window.require`) rather than a bare `require` keeps
    // these Node built-ins out of the static import graph the Obsidian plugin
    // linter rejects, while resolving the exact same modules at runtime.
    if (Platform.isDesktop) {
      const nodeRequire = (
        window as unknown as { require: (id: string) => unknown }
      ).require
      this._nodeFs = nodeRequire('fs') as NodeFsLike
      this._nodePath = nodeRequire('path') as NodePathLike
      this._nodeChildProcess = nodeRequire(
        'child_process',
      ) as NodeChildProcessModuleLike
      this._nodeNet = nodeRequire('net') as NodeNetModuleLike
    }

    // --- ZERO-CONFIG & PORTABILITY ---
    if (Platform.isDesktop && !this.settings.lightRagWorkDir) {
      // Safe casting to check for desktop adapter capabilities
      const adapter = this.app.vault.adapter

      if (
        typeof (adapter as unknown as FileSystemAdapterWithBasePath)
          .getBasePath === 'function'
      ) {
        const vaultRoot = (
          adapter as unknown as FileSystemAdapterWithBasePath
        ).getBasePath()
        const defaultPath = this._nodePath!.join(vaultRoot, '.neural_memory')

        if (!this._nodeFs!.existsSync(defaultPath)) {
          try {
            this._nodeFs!.mkdirSync(defaultPath, { recursive: true })
          } catch (e) {
            console.error('Failed to create default folder:', e)
            new Notice('Failed to create default .neural_memory folder.')
          }
        }

        this.settings.lightRagWorkDir = defaultPath
        await this.saveData(this.settings)
      }
    }

    // --- STATUS BAR INITIALIZATION ---
    this.statusBarEl = this.addStatusBarItem()
    this.statusBarEl.addClass('nrlcmp-status-bar-item')
    this.statusDotEl = this.statusBarEl.createSpan({ cls: 'nrlcmp-status-dot' })
    this.statusBarEl.createSpan({ text: 'Neural' })
    setTooltip(this.statusBarEl, `${BACKEND_NAME} server status`)

    this.statusBarEl.onclick = () => {
      void this.handleStatusBarClick()
    }

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this))
    this.registerView(APPLY_VIEW_TYPE, (leaf) => new ApplyView(leaf))

    this.addRibbonIcon('brain-circuit', `Open ${PLUGIN_NAME}`, () => {
      void this.openChatView()
    })

    // NATIVE GRAPH VIEWER
    this.registerView(
      NATIVE_GRAPH_VIEW_TYPE,
      (leaf) => new NativeGraphView(leaf, this),
    )

    this.addCommand({
      id: 'open-native-graph',
      name: 'Open native graph view',
      callback: () => {
        // Wrapped in void async IIFE to satisfy void return expectation
        void (async () => {
          const { workspace } = this.app
          let leaf: WorkspaceLeaf | null = null
          const leaves = workspace.getLeavesOfType(NATIVE_GRAPH_VIEW_TYPE)

          if (leaves.length > 0) {
            leaf = leaves[0]
          } else {
            leaf = workspace.getLeaf(true)
            await leaf.setViewState({
              type: NATIVE_GRAPH_VIEW_TYPE,
              active: true,
            })
          }
          if (leaf) await workspace.revealLeaf(leaf)
        })()
      },
    })

    this.addCommand({
      id: 'open-new-chat',
      name: 'Open chat',
      callback: () => {
        void this.openChatView(true)
      },
    })

    this.addCommand({
      id: 'add-selection-to-chat',
      name: 'Add selection to chat',
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.addSelectionToChat(editor, view)
      },
    })

    // --- QUICK RESTART COMMAND ---
    this.addCommand({
      id: 'restart-neural-backend',
      name: `Restart neural backend (${BACKEND_NAME})`,
      callback: () => {
        if (!Platform.isDesktop) {
          new Notice(
            'Local server management is only available on desktop. Use remote server mode on mobile.',
          )
          return
        }
        this.restartLightRagServer()
      },
    })

    this.addCommand({
      id: 'ping-lightrag-server',
      name: 'Ping LightRAG server',
      callback: () => {
        void this.pingLightRagServer()
      },
    })

    // --- CONTEXT MENU (FOLDERS) ---
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFolder) {
          const inGraph = this.isFolderInGraph(file.path)
          const showIngest = !this.ingestedFolderPathsLoaded || !inGraph
          const showRemove = !this.ingestedFolderPathsLoaded || inGraph

          if (showIngest) {
            menu.addItem((item) => {
              item
                .setTitle(CMD_INGEST_FOLDER)
                .setIcon('layers')
                .onClick(() => {
                  void this.batchIngestFolder(file)
                })
            })
          }
          if (showRemove) {
            menu.addItem((item) => {
              item
                .setTitle('Remove folder from graph')
                .setIcon('trash-2')
                .onClick(() => {
                  void this.batchRemoveFolderFromGraph(file)
                })
            })
          }
        }
      }),
    )

    // --- CONTEXT MENU: exclude / re-include from graph sync ---
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        this.addGraphExclusionMenuItem(menu, [file])
      }),
    )
    this.registerEvent(
      this.app.workspace.on('files-menu', (menu, files) => {
        this.addGraphExclusionMenuItem(menu, files)
      }),
    )

    this.addCommand({
      id: 'ingest-current-file',
      name: 'Ingest current file into knowledge graph',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile()
        if (
          !file ||
          !SUPPORTED_EXTENSIONS.includes(file.extension.toLowerCase())
        )
          return false
        if (!checking) void this.runGraphBatch([file], 'new')
        return true
      },
    })
    this.addCommand({
      id: 'reprocess-current-file',
      name: 'Reprocess current file with current settings',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile()
        if (
          !file ||
          !SUPPORTED_EXTENSIONS.includes(file.extension.toLowerCase())
        )
          return false
        if (!checking) void this.confirmGraphReprocessing([file])
        return true
      },
    })
    this.addCommand({
      id: 'cancel-graph-processing',
      name: 'Cancel graph processing batch',
      callback: () => {
        if (!this.graphBatchAbort) {
          new Notice('No graph processing batch is running.')
          return
        }
        this.graphBatchAbort.abort()
        new Notice(
          'Stopping further submissions; accepted server work may continue.',
        )
      },
    })
    this.addCommand({
      id: 'resume-graph-sync',
      name: 'Resume queued graph synchronization',
      callback: () => {
        if (this.graphBatchAbort) {
          new Notice('Wait for the current batch to stop.')
          return
        }
        const changes = [...this.deferredGraphChanges.values()]
        this.deferredGraphChanges.clear()
        for (const change of changes) this.queueGraphChange(change)
        new Notice(
          `Resuming ${changes.length} queued graph change(s). Failed operations still require explicit retry.`,
        )
      },
    })

    const refreshSources = () => {
      if (this.docIndexReady) {
        void this.docIndexService
          ?.rebuildSourceMap()
          .catch((error: unknown) =>
            console.error('Document source reconciliation failed', error),
          )
      }
    }

    this.registerEvent(
      this.app.vault.on('create', (file) => {
        refreshSources()
        if (!(file instanceof TFile) || !this.docIndexReady) return
        if (!this.isWatchedGraphPath(file.path)) return
        this.scheduleGraphSync(file, 2000)
      }),
    )
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile) || !this.docIndexReady) return
        if (!this.isWatchedGraphPath(file.path)) return
        this.scheduleGraphSync(file, 5000)
      }),
    )
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        refreshSources()
        if (!(file instanceof TFile) || !this.docIndexReady) return
        const pending = this.deferredGraphChanges.get(file.path)
        if (!this.isWatchedGraphPath(file.path) && !pending) return
        this.deferredGraphChanges.delete(file.path)
        this.queueGraphChange({
          path: pending?.previousPath ?? file.path,
          remove: true,
        })
      }),
    )
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        refreshSources()
        this.handleGraphRename(file, oldPath)
      }),
    )

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
        if (file instanceof TFolder) {
          menu.addItem((item) =>
            item
              .setTitle('Reprocess with current settings')
              .setIcon('refresh-cw')
              .onClick(() => {
                void this.confirmGraphReprocessing(
                  this.getAllSupportedFiles(file),
                )
              }),
          )
          return
        }
        if (!(file instanceof TFile)) return
        if (!SUPPORTED_EXTENSIONS.includes(file.extension.toLowerCase())) return
        const record = this.docIndexService?.getRecord(file.path)
        menu.addItem((item) =>
          item
            .setTitle('Reprocess with current settings')
            .setIcon('refresh-cw')
            .onClick(() => void this.confirmGraphReprocessing([file])),
        )
        if (record?.pending) {
          menu.addItem((item) =>
            item
              .setTitle('Retry failed processing')
              .setIcon('refresh-cw')
              .onClick(
                () => void this.confirmGraphReprocessing([file], 'retry'),
              ),
          )
        }
        menu.addItem((item) =>
          item
            .setTitle('Map existing graph document')
            .setIcon('link')
            .onClick(() => void this.mapGraphDocument(file)),
        )
        if (record?.status === 'removed') {
          menu.addItem((item) =>
            item
              .setTitle('Re-add to graph')
              .setIcon('plus')
              .onClick(
                () =>
                  void this.confirmGraphReprocessing([file], 'reprocess', true),
              ),
          )
        } else if (record?.docId) {
          menu.addItem((item) =>
            item
              .setTitle('Remove from graph')
              .setIcon('trash-2')
              .onClick(() => {
                new ConfirmModal(this.app, {
                  title: 'Remove from graph',
                  message: `Remove "${file.path}" and its graph contributions? The vault file will be kept.`,
                  ctaText: 'Remove',
                  destructive: true,
                  onConfirm: () =>
                    this.queueGraphChange({ path: file.path, remove: true }),
                }).open()
              }),
          )
        }
      }),
    )

    this.addSettingTab(new NeuralComposerSettingTab(this.app, this))

    // --- AGGRESSIVE AUTO-START ---
    this.app.workspace.onLayoutReady(() => {
      if (
        Platform.isDesktop &&
        this.settings.enableAutoStartServer &&
        !this.isRemoteServer()
      ) {
        void this.startLightRagServer()
      }
      // --- LATIDO LEGAL Y SEGURO ---
      // registerInterval asegura que el proceso muera si el plugin se apaga
      this.registerInterval(
        window.setInterval(() => {
          void this.checkAndUpdateStatus()
        }, 30000),
      )

      // Primera revisión inmediata
      void this.checkAndUpdateStatus()

      // Initialize doc index service + file explorer decoration
      this.docIndexService ??= new DocIndexService(this)
      this.fileExplorerDecorator = new FileExplorerDecorator()
      this.docIndexService.setUpdateCallback(() => this.decorateFileExplorer())

      // MutationObserver inside FileExplorerDecorator watches childList changes
      // (Obsidian re-rendering file items) and re-applies data-nc-status attributes.
      // Safe: our setAttribute calls are attribute mutations — they do NOT fire
      // childList observers, so there is zero risk of an infinite loop.
      this.fileExplorerDecorator.startObserving(() =>
        this.decorateFileExplorer(),
      )

      // Re-decorate whenever the workspace layout changes (pane open/close, etc.)
      this.registerEvent(
        this.app.workspace.on('layout-change', () => {
          this.decorateFileExplorer()
        }),
      )

      // Load persisted index → render immediately, then sync with server
      void (async () => {
        await this.ensureDocIndex()
        this.decorateFileExplorer() // render cached statuses right away

        // Give a short delay for the server to be reachable, then sync.
        // We check health first so we don't clobber the cached index when
        // the server is simply offline.
        this.timeoutIds.push(
          window.setTimeout(() => {
            void (async () => {
              const online = await this.docIndexService?.isServerOnline()
              if (online) {
                await this.docIndexService?.syncFromServer()
                await this.getRAGEngine()
                this.decorateFileExplorer()
                // Always start pipeline watch after the initial sync:
                // • If the pipeline is idle → one poll → busy=false → stops immediately
                // • If docs are processing (from a previous session) → watches until done
                this.docIndexService?.startPipelineWatch(2000)
              }
            })().catch((error: unknown) => {
              new Notice(
                `Graph recovery paused: ${error instanceof Error ? error.message : String(error)}`,
              )
            })
          }, 2000),
        )
      })().catch((error: unknown) => {
        new Notice(
          `Document index unavailable: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    })
  }

  // --- BATCH LOGIC ---
  private getAllSupportedFiles(folder: TFolder): TFile[] {
    let files: TFile[] = []
    for (const child of folder.children) {
      if (child instanceof TFile) {
        if (SUPPORTED_EXTENSIONS.includes(child.extension.toLowerCase())) {
          files.push(child)
        }
      } else if (child instanceof TFolder) {
        files = files.concat(this.getAllSupportedFiles(child))
      }
    }
    return files
  }

  async batchIngestFolder(folder: TFolder) {
    await this.runGraphBatch(this.getAllSupportedFiles(folder), 'new')
  }

  async refreshIngestedFolderPaths(): Promise<void> {
    const backendId = this.settings.lightRagBackendIdentity
    const namespace = this.settings.lightRagVaultNamespace
    try {
      const ragEngine = await this.getRAGEngine()
      if (
        this.graphDisposed ||
        backendId !== this.settings.lightRagBackendIdentity ||
        namespace !== this.settings.lightRagVaultNamespace
      )
        return
      const paths = await ragEngine.listAllDocumentPaths()
      if (
        this.graphDisposed ||
        backendId !== this.settings.lightRagBackendIdentity ||
        namespace !== this.settings.lightRagVaultNamespace
      )
        return
      const folders = new Set<string>()
      for (const filePath of paths) {
        const normalized = filePath.replace(/\\/g, '/')
        const parts = normalized.split('/')
        for (let i = parts.length - 1; i > 0; i--) {
          folders.add(parts.slice(0, i).join('/'))
        }
      }
      if (
        this.graphDisposed ||
        backendId !== this.settings.lightRagBackendIdentity ||
        namespace !== this.settings.lightRagVaultNamespace
      )
        return
      this.ingestedFolderPaths = folders
      this.ingestedFolderPathsLoaded = true
    } catch (e) {
      console.error('refreshIngestedFolderPaths failed:', e)
    }
  }

  private isFolderInGraph(folderPath: string): boolean {
    if (!this.ingestedFolderPathsLoaded) return false
    return this.ingestedFolderPaths.has(folderPath)
  }

  isPathExcludedFromGraph(path: string): boolean {
    return isExcludedFromGraphSync(path, {
      excludePatterns: this.settings.lightRagExcludePatterns,
      excludeHiddenFiles: this.settings.lightRagExcludeHiddenFiles,
    })
  }

  private stopGraphSubmissionsForRemoval(paths: string[]): void {
    if (paths.length === 0) return
    this.graphBatchAbort?.abort()
    const selected = new Set(paths)
    for (const [key, change] of this.deferredGraphChanges) {
      if (
        selected.has(change.path) ||
        (change.previousPath !== undefined && selected.has(change.previousPath))
      ) {
        this.deferredGraphChanges.delete(key)
      }
    }
    for (const path of selected) {
      const timer = this.modifyDebounceMap.get(path)
      if (timer !== undefined) {
        window.clearTimeout(timer)
        this.modifyDebounceMap.delete(path)
      }
    }
  }

  private addGraphExclusionMenuItem(menu: Menu, files: TAbstractFile[]) {
    if (files.length === 0) return

    const patterns = files.map((file) =>
      getExcludePatternForPath(file.path, file instanceof TFolder),
    )
    const current = this.settings.lightRagExcludePatterns
    const allExcluded = patterns.every((p) => current.includes(p))

    menu.addItem((item) => {
      item
        .setTitle(
          allExcluded ? 'Re-include in graph sync' : 'Exclude from graph sync',
        )
        .setIcon(allExcluded ? 'eye' : 'eye-off')
        .onClick(() => {
          if (allExcluded) {
            void this.removeGraphExcludePatterns(patterns)
          } else {
            void this.addGraphExclusionForFiles(files, patterns)
          }
        })
    })
  }

  private async addGraphExclusionForFiles(
    files: TAbstractFile[],
    patterns: string[],
  ) {
    const backendId = this.settings.lightRagBackendIdentity
    const namespace = this.settings.lightRagVaultNamespace
    const targetFiles: TFile[] = []
    for (const file of files) {
      if (file instanceof TFolder) {
        targetFiles.push(...this.getAllSupportedFiles(file))
      } else if (file instanceof TFile) {
        targetFiles.push(file)
      }
    }
    const targetPaths = [...new Set(targetFiles.map((file) => file.path))]
    this.stopGraphSubmissionsForRemoval(targetPaths)

    const merged = Array.from(
      new Set([...this.settings.lightRagExcludePatterns, ...patterns]),
    )
    await this.setSettings({
      ...this.settings,
      lightRagExcludePatterns: merged,
    })

    if (targetPaths.length === 0) {
      new Notice('Excluded from graph sync')
      return
    }

    const notice = new Notice('Removing excluded files from graph...', 0)
    try {
      const ragEngine = await this.getRAGEngine()
      if (
        this.graphDisposed ||
        backendId !== this.settings.lightRagBackendIdentity ||
        namespace !== this.settings.lightRagVaultNamespace
      ) {
        throw new Error('Graph ownership changed; removal was not redirected.')
      }
      const removed = await ragEngine.deleteDocumentsByPaths(targetPaths)
      if (
        this.graphDisposed ||
        backendId !== this.settings.lightRagBackendIdentity ||
        namespace !== this.settings.lightRagVaultNamespace
      ) {
        throw new Error(
          'Graph ownership changed; removal result was not applied.',
        )
      }
      if (!removed) {
        throw new Error(
          'Removal is unresolved; excluded documents remain paused.',
        )
      }
      notice.setMessage(
        `Excluded from graph sync (removed ${targetPaths.length} file${targetPaths.length === 1 ? '' : 's'} from graph)`,
      )
    } catch (error) {
      console.error('Error removing excluded files from graph:', error)
      notice.setMessage(
        `Excluded from graph sync (graph removal paused: ${error instanceof Error ? error.message : String(error)})`,
      )
    } finally {
      window.setTimeout(() => notice.hide(), 4000)
    }
  }

  private async removeGraphExcludePatterns(patterns: string[]) {
    const toRemove = new Set(patterns)
    const remaining = this.settings.lightRagExcludePatterns.filter(
      (p) => !toRemove.has(p),
    )
    await this.setSettings({
      ...this.settings,
      lightRagExcludePatterns: remaining,
    })
    new Notice(
      'Re-included in graph sync. Removed documents stay removed; resolve any paused removal, then use "re-add to graph" for each document you want to add again.',
    )
  }

  batchRemoveFolderFromGraph(folder: TFolder) {
    const files = this.getAllSupportedFiles(folder)
    if (files.length === 0) {
      new Notice('Empty folder or no supported files.')
      return
    }

    new ConfirmModal(this.app, {
      title: 'Remove folder from graph',
      message: `Remove ${files.length} file${
        files.length === 1 ? '' : 's'
      } in "${folder.path}" (and its subfolders) from the ${BACKEND_NAME} graph?\n\nThe files themselves stay in the vault.`,
      ctaText: 'Remove',
      destructive: true,
      onConfirm: () => {
        void this.executeBatchRemoveFolderFromGraph(folder, files)
      },
    }).open()
  }

  private async executeBatchRemoveFolderFromGraph(
    folder: TFolder,
    files: TFile[],
  ) {
    const backendId = this.settings.lightRagBackendIdentity
    const namespace = this.settings.lightRagVaultNamespace
    const paths = [...new Set(files.map((file) => file.path))]
    const notice = new Notice(`Removing ${paths.length} files from graph...`, 0)
    this.stopGraphSubmissionsForRemoval(paths)

    try {
      const ragEngine = await this.getRAGEngine()
      if (
        this.graphDisposed ||
        backendId !== this.settings.lightRagBackendIdentity ||
        namespace !== this.settings.lightRagVaultNamespace
      ) {
        throw new Error('Graph ownership changed; removal was not redirected.')
      }
      notice.setMessage('Settling accepted work before removal…')
      const removed = await ragEngine.deleteDocumentsByPaths(paths)
      if (
        this.graphDisposed ||
        backendId !== this.settings.lightRagBackendIdentity ||
        namespace !== this.settings.lightRagVaultNamespace
      ) {
        throw new Error(
          'Graph ownership changed; removal result was not applied.',
        )
      }
      if (!removed) {
        throw new Error('Removal is unresolved; documents remain paused.')
      }

      this.updateStatusUI('online')
      notice.setMessage(
        `Removed ${paths.length} from "${folder.path}".\nReopen the graph view to refresh.`,
      )
      window.setTimeout(() => notice.hide(), 6000)
      void this.refreshIngestedFolderPaths()
      this.decorateFileExplorer()
    } catch (error) {
      console.error('Batch remove error:', error)
      notice.setMessage(
        `Folder removal paused: ${error instanceof Error ? error.message : String(error)}`,
      )
      window.setTimeout(() => notice.hide(), 5000)
    }
  }

  // --- LIFECYCLE & SERVER MANAGEMENT ---

  onunload() {
    this.graphDisposed = true
    this.invalidateLightRagHealthRequest()
    this.graphBatchAbort?.abort()
    this.deferredGraphChanges.clear()
    this.modelCatalog?.dispose()
    window.clearInterval(this.heartbeatInterval)
    this.timeoutIds.forEach((id) => window.clearTimeout(id))
    this.timeoutIds = []
    this.modifyDebounceMap.forEach((id) => window.clearTimeout(id))
    this.modifyDebounceMap.clear()

    if (this.ragEngine) {
      this.ragEngine.cleanup()
      this.ragEngine = null
    }

    // Reset promises so they can be re-initialized if plugin is re-enabled without full reload
    this.dbManagerInitPromise = null
    this.docIndexLoadPromise = null
    this.ragEngineInitPromise = null

    if (this.dbManager) {
      // FIX: Use void operator to handle the async cleanup promise
      void this.dbManager.cleanup()
      this.dbManager = null
    }
    if (this.mcpManager) {
      // FIX: Use void operator here too if mcpManager.cleanup() is async
      void this.mcpManager.cleanup()
      this.mcpManager = null
    }
    this.docIndexService?.destroy()
    this.docIndexService = null
    this.fileExplorerDecorator?.clear()
    this.fileExplorerDecorator = null
    this.stopLightRagServer()
  }

  /** Apply data-nc-status attributes to files and the watched folder. No DOM injection. */
  private decorateFileExplorer(): void {
    if (!this.fileExplorerDecorator || !this.docIndexService) return
    const syncFolder = this.settings.lightRagSyncFolder.trim()

    // Compute aggregate folder status from ALL files in the sync folder,
    // not just the ones visible in the DOM (avoids false-green on scroll).
    const folderFilePaths = syncFolder
      ? this.app.vault
          .getFiles()
          .filter(
            (f) => f.path === syncFolder || f.path.startsWith(syncFolder + '/'),
          )
          .map((f) => f.path)
      : []
    const folderStatus =
      this.docIndexService.computeFolderStatus(folderFilePaths)

    this.fileExplorerDecorator.decorate(
      syncFolder,
      (path) => this.docIndexService!.getStatus(path),
      folderStatus,
    )
  }

  public stopLightRagServer() {
    if (!Platform.isDesktop) {
      this.updateStatusUI('offline')
      return
    }
    const child = this.serverProcess
    if (!child) {
      this.updateStatusUI('offline')
      return
    }
    this.serverProcess = null

    let terminated = false
    try {
      if (typeof process !== 'undefined') {
        if (process.platform === 'win32') {
          if (this._nodeChildProcess) {
            this._nodeChildProcess.execSync(
              `taskkill /PID ${child.pid} /T /F`,
              { stdio: 'ignore' },
            )
            terminated = true
          }
        } else {
          process.kill(-child.pid, 'SIGTERM')
          terminated = true
        }
      }
    } catch {
      // Fall back to the exact owned handle below.
    }
    if (!terminated) {
      try {
        child.kill('SIGTERM')
      } catch {
        // The owned process already exited.
      }
    }
    this.updateStatusUI('offline')
  }

  public restartLightRagServer(skipEnvUpdate = false) {
    if (!Platform.isDesktop) {
      new Notice(
        'Local server management is only available on desktop. Use remote server mode on mobile.',
      )
      return
    }
    new Notice('Restarting system backend...')
    this.stopLightRagServer()
    // Use timeout to allow process to fully die
    this.timeoutIds.push(
      window.setTimeout(() => {
        void this.startLightRagServer(skipEnvUpdate)
      }, 2000),
    )
  }

  // Normalizes a provider base URL so it ends with /v1, regardless of how the user entered it.
  // LightRAG's Python OpenAI client uses base_url directly and expects the /v1 path to be included.
  private normalizeBindingHost(url: string): string {
    const trimmed = url.replace(/\/+$/, '') // strip trailing slashes
    if (trimmed.endsWith('/v1')) return trimmed
    return `${trimmed}/v1`
  }

  // GENERATOR
  public generateEnvConfig(): string {
    const workDir = this.settings.lightRagWorkDir
    if (!workDir) return ''

    try {
      const targetLlmId =
        this.settings.lightRagModelId || this.settings.chatModelId
      const embeddingId =
        this.settings.lightRagEmbeddingModelId || this.settings.embeddingModelId

      const llmModelObj = this.settings.chatModels.find(
        (m) => m.id === targetLlmId,
      )
      const embedModelObj = this.settings.embeddingModels.find(
        (m) => m.id === embeddingId,
      )

      const llmProvider = this.settings.providers.find(
        (p) => p.id === llmModelObj?.providerId,
      )
      const embedProvider = this.settings.providers.find(
        (p) => p.id === embedModelObj?.providerId,
      )

      if (
        llmProvider?.type === 'codex-cli' ||
        embedProvider?.type === 'codex-cli'
      ) {
        new Notice(
          'Codex CLI cannot run the LightRAG backend or embeddings. Select a separate graph logic model and embedding provider in settings.',
        )
        return ''
      }

      let envContent = `# Generated by Neural Composer\n`
      envContent += `# You can edit this file manually before restarting.\n\n`

      envContent += `WORKING_DIR=${workDir}\n`
      envContent += `HOST=127.0.0.1\n`
      envContent += `PORT=${this.getServerPort()}\n`
      envContent += `SUMMARY_LANGUAGE=${this.settings.lightRagSummaryLanguage || 'English'}\n`

      // --- TUNING VARS ---
      envContent += `\n# --- Performance Tuning ---\n`
      envContent += `MAX_ASYNC=${this.settings.lightRagMaxAsync}\n`
      envContent += `MAX_PARALLEL_INSERT=${this.settings.lightRagMaxParallelInsert}\n`
      envContent += `CHUNK_SIZE=${this.settings.lightRagChunkSize}\n`
      envContent += `CHUNK_OVERLAP_SIZE=${this.settings.lightRagChunkOverlap}\n\n`

      // Plugin provider IDs → LightRAG binding names.
      // LightRAG uses 'google' (not 'gemini') and 'azure_openai' (not 'azure').
      const LIGHTRAG_BINDING_MAP: Record<string, string> = {
        gemini: 'google',
        azure: 'azure_openai',
      }

      // LLM CONFIGURATION
      if (llmModelObj && llmProvider) {
        envContent += `# LLM Configuration\n`

        const nativeProviders = [
          'openai',
          'gemini',
          'ollama',
          'anthropic',
          'azure',
        ]

        // ¿Es un proveedor nativo o uno custom?
        const isNative = nativeProviders.includes(llmProvider.id)

        if (isNative) {
          const llmBindingName =
            LIGHTRAG_BINDING_MAP[llmProvider.id] ?? llmProvider.id
          envContent += `LLM_BINDING=${llmBindingName}\n`

          const configuredNativeLlmHost = llmProvider.baseUrl?.trim()
          const resolvedNativeLlmHost =
            configuredNativeLlmHost ||
            NATIVE_PROVIDER_DEFAULT_HOSTS[llmProvider.id]
          if (!resolvedNativeLlmHost) {
            if (
              !hasExplicitEnvValue(
                this.settings.lightRagCustomEnv,
                'LLM_BINDING_HOST',
              )
            ) {
              throw new Error(
                `No LightRAG host is available for provider "${llmProvider.id}".`,
              )
            }
          } else if (llmProvider.id === 'ollama') {
            const ollamaHost = resolvedNativeLlmHost.replace(/\/+$/, '')
            envContent += `OLLAMA_HOST=${ollamaHost}\n`
            envContent += `LLM_BINDING_HOST=${ollamaHost}\n`
          } else {
            const normalizedLlmHost = configuredNativeLlmHost
              ? this.normalizeBindingHost(configuredNativeLlmHost)
              : resolvedNativeLlmHost
            envContent += `LLM_BINDING_HOST=${normalizedLlmHost}\n`
          }
        } else {
          // Custom provider: use openai-compatible binding.
          // Include a fallback base URL for well-known providers that may not
          // have an explicit baseUrl stored (e.g. openrouter added before this
          // field was required). Without this, LightRAG silently falls back to
          // api.openai.com and rejects non-OpenAI keys with a 401 error.
          envContent += `LLM_BINDING=openai\n`
          const resolvedLlmBaseUrl =
            llmProvider.baseUrl?.trim() ||
            KNOWN_PROVIDER_BASE_URLS[llmProvider.id] ||
            KNOWN_PROVIDER_BASE_URLS[llmProvider.type]
          if (!resolvedLlmBaseUrl) {
            if (
              !hasExplicitEnvValue(
                this.settings.lightRagCustomEnv,
                'LLM_BINDING_HOST',
              )
            ) {
              throw new Error(
                `No LightRAG host is available for provider "${llmProvider.id}".`,
              )
            }
          } else {
            envContent += `LLM_BINDING_HOST=${this.normalizeBindingHost(resolvedLlmBaseUrl)}\n`
          }
        }

        envContent += `LLM_BINDING_API_KEY=${llmProvider.apiKey ?? ''}\n`
        envContent += `LLM_MODEL=${llmModelObj.model}\n`
      }

      // Embeddings (Smart Mapping)
      if (embedModelObj && embedProvider) {
        envContent += `\n# Embedding Configuration\n`

        const nativeEmbedProviders = [
          'openai',
          'gemini',
          'ollama',
          'anthropic',
          'azure',
        ]
        const isNativeEmbed = nativeEmbedProviders.includes(embedProvider.id)

        if (isNativeEmbed) {
          const embedBindingName =
            LIGHTRAG_BINDING_MAP[embedProvider.id] ?? embedProvider.id
          envContent += `EMBEDDING_BINDING=${embedBindingName}\n`

          // LightRAG bug workaround: get_default_host('ollama') reads LLM_BINDING_HOST
          // as a fallback instead of using a proper Ollama default. When LLM_BINDING_HOST
          // is set to a remote provider (e.g. OpenRouter), Ollama embedding silently routes
          // there and gets 404s. Always write EMBEDDING_BINDING_HOST explicitly to prevent this.
          const configuredNativeEmbedHost = embedProvider.baseUrl?.trim()
          const resolvedNativeEmbedHost =
            configuredNativeEmbedHost ||
            NATIVE_PROVIDER_DEFAULT_HOSTS[embedProvider.id]
          if (!resolvedNativeEmbedHost) {
            if (
              !hasExplicitEnvValue(
                this.settings.lightRagCustomEnv,
                'EMBEDDING_BINDING_HOST',
              )
            ) {
              throw new Error(
                `No LightRAG host is available for provider "${embedProvider.id}".`,
              )
            }
          } else {
            // Ollama uses its own /api/* paths — do NOT append /v1
            const normalizedEmbedHost =
              embedProvider.id === 'ollama'
                ? resolvedNativeEmbedHost.replace(/\/+$/, '')
                : configuredNativeEmbedHost
                  ? this.normalizeBindingHost(configuredNativeEmbedHost)
                  : resolvedNativeEmbedHost
            envContent += `EMBEDDING_BINDING_HOST=${normalizedEmbedHost}\n`
          }
        } else {
          // Custom provider: use openai-compatible binding with fallback base URL.
          envContent += `EMBEDDING_BINDING=openai\n`
          const resolvedEmbedBaseUrl =
            embedProvider.baseUrl?.trim() ||
            KNOWN_PROVIDER_BASE_URLS[embedProvider.id] ||
            KNOWN_PROVIDER_BASE_URLS[embedProvider.type]
          if (!resolvedEmbedBaseUrl) {
            if (
              !hasExplicitEnvValue(
                this.settings.lightRagCustomEnv,
                'EMBEDDING_BINDING_HOST',
              )
            ) {
              throw new Error(
                `No LightRAG host is available for provider "${embedProvider.id}".`,
              )
            }
          } else {
            envContent += `EMBEDDING_BINDING_HOST=${this.normalizeBindingHost(resolvedEmbedBaseUrl)}\n`
          }
        }

        envContent += `EMBEDDING_BINDING_API_KEY=${embedProvider.apiKey ?? ''}\n`
        envContent += `EMBEDDING_MODEL=${embedModelObj.model}\n`
        envContent += `EMBEDDING_DIM=${embedModelObj.dimension || 1024}\n`
        envContent += `MAX_TOKEN_SIZE=8192\n`
      }

      // RERANKING
      const rerankSelection = this.settings.lightRagRerankBinding

      if (rerankSelection && rerankSelection !== '') {
        envContent += `\n# Reranking Configuration\n`

        let realBindingName = rerankSelection

        if (rerankSelection === 'custom') {
          realBindingName = this.settings.lightRagRerankBindingType || 'cohere'
          envContent += `RERANK_BINDING_HOST=${this.settings.lightRagRerankHost}\n`
        } else {
          if (rerankSelection === 'jina')
            envContent += `RERANK_BINDING_HOST=https://api.jina.ai/v1/rerank\n`
          if (rerankSelection === 'cohere')
            envContent += `RERANK_BINDING_HOST=https://api.cohere.com/v2/rerank\n`
        }

        envContent += `RERANK_BINDING=${realBindingName}\n`
        envContent += `RERANK_MODEL=${this.settings.lightRagRerankModel}\n`
        if (this.settings.lightRagRerankApiKey) {
          envContent += `RERANK_BINDING_API_KEY=${this.settings.lightRagRerankApiKey}\n`
        }
      } else {
        envContent += `\n# Reranking Disabled\n`
        envContent += `RERANK_BINDING=null\n`
      }

      // API Keys
      const providersNeeded = new Set([llmProvider, embedProvider])
      envContent += `\n# API Keys\n`
      let openAiKeyWritten = false
      providersNeeded.forEach((provider) => {
        if (!provider) return
        if (provider.id === 'gemini')
          envContent += `GEMINI_API_KEY=${provider.apiKey ?? ''}\n`
        if (provider.id === 'anthropic')
          envContent += `ANTHROPIC_API_KEY=${provider.apiKey ?? ''}\n`
        if (provider.id === 'openai' && provider.apiKey) {
          envContent += `OPENAI_API_KEY=${provider.apiKey}\n`
          openAiKeyWritten = true
        }
      })
      // Providers that use LightRAG's "openai" binding (e.g. LM Studio,
      // OpenRouter, Groq) don't necessarily have an OPENAI_API_KEY, but
      // LightRAG's Python client accesses os.environ['OPENAI_API_KEY']
      // directly and raises KeyError when it's absent. Writing a placeholder
      // satisfies the client without affecting auth (the real key is in
      // LLM_BINDING_API_KEY / EMBEDDING_BINDING_API_KEY).
      if (!openAiKeyWritten) {
        envContent += `OPENAI_API_KEY=no-api-key\n`
      }

      // Entity type descriptions are consumed by LightRAG v1.5+ through a
      // managed YAML profile. ENTITY_TYPES keeps older backends compatible.
      if (this.settings.useCustomEntityTypes) {
        const typeNames = entityTypeNames(
          this.settings.lightRagEntityTypeGuidance,
        )
        envContent += `\nPROMPT_DIR=prompts\n`
        envContent += `ENTITY_TYPE_PROMPT_FILE=${ENTITY_TYPE_PROFILE_NAME}\n`
        envContent += `ENTITY_TYPES='${JSON.stringify(typeNames)}'\n`
      }
      // Custom Overrides
      if (this.settings.lightRagCustomEnv) {
        envContent += `\n\n#####################################\n`
        envContent += `### USER CUSTOM CONFIGURATION     ###\n`
        envContent += `### (Overrides defaults above)    ###\n`
        envContent += `#####################################\n`
        envContent += this.settings.lightRagCustomEnv
        envContent += `\n`
      }

      // Hard privacy pin: native Markdown parsing must never fetch remote
      // images — external hosts would learn what private notes reference.
      // Emitted after custom overrides because dotenv applies the last
      // assignment, so the vault side cannot re-enable image downloads.
      envContent += `\n# External image download (hard privacy pin)\n`
      envContent += `NATIVE_MD_IMAGE_DOWNLOAD_ENABLED=false\n`

      return envContent
    } catch (err) {
      console.error('Error generating config:', err)
      return ''
    }
  }

  private readEnvFileSource(): EnvFileSource {
    if (!Platform.isDesktop || !this._nodeFs || !this._nodePath)
      throw new Error('Local server configuration is unavailable.')
    const workDir = this.settings.lightRagWorkDir
    if (!workDir) throw new Error('Configure a local server directory first.')
    const envPath = this._nodePath.join(workDir, '.env')
    const originalExists = this._nodeFs.existsSync(envPath)
    return {
      backendIdentity: this.settings.lightRagBackendIdentity,
      envPath,
      originalContent: originalExists
        ? this._nodeFs.readFileSync(envPath, 'utf8')
        : '',
      originalExists,
    }
  }

  private isEnvEditorSnapshotCurrent(
    snapshot: Pick<EnvEditorSnapshot, 'backendIdentity' | 'envPath'>,
  ): boolean {
    if (!Platform.isDesktop || !this._nodeFs || !this._nodePath) return false
    const workDir = this.settings.lightRagWorkDir
    return (
      Boolean(workDir) &&
      snapshot.backendIdentity === this.settings.lightRagBackendIdentity &&
      snapshot.envPath === this._nodePath.join(workDir, '.env')
    )
  }

  private prepareEnvEditorSnapshot(
    source = this.readEnvFileSource(),
  ): EnvEditorSnapshot {
    if (!this.isEnvEditorSnapshotCurrent(source))
      throw new Error('Server connection changed; configuration was not read.')
    const generated = this.generateEnvConfig()
    if (!generated) throw new Error('Server configuration is unavailable.')
    const content = this.mergeGeneratedEnv(source.originalContent, generated)
    if (content === null)
      throw new Error('Managed environment markers are malformed or ambiguous.')
    return { ...source, content }
  }

  public loadEnvEditorSnapshot(): EnvEditorSnapshot | null {
    try {
      return this.prepareEnvEditorSnapshot()
    } catch (error) {
      console.error('Error preparing .env file:', error)
      new Notice(
        'Server configuration could not be opened; original file was kept.',
      )
      return null
    }
  }

  public async saveEnvAndRestart(
    content: string,
    snapshot: EnvEditorSnapshot,
  ): Promise<boolean> {
    if (!this.isEnvEditorSnapshotCurrent(snapshot)) {
      new Notice('Server configuration changed; reopen it before saving.')
      return false
    }
    if (this.mergeGeneratedEnv(content, '') === null) {
      new Notice('Server configuration update failed; original file was kept.')
      return false
    }

    try {
      this.writeEntityTypeProfile()
      this.writeEnvFileVerified(
        snapshot.envPath,
        snapshot.originalContent,
        content,
        snapshot.originalExists,
      )
      if (!this.isEnvEditorSnapshotCurrent(snapshot)) {
        new Notice('Server configuration changed; restart was cancelled.')
        return false
      }
      this.restartLightRagServer(true)
      return true
    } catch (error) {
      new Notice('Error saving .env file')
      console.error(error)
      return false
    }
  }

  private findEnvMarkerLines(
    content: string,
    marker: string,
  ): { start: number; end: number }[] {
    const matches: { start: number; end: number }[] = []
    let start = 0
    while (start <= content.length) {
      const newline = content.indexOf('\n', start)
      const end = newline === -1 ? content.length : newline
      const lineEnd = end > start && content[end - 1] === '\r' ? end - 1 : end
      if (content.slice(start, lineEnd) === marker) {
        matches.push({ start, end: lineEnd })
      }
      if (newline === -1) break
      start = newline + 1
    }
    return matches
  }

  private mergeGeneratedEnv(
    existing: string,
    generated: string,
  ): string | null {
    if (
      this.findEnvMarkerLines(generated, MANAGED_ENV_BEGIN).length > 0 ||
      this.findEnvMarkerLines(generated, MANAGED_ENV_END).length > 0
    ) {
      return null
    }
    const begins = this.findEnvMarkerLines(existing, MANAGED_ENV_BEGIN)
    const ends = this.findEnvMarkerLines(existing, MANAGED_ENV_END)
    if (
      begins.length !== ends.length ||
      begins.length > 1 ||
      (begins.length === 1 && begins[0].start >= ends[0].start)
    ) {
      return null
    }

    const newline = existing.includes('\r\n') ? '\r\n' : '\n'
    const generatedBody = generated
      .replace(/\r\n?/g, '\n')
      .replace(/\n+$/, '')
      .replace(/\n/g, newline)
    const managed = `${MANAGED_ENV_BEGIN}${newline}${generatedBody}${newline}${MANAGED_ENV_END}`
    if (begins.length === 1) {
      return (
        existing.slice(0, begins[0].start) +
        managed +
        existing.slice(ends[0].end)
      )
    }

    const separator =
      existing.length === 0
        ? ''
        : existing.endsWith('\n')
          ? newline
          : `${newline}${newline}`
    return `${existing}${separator}${managed}${newline}`
  }

  private writeEnvFileVerified(
    envPath: string,
    previous: string,
    content: string,
    previousExists: boolean,
  ): void {
    if (!this._nodeFs) return
    if (content === previous) {
      if (
        this._nodeFs.existsSync(envPath) !== previousExists ||
        (previousExists &&
          this._nodeFs.readFileSync(envPath, 'utf8') !== previous)
      )
        throw new Error(
          'Server configuration changed externally; original file was kept.',
        )
      return
    }
    const temporaryPath = `${envPath}.${uuidv4()}.tmp`
    const backupPath = `${temporaryPath}.bak`
    this._nodeFs.writeFileSync(temporaryPath, content, { mode: 0o600 })
    if (this._nodeFs.readFileSync(temporaryPath, 'utf8') !== content)
      throw new Error(
        'Could not verify the new configuration; original file was kept.',
      )
    if (previousExists) {
      this._nodeFs.writeFileSync(backupPath, previous, { mode: 0o600 })
      if (this._nodeFs.readFileSync(backupPath, 'utf8') !== previous)
        throw new Error(
          'Could not verify the configuration backup; original file was kept.',
        )
    }
    if (
      this._nodeFs.existsSync(envPath) !== previousExists ||
      (previousExists &&
        this._nodeFs.readFileSync(envPath, 'utf8') !== previous)
    )
      throw new Error(
        'Server configuration changed externally; original file was kept.',
      )
    this._nodeFs.renameSync(temporaryPath, envPath)
    if (this._nodeFs.readFileSync(envPath, 'utf8') !== content) {
      const recovery = previousExists ? ` Recovery copy: ${backupPath}` : ''
      throw new Error(`Could not verify the updated configuration.${recovery}`)
    }
    if (previousExists) this._nodeFs.unlinkSync(backupPath)
  }

  private writeEntityTypeProfile(): void {
    if (!this.settings.useCustomEntityTypes) return
    if (!this._nodeFs || !this._nodePath)
      throw new Error('Local server configuration is unavailable.')
    const workDir = this.settings.lightRagWorkDir
    if (!workDir) throw new Error('Configure a local server directory first.')

    const profileDir = this._nodePath.join(workDir, 'prompts', 'entity_type')
    const profilePath = this._nodePath.join(
      profileDir,
      ENTITY_TYPE_PROFILE_NAME,
    )
    const previousExists = this._nodeFs.existsSync(profilePath)
    const previous = previousExists
      ? this._nodeFs.readFileSync(profilePath, 'utf8')
      : ''
    const guidance = normalizeEntityTypeGuidance(
      this.settings.lightRagEntityTypeGuidance,
    )
    const content = buildEntityTypeProfile(guidance)

    this._nodeFs.mkdirSync(profileDir, { recursive: true })
    this.writeEnvFileVerified(profilePath, previous, content, previousExists)
  }

  public updateEnvFile(): boolean {
    try {
      const snapshot = this.prepareEnvEditorSnapshot()
      if (!this.isEnvEditorSnapshotCurrent(snapshot))
        throw new Error(
          'Server connection changed; configuration was not replaced.',
        )
      this.writeEntityTypeProfile()
      this.writeEnvFileVerified(
        snapshot.envPath,
        snapshot.originalContent,
        snapshot.content,
        snapshot.originalExists,
      )
      return true
    } catch (error) {
      console.error('Error updating .env file:', error)
      new Notice('Server configuration update failed; original file was kept.')
      return false
    }
  }

  public async reprocessFailedDocuments(): Promise<void> {
    const url = `${this.settings.lightRagServerUrl}/documents/reprocess_failed`
    try {
      const response = await requestUrl({
        url,
        method: 'POST',
        headers: this.settings.lightRagApiKey
          ? { 'X-API-Key': this.settings.lightRagApiKey }
          : {},
        throw: false,
      })
      if (response.status < 400) {
        new Notice(
          'Re-processing failed documents — check the graph view in a few minutes.',
        )
      } else {
        new Notice(`Reprocess request failed (HTTP ${response.status})`)
      }
    } catch (e) {
      console.error('reprocessFailedDocuments error:', e)
      new Notice('Could not reach the LightRAG server.')
    }
  }

  private isPortInUse(port: number): Promise<boolean> {
    if (!Platform.isDesktop || !this._nodeNet) return Promise.resolve(false)
    return new Promise((resolve) => {
      const socket = new this._nodeNet!.Socket()

      const onError = () => {
        socket.destroy()
        resolve(false) // Closed
      }

      socket.setTimeout(500)
      socket.once('error', onError)
      socket.once('timeout', onError)

      socket.connect(port, '127.0.0.1', () => {
        socket.destroy()
        resolve(true) // Open (In Use)
      })
    })
  }

  async startLightRagServer(skipEnvUpdate = false) {
    if (!Platform.isDesktop) {
      new Notice(
        'Local server is not supported on mobile. Configure a remote server in settings.',
      )
      return
    }
    if (this.isRemoteServer()) {
      void this.checkAndUpdateStatus()
      return
    }

    const command = this.settings.lightRagCommand
    const workDir = this.settings.lightRagWorkDir

    if (!workDir || !command) {
      new Notice(`Configure ${BACKEND_NAME} paths in settings.`)
      return
    }

    if (!skipEnvUpdate && !this.updateEnvFile()) return

    const isAlive = await this.isPortInUse(this.getServerPort())
    if (isAlive) {
      this.updateStatusUI('online') // Si ya está vivo, lo ponemos verde
      return
    }

    new Notice(`Starting ${BACKEND_NAME}...`)
    this.updateStatusUI('busy') // Amarillo mientras arranca

    try {
      const envVars = typeof process !== 'undefined' ? { ...process.env } : {}

      // --- FIX: SANITIZE PATHS (ESPACIOS EN WINDOWS) ---
      // Si la ruta tiene espacios y no tiene comillas, las agregamos.
      const safeWorkDir =
        workDir.includes(' ') && !workDir.startsWith('"')
          ? `"${workDir}"`
          : workDir

      const safeCommand =
        command.includes(' ') && !command.startsWith('"')
          ? `"${command}"`
          : command
      // ------------------------------------------------

      // Usamos las variables sanitizadas en el comando y argumentos
      const child = this._nodeChildProcess!.spawn(
        safeCommand,
        [
          '--port',
          `${this.getServerPort()}`,
          '--working-dir',
          safeWorkDir,
          '--workers',
          '1',
        ],
        {
          detached:
            typeof process !== 'undefined' && process.platform !== 'win32',
          cwd: workDir, // cwd usa la ruta original (Node la maneja bien)
          shell: true,
          env: { ...envVars, PYTHONIOENCODING: 'utf-8', FORCE_COLOR: '1' },
        },
      )
      this.serverProcess = child

      child.stderr?.on('data', (data: BufferLike | string) => {
        if (this.serverProcess !== child) return
        const msg = String(data)
        const now = Date.now()

        if (!this.lastErrorTime || now - this.lastErrorTime > 5000) {
          if (
            msg.includes('503') ||
            msg.includes('overloaded') ||
            msg.includes('UNAVAILABLE')
          ) {
            new Notice(
              'Provider error: model overloaded (503).\nServer is busy, please wait a moment.',
              0,
            )
            this.lastErrorTime = now
          } else if (msg.includes('Invalid API key') || msg.includes('401')) {
            if (msg.includes('Rerank'))
              new Notice(`Rerank error: invalid ${TERM_API} key.`, 0)
            else
              new Notice(`${TERM_LLM_EMBED} error: Invalid ${TERM_API} key.`, 0)
            this.lastErrorTime = now
          } else if (
            msg.includes('Quota') ||
            msg.includes('429') ||
            msg.includes('RESOURCE_EXHAUSTED')
          ) {
            if (msg.includes('Rerank')) new Notice('Rerank quota exceeded.', 0)
            else if (msg.includes('google') || msg.includes('gemini'))
              new Notice(
                `Gemini quota exceeded.\nReduce ${VAR_MAX_ASYNC} in settings.`,
                0,
              )
            else new Notice(`${TERM_API} rate limit hit.`, 0)
            this.lastErrorTime = now
          }
        }

        if (!msg.includes('INFO:') && !msg.includes('WARNING:')) {
          console.error(`[LightRAG Error]: ${msg}`)
        }
      })

      child.on('close', (_code) => {
        if (this.serverProcess !== child) return
        this.serverProcess = null
        this.updateStatusUI('offline')
      })
      child.on('error', (error) => {
        if (this.serverProcess !== child) return
        this.serverProcess = null
        console.error('LightRAG server process error:', error)
        this.updateStatusUI('offline')
      })

      // --- DETECCIÓN REACTIVA (LINTER SAFE) ---
      void (async () => {
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => window.setTimeout(r, 1000))
          if (this.serverProcess !== child) return
          const alive = await this.isPortInUse(this.getServerPort())
          if (this.serverProcess !== child) return
          if (alive) {
            this.updateStatusUI('online')
            new Notice(`${BACKEND_NAME} activated`)
            return
          }
        }
        if (this.serverProcess !== child) return
        this.updateStatusUI('offline')
        new Notice('Server failed to respond in time.')
      })()
    } catch (error) {
      console.error('Error starting server:', error)
      new Notice('Fatal error starting server.')
      this.updateStatusUI('offline')
    }
  }

  async loadSettings() {
    this.settings = parseNeuralComposerSettings(await this.loadData())
    this.settings.lightRagVaultNamespace ||= uuidv4()
    this.settings.lightRagBackendIdentity ||= uuidv4()
    // Mobile cannot spawn a local LightRAG server (no child_process / fs).
    // Force remote-server mode on so the rest of the plugin treats the backend
    // as remote-only and never tries to auto-start or shell out.
    if (!Platform.isDesktop) {
      if (!this.settings.lightRagUseRemote) {
        this.settings.lightRagBackendIdentity = uuidv4()
      }
      this.settings.lightRagUseRemote = true
      this.settings.enableAutoStartServer = false
    }
    await this.saveData(this.settings)
  }

  async setSettings(newSettings: NeuralComposerSettings) {
    const validationResult = NeuralComposerSettingsSchema.safeParse(newSettings)
    if (!validationResult.success) {
      new Notice('Invalid settings')
      return
    }
    const connectionChanged =
      newSettings.lightRagServerUrl !== this.settings.lightRagServerUrl ||
      newSettings.lightRagApiKey !== this.settings.lightRagApiKey ||
      newSettings.lightRagUseRemote !== this.settings.lightRagUseRemote ||
      newSettings.lightRagWorkDir !== this.settings.lightRagWorkDir
    if (connectionChanged) {
      newSettings = { ...newSettings, lightRagBackendIdentity: uuidv4() }
    }
    const ownershipChanged =
      newSettings.lightRagBackendIdentity !==
      this.settings.lightRagBackendIdentity
    if (ownershipChanged) {
      this.graphBatchAbort?.abort()
      this.deferredGraphChanges.clear()
      this.modifyDebounceMap.forEach((id) => window.clearTimeout(id))
      this.modifyDebounceMap.clear()
    }
    await this.saveData(newSettings)
    if (ownershipChanged) this.invalidateLightRagHealthRequest()
    if (newSettings.lightRagUseRemote && !this.settings.lightRagUseRemote)
      this.stopLightRagServer()
    this.settings = newSettings
    this.ragEngine?.setSettings(newSettings)
    if (ownershipChanged) {
      this.ingestedFolderPaths.clear()
      this.ingestedFolderPathsLoaded = false
      this.setServerVersion(null)
      void this.docIndexService
        ?.rebuildSourceMap()
        .catch((error: unknown) =>
          console.error('Document source reconciliation failed', error),
        )
    }
    this.settingsChangeListeners.forEach((listener) => listener(newSettings))
  }

  public async invalidateParagraphBackend(): Promise<void> {
    await this.setSettings({
      ...this.settings,
      lightRagBackendIdentity: uuidv4(),
    })
  }

  private ensureDocIndex(): Promise<DocIndexService> {
    if (!this.docIndexLoadPromise) {
      const index = (this.docIndexService ??= new DocIndexService(this))
      this.docIndexLoadPromise = index.load().then(() => {
        if (this.graphDisposed) throw new Error('Plugin unloaded')
        this.docIndexReady = true
        return index
      })
    }
    return this.docIndexLoadPromise
  }

  private isWatchedGraphPath(path: string): boolean {
    const folder = this.settings.lightRagSyncFolder.trim().replace(/\/+$/, '')
    return Boolean(folder && (path === folder || path.startsWith(`${folder}/`)))
  }

  private handleGraphRename(file: TAbstractFile, oldPath: string): void {
    // Folder callbacks still contain stale child paths; Obsidian then emits each file's rename.
    if (!(file instanceof TFile) || !this.docIndexReady) return
    const previous = this.deferredGraphChanges.get(oldPath)
    this.deferredGraphChanges.delete(oldPath)
    const originalPath = previous?.previousPath ?? oldPath
    const wasWatched = this.isWatchedGraphPath(originalPath)
    const isWatched = this.isWatchedGraphPath(file.path)
    if (!wasWatched && !isWatched) return
    if (!isWatched || this.isPathExcludedFromGraph(file.path)) {
      if (wasWatched)
        this.queueGraphChange({ path: originalPath, remove: true })
      return
    }
    this.queueGraphChange({
      path: file.path,
      previousPath: wasWatched ? originalPath : undefined,
      remove: false,
    })
  }

  private scheduleGraphSync(file: TFile, delay: number): void {
    if (
      !SUPPORTED_EXTENSIONS.includes(file.extension.toLowerCase()) ||
      this.isPathExcludedFromGraph(file.path)
    )
      return
    const previous = this.modifyDebounceMap.get(file.path)
    if (previous) window.clearTimeout(previous)
    const path = file.path
    const timer = window.setTimeout(() => {
      this.modifyDebounceMap.delete(path)
      this.queueGraphChange({ path, remove: false })
    }, delay)
    this.modifyDebounceMap.set(path, timer)
  }

  private queueGraphChange(change: {
    path: string
    previousPath?: string
    remove: boolean
  }): void {
    if (this.graphDisposed) return
    if (change.remove) {
      const timer = this.modifyDebounceMap.get(change.path)
      if (timer !== undefined) {
        window.clearTimeout(timer)
        this.modifyDebounceMap.delete(change.path)
      }
      const backendId = this.settings.lightRagBackendIdentity
      const namespace = this.settings.lightRagVaultNamespace
      const removal = (async () => {
        if (
          this.graphDisposed ||
          backendId !== this.settings.lightRagBackendIdentity ||
          namespace !== this.settings.lightRagVaultNamespace
        )
          return
        const engine = await this.getRAGEngine()
        if (
          this.graphDisposed ||
          backendId !== this.settings.lightRagBackendIdentity ||
          namespace !== this.settings.lightRagVaultNamespace
        )
          return
        const removed = await engine.deleteDocumentsByPaths([change.path])
        if (
          this.graphDisposed ||
          backendId !== this.settings.lightRagBackendIdentity ||
          namespace !== this.settings.lightRagVaultNamespace
        )
          return
        if (!removed) new Notice(`Graph removal paused: ${change.path}`)
      })().catch((error: unknown) => {
        if (
          this.graphDisposed ||
          backendId !== this.settings.lightRagBackendIdentity ||
          namespace !== this.settings.lightRagVaultNamespace
        )
          return
        new Notice(
          `Graph removal paused: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
      this.graphSyncTail = this.graphSyncTail.then(() => removal)
      return
    }
    if (this.graphBatchAbort) {
      const previous = this.deferredGraphChanges.get(change.path)
      this.deferredGraphChanges.set(change.path, {
        ...change,
        previousPath: previous?.previousPath ?? change.previousPath,
      })
      return
    }
    const backendId = this.settings.lightRagBackendIdentity
    const namespace = this.settings.lightRagVaultNamespace
    this.graphSyncTail = this.graphSyncTail
      .then(async () => {
        if (
          this.graphDisposed ||
          backendId !== this.settings.lightRagBackendIdentity ||
          namespace !== this.settings.lightRagVaultNamespace
        )
          return
        if (this.graphBatchAbort) {
          this.queueGraphChange(change)
          return
        }
        const engine = await this.getRAGEngine()
        const index = await this.ensureDocIndex()
        if (
          this.graphDisposed ||
          backendId !== this.settings.lightRagBackendIdentity ||
          namespace !== this.settings.lightRagVaultNamespace
        )
          return
        const file = this.app.vault.getAbstractFileByPath(change.path)
        if (
          !(file instanceof TFile) ||
          !this.isWatchedGraphPath(file.path) ||
          this.isPathExcludedFromGraph(file.path)
        )
          return
        if (
          !change.previousPath &&
          !index.needsIngestion(file.path, file.stat.mtime)
        )
          return
        const previousRecord = change.previousPath
          ? index.getRecord(change.previousPath, backendId)
          : undefined
        if (
          change.previousPath &&
          previousRecord &&
          (previousRecord.status === 'removed' ||
            previousRecord.removeRequested)
        ) {
          if (previousRecord.status === 'removed') {
            const source = await documentSourceName(namespace, file.path)
            if (
              this.graphDisposed ||
              backendId !== this.settings.lightRagBackendIdentity ||
              namespace !== this.settings.lightRagVaultNamespace
            )
              return
            await index.saveRecord(
              file.path,
              {
                ...previousRecord,
                source,
                pending: undefined,
                aliases: [
                  ...new Set([
                    ...(previousRecord.aliases ?? []),
                    ...(previousRecord.source ? [previousRecord.source] : []),
                  ]),
                ],
              },
              backendId,
              { previousPath: change.previousPath },
            )
          } else {
            await index.saveRecord(file.path, previousRecord, backendId, {
              previousPath: change.previousPath,
            })
          }
          return
        }
        const result = await engine.ingestFile(file, {
          intent: 'sync',
          previousPath: change.previousPath,
        })
        if (result.status === 'failed' || result.status === 'paused')
          new Notice(
            result.message ?? `Graph synchronization paused: ${file.path}`,
          )
        this.decorateFileExplorer()
      })
      .catch((error: unknown) => {
        new Notice(
          `Graph synchronization paused: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  }

  private async mapGraphDocument(file: TFile): Promise<void> {
    try {
      const backendId = this.settings.lightRagBackendIdentity
      const engine = await this.getRAGEngine()
      const candidates = await engine.listDocumentCandidates(file)
      new GraphDocumentMappingModal(
        this.app,
        file.path,
        candidates,
        async (docId) => {
          if (backendId !== this.settings.lightRagBackendIdentity) {
            throw new Error('Backend changed; reopen document mapping.')
          }
          await engine.bindDocument(file, docId)
          new Notice(
            'Document mapped. Reprocess with current settings to adopt a processing policy.',
          )
        },
      ).open()
    } catch (error) {
      new Notice(
        `Document mapping unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async confirmGraphReprocessing(
    files: TFile[],
    intent: 'reprocess' | 'retry' = 'reprocess',
    includeRemoved = false,
  ): Promise<void> {
    try {
      const index = await this.ensureDocIndex()
      const policy =
        intent === 'reprocess' ? processingPolicy(this.settings) : undefined
      const eligible = files.filter((file) => {
        if (this.isPathExcludedFromGraph(file.path)) return false
        if (!includeRemoved && index.getStatus(file.path) === 'removed')
          return false
        if (policy?.mode === 'paragraph' && !isParagraphFile(file.extension))
          return false
        return (
          intent !== 'retry' || Boolean(index.getRecord(file.path)?.pending)
        )
      })
      if (!eligible.length) {
        new Notice(
          'No eligible documents. Excluded, removed, or unsupported documents were skipped.',
        )
        return
      }
      const backendId = this.settings.lightRagBackendIdentity
      const policyDescription = policy
        ? `${policy.mode === 'paragraph' ? 'Native paragraph' : 'Existing behavior'}; maximum ${policy.chunkSize} tokens; overlap ${policy.chunkOverlap}.`
        : 'Each document keeps its originally submitted processing settings.'
      new ConfirmModal(this.app, {
        title:
          intent === 'retry'
            ? 'Retry failed processing'
            : 'Reprocess with current settings',
        message: `${eligible.length} document(s); ${files.length - eligible.length} skipped.\n${policyDescription}\n\nExisting graph entries may be deleted before replacement. Retrieval is unavailable for each deleted document until processing succeeds, and ingestion incurs model costs. Vault files are kept.`,
        ctaText: intent === 'retry' ? 'Retry' : 'Reprocess',
        destructive: true,
        onConfirm: () => {
          if (backendId !== this.settings.lightRagBackendIdentity) {
            new Notice('Server connection changed. Review the operation again.')
            return
          }
          void this.runGraphBatch(eligible, intent, policy, includeRemoved)
        },
      }).open()
    } catch (error) {
      new Notice(
        `Cannot prepare reprocessing: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async runGraphBatch(
    files: TFile[],
    intent: 'new' | 'reprocess' | 'retry',
    policy?: ProcessingPolicy,
    includeRemoved = false,
  ): Promise<void> {
    if (this.graphBatchAbort) {
      new Notice('A graph batch is already running.')
      return
    }
    const paths = files.map((file) => file.path)
    const controller = new AbortController()
    this.graphBatchAbort = controller
    const backendId = this.settings.lightRagBackendIdentity
    const notice = new Notice('Preparing graph processing…', 0)
    let completed = 0
    let skipped = 0
    try {
      const capturedPolicy =
        policy ??
        (intent === 'retry' ? undefined : processingPolicy(this.settings))
      await this.graphSyncTail
      const engine = await this.getRAGEngine()
      for (const path of paths) {
        if (
          controller.signal.aborted ||
          this.graphDisposed ||
          backendId !== this.settings.lightRagBackendIdentity
        )
          break
        const file = this.app.vault.getAbstractFileByPath(path)
        if (
          !(file instanceof TFile) ||
          this.isPathExcludedFromGraph(file.path) ||
          (!includeRemoved &&
            this.docIndexService?.getStatus(file.path) === 'removed') ||
          (capturedPolicy?.mode === 'paragraph' &&
            !isParagraphFile(file.extension))
        ) {
          skipped++
          continue
        }
        notice.setMessage(
          `Processing ${completed + skipped + 1}/${paths.length}: ${file.path}`,
        )
        const result = await engine.ingestFile(file, {
          intent,
          policy: capturedPolicy,
          signal: controller.signal,
        })
        if (result.status === 'processed') completed++
        else if (result.status === 'skipped') skipped++
        else {
          controller.abort()
          new Notice(result.message ?? `Processing paused: ${file.path}`, 10000)
          break
        }
      }
      notice.setMessage(
        `${controller.signal.aborted ? 'Batch paused' : 'Batch finished'}: ${completed} processed, ${skipped} skipped. Accepted server work may continue.`,
      )
      if (backendId === this.settings.lightRagBackendIdentity)
        await this.refreshIngestedFolderPaths()
    } catch (error) {
      controller.abort()
      notice.setMessage(
        `Graph processing paused: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      if (this.graphBatchAbort === controller) this.graphBatchAbort = null
      this.decorateFileExplorer()
      this.timeoutIds.push(window.setTimeout(() => notice.hide(), 10000))
      if (!controller.signal.aborted && !this.graphDisposed) {
        const changes = [...this.deferredGraphChanges.values()]
        this.deferredGraphChanges.clear()
        for (const change of changes) this.queueGraphChange(change)
      }
    }
  }

  addSettingsChangeListener(
    listener: (newSettings: NeuralComposerSettings) => void,
  ) {
    this.settingsChangeListeners.push(listener)
    return () => {
      this.settingsChangeListeners = this.settingsChangeListeners.filter(
        (l) => l !== listener,
      )
    }
  }

  openChatView(openNewChat = false) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    const editor = view?.editor
    if (!view || !editor) {
      void this.activateChatView(undefined, openNewChat)
      return
    }
    const selectedBlockData = getMentionableBlockData(editor, view)
    void this.activateChatView(
      { selectedBlock: selectedBlockData ?? undefined },
      openNewChat,
    )
  }

  async activateChatView(chatProps?: ChatProps, openNewChat = false) {
    this.initialChatProps = chatProps
    let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) as WorkspaceLeaf
      if (leaf) {
        await leaf.setViewState({
          type: CHAT_VIEW_TYPE,
          active: true,
        })
      }
    }

    // Ensure leaf exists before accessing view
    leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]

    if (leaf) {
      // FIX: Add await because revealLeaf returns a Promise
      await this.app.workspace.revealLeaf(leaf)

      if (openNewChat && leaf.view instanceof ChatView) {
        leaf.view.openNewChat(chatProps?.selectedBlock)
      }
    }
  }

  async addSelectionToChat(editor: Editor, view: MarkdownView) {
    const data = getMentionableBlockData(editor, view)
    if (!data) return

    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView({ selectedBlock: data })
      return
    }

    const leaf = leaves[0]
    await this.app.workspace.revealLeaf(leaf)

    if (leaf.view instanceof ChatView) {
      const chatView = leaf.view
      chatView.addSelectionToChat(data)
      chatView.focusMessage()
    }
  }

  // --- BYPASS ---
  getDbManager(): Promise<DatabaseManager> {
    // Changed to return Promise.resolve to satisfy interface without async keyword overhead for mock
    return Promise.resolve({} as DatabaseManager)
  }

  getRAGEngine(): Promise<RAGEngine> {
    this.ragEngineInitPromise ??= (async () => {
      const index = await this.ensureDocIndex()
      this.ragEngine ??= new RAGEngine(
        this.app,
        this.settings,
        {} as unknown as VectorManager,
        index,
        () => {
          this.restartLightRagServer()
          return Promise.resolve()
        },
      )
      await this.ragEngine.recoverPendingOperations()
      if (this.graphDisposed) throw new Error('Plugin unloaded')
      return this.ragEngine
    })()
    return this.ragEngineInitPromise
  }

  async getMcpManager(): Promise<McpManager> {
    if (this.mcpManager) return this.mcpManager
    try {
      this.mcpManager = new McpManager({
        settings: this.settings,
        registerSettingsListener: (l) => this.addSettingsChangeListener(l),
      })
      await this.mcpManager.initialize()
      return this.mcpManager
    } catch (error) {
      this.mcpManager = null
      throw error
    }
  }

  // --- AUTOMATED ONTOLOGIST ---
  public async generateEntityTypes(): Promise<string | null> {
    const sourcePath = this.settings.lightRagOntologyFolder

    if (!sourcePath) {
      new Notice("Please define an 'ontology source folder' first.")
      return null
    }

    const folder = this.app.vault.getAbstractFileByPath(sourcePath)
    if (!folder || !(folder instanceof TFolder)) {
      new Notice(`Folder not found: "${sourcePath}"`)
      return null
    }

    new Notice(`Analyzing notes in "${sourcePath}"...`)

    try {
      const allFiles = this.getAllSupportedFiles(folder)
      if (allFiles.length === 0) throw new Error('Folder is empty.')

      const sampleSize = Math.min(allFiles.length, 5)
      const sampleFiles = allFiles
        .sort(() => 0.5 - Math.random())
        .slice(0, sampleSize)

      let sampleText = ''
      for (const file of sampleFiles) {
        const content = await this.app.vault.read(file)
        sampleText += `--- NOTE: ${file.basename} ---\n${content.substring(0, 1000)}\n...\n\n`
      }

      const targetLang = this.settings.lightRagSummaryLanguage || 'English'

      const prompt = `
        ACT AS: Senior Data Ontologist & Knowledge Graph Architect.
        TASK: Analyze the provided user's "${sourcePath}" folder to extract the fundamental ontology.
        GOAL: Define a concise set of high-level entity types that covers the majority of the concepts without becoming overly granular.

        GUIDELINES:
        - Prefer broad categories (for example, Organization instead of Company, Startup, and NGO).
        - Include abstract concepts when relevant because LightRAG relies on conceptual connections.
        - Each description must clearly state what belongs in that type so the extraction model can distinguish overlapping categories.
        - Cover at least 90% of the key nouns with the top 8-15 types.

        RULES:
        1. Output one entity type per line as: PascalCaseName: concise description
        2. Output only those lines. Do not use markdown, bullets, a preamble, or a conclusion.
        3. Type names must be singular PascalCase (for example, ResearchPaper or SoftwareTool).
        4. Type names and descriptions must be written in ${targetLang}.

        SAMPLE CONTENT:
        ${sampleText}

        YOUR OUTPUT:
        `

      const generatedTypes = await this.simpleLLMCall(prompt)

      if (generatedTypes) {
        const withoutFence = generatedTypes
          .trim()
          .replace(/^```(?:text)?\s*/i, '')
          .replace(/\s*```$/, '')
        const guidance = normalizeEntityTypeGuidance(withoutFence)

        await this.setSettings({
          ...this.settings,
          lightRagEntityTypeGuidance: guidance,
        })

        new Notice('Entity type guidance generated and saved.')
        this.updateEnvFile()

        return guidance
      }
    } catch (e) {
      console.error(e)
      new Notice('Error generating ontology.')
    }
    return null
  }

  // Simple Helper for LLM Call
  async simpleLLMCall(prompt: string): Promise<string> {
    const chatModelId = this.settings.chatModelId
    const modelObj = this.settings.chatModels.find((m) => m.id === chatModelId)
    const provider = this.settings.providers.find(
      (p) => p.id === modelObj?.providerId,
    )

    if (!provider || !modelObj) throw new Error('Model not configured')

    // Gemini Logic
    if (provider.id === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelObj.model}:generateContent?key=${provider.apiKey}`

      const response = await requestUrl({
        url: url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      })

      const data = response.json as {
        candidates?: { content?: { parts?: { text?: string }[] } }[]
      }
      return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
    }

    // Generic Fallback (OpenAI/Ollama/Compatible)
    const baseUrl =
      provider.baseUrl ||
      (provider.id === 'openai'
        ? 'https://api.openai.com/v1'
        : 'http://localhost:11434/v1')

    const response = await requestUrl({
      url: `${baseUrl}/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey || 'ollama'}`,
      },
      body: JSON.stringify({
        model: modelObj.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
    })

    const data = response.json as {
      choices?: { message?: { content?: string } }[]
    }
    return data.choices?.[0]?.message?.content || ''
  }

  // --- STATUS BAR LOGIC ---
  private startStatusHeartbeat() {
    // Revisar cada 30 segundos
    this.heartbeatInterval = window.setInterval(() => {
      void this.checkAndUpdateStatus()
    }, 30000)
    // Primera revisión inmediata
    void this.checkAndUpdateStatus()
  }

  private invalidateLightRagHealthRequest(): void {
    const pending = this.pendingLightRagHealth
    if (!pending) return
    this.pendingLightRagHealth = null
    window.clearTimeout(pending.timeoutId)
    pending.invalidate()
  }

  private async checkLightRagHealth(): Promise<LightRagHealthResult> {
    if (this.graphDisposed) return { kind: 'stale' }
    if (this.pendingLightRagHealth) return this.pendingLightRagHealth.promise

    const startedAt = Date.now()
    const backendIdentity = this.settings.lightRagBackendIdentity
    let timeoutId = 0
    let invalidate!: () => void
    const stale = new Promise<LightRagHealthResult>((resolve) => {
      invalidate = () => resolve({ kind: 'stale' })
    })
    const request = requestUrl({
      url: `${this.settings.lightRagServerUrl.replace(/\/+$/, '')}/health`,
      method: 'GET',
      headers: this.getLightRagHeaders(),
      throw: false,
    })
      .then((response): LightRagHealthResult => {
        if (response.status !== 200)
          return { kind: 'http', status: response.status }

        let data: unknown
        try {
          data = response.json
        } catch {
          return { kind: 'invalid' }
        }
        if (typeof data !== 'object' || data === null)
          return { kind: 'invalid' }

        const health = data as Record<string, unknown>
        if (
          health.status !== 'healthy' ||
          (health.pipeline_busy !== undefined &&
            typeof health.pipeline_busy !== 'boolean')
        )
          return { kind: 'invalid' }

        const version =
          typeof health.core_version === 'string' && health.core_version
            ? health.core_version
            : typeof health.api_version === 'string' && health.api_version
              ? health.api_version
              : undefined
        return {
          kind: 'healthy',
          busy: health.pipeline_busy === true,
          ...(version ? { version } : {}),
          elapsedMs: Math.max(0, Date.now() - startedAt),
        }
      })
      .catch((): LightRagHealthResult => ({ kind: 'network' }))
    const timeout = new Promise<LightRagHealthResult>((resolve) => {
      timeoutId = window.setTimeout(() => resolve({ kind: 'timeout' }), 5000)
    })
    const healthResult = Promise.race([request, timeout, stale]).then(
      (result): LightRagHealthResult => {
        if (
          this.graphDisposed ||
          backendIdentity !== this.settings.lightRagBackendIdentity
        )
          return { kind: 'stale' }
        return result
      },
    )
    const pending = { invalidate, promise: healthResult, timeoutId }
    pending.promise = healthResult.finally(() => {
      window.clearTimeout(timeoutId)
      if (this.pendingLightRagHealth === pending)
        this.pendingLightRagHealth = null
    })
    this.pendingLightRagHealth = pending
    return pending.promise
  }

  private async checkAndUpdateStatus(): Promise<LightRagHealthResult> {
    const result = await this.checkLightRagHealth()
    if (result.kind === 'stale') return result

    if (result.kind === 'healthy') {
      this.setServerVersion(result.version ?? null)
      this.updateStatusUI(result.busy ? 'busy' : 'online')
      if (!this.ingestedFolderPathsLoaded) {
        void this.refreshIngestedFolderPaths()
      }
    } else {
      this.setServerVersion(null)
      this.updateStatusUI('offline')
    }
    return result
  }

  public async pingLightRagServer(): Promise<void> {
    const endpoint = this.getSafeLightRagEndpoint()
    const notice = new Notice(`Pinging ${BACKEND_NAME} at ${endpoint}…`, 10000)
    const result = await this.checkAndUpdateStatus()

    if (result.kind === 'stale') {
      if (this.graphDisposed) {
        notice.hide()
      } else {
        notice.setMessage('LightRAG server connection changed; retry the ping.')
      }
      return
    }
    if (result.kind === 'healthy') {
      const version = result.version ? ` v${result.version}` : ''
      const activity = result.busy ? ' and busy processing documents' : ''
      notice.setMessage(
        `${BACKEND_NAME}${version} is healthy${activity} (${result.elapsedMs} ms).`,
      )
      return
    }
    if (result.kind === 'http') {
      const authentication =
        result.status === 401 || result.status === 403
          ? ' Check the configured API key and server authentication.'
          : ''
      notice.setMessage(
        `${BACKEND_NAME} at ${endpoint} refused the health check (HTTP ${result.status}).${authentication}`,
      )
      return
    }
    if (result.kind === 'timeout') {
      notice.setMessage(
        `${BACKEND_NAME} at ${endpoint} did not respond within 5 seconds.`,
      )
      return
    }
    if (result.kind === 'invalid') {
      notice.setMessage(
        `${BACKEND_NAME} at ${endpoint} returned an invalid health response.`,
      )
      return
    }
    notice.setMessage(`Could not reach ${BACKEND_NAME} at ${endpoint}.`)
  }

  private updateStatusUI(status: 'online' | 'offline' | 'busy') {
    if (status === 'online' && this.lastServerStatus !== 'online') {
      // Server just came online — sync statuses and update dots
      void (async () => {
        await this.docIndexService?.syncFromServer()
        this.decorateFileExplorer()
      })()
    }
    this.lastServerStatus = status
    if (!this.statusDotEl) return
    this.statusDotEl.removeClass('is-online', 'is-offline', 'is-busy')

    const versionTag = this.lightRagServerVersion
      ? ` v${this.lightRagServerVersion}`
      : ''
    if (status === 'online') {
      this.statusDotEl.addClass('is-online')
      setTooltip(this.statusBarEl, `LightRAG${versionTag} · Online`, {
        placement: 'top',
      })
    } else if (status === 'busy') {
      this.statusDotEl.addClass('is-busy')
      setTooltip(this.statusBarEl, `LightRAG${versionTag} · Processing…`, {
        placement: 'top',
      })
    } else {
      this.statusDotEl.addClass('is-offline')
      const offlineHint = this.isRemoteServer()
        ? 'check remote server'
        : 'click to restart'
      setTooltip(this.statusBarEl, `LightRAG · Offline (${offlineHint})`, {
        placement: 'top',
      })
    }
  }

  private async handleStatusBarClick() {
    if (this.isRemoteServer()) {
      new Notice(`Checking remote ${BACKEND_NAME} server...`)
      void this.checkAndUpdateStatus()
      return
    }
    if (!Platform.isDesktop) {
      new Notice(
        'Configure a remote LightRAG server in settings to use Neural Composer on mobile.',
      )
      return
    }
    const isAlive = await this.isPortInUse(this.getServerPort())
    if (!isAlive) {
      new Notice(`Starting ${BACKEND_NAME} from status bar...`)
      void this.startLightRagServer()
    } else {
      new Notice('System is already online.')
    }
  }
}
