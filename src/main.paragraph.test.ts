import { Platform, TFile, TFolder } from 'obsidian'

import * as documentProcessing from './core/rag/documentProcessing'
import NeuralComposerPlugin from './main'
import {
  DEFAULT_SETTINGS,
  NeuralComposerSettings,
} from './settings/schema/setting.types'

jest.mock('obsidian', () => ({
  Plugin: class {},
  Platform: { isDesktop: true },
  Notice: jest.fn().mockImplementation(() => ({
    hide: jest.fn(),
    setMessage: jest.fn(),
  })),
  TFile: class TFile {},
  TFolder: class TFolder {},
}))
jest.mock('./ApplyView', () => ({}))
jest.mock('./ChatView', () => ({}))
jest.mock('./components/chat-view/Chat', () => ({}))
jest.mock('./components/modals/ConfirmModal', () => ({}))
jest.mock('./components/modals/GraphDocumentMappingModal', () => ({}))
jest.mock('./core/mcp/mcpManager', () => ({}))
jest.mock('./core/rag/docIndexService', () => ({}))
jest.mock('./core/rag/fileExplorerDecorator', () => ({}))
jest.mock('./core/rag/ragEngine', () => ({}))
jest.mock('./database/DatabaseManager', () => ({}))
jest.mock('./database/modules/vector/VectorManager', () => ({}))
jest.mock('./settings/SettingTab', () => ({}))
jest.mock('./utils/obsidian', () => ({}))
jest.mock('./views/NativeGraphView', () => ({}))

type ProcessingSettings = NeuralComposerSettings & {
  lightRagVaultNamespace: string
  lightRagBackendIdentity: string
  lightRagImageDownloadsDisabledFor: string
}

type GraphChange = {
  path: string
  previousPath?: string
  remove: boolean
}

type GraphInternals = {
  addGraphExclusionForFiles(
    files: (TFile | TFolder)[],
    patterns: string[],
  ): Promise<void>
  executeBatchRemoveFolderFromGraph(
    folder: TFolder,
    files: TFile[],
  ): Promise<void>
  removeGraphExcludePatterns(patterns: string[]): Promise<void>
  graphSyncTail: Promise<void>
  handleGraphRename(file: TFile | TFolder, oldPath: string): void
  queueGraphChange(change: GraphChange): void
  runGraphBatch(files: TFile[], intent: 'new'): Promise<void>
}

const MANAGED_ENV_BEGIN = '# BEGIN NEURAL COMPOSER MANAGED ENV'
const MANAGED_ENV_END = '# END NEURAL COMPOSER MANAGED ENV'

function createGraphFile(path: string, mtime = 1): TFile {
  return Object.assign(new TFile(), {
    extension: 'md',
    name: path.split('/').pop() ?? path,
    path,
    stat: { mtime },
  })
}

function createMemoryFs(initial: string) {
  const files = new Map([['/synthetic/.env', initial]])
  const fs = {
    existsSync: jest.fn((path: string) => files.has(path)),
    mkdirSync: jest.fn(),
    readFileSync: jest.fn((path: string) => {
      const content = files.get(path)
      if (content === undefined)
        throw new Error(`Missing fixture file: ${path}`)
      return content
    }),
    renameSync: jest.fn((from: string, to: string) => {
      const content = files.get(from)
      if (content === undefined)
        throw new Error(`Missing fixture file: ${from}`)
      files.set(to, content)
      files.delete(from)
    }),
    unlinkSync: jest.fn((path: string) => {
      files.delete(path)
    }),
    writeFileSync: jest.fn((path: string, content: string) => {
      files.set(path, content)
    }),
  }
  return { files, fs }
}

function lastEnvValue(content: string, key: string): string | undefined {
  const prefix = `${key}=`
  const assignments = content
    .split('\n')
    .filter((line) => line.startsWith(prefix))
  return assignments[assignments.length - 1]?.slice(prefix.length)
}

function installGraphRuntime(
  plugin: NeuralComposerPlugin,
  files: TFile[],
  engine: object,
) {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const index = {
    getRecord: jest.fn<unknown, [string, string?]>(),
    getStatus: jest.fn<string | undefined, [string]>(),
    needsIngestion: jest.fn<boolean, [string, number]>(() => true),
    saveRecord: jest
      .fn<
        Promise<void>,
        [string, object, string?, { previousPath?: string }?]
      >()
      .mockResolvedValue(undefined),
    setRemoved: jest.fn<void, [string]>(),
  }
  Object.assign(plugin, {
    app: {
      vault: {
        getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
      },
    },
    decorateFileExplorer: jest.fn(),
    deferredGraphChanges: new Map<string, GraphChange>(),
    docIndexService: index,
    ensureDocIndex: jest.fn(async () => index),
    getRAGEngine: jest.fn(async () => engine),
    graphBatchAbort: null,
    graphDisposed: false,
    graphSyncTail: Promise.resolve(),
    refreshIngestedFolderPaths: jest.fn(async () => undefined),
    timeoutIds: [],
    updateStatusUI: jest.fn(),
  })
  return {
    index,
    internals: plugin as unknown as GraphInternals,
  }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalProcessEnv = Object.getOwnPropertyDescriptor(process, 'env')

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: globalThis,
  })
  if (!originalProcessEnv)
    throw new Error('process.env descriptor is unavailable')
  Object.defineProperty(process, 'env', {
    ...originalProcessEnv,
    value: { NODE_ENV: 'test', PATH: '/usr/bin:/bin' },
  })
})

afterAll(() => {
  if (originalProcessEnv)
    Object.defineProperty(process, 'env', originalProcessEnv)
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow)
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }
})

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.clearAllTimers()
  jest.useRealTimers()
})

function createPlugin() {
  const settings: ProcessingSettings = {
    ...DEFAULT_SETTINGS,
    lightRagUseRemote: true,
    lightRagVaultNamespace: 'shared-vault',
    lightRagBackendIdentity: 'original-backend',
    lightRagImageDownloadsDisabledFor: 'original-backend',
  }
  const saveData = jest
    .fn<Promise<void>, [ProcessingSettings]>()
    .mockResolvedValue(undefined)
  const plugin = Object.assign(Object.create(NeuralComposerPlugin.prototype), {
    settings,
    saveData,
    settingsChangeListeners: [],
    versionChangeListeners: new Set(),
    modifyDebounceMap: new Map(),
    ingestedFolderPaths: new Set(),
    deferredGraphChanges: new Map<string, GraphChange>(),
    graphDisposed: false,
    graphSyncTail: Promise.resolve(),
    timeoutIds: [],
    docIndexService: null,
    ragEngine: null,
  }) as NeuralComposerPlugin
  return { plugin, settings, saveData }
}

it('writes described entity guidance for current and legacy LightRAG extraction', () => {
  const { plugin, settings } = createPlugin()
  const { files, fs } = createMemoryFs('')
  Object.assign(plugin, {
    settings: {
      ...settings,
      lightRagEntityTypeGuidance: [
        'Person: Human individuals',
        'Vulnerability: A weakness that can be exploited',
      ].join('\n'),
      lightRagUseRemote: false,
      lightRagWorkDir: '/synthetic',
      useCustomEntityTypes: true,
    },
    _nodeFs: fs,
    _nodePath: { join: (...parts: string[]) => parts.join('/') },
  })

  expect(plugin.updateEnvFile()).toBe(true)
  const env = files.get('/synthetic/.env') ?? ''
  expect(lastEnvValue(env, 'PROMPT_DIR')).toBe('prompts')
  expect(lastEnvValue(env, 'ENTITY_TYPE_PROMPT_FILE')).toBe(
    'neural-composer.yml',
  )
  expect(lastEnvValue(env, 'ENTITY_TYPES')).toBe(`'["Person","Vulnerability"]'`)
  expect(
    files.get('/synthetic/prompts/entity_type/neural-composer.yml'),
  ).toContain('  - Vulnerability: A weakness that can be exploited')
})

it('generates and persists described entity guidance', async () => {
  const { plugin, settings } = createPlugin()
  const file = Object.assign(new TFile(), {
    basename: 'Example',
    extension: 'md',
    name: 'Example.md',
    path: 'Ontology/Example.md',
  })
  const folder = Object.assign(new TFolder(), {
    children: [file],
    name: 'Ontology',
    path: 'Ontology',
  })
  const setSettings = jest.fn(async (next: NeuralComposerSettings) => {
    plugin.settings = next
  })
  const updateEnvFile = jest.fn(() => true)
  const simpleLLMCall = jest.fn(async () =>
    [
      '```text',
      'Person: Human individuals mentioned in the notes',
      'Vulnerability: Weaknesses that can cause harm',
      '```',
    ].join('\n'),
  )
  Object.assign(plugin, {
    app: {
      vault: {
        getAbstractFileByPath: () => folder,
        read: async () => 'Alice documented an exploitable weakness.',
      },
    },
    settings: {
      ...settings,
      lightRagOntologyFolder: 'Ontology',
    },
    setSettings,
    simpleLLMCall,
    updateEnvFile,
  })

  await expect(plugin.generateEntityTypes()).resolves.toBe(
    [
      'Person: Human individuals mentioned in the notes',
      'Vulnerability: Weaknesses that can cause harm',
    ].join('\n'),
  )
  expect(simpleLLMCall).toHaveBeenCalledWith(
    expect.stringContaining('Output one entity type per line'),
  )
  expect(setSettings).toHaveBeenCalledTimes(1)
  expect(setSettings.mock.calls[0][0].lightRagEntityTypeGuidance).toContain(
    'Vulnerability: Weaknesses that can cause harm',
  )
  expect(updateEnvFile).toHaveBeenCalledTimes(1)
})

function overrideProcessPlatform(platform: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (!descriptor) throw new Error('process.platform descriptor is unavailable')
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  return () => {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

it('finishes startup recovery once before exposing the engine to new work', async () => {
  const { plugin } = createPlugin()
  let finishRecovery!: () => void
  const recovery = new Promise<void>((resolve) => {
    finishRecovery = resolve
  })
  const engine = { recoverPendingOperations: jest.fn(() => recovery) }
  Object.assign(plugin, {
    ragEngine: engine,
    ensureDocIndex: async () => ({}),
  })
  let exposed = false
  const first = plugin.getRAGEngine().then((value) => {
    exposed = true
    return value
  })
  const second = plugin.getRAGEngine()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(exposed).toBe(false)

  finishRecovery()

  expect(await first).toBe(engine)
  expect(await second).toBe(engine)
  expect(engine.recoverPendingOperations).toHaveBeenCalledTimes(1)
})

it.each([
  ['remote', true],
  ['local', false],
])(
  'does not terminate another process without an owned handle in %s mode',
  (_mode, useRemote) => {
    const { plugin, settings } = createPlugin()
    const execSync = jest.fn()
    Object.assign(plugin, {
      settings: { ...settings, lightRagUseRemote: useRemote },
      serverProcess: null,
      _nodeChildProcess: { execSync },
      updateStatusUI: jest.fn(),
    })

    plugin.stopLightRagServer()

    expect(execSync).not.toHaveBeenCalled()
  },
)

it('terminates only the owned POSIX process group', () => {
  const restorePlatform = overrideProcessPlatform('linux')
  try {
    const processKill = jest
      .spyOn(process, 'kill')
      .mockImplementation(() => true)
    const handleKill = jest.fn(() => true)
    const execSync = jest.fn()
    const child = { pid: 4242, kill: handleKill }
    const { plugin } = createPlugin()
    Object.assign(plugin, {
      serverProcess: child,
      _nodeChildProcess: { execSync },
      updateStatusUI: jest.fn(),
    })
    const internals = plugin as unknown as { serverProcess: unknown }

    plugin.stopLightRagServer()

    expect(processKill).toHaveBeenCalledTimes(1)
    expect(processKill.mock.calls[0][0]).toBe(-child.pid)
    expect(handleKill).not.toHaveBeenCalled()
    expect(execSync).not.toHaveBeenCalled()
    expect(internals.serverProcess).toBeNull()
  } finally {
    restorePlatform()
  }
})

it('terminates only the owned Windows PID tree', () => {
  const restorePlatform = overrideProcessPlatform('win32')
  try {
    const handleKill = jest.fn(() => true)
    const execSync = jest.fn((_command: string) => '')
    const child = { pid: 4242, kill: handleKill }
    const { plugin } = createPlugin()
    Object.assign(plugin, {
      serverProcess: child,
      _nodeChildProcess: { execSync },
      updateStatusUI: jest.fn(),
    })
    const internals = plugin as unknown as { serverProcess: unknown }

    plugin.stopLightRagServer()

    expect(execSync).toHaveBeenCalledTimes(1)
    const command = String(execSync.mock.calls[0][0])
    expect(command).toMatch(/\/PID\s+4242\b/i)
    expect(command).toMatch(/\/T\b/i)
    expect(command).not.toMatch(/\/IM\b/i)
    expect(handleKill).not.toHaveBeenCalled()
    expect(internals.serverProcess).toBeNull()
  } finally {
    restorePlatform()
  }
})

it('launches the owned POSIX server in a detached process group', async () => {
  const restorePlatform = overrideProcessPlatform('linux')
  try {
    const child = {
      pid: 4242,
      stdout: null,
      stderr: null,
      kill: jest.fn(() => true),
      on: jest.fn().mockReturnThis(),
    }
    const spawn = jest.fn(
      (
        _command: string,
        _args: string[],
        _options?: { detached?: boolean; shell?: boolean },
      ) => child,
    )
    const { plugin, settings } = createPlugin()
    Object.assign(plugin, {
      settings: {
        ...settings,
        lightRagCommand: 'lightrag-server',
        lightRagUseRemote: false,
        lightRagWorkDir: '/synthetic',
      },
      isPortInUse: jest.fn(async () => false),
      updateStatusUI: jest.fn(),
      _nodeChildProcess: { execSync: jest.fn(), spawn },
    })

    await plugin.startLightRagServer(true)

    const spawnOptions = spawn.mock.calls[0]?.[2]
    expect(spawnOptions?.detached).toBe(true)
    expect(spawnOptions?.shell).toBe(true)
  } finally {
    restorePlatform()
  }
})

it('ignores stale close and error events from an older owned server process', async () => {
  let closeListener: ((value: unknown) => void) | undefined
  let errorListener: ((value: unknown) => void) | undefined
  const on = jest.fn()
  const child = {
    pid: 4242,
    stdout: null,
    stderr: null,
    kill: jest.fn(() => true),
    on,
  }
  on.mockImplementation((event: string, listener: (value: unknown) => void) => {
    if (event === 'close') closeListener = listener
    if (event === 'error') errorListener = listener
    return child
  })
  const newerChild = { ...child, pid: 4343 }
  const spawn = jest.fn(() => child)
  const updateStatusUI = jest.fn()
  const { plugin, settings } = createPlugin()
  Object.assign(plugin, {
    settings: {
      ...settings,
      lightRagCommand: 'lightrag-server',
      lightRagUseRemote: false,
      lightRagWorkDir: '/synthetic',
    },
    isPortInUse: jest.fn(async () => false),
    updateStatusUI,
    _nodeChildProcess: { execSync: jest.fn(), spawn },
  })

  await plugin.startLightRagServer(true)
  const internals = plugin as unknown as { serverProcess: unknown }
  internals.serverProcess = newerChild
  updateStatusUI.mockClear()
  if (!closeListener) throw new Error('Close listener was not registered')
  if (!errorListener) throw new Error('Error listener was not registered')

  closeListener(0)
  errorListener(new Error('synthetic stale process error'))

  expect(internals.serverProcess).toBe(newerChild)
  expect(updateStatusUI).not.toHaveBeenCalledWith('offline')
})

describe('Paragraph processing connection identity', () => {
  it('does not carry local ownership or privacy acknowledgement into forced mobile remote mode', async () => {
    jest.replaceProperty(Platform, 'isDesktop', false)
    try {
      const { plugin, settings } = createPlugin()
      Object.assign(plugin, {
        loadData: async () => ({ ...settings, lightRagUseRemote: false }),
      })
      await plugin.loadSettings()
      expect(plugin.settings.lightRagUseRemote).toBe(true)
      expect(plugin.settings.lightRagBackendIdentity).not.toBe(
        'original-backend',
      )
      expect(plugin.settings.lightRagImageDownloadsDisabledFor).toBe('')
      expect(plugin.settings.lightRagVaultNamespace).toBe('shared-vault')
    } finally {
      jest.restoreAllMocks()
    }
  })

  it('invalidates privacy confirmation when connection credentials change without changing the shared vault namespace', async () => {
    const { plugin, settings, saveData } = createPlugin()
    await plugin.setSettings({ ...settings, lightRagApiKey: 'synthetic-key' })
    const persisted = saveData.mock.calls[0][0]
    expect(persisted.lightRagBackendIdentity).not.toBe('original-backend')
    expect(persisted.lightRagBackendIdentity).toMatch(/^[0-9a-f-]{36}$/)
    expect(persisted.lightRagImageDownloadsDisabledFor).toBe('')
    expect(persisted.lightRagVaultNamespace).toBe('shared-vault')
  })

  it('retains backend ownership and privacy confirmation when only future chunk settings change', async () => {
    const { plugin, settings, saveData } = createPlugin()
    await plugin.setSettings({ ...settings, lightRagChunkSize: 1800 })
    const persisted = saveData.mock.calls[0][0]
    expect(persisted.lightRagBackendIdentity).toBe('original-backend')
    expect(persisted.lightRagImageDownloadsDisabledFor).toBe('original-backend')
    expect(persisted.lightRagChunkSize).toBe(1800)
  })

  it('persists a namespace on first load and reuses it on subsequent loads', async () => {
    const { plugin, saveData } = createPlugin()
    let stored: unknown = DEFAULT_SETTINGS
    Object.assign(plugin, {
      loadData: jest.fn(async () => stored),
      saveData: saveData.mockImplementation(async (value) => {
        stored = value
      }),
    })
    await plugin.loadSettings()
    const first = stored as ProcessingSettings
    expect(first.lightRagVaultNamespace).toEqual(expect.any(String))
    expect(first.lightRagVaultNamespace).toMatch(/^[0-9a-f-]{36}$/)
    await plugin.loadSettings()
    expect((stored as ProcessingSettings).lightRagVaultNamespace).toBe(
      first.lightRagVaultNamespace,
    )
  })
})

it('keeps the original server configuration when staged privacy configuration cannot be verified', async () => {
  const { plugin, settings } = createPlugin()
  const original = 'CUSTOM_LIMIT=42\nNATIVE_MD_IMAGE_DOWNLOAD_ENABLED=true\n'
  const files = new Map([['/synthetic/.env', original]])
  const restart = jest.fn()
  Object.assign(plugin, {
    settings: {
      ...settings,
      lightRagUseRemote: false,
      lightRagWorkDir: '/synthetic',
    },
    restartLightRagServer: restart,
    _nodePath: { join: (...parts: string[]) => parts.join('/') },
    _nodeFs: {
      existsSync: (path: string) => files.has(path),
      readFileSync: (path: string) => files.get(path),
      writeFileSync: (path: string) => files.set(path, 'incomplete write'),
      renameSync: jest.fn(),
      unlinkSync: jest.fn(),
    },
  })
  await expect(plugin.configureParagraphPrivacy()).rejects.toThrow(
    'original file was kept',
  )
  expect(files.get('/synthetic/.env')).toBe(original)
  expect(restart).not.toHaveBeenCalled()
  expect(
    (plugin.settings as ProcessingSettings).lightRagImageDownloadsDisabledFor,
  ).toBe('')
})

it('retains the explicit environment when starting without regeneration', async () => {
  const { plugin, settings } = createPlugin()
  const original = 'CUSTOM_LIMIT=42\nNATIVE_MD_IMAGE_DOWNLOAD_ENABLED=false\n'
  const files = new Map([['/synthetic/.env', original]])
  Object.assign(plugin, {
    settings: {
      ...settings,
      lightRagUseRemote: false,
      lightRagServerUrl: 'http://localhost:9621',
      lightRagWorkDir: '/synthetic',
      lightRagCommand: 'fixture-command',
    },
    generateEnvConfig: () => 'GENERATED_ONLY=true\n',
    isPortInUse: async () => true,
    updateStatusUI: () => undefined,
    _nodePath: { join: (...parts: string[]) => parts.join('/') },
    _nodeFs: {
      writeFileSync: (path: string, content: string) =>
        files.set(path, content),
    },
  })

  await plugin.startLightRagServer(true)

  expect(files.get('/synthetic/.env')).toBe(original)
})

it('preserves user environment text while normal generation tracks provider changes without growth', async () => {
  const { plugin, settings } = createPlugin()
  const userText = [
    '# User-maintained local values',
    'CUSTOM_LIMIT=42',
    'MULTILINE_CUSTOM="first line',
    'second line=value',
    '# third line stays in the quoted value',
    'last line"',
    'LLM_MODEL=legacy-generated-model',
    '',
  ].join('\n')
  const { files, fs } = createMemoryFs(userText)
  const modelId = settings.lightRagModelId || settings.chatModelId
  const selectedModel = settings.chatModels.find(
    (model) => model.id === modelId,
  )
  if (!selectedModel) throw new Error('Selected model fixture is unavailable')
  const withGeneratedSelection = (
    model: string,
    baseUrl: string,
  ): NeuralComposerSettings => ({
    ...plugin.settings,
    chatModels: plugin.settings.chatModels.map((candidate) =>
      candidate.id === modelId ? { ...candidate, model } : candidate,
    ),
    providers: plugin.settings.providers.map((provider) =>
      provider.id === selectedModel.providerId
        ? { ...provider, baseUrl }
        : provider,
    ),
  })
  Object.assign(plugin, {
    settings: {
      ...withGeneratedSelection('managed-model-one', 'https://one.example'),
      lightRagCommand: 'fixture-command',
      lightRagUseRemote: false,
      lightRagWorkDir: '/synthetic',
    },
    isPortInUse: jest.fn(async () => true),
    updateStatusUI: jest.fn(),
    _nodeFs: fs,
    _nodePath: { join: (...parts: string[]) => parts.join('/') },
  })

  await plugin.startLightRagServer()
  const first = files.get('/synthetic/.env') ?? ''
  expect(first).toContain(userText)
  expect(lastEnvValue(first, 'LLM_MODEL')).toBe('managed-model-one')
  expect(lastEnvValue(first, 'LLM_BINDING_HOST')).toBe('https://one.example/v1')
  expect(plugin.settings.lightRagCustomEnv).toBe('')

  plugin.settings = withGeneratedSelection(
    'managed-model-two',
    'https://two.example',
  )
  await plugin.startLightRagServer()
  const changed = files.get('/synthetic/.env') ?? ''
  expect(changed).toContain(userText)
  expect(lastEnvValue(changed, 'LLM_MODEL')).toBe('managed-model-two')
  expect(lastEnvValue(changed, 'LLM_BINDING_HOST')).toBe(
    'https://two.example/v1',
  )
  expect(changed.match(/CUSTOM_LIMIT=42/g)).toHaveLength(1)

  await plugin.startLightRagServer()
  expect(files.get('/synthetic/.env')).toBe(changed)
})

it('previews the merged environment and saves intentional edits without changing other bytes', async () => {
  const { plugin, settings, saveData } = createPlugin()
  const original = [
    '# Operador – mantener exactamente',
    'CUSTOM_LIMIT=42',
    'MULTILINE_CUSTOM="first line',
    'second line=value',
    'last line"',
    '',
  ].join('\r\n')
  const { files, fs } = createMemoryFs(original)
  const restart = jest.fn(() => {
    expect(
      (plugin.settings as ProcessingSettings).lightRagImageDownloadsDisabledFor,
    ).toBe('')
  })
  const engine = { setSettings: jest.fn() }
  Object.assign(plugin, {
    settings: {
      ...settings,
      lightRagUseRemote: false,
      lightRagWorkDir: '/synthetic',
    },
    generateEnvConfig: jest.fn(() => 'CURRENT_GENERATED=true\n'),
    ragEngine: engine,
    restartLightRagServer: restart,
    _nodeFs: fs,
    _nodePath: { join: (...parts: string[]) => parts.join('/') },
  })

  const snapshot = plugin.loadEnvEditorSnapshot()

  expect(snapshot).not.toBeNull()
  expect(snapshot?.originalContent).toBe(original)
  expect(snapshot?.backendIdentity).toBe('original-backend')
  expect(snapshot?.envPath).toBe('/synthetic/.env')
  expect(snapshot?.originalExists).toBe(true)
  expect(snapshot?.content.slice(0, original.length)).toBe(original)
  expect(snapshot?.content).toContain(
    `${MANAGED_ENV_BEGIN}\r\nCURRENT_GENERATED=true\r\n${MANAGED_ENV_END}`,
  )
  if (!snapshot) throw new Error('Environment snapshot is unavailable')
  const edited = snapshot.content
    .replace('CUSTOM_LIMIT=42', 'CUSTOM_LIMIT=84')
    .replace('CURRENT_GENERATED=true', 'CURRENT_GENERATED=reviewed')

  await expect(plugin.saveEnvAndRestart(edited, snapshot)).resolves.toBe(true)

  expect(files.get('/synthetic/.env')).toBe(edited)
  expect(saveData).toHaveBeenCalledWith(
    expect.objectContaining({ lightRagImageDownloadsDisabledFor: '' }),
  )
  expect(engine.setSettings).toHaveBeenCalledWith(
    expect.objectContaining({ lightRagImageDownloadsDisabledFor: '' }),
  )
  expect(restart).toHaveBeenCalledWith(true)
})

it.each([
  [
    'an unterminated managed section',
    `CUSTOM_LIMIT=42\n${MANAGED_ENV_BEGIN}\nSTALE_GENERATED=true\n`,
    false,
  ],
  [
    'multiple managed sections',
    `${MANAGED_ENV_BEGIN}\nONE=true\n${MANAGED_ENV_END}\n${MANAGED_ENV_BEGIN}\nTWO=true\n${MANAGED_ENV_END}\n`,
    false,
  ],
  ['a read failure', 'CUSTOM_LIMIT=42\n', true],
])(
  'does not prepare a manual environment edit for %s',
  (_case, original, failRead) => {
    const { plugin, settings } = createPlugin()
    const { files, fs } = createMemoryFs(original)
    if (failRead) {
      fs.readFileSync.mockImplementation(() => {
        throw new Error('synthetic read failure')
      })
    }
    const restart = jest.fn()
    Object.assign(plugin, {
      settings: {
        ...settings,
        lightRagUseRemote: false,
        lightRagWorkDir: '/synthetic',
      },
      generateEnvConfig: jest.fn(() => 'CURRENT_GENERATED=true\n'),
      restartLightRagServer: restart,
      _nodeFs: fs,
      _nodePath: { join: (...parts: string[]) => parts.join('/') },
    })

    expect(plugin.loadEnvEditorSnapshot()).toBeNull()
    expect(files.get('/synthetic/.env')).toBe(original)
    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  },
)

it('rejects malformed manual content without replacing the environment or restarting', async () => {
  const { plugin, settings } = createPlugin()
  const original = 'CUSTOM_LIMIT=42\n'
  const { files, fs } = createMemoryFs(original)
  const restart = jest.fn()
  Object.assign(plugin, {
    settings: {
      ...settings,
      lightRagUseRemote: false,
      lightRagWorkDir: '/synthetic',
    },
    generateEnvConfig: jest.fn(() => 'CURRENT_GENERATED=true\n'),
    restartLightRagServer: restart,
    _nodeFs: fs,
    _nodePath: { join: (...parts: string[]) => parts.join('/') },
  })
  const snapshot = plugin.loadEnvEditorSnapshot()
  if (!snapshot) throw new Error('Environment snapshot is unavailable')
  const malformed = snapshot.content.replace(MANAGED_ENV_END, '')

  await expect(plugin.saveEnvAndRestart(malformed, snapshot)).resolves.toBe(
    false,
  )

  expect(files.get('/synthetic/.env')).toBe(original)
  expect(restart).not.toHaveBeenCalled()
})

it('rejects an external environment change made after the manual preview', async () => {
  const { plugin, settings } = createPlugin()
  const original = 'CUSTOM_LIMIT=42\n'
  const external = 'CUSTOM_LIMIT=99\n'
  const { files, fs } = createMemoryFs(original)
  const restart = jest.fn()
  Object.assign(plugin, {
    settings: {
      ...settings,
      lightRagUseRemote: false,
      lightRagWorkDir: '/synthetic',
    },
    generateEnvConfig: jest.fn(() => 'CURRENT_GENERATED=true\n'),
    restartLightRagServer: restart,
    _nodeFs: fs,
    _nodePath: { join: (...parts: string[]) => parts.join('/') },
  })
  const snapshot = plugin.loadEnvEditorSnapshot()
  if (!snapshot) throw new Error('Environment snapshot is unavailable')
  files.set('/synthetic/.env', external)

  await expect(
    plugin.saveEnvAndRestart(
      snapshot.content.replace(
        'CURRENT_GENERATED=true',
        'CURRENT_GENERATED=reviewed',
      ),
      snapshot,
    ),
  ).resolves.toBe(false)

  expect(files.get('/synthetic/.env')).toBe(external)
  expect(restart).not.toHaveBeenCalled()
})

it('rejects an unchanged review when the canonical environment changed after preview', async () => {
  const { plugin, settings } = createPlugin()
  const original = [
    'CUSTOM_LIMIT=42',
    '',
    MANAGED_ENV_BEGIN,
    'CURRENT_GENERATED=true',
    MANAGED_ENV_END,
    '',
  ].join('\n')
  const external = `${original}EXTERNAL_CHANGE=kept\n`
  const { files, fs } = createMemoryFs(original)
  const restart = jest.fn()
  Object.assign(plugin, {
    settings: {
      ...settings,
      lightRagUseRemote: false,
      lightRagWorkDir: '/synthetic',
    },
    generateEnvConfig: jest.fn(() => 'CURRENT_GENERATED=true\n'),
    restartLightRagServer: restart,
    _nodeFs: fs,
    _nodePath: { join: (...parts: string[]) => parts.join('/') },
  })
  const snapshot = plugin.loadEnvEditorSnapshot()
  if (!snapshot) throw new Error('Environment snapshot is unavailable')
  expect(snapshot.content).toBe(snapshot.originalContent)
  files.set('/synthetic/.env', external)

  await expect(
    plugin.saveEnvAndRestart(snapshot.content, snapshot),
  ).resolves.toBe(false)

  expect(files.get('/synthetic/.env')).toBe(external)
  expect(fs.writeFileSync).not.toHaveBeenCalled()
  expect(restart).not.toHaveBeenCalled()
})

it('rejects a same-byte snapshot after the selected backend and workdir change', async () => {
  const { plugin, settings } = createPlugin()
  const original = 'CUSTOM_LIMIT=42\n'
  const { files, fs } = createMemoryFs(original)
  const restart = jest.fn()
  Object.assign(plugin, {
    settings: {
      ...settings,
      lightRagUseRemote: false,
      lightRagWorkDir: '/synthetic',
    },
    generateEnvConfig: jest.fn(() => 'CURRENT_GENERATED=true\n'),
    restartLightRagServer: restart,
    _nodeFs: fs,
    _nodePath: { join: (...parts: string[]) => parts.join('/') },
  })
  const snapshot = plugin.loadEnvEditorSnapshot()
  if (!snapshot) throw new Error('Environment snapshot is unavailable')
  files.set('/replacement/.env', original)
  plugin.settings = {
    ...plugin.settings,
    lightRagBackendIdentity: 'replacement-backend',
    lightRagImageDownloadsDisabledFor: 'replacement-backend',
    lightRagWorkDir: '/replacement',
  }

  await expect(
    plugin.saveEnvAndRestart(
      snapshot.content.replace(
        'CURRENT_GENERATED=true',
        'CURRENT_GENERATED=reviewed',
      ),
      snapshot,
    ),
  ).resolves.toBe(false)

  expect(files.get('/synthetic/.env')).toBe(original)
  expect(files.get('/replacement/.env')).toBe(original)
  expect(fs.writeFileSync).not.toHaveBeenCalled()
  expect(restart).not.toHaveBeenCalled()
  expect(
    (plugin.settings as ProcessingSettings).lightRagImageDownloadsDisabledFor,
  ).toBe('replacement-backend')
})

it('rechecks snapshot ownership after asynchronously clearing acknowledgement', async () => {
  const { plugin, settings } = createPlugin()
  const original = 'CUSTOM_LIMIT=42\n'
  const { files, fs } = createMemoryFs(original)
  const restart = jest.fn()
  const setSettings = jest.fn(async (next: NeuralComposerSettings) => {
    expect(next.lightRagImageDownloadsDisabledFor).toBe('')
    plugin.settings = {
      ...next,
      lightRagBackendIdentity: 'replacement-backend',
      lightRagImageDownloadsDisabledFor: 'replacement-backend',
      lightRagWorkDir: '/replacement',
    }
  })
  Object.assign(plugin, {
    settings: {
      ...settings,
      lightRagUseRemote: false,
      lightRagWorkDir: '/synthetic',
    },
    generateEnvConfig: jest.fn(() => 'CURRENT_GENERATED=true\n'),
    restartLightRagServer: restart,
    setSettings,
    _nodeFs: fs,
    _nodePath: { join: (...parts: string[]) => parts.join('/') },
  })
  const snapshot = plugin.loadEnvEditorSnapshot()
  if (!snapshot) throw new Error('Environment snapshot is unavailable')

  await expect(
    plugin.saveEnvAndRestart(snapshot.content, snapshot),
  ).resolves.toBe(false)

  expect(setSettings).toHaveBeenCalledTimes(1)
  expect(files.get('/synthetic/.env')).toBe(original)
  expect(fs.writeFileSync).not.toHaveBeenCalled()
  expect(restart).not.toHaveBeenCalled()
})

it('makes unkeyed Ollama routing authoritative over preserved legacy bindings', async () => {
  const { plugin, settings } = createPlugin()
  const legacy = [
    '# User-maintained local values',
    'CUSTOM_LIMIT=42',
    'LLM_BINDING_HOST=https://legacy-llm.example/v1',
    'LLM_BINDING_API_KEY=legacy-llm-secret',
    'EMBEDDING_BINDING_HOST=https://legacy-embedding.example/v1',
    'EMBEDDING_BINDING_API_KEY=legacy-embedding-secret',
    '',
  ].join('\n')
  const { files, fs } = createMemoryFs(legacy)
  const ollamaProvider = settings.providers.find(
    (provider) => provider.type === 'ollama',
  )
  const ollamaEmbedding = settings.embeddingModels.find(
    (model) => model.providerType === 'ollama',
  )
  if (!ollamaProvider || !ollamaEmbedding)
    throw new Error('Ollama fixtures are unavailable')
  const ollamaHost = 'http://ollama.example:11434'
  const ollamaChat = {
    id: 'ollama/test-chat',
    model: 'test-chat',
    providerId: ollamaProvider.id,
    providerType: 'ollama' as const,
  }
  Object.assign(plugin, {
    settings: {
      ...settings,
      chatModels: [...settings.chatModels, ollamaChat],
      lightRagCommand: 'fixture-command',
      lightRagEmbeddingModelId: ollamaEmbedding.id,
      lightRagModelId: ollamaChat.id,
      lightRagUseRemote: false,
      lightRagWorkDir: '/synthetic',
      providers: settings.providers.map((provider) =>
        provider.id === ollamaProvider.id
          ? { ...provider, apiKey: undefined, baseUrl: `${ollamaHost}/` }
          : provider,
      ),
    },
    isPortInUse: jest.fn(async () => true),
    updateStatusUI: jest.fn(),
    _nodeFs: fs,
    _nodePath: { join: (...parts: string[]) => parts.join('/') },
  })

  await plugin.startLightRagServer()

  const content = files.get('/synthetic/.env') ?? ''
  expect(content).toContain(legacy)
  expect(lastEnvValue(content, 'LLM_BINDING')).toBe('ollama')
  expect(lastEnvValue(content, 'LLM_BINDING_HOST')).toBe(ollamaHost)
  expect(lastEnvValue(content, 'LLM_BINDING_API_KEY')).toBe('')
  expect(lastEnvValue(content, 'EMBEDDING_BINDING')).toBe('ollama')
  expect(lastEnvValue(content, 'EMBEDDING_BINDING_HOST')).toBe(ollamaHost)
  expect(lastEnvValue(content, 'EMBEDDING_BINDING_API_KEY')).toBe('')
})

it('makes default OpenAI routing authoritative over preserved legacy hosts', async () => {
  const { plugin, settings } = createPlugin()
  const legacy = [
    '# User-maintained local values',
    'CUSTOM_LIMIT=42',
    'LLM_BINDING_HOST=https://legacy-llm.example/v1',
    'LLM_BINDING_API_KEY=legacy-llm-secret',
    'EMBEDDING_BINDING_HOST=https://legacy-embedding.example/v1',
    'EMBEDDING_BINDING_API_KEY=legacy-embedding-secret',
    '',
  ].join('\n')
  const { files, fs } = createMemoryFs(legacy)
  const openAiProvider = settings.providers.find(
    (provider) => provider.id === 'openai',
  )
  const openAiChat = settings.chatModels.find(
    (model) => model.providerId === openAiProvider?.id,
  )
  const openAiEmbedding = settings.embeddingModels.find(
    (model) => model.providerId === openAiProvider?.id,
  )
  if (!openAiProvider || !openAiChat || !openAiEmbedding)
    throw new Error('OpenAI fixtures are unavailable')
  Object.assign(plugin, {
    settings: {
      ...settings,
      lightRagCommand: 'fixture-command',
      lightRagEmbeddingModelId: openAiEmbedding.id,
      lightRagModelId: openAiChat.id,
      lightRagUseRemote: false,
      lightRagWorkDir: '/synthetic',
      providers: settings.providers.map((provider) =>
        provider.id === openAiProvider.id
          ? {
              ...provider,
              apiKey: 'synthetic-openai-key',
              baseUrl: undefined,
            }
          : provider,
      ),
    },
    isPortInUse: jest.fn(async () => true),
    updateStatusUI: jest.fn(),
    _nodeFs: fs,
    _nodePath: { join: (...parts: string[]) => parts.join('/') },
  })

  await plugin.startLightRagServer()

  const content = files.get('/synthetic/.env') ?? ''
  expect(content).toContain(legacy)
  expect(lastEnvValue(content, 'LLM_BINDING')).toBe('openai')
  expect(lastEnvValue(content, 'LLM_BINDING_HOST')).toBe(
    'https://api.openai.com/v1',
  )
  expect(lastEnvValue(content, 'LLM_BINDING_API_KEY')).toBe(
    'synthetic-openai-key',
  )
  expect(lastEnvValue(content, 'EMBEDDING_BINDING')).toBe('openai')
  expect(lastEnvValue(content, 'EMBEDDING_BINDING_HOST')).toBe(
    'https://api.openai.com/v1',
  )
  expect(lastEnvValue(content, 'EMBEDDING_BINDING_API_KEY')).toBe(
    'synthetic-openai-key',
  )
})

it.each([
  [
    'gemini',
    'GEMINI_API_KEY',
    'google',
    'https://generativelanguage.googleapis.com',
  ],
  ['anthropic', 'ANTHROPIC_API_KEY', 'anthropic', 'https://api.anthropic.com'],
])(
  'clears a preserved %s fallback key and uses its native default URL',
  (providerId, fallbackKey, binding, defaultHost) => {
    const { plugin, settings } = createPlugin()
    const original = `CUSTOM_LIMIT=42\n${fallbackKey}=legacy-secret\n`
    const { files, fs } = createMemoryFs(original)
    const provider = settings.providers.find(
      (candidate) => candidate.id === providerId,
    )
    const model = settings.chatModels.find(
      (candidate) => candidate.providerId === providerId,
    )
    if (!provider || !model)
      throw new Error(`Native ${providerId} fixtures are unavailable`)
    Object.assign(plugin, {
      settings: {
        ...settings,
        lightRagModelId: model.id,
        lightRagUseRemote: false,
        lightRagWorkDir: '/synthetic',
        providers: settings.providers.map((candidate) =>
          candidate.id === providerId
            ? { ...candidate, apiKey: undefined, baseUrl: undefined }
            : candidate,
        ),
      },
      _nodeFs: fs,
      _nodePath: { join: (...parts: string[]) => parts.join('/') },
    })

    expect(plugin.updateEnvFile()).toBe(true)
    const generated = files.get('/synthetic/.env') ?? ''
    expect(lastEnvValue(generated, 'LLM_BINDING')).toBe(binding)
    expect(lastEnvValue(generated, 'LLM_BINDING_HOST')).toBe(defaultHost)
    expect(lastEnvValue(generated, 'LLM_BINDING_API_KEY')).toBe('')
    expect(lastEnvValue(generated, fallbackKey)).toBe('')

    plugin.settings = {
      ...plugin.settings,
      lightRagCustomEnv: `${fallbackKey}=operator-override`,
    }
    expect(plugin.updateEnvFile()).toBe(true)
    expect(lastEnvValue(files.get('/synthetic/.env') ?? '', fallbackKey)).toBe(
      'operator-override',
    )
  },
)

it('fails closed on an unresolved custom host while honoring explicit custom routing', () => {
  const { plugin, settings } = createPlugin()
  const legacy = [
    'CUSTOM_LIMIT=42',
    'LLM_BINDING_HOST=https://legacy-llm.example/v1',
    'EMBEDDING_BINDING_HOST=https://legacy-embedding.example/v1',
    '',
  ].join('\n')
  const { files, fs } = createMemoryFs(legacy)
  const provider = {
    apiKey: 'synthetic-custom-key',
    id: 'unresolved-custom',
    type: 'openai-compatible' as const,
  }
  const chatModel = {
    id: 'unresolved-custom/chat',
    model: 'synthetic-chat',
    providerId: provider.id,
    providerType: provider.type,
  }
  const embeddingModel = {
    dimension: 8,
    id: 'unresolved-custom/embedding',
    model: 'synthetic-embedding',
    providerId: provider.id,
    providerType: provider.type,
  }
  Object.assign(plugin, {
    settings: {
      ...settings,
      chatModels: [...settings.chatModels, chatModel],
      embeddingModels: [...settings.embeddingModels, embeddingModel],
      lightRagEmbeddingModelId: embeddingModel.id,
      lightRagModelId: chatModel.id,
      lightRagUseRemote: false,
      lightRagWorkDir: '/synthetic',
      providers: [...settings.providers, provider],
    },
    _nodeFs: fs,
    _nodePath: { join: (...parts: string[]) => parts.join('/') },
  })

  expect(plugin.updateEnvFile()).toBe(false)
  expect(files.get('/synthetic/.env')).toBe(legacy)
  expect(fs.writeFileSync).not.toHaveBeenCalled()

  plugin.settings = {
    ...plugin.settings,
    lightRagCustomEnv: [
      'LLM_BINDING_HOST=https://explicit-llm.example/v1',
      'EMBEDDING_BINDING_HOST=https://explicit-embedding.example/v1',
    ].join('\n'),
  }
  expect(plugin.updateEnvFile()).toBe(true)
  const overridden = files.get('/synthetic/.env') ?? ''
  expect(lastEnvValue(overridden, 'LLM_BINDING_HOST')).toBe(
    'https://explicit-llm.example/v1',
  )
  expect(lastEnvValue(overridden, 'EMBEDDING_BINDING_HOST')).toBe(
    'https://explicit-embedding.example/v1',
  )
})

it.each([
  [
    'an unterminated managed section',
    `CUSTOM_LIMIT=42\n${MANAGED_ENV_BEGIN}\nSTALE_GENERATED=true\n`,
  ],
  [
    'multiple managed sections',
    `${MANAGED_ENV_BEGIN}\nONE=true\n${MANAGED_ENV_END}\n${MANAGED_ENV_BEGIN}\nTWO=true\n${MANAGED_ENV_END}\n`,
  ],
])('keeps the original environment for %s', (_case, original) => {
  const { plugin, settings } = createPlugin()
  const { files, fs } = createMemoryFs(original)
  Object.assign(plugin, {
    settings: {
      ...settings,
      lightRagUseRemote: false,
      lightRagWorkDir: '/synthetic',
    },
    generateEnvConfig: jest.fn(() => 'CURRENT_GENERATED=true\n'),
    _nodeFs: fs,
    _nodePath: { join: (...parts: string[]) => parts.join('/') },
  })

  expect(plugin.updateEnvFile()).toBe(false)
  expect(files.get('/synthetic/.env')).toBe(original)
  expect(fs.writeFileSync).not.toHaveBeenCalled()
})

it('keeps the original environment when it cannot be read', () => {
  const { plugin, settings } = createPlugin()
  const original = 'CUSTOM_LIMIT=42\n'
  const { files, fs } = createMemoryFs(original)
  fs.readFileSync.mockImplementation(() => {
    throw new Error('synthetic read failure')
  })
  Object.assign(plugin, {
    settings: {
      ...settings,
      lightRagUseRemote: false,
      lightRagWorkDir: '/synthetic',
    },
    generateEnvConfig: jest.fn(() => 'CURRENT_GENERATED=true\n'),
    _nodeFs: fs,
    _nodePath: { join: (...parts: string[]) => parts.join('/') },
  })

  expect(plugin.updateEnvFile()).toBe(false)
  expect(files.get('/synthetic/.env')).toBe(original)
  expect(fs.writeFileSync).not.toHaveBeenCalled()
})

it('keeps a deferred rename when a later edit coalesces into the same batch slot', () => {
  const { plugin } = createPlugin()
  type Change = { path: string; previousPath?: string; remove: boolean }
  const deferred = new Map<string, Change>()
  Object.assign(plugin, {
    graphBatchAbort: new AbortController(),
    deferredGraphChanges: deferred,
  })
  const scheduler = plugin as unknown as {
    queueGraphChange(change: Change): void
  }

  scheduler.queueGraphChange({
    path: 'B.md',
    previousPath: 'A.md',
    remove: false,
  })
  scheduler.queueGraphChange({ path: 'B.md', remove: false })

  expect([...deferred.values()]).toEqual([
    { path: 'B.md', previousPath: 'A.md', remove: false },
  ])
})

it('waits for per-file rename events when folder children still have old paths', () => {
  const { plugin, settings } = createPlugin()
  const deferred = new Map<
    string,
    { path: string; previousPath?: string; remove: boolean }
  >()
  Object.assign(plugin, {
    settings: { ...settings, lightRagSyncFolder: 'Projects' },
    graphBatchAbort: new AbortController(),
    docIndexReady: true,
    deferredGraphChanges: deferred,
  })
  const child = Object.assign(new TFile(), {
    path: 'Projects/Beta/Overview.md',
    name: 'Overview.md',
    extension: 'md',
  })
  const folder = Object.assign(new TFolder(), {
    path: 'Projects/BetaMoved',
    children: [child],
  })
  const handler = plugin as unknown as {
    handleGraphRename(file: TFile | TFolder, oldPath: string): void
  }

  handler.handleGraphRename(folder, 'Projects/Beta')
  child.path = 'Projects/BetaMoved/Overview.md'
  handler.handleGraphRename(child, 'Projects/Beta/Overview.md')

  expect([...deferred.values()]).toEqual([
    {
      path: 'Projects/BetaMoved/Overview.md',
      previousPath: 'Projects/Beta/Overview.md',
      remove: false,
    },
  ])
})

it('honors explicit removal when a later modification is deferred by a batch', async () => {
  const { plugin } = createPlugin()
  const holding = createGraphFile('Notes/Holding.md')
  const target = createGraphFile('Notes/Target.md')
  let releaseUpload!: () => void
  let reportUploadStarted!: () => void
  const uploadStarted = new Promise<void>((resolve) => {
    reportUploadStarted = resolve
  })
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve
  })
  const engine = {
    deleteDocumentsByPaths: jest.fn(async (_paths: string[]) => true),
    ingestFile: jest.fn(
      async (file: TFile, options: { intent: 'new' | 'sync' }) => {
        if (file.path === holding.path && options.intent === 'new') {
          reportUploadStarted()
          await uploadGate
        }
        return { status: 'processed' as const }
      },
    ),
  }
  const { index, internals } = installGraphRuntime(
    plugin,
    [holding, target],
    engine,
  )
  const removed = new Set<string>()
  engine.deleteDocumentsByPaths.mockImplementation(async (paths) => {
    paths.forEach((path) => removed.add(path))
    index.getStatus.mockImplementation((path) =>
      removed.has(path) ? 'removed' : undefined,
    )
    index.needsIngestion.mockImplementation((path) => !removed.has(path))
    return true
  })
  plugin.settings = {
    ...plugin.settings,
    lightRagSyncFolder: 'Notes',
  }

  const batch = internals.runGraphBatch([holding], 'new')
  await uploadStarted
  internals.queueGraphChange({ path: target.path, remove: true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(engine.deleteDocumentsByPaths).toHaveBeenCalledWith([target.path])
  internals.queueGraphChange({ path: target.path, remove: false })
  releaseUpload()
  await batch
  await internals.graphSyncTail

  expect(engine.deleteDocumentsByPaths).toHaveBeenCalledTimes(1)
  expect(
    engine.ingestFile.mock.calls.some(
      ([file, options]) =>
        file.path === target.path && options.intent === 'sync',
    ),
  ).toBe(false)
})

it('honors explicit removal through a deferred rename and later modification', async () => {
  const { plugin } = createPlugin()
  const holding = createGraphFile('Notes/Holding.md')
  const renamed = createGraphFile('Notes/Renamed.md')
  let releaseUpload!: () => void
  let reportUploadStarted!: () => void
  const uploadStarted = new Promise<void>((resolve) => {
    reportUploadStarted = resolve
  })
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve
  })
  let originalRecord: object = {
    aliases: [],
    docId: 'original-document-id',
    source: 'original-transport-source.md',
    status: 'processed',
  }
  const engine = {
    deleteDocumentsByPaths: jest.fn(async (_paths: string[]) => {
      originalRecord = {
        aliases: [],
        source: 'original-transport-source.md',
        status: 'removed',
      }
      return true
    }),
    ingestFile: jest.fn(
      async (file: TFile, options: { intent: 'new' | 'sync' }) => {
        if (file.path === holding.path && options.intent === 'new') {
          reportUploadStarted()
          await uploadGate
        }
        return { status: 'processed' as const }
      },
    ),
  }
  const { index, internals } = installGraphRuntime(
    plugin,
    [holding, renamed],
    engine,
  )
  plugin.settings = {
    ...plugin.settings,
    lightRagSyncFolder: 'Notes',
  }
  Object.assign(plugin, { docIndexReady: true })
  index.getRecord.mockImplementation((path) =>
    path === 'Notes/Original.md' ? originalRecord : undefined,
  )

  const batch = internals.runGraphBatch([holding], 'new')
  await uploadStarted
  internals.queueGraphChange({ path: 'Notes/Original.md', remove: true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(engine.deleteDocumentsByPaths).toHaveBeenCalledWith([
    'Notes/Original.md',
  ])
  internals.handleGraphRename(renamed, 'Notes/Original.md')
  internals.queueGraphChange({ path: renamed.path, remove: false })
  releaseUpload()
  await batch
  await internals.graphSyncTail

  expect(engine.deleteDocumentsByPaths).toHaveBeenCalledTimes(1)
  expect(index.saveRecord).toHaveBeenCalledWith(
    renamed.path,
    expect.objectContaining({
      aliases: expect.arrayContaining([
        'original-transport-source.md',
      ]) as unknown,
      status: 'removed',
    }),
    'original-backend',
    { previousPath: 'Notes/Original.md' },
  )
  expect(
    engine.ingestFile.mock.calls.some(
      ([file, options]) =>
        file.path === renamed.path && options.intent === 'sync',
    ),
  ).toBe(false)
})

it('does not reinterpret a renamed unsent batch file as a fresh new upload', async () => {
  const { plugin } = createPlugin()
  const holding = createGraphFile('Notes/Holding.md')
  const renamed = createGraphFile('Notes/Original.md')
  const originalPath = renamed.path
  let releaseUpload!: () => void
  let reportUploadStarted!: () => void
  const uploadStarted = new Promise<void>((resolve) => {
    reportUploadStarted = resolve
  })
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve
  })
  const engine = {
    ingestFile: jest.fn(
      async (file: TFile, options: { intent: 'new' | 'sync' }) => {
        if (file === holding && options.intent === 'new') {
          reportUploadStarted()
          await uploadGate
        }
        return { status: 'processed' as const }
      },
    ),
  }
  const { internals } = installGraphRuntime(plugin, [holding, renamed], engine)
  plugin.settings = {
    ...plugin.settings,
    lightRagSyncFolder: 'Notes',
  }
  Object.assign(plugin, {
    docIndexReady: true,
    app: {
      vault: {
        getAbstractFileByPath: (path: string) =>
          [holding, renamed].find((file) => file.path === path) ?? null,
      },
    },
  })

  const batch = internals.runGraphBatch([holding, renamed], 'new')
  await uploadStarted
  renamed.path = 'Notes/Renamed.md'
  renamed.name = 'Renamed.md'
  internals.handleGraphRename(renamed, originalPath)
  releaseUpload()
  await batch
  await internals.graphSyncTail

  expect(
    engine.ingestFile.mock.calls.some(
      ([file, options]) => file === renamed && options.intent === 'new',
    ),
  ).toBe(false)
  expect(engine.ingestFile).toHaveBeenCalledWith(
    renamed,
    expect.objectContaining({ intent: 'sync' }),
  )
})

it('settles an accepted upload before completing folder exclusion removal', async () => {
  const { plugin } = createPlugin()
  const accepted = createGraphFile('Notes/Accepted.md')
  const unsent = createGraphFile('Notes/Unsent.md')
  const folder = Object.assign(new TFolder(), {
    children: [accepted, unsent],
    path: 'Notes',
  })
  let releaseUpload!: () => void
  let reportUploadStarted!: () => void
  let acceptedUploadLanded = false
  const uploadStarted = new Promise<void>((resolve) => {
    reportUploadStarted = resolve
  })
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve
  })
  const engine = {
    deleteDocumentsByIds: jest.fn(async () => true),
    deleteDocumentsByPaths: jest.fn(async (_paths: string[]) => {
      await uploadGate
      return acceptedUploadLanded
    }),
    getDocIdMap: jest.fn(async () => new Map()),
    ingestFile: jest.fn(async (file: TFile) => {
      if (file.path === accepted.path) {
        reportUploadStarted()
        await uploadGate
        acceptedUploadLanded = true
      }
      return { status: 'processed' as const }
    }),
  }
  const { internals } = installGraphRuntime(plugin, [accepted, unsent], engine)
  plugin.settings = {
    ...plugin.settings,
    lightRagSyncFolder: 'Notes',
  }
  Object.assign(plugin, {
    setSettings: jest.fn(async (next: NeuralComposerSettings) => {
      plugin.settings = next
    }),
  })

  const batch = internals.runGraphBatch([accepted, unsent], 'new')
  await uploadStarted
  let exclusionSettled = false
  const exclusion = internals
    .addGraphExclusionForFiles([folder], ['Notes/**'])
    .then(() => {
      exclusionSettled = true
    })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(exclusionSettled).toBe(false)
  expect(engine.deleteDocumentsByPaths).toHaveBeenCalledWith([
    accepted.path,
    unsent.path,
  ])

  releaseUpload()
  await Promise.all([batch, exclusion])

  expect(engine.getDocIdMap).not.toHaveBeenCalled()
  expect(engine.deleteDocumentsByIds).not.toHaveBeenCalled()
  expect(
    engine.ingestFile.mock.calls.some(([file]) => file.path === unsent.path),
  ).toBe(false)
})

it('settles accepted work and stops unsent work before completing folder removal', async () => {
  const { plugin } = createPlugin()
  const accepted = createGraphFile('Notes/Accepted.md')
  const unsent = createGraphFile('Notes/Unsent.md')
  const folder = Object.assign(new TFolder(), {
    children: [accepted, unsent],
    path: 'Notes',
  })
  let releaseUpload!: () => void
  let reportUploadStarted!: () => void
  let acceptedUploadLanded = false
  const uploadStarted = new Promise<void>((resolve) => {
    reportUploadStarted = resolve
  })
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve
  })
  const engine = {
    deleteDocumentsByIds: jest.fn(async () => true),
    deleteDocumentsByPaths: jest.fn(async (_paths: string[]) => {
      await uploadGate
      return acceptedUploadLanded
    }),
    getDocIdMap: jest.fn(async () => new Map()),
    ingestFile: jest.fn(async (file: TFile) => {
      if (file.path === accepted.path) {
        reportUploadStarted()
        await uploadGate
        acceptedUploadLanded = true
      }
      return { status: 'processed' as const }
    }),
  }
  const { internals } = installGraphRuntime(plugin, [accepted, unsent], engine)
  plugin.settings = {
    ...plugin.settings,
    lightRagSyncFolder: 'Notes',
  }

  const batch = internals.runGraphBatch([accepted, unsent], 'new')
  await uploadStarted
  let removalSettled = false
  const removal = internals
    .executeBatchRemoveFolderFromGraph(folder, [accepted, unsent])
    .then(() => {
      removalSettled = true
    })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(removalSettled).toBe(false)
  expect(engine.deleteDocumentsByPaths).toHaveBeenCalledWith([
    accepted.path,
    unsent.path,
  ])

  releaseUpload()
  await Promise.all([batch, removal])

  expect(engine.getDocIdMap).not.toHaveBeenCalled()
  expect(engine.deleteDocumentsByIds).not.toHaveBeenCalled()
  expect(
    engine.ingestFile.mock.calls.some(([file]) => file.path === unsent.path),
  ).toBe(false)
})

it('does not list or replace folder status when backend ownership changes while acquiring the engine', async () => {
  const { plugin } = createPlugin()
  const listAllDocumentPaths = jest.fn(async () => ['Old/Document.md'])
  const engine = { listAllDocumentPaths }
  let resolveEngine!: (value: typeof engine) => void
  const engineGate = new Promise<typeof engine>((resolve) => {
    resolveEngine = resolve
  })
  const folderState = plugin as unknown as {
    ingestedFolderPaths: Set<string>
    ingestedFolderPathsLoaded: boolean
  }
  folderState.ingestedFolderPaths = new Set(['Current'])
  folderState.ingestedFolderPathsLoaded = true
  Object.assign(plugin, {
    getRAGEngine: jest.fn(() => engineGate),
  })

  const refresh = plugin.refreshIngestedFolderPaths()
  plugin.settings = {
    ...plugin.settings,
    lightRagBackendIdentity: 'replacement-backend',
  }
  resolveEngine(engine)
  await refresh

  expect(listAllDocumentPaths).not.toHaveBeenCalled()
  expect(folderState.ingestedFolderPaths).toEqual(new Set(['Current']))
  expect(folderState.ingestedFolderPathsLoaded).toBe(true)
})

it('does not apply folder status when the vault namespace changes during listing', async () => {
  const { plugin } = createPlugin()
  let resolvePaths!: (value: string[]) => void
  const pathsGate = new Promise<string[]>((resolve) => {
    resolvePaths = resolve
  })
  const listAllDocumentPaths = jest.fn(() => pathsGate)
  const folderState = plugin as unknown as {
    ingestedFolderPaths: Set<string>
    ingestedFolderPathsLoaded: boolean
  }
  folderState.ingestedFolderPaths = new Set(['Current'])
  folderState.ingestedFolderPathsLoaded = true
  Object.assign(plugin, {
    getRAGEngine: jest.fn(async () => ({ listAllDocumentPaths })),
  })

  const refresh = plugin.refreshIngestedFolderPaths()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(listAllDocumentPaths).toHaveBeenCalledTimes(1)
  plugin.settings = {
    ...plugin.settings,
    lightRagVaultNamespace: 'replacement-namespace',
  }
  resolvePaths(['Old/Document.md'])
  await refresh

  expect(folderState.ingestedFolderPaths).toEqual(new Set(['Current']))
  expect(folderState.ingestedFolderPathsLoaded).toBe(true)
})

it.each(['lightRagBackendIdentity', 'lightRagVaultNamespace'] as const)(
  'does not move a removed tombstone after source hashing loses %s ownership',
  async (ownershipField) => {
    const { plugin } = createPlugin()
    const renamed = createGraphFile('Notes/Renamed.md')
    const engine = { ingestFile: jest.fn() }
    const { index, internals } = installGraphRuntime(plugin, [renamed], engine)
    plugin.settings = {
      ...plugin.settings,
      lightRagSyncFolder: 'Notes',
    }
    index.getRecord.mockImplementation((path) =>
      path === 'Notes/Original.md'
        ? {
            aliases: [],
            source: 'original-source.md',
            status: 'removed',
          }
        : undefined,
    )
    let reportHashStarted!: () => void
    let releaseHash!: () => void
    const hashStarted = new Promise<void>((resolve) => {
      reportHashStarted = resolve
    })
    const hashGate = new Promise<void>((resolve) => {
      releaseHash = resolve
    })
    jest
      .spyOn(documentProcessing, 'documentSourceName')
      .mockImplementationOnce(async () => {
        reportHashStarted()
        await hashGate
        return 'nc-renamed-source'
      })

    internals.queueGraphChange({
      path: renamed.path,
      previousPath: 'Notes/Original.md',
      remove: false,
    })
    await hashStarted
    plugin.settings = {
      ...plugin.settings,
      [ownershipField]: `replacement-${ownershipField}`,
    }
    releaseHash()
    await internals.graphSyncTail

    expect(index.saveRecord).not.toHaveBeenCalled()
    expect(engine.ingestFile).not.toHaveBeenCalled()
  },
)

it('does not redirect exclusion removal when backend ownership changes while acquiring the engine', async () => {
  const { plugin } = createPlugin()
  const target = createGraphFile('Notes/Excluded.md')
  const engine = {
    deleteDocumentsByPaths: jest.fn(async () => true),
    ingestFile: jest.fn(),
  }
  const { internals } = installGraphRuntime(plugin, [target], engine)
  let reportGetStarted!: () => void
  let resolveEngine!: (value: typeof engine) => void
  const getStarted = new Promise<void>((resolve) => {
    reportGetStarted = resolve
  })
  const engineGate = new Promise<typeof engine>((resolve) => {
    resolveEngine = resolve
  })
  Object.assign(plugin, {
    getRAGEngine: jest.fn(() => {
      reportGetStarted()
      return engineGate
    }),
    setSettings: jest.fn(async (next: NeuralComposerSettings) => {
      plugin.settings = next
    }),
  })

  const exclusion = internals.addGraphExclusionForFiles(
    [target],
    ['Notes/Excluded.md'],
  )
  await getStarted
  plugin.settings = {
    ...plugin.settings,
    lightRagBackendIdentity: 'replacement-backend',
  }
  resolveEngine(engine)
  await exclusion

  expect(engine.deleteDocumentsByPaths).not.toHaveBeenCalled()
})

it('does not apply folder removal after backend ownership changes during deletion', async () => {
  const { plugin } = createPlugin()
  const target = createGraphFile('Notes/Target.md')
  const folder = Object.assign(new TFolder(), {
    children: [target],
    path: 'Notes',
  })
  let reportDeletionStarted!: () => void
  let resolveDeletion!: (value: boolean) => void
  const deletionStarted = new Promise<void>((resolve) => {
    reportDeletionStarted = resolve
  })
  const deletionGate = new Promise<boolean>((resolve) => {
    resolveDeletion = resolve
  })
  const engine = {
    deleteDocumentsByPaths: jest.fn(() => {
      reportDeletionStarted()
      return deletionGate
    }),
    ingestFile: jest.fn(),
  }
  const { internals } = installGraphRuntime(plugin, [target], engine)
  const refreshIngestedFolderPaths = jest.fn(async () => undefined)
  const decorateFileExplorer = jest.fn()
  const updateStatusUI = jest.fn()
  Object.assign(plugin, {
    refreshIngestedFolderPaths,
    decorateFileExplorer,
    updateStatusUI,
  })

  const removal = internals.executeBatchRemoveFolderFromGraph(folder, [target])
  await deletionStarted
  plugin.settings = {
    ...plugin.settings,
    lightRagBackendIdentity: 'replacement-backend',
  }
  resolveDeletion(true)
  await removal

  expect(refreshIngestedFolderPaths).not.toHaveBeenCalled()
  expect(decorateFileExplorer).not.toHaveBeenCalled()
  expect(updateStatusUI).not.toHaveBeenCalled()
})

it('keeps exclusion removal unresolved files out of ordinary ingestion', async () => {
  const { plugin } = createPlugin()
  const target = createGraphFile('Notes/Excluded.md')
  const engine = {
    deleteDocumentsByPaths: jest.fn(async () => false),
    ingestFile: jest.fn(async () => ({ status: 'processed' as const })),
  }
  const { internals } = installGraphRuntime(plugin, [target], engine)
  Object.assign(plugin, {
    setSettings: jest.fn(async (next: NeuralComposerSettings) => {
      plugin.settings = next
    }),
  })

  await internals.addGraphExclusionForFiles([target], ['Notes/Excluded.md'])
  await internals.runGraphBatch([target], 'new')

  expect(plugin.settings.lightRagExcludePatterns).toContain('Notes/Excluded.md')
  expect(engine.ingestFile).not.toHaveBeenCalled()
})

it('does not apply successful folder-removal state when removal is unresolved', async () => {
  const { plugin } = createPlugin()
  const target = createGraphFile('Notes/Target.md')
  const folder = Object.assign(new TFolder(), {
    children: [target],
    path: 'Notes',
  })
  const engine = {
    deleteDocumentsByPaths: jest.fn(async () => false),
    ingestFile: jest.fn(),
  }
  const { internals } = installGraphRuntime(plugin, [target], engine)
  const refreshIngestedFolderPaths = jest.fn(async () => undefined)
  const decorateFileExplorer = jest.fn()
  const updateStatusUI = jest.fn()
  Object.assign(plugin, {
    refreshIngestedFolderPaths,
    decorateFileExplorer,
    updateStatusUI,
  })

  await internals.executeBatchRemoveFolderFromGraph(folder, [target])

  expect(refreshIngestedFolderPaths).not.toHaveBeenCalled()
  expect(decorateFileExplorer).not.toHaveBeenCalled()
  expect(updateStatusUI).not.toHaveBeenCalled()
})

it('keeps a removed document removed after its exclusion is lifted', async () => {
  const { plugin } = createPlugin()
  const target = createGraphFile('Notes/Removed.md')
  const engine = {
    deleteDocumentsByPaths: jest.fn(),
    ingestFile: jest.fn(async () => ({ status: 'processed' as const })),
  }
  const { index, internals } = installGraphRuntime(plugin, [target], engine)
  plugin.settings = {
    ...plugin.settings,
    lightRagExcludePatterns: ['Notes/Removed.md'],
    lightRagSyncFolder: 'Notes',
  }
  index.getStatus.mockReturnValue('removed')
  index.needsIngestion.mockReturnValue(false)
  Object.assign(plugin, {
    setSettings: jest.fn(async (next: NeuralComposerSettings) => {
      plugin.settings = next
    }),
  })

  await internals.removeGraphExcludePatterns(['Notes/Removed.md'])
  internals.queueGraphChange({ path: target.path, remove: false })
  await internals.graphSyncTail
  await internals.runGraphBatch([target], 'new')

  expect(plugin.settings.lightRagExcludePatterns).not.toContain(
    'Notes/Removed.md',
  )
  expect(engine.ingestFile).not.toHaveBeenCalled()
})
