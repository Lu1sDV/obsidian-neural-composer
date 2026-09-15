import { Notice, Platform, requestUrl } from 'obsidian'
import type {
  App,
  PluginManifest,
  RequestUrlResponse,
  RequestUrlResponsePromise,
} from 'obsidian'

import type * as ModelCatalogModule from './core/llm/modelCatalog'
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
  TAbstractFile: class TAbstractFile {},
  TFile: class TFile {},
  TFolder: class TFolder {},
  MarkdownView: class MarkdownView {},
  requestUrl: jest.fn(),
  setTooltip: jest.fn(),
}))
jest.mock('./ApplyView', () => ({ ApplyView: class ApplyView {} }))
jest.mock('./ChatView', () => ({ ChatView: class ChatView {} }))
jest.mock('./components/chat-view/Chat', () => ({}))
jest.mock('./components/modals/ConfirmModal', () => ({
  ConfirmModal: class ConfirmModal {},
}))
jest.mock('./components/modals/GraphDocumentMappingModal', () => ({
  GraphDocumentMappingModal: class GraphDocumentMappingModal {},
}))
jest.mock('./core/llm/modelCatalog', () => ({
  ...jest.requireActual<typeof ModelCatalogModule>('./core/llm/modelCatalog'),
  ModelCatalog: class ModelCatalog {},
}))
jest.mock('./core/mcp/mcpManager', () => ({ McpManager: class McpManager {} }))
jest.mock('./core/rag/docIndexService', () => ({
  DocIndexService: class DocIndexService {},
}))
jest.mock('./core/rag/fileExplorerDecorator', () => ({
  FileExplorerDecorator: class FileExplorerDecorator {},
}))
jest.mock('./core/rag/ragEngine', () => ({ RAGEngine: class RAGEngine {} }))
jest.mock('./database/DatabaseManager', () => ({
  DatabaseManager: class DatabaseManager {},
}))
jest.mock('./database/modules/vector/VectorManager', () => ({
  VectorManager: class VectorManager {},
}))
jest.mock('./settings/SettingTab', () => ({
  NeuralComposerSettingTab: class NeuralComposerSettingTab {},
}))
jest.mock('./utils/obsidian', () => ({}))
jest.mock('./views/NativeGraphView', () => ({
  NATIVE_GRAPH_VIEW_TYPE: 'native-graph',
  NativeGraphView: class NativeGraphView {},
}))

type HealthResult =
  | { kind: 'healthy'; busy: boolean; version?: string; elapsedMs: number }
  | { kind: 'http'; status: number }
  | { kind: 'network' }
  | { kind: 'timeout' }
  | { kind: 'invalid' }
  | { kind: 'stale' }

type HealthInternals = {
  checkLightRagHealth(): Promise<HealthResult>
  pingLightRagServer(): Promise<void>
  checkAndUpdateStatus(): Promise<void>
}

type RegisteredCommand = {
  id: string
  name: string
  callback?: () => void
}

type RequestResponse = RequestUrlResponse

function response(status: number, json: unknown): RequestResponse {
  return { status, json, headers: {}, text: '' } as RequestResponse
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

type NoticeInstance = {
  hide: jest.Mock
  setMessage: jest.Mock<void, [string]>
}

function noticeInstances(): NoticeInstance[] {
  return (Notice as unknown as jest.Mock).mock.results.map(
    ({ value }) => value as NoticeInstance,
  )
}

function noticeMessages(): string[] {
  const noticeMock = Notice as unknown as jest.Mock<NoticeInstance, [string]>
  return noticeInstances().map((notice, index) => {
    const updates = notice.setMessage.mock.calls
    return String(
      updates.length > 0
        ? updates[updates.length - 1][0]
        : noticeMock.mock.calls[index][0],
    )
  })
}

function createPlugin(overrides: Partial<NeuralComposerSettings> = {}) {
  const settings: NeuralComposerSettings = {
    ...DEFAULT_SETTINGS,
    enableAutoStartServer: false,
    lightRagApiKey: 'test-api-key',
    lightRagBackendIdentity: 'backend-a',
    lightRagServerUrl: 'http://127.0.0.1:9621',
    lightRagUseRemote: true,
    lightRagVaultNamespace: 'test-vault',
    ...overrides,
  }
  const updateStatusUI = jest.fn()
  const plugin = new NeuralComposerPlugin({} as App, {} as PluginManifest)
  Object.assign(plugin, {
    settings,
    settingsChangeListeners: [],
    versionChangeListeners: new Set(),
    graphDisposed: false,
    serverProcess: null,
    ingestedFolderPathsLoaded: true,
    lightRagServerChecked: false,
    lightRagServerVersion: null,
    lastServerStatus: 'offline',
    updateStatusUI,
    refreshIngestedFolderPaths: jest.fn(async () => undefined),
    saveData: jest.fn(async () => undefined),
  })
  return {
    internals: plugin as unknown as HealthInternals,
    plugin,
    settings,
    updateStatusUI,
  }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: globalThis,
  })
})

afterAll(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow)
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }
})

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
  jest.setSystemTime(0)
  jest.clearAllMocks()
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.clearAllTimers()
  jest.useRealTimers()
})

describe('LightRAG health command', () => {
  it('registers the manual ping command', async () => {
    jest.replaceProperty(Platform, 'isDesktop', false)
    const { plugin } = createPlugin()
    const commands: RegisteredCommand[] = []
    const statusDot = {
      addClass: jest.fn(),
      removeClass: jest.fn(),
    }
    const statusBar = {
      addClass: jest.fn(),
      createSpan: jest.fn(() => statusDot),
      onclick: null as null | (() => void),
    }
    Object.assign(plugin, {
      app: {
        vault: { on: jest.fn() },
        workspace: {
          on: jest.fn(),
          onLayoutReady: jest.fn(),
        },
      },
      loadSettings: jest.fn(async () => undefined),
      addStatusBarItem: jest.fn(() => statusBar),
      registerView: jest.fn(),
      addRibbonIcon: jest.fn(),
      addCommand: jest.fn((command: RegisteredCommand) => {
        commands.push(command)
        return command
      }),
      registerEvent: jest.fn(),
      addSettingTab: jest.fn(),
      registerInterval: jest.fn(),
    })

    await plugin.onload()

    const command = commands.find(({ id }) => id === 'ping-lightrag-server')
    expect(command).toBeDefined()
    const request = jest
      .mocked(requestUrl)
      .mockResolvedValueOnce(response(200, { status: 'healthy' }))
    command?.callback?.()
    await jest.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('manually probes a local server when auto-start is disabled without starting or restarting it', async () => {
    const request = deferred<RequestResponse>()
    jest
      .mocked(requestUrl)
      .mockReturnValueOnce(request.promise as RequestUrlResponsePromise)
    const { plugin, updateStatusUI } = createPlugin({
      lightRagUseRemote: false,
    })
    const startLightRagServer = jest.fn()
    const restartLightRagServer = jest.fn()
    Object.assign(plugin, { startLightRagServer, restartLightRagServer })

    const ping = plugin.pingLightRagServer()
    expect(requestUrl).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:9621/health',
      method: 'GET',
      headers: { 'X-API-Key': 'test-api-key' },
      throw: false,
    })

    await jest.advanceTimersByTimeAsync(37)
    request.resolve(
      response(200, {
        status: 'healthy',
        pipeline_busy: false,
        core_version: '1.5.7',
      }),
    )
    await ping

    expect(startLightRagServer).not.toHaveBeenCalled()
    expect(restartLightRagServer).not.toHaveBeenCalled()
    expect(updateStatusUI).toHaveBeenCalledWith('online')
    expect(plugin.lightRagServerVersion).toBe('1.5.7')
    expect(noticeMessages()).toHaveLength(1)
    expect(noticeMessages()[0]).toMatch(/LightRAG/i)
    expect(noticeMessages()[0]).toMatch(/healthy|online/i)
    expect(noticeMessages()[0]).toContain('1.5.7')
    expect(noticeMessages()[0]).toMatch(/37\s*ms/i)
    expect(noticeMessages()[0]).not.toContain('test-api-key')
  })

  it('reports a busy healthy server and shares one pending request with background status', async () => {
    const request = deferred<RequestResponse>()
    jest
      .mocked(requestUrl)
      .mockReturnValueOnce(request.promise as RequestUrlResponsePromise)
    const { internals, updateStatusUI } = createPlugin()

    const health = internals.checkLightRagHealth()
    const status = internals.checkAndUpdateStatus()
    const ping = internals.pingLightRagServer()

    expect(requestUrl).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(12)
    request.resolve(
      response(200, {
        status: 'healthy',
        pipeline_busy: true,
        api_version: '1.5.6',
      }),
    )

    await expect(health).resolves.toEqual({
      kind: 'healthy',
      busy: true,
      version: '1.5.6',
      elapsedMs: 12,
    })
    await status
    await ping

    expect(updateStatusUI).toHaveBeenCalledWith('busy')
    expect(noticeMessages()).toHaveLength(1)
    expect(noticeMessages()[0]).toMatch(/busy|processing/i)
    expect(noticeMessages()[0]).toContain('1.5.6')
  })

  it.each([401, 403])(
    'classifies HTTP %i as an authentication failure without exposing response data',
    async (status) => {
      const rawSecret = 'raw-private-health-response'
      jest
        .mocked(requestUrl)
        .mockResolvedValueOnce(response(status, { detail: rawSecret }))
        .mockResolvedValueOnce(response(status, { detail: rawSecret }))
      const { internals, updateStatusUI } = createPlugin()

      await expect(internals.checkLightRagHealth()).resolves.toEqual({
        kind: 'http',
        status,
      })
      await internals.pingLightRagServer()

      expect(updateStatusUI).toHaveBeenCalledWith('offline')
      expect(noticeMessages()).toHaveLength(1)
      expect(noticeMessages()[0]).toMatch(new RegExp(`HTTP ${status}`))
      expect(noticeMessages()[0]).toMatch(/API key|auth/i)
      expect(noticeMessages()[0]).not.toContain(rawSecret)
      expect(noticeMessages()[0]).not.toContain('test-api-key')
    },
  )

  it('classifies a rejected request as a network failure without exposing the error', async () => {
    const rawSecret = 'https://private-host.invalid/?token=secret'
    jest
      .mocked(requestUrl)
      .mockRejectedValueOnce(new Error(rawSecret))
      .mockRejectedValueOnce(new Error(rawSecret))
    const { internals, updateStatusUI } = createPlugin()

    await expect(internals.checkLightRagHealth()).resolves.toEqual({
      kind: 'network',
    })
    await internals.pingLightRagServer()

    expect(updateStatusUI).toHaveBeenCalledWith('offline')
    expect(noticeMessages()).toHaveLength(1)
    expect(noticeMessages()[0]).toMatch(/could not reach|network|unreachable/i)
    expect(noticeMessages()[0]).not.toContain(rawSecret)
  })

  it('rejects a malformed successful health response without exposing its body', async () => {
    const rawSecret = 'raw-private-health-body'
    jest
      .mocked(requestUrl)
      .mockResolvedValueOnce(response(200, rawSecret))
      .mockResolvedValueOnce(response(200, rawSecret))
    const { internals, updateStatusUI } = createPlugin()

    await expect(internals.checkLightRagHealth()).resolves.toEqual({
      kind: 'invalid',
    })
    await internals.pingLightRagServer()

    expect(updateStatusUI).toHaveBeenCalledWith('offline')
    expect(noticeMessages()).toHaveLength(1)
    expect(noticeMessages()[0]).toMatch(/invalid|malformed|unexpected/i)
    expect(noticeMessages()[0]).not.toContain(rawSecret)
  })

  it('times out at five seconds, permits a retry, and ignores the late response', async () => {
    const lateRequest = deferred<RequestResponse>()
    jest
      .mocked(requestUrl)
      .mockReturnValueOnce(lateRequest.promise as RequestUrlResponsePromise)
      .mockResolvedValueOnce(
        response(200, {
          status: 'healthy',
          pipeline_busy: false,
          core_version: 'retry-version',
        }),
      )
    const { internals, plugin, updateStatusUI } = createPlugin()

    const health = internals.checkLightRagHealth()
    const status = internals.checkAndUpdateStatus()
    expect(requestUrl).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(4999)
    expect(updateStatusUI).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)

    await expect(health).resolves.toEqual({ kind: 'timeout' })
    await status
    expect(updateStatusUI).toHaveBeenCalledTimes(1)
    expect(updateStatusUI).toHaveBeenCalledWith('offline')
    expect(plugin.lightRagServerVersion).toBeNull()

    await expect(internals.checkLightRagHealth()).resolves.toEqual({
      kind: 'healthy',
      busy: false,
      version: 'retry-version',
      elapsedMs: 0,
    })
    expect(requestUrl).toHaveBeenCalledTimes(2)

    lateRequest.resolve(
      response(200, {
        status: 'healthy',
        pipeline_busy: true,
        core_version: 'late-version',
      }),
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(updateStatusUI).toHaveBeenCalledTimes(1)
    expect(updateStatusUI).not.toHaveBeenCalledWith('busy')
    expect(plugin.lightRagServerVersion).toBeNull()
  })

  it('marks a pending shared result stale when backend settings change', async () => {
    const request = deferred<RequestResponse>()
    jest
      .mocked(requestUrl)
      .mockReturnValueOnce(request.promise as RequestUrlResponsePromise)
    const { internals, plugin, settings, updateStatusUI } = createPlugin()

    const health = internals.checkLightRagHealth()
    const status = internals.checkAndUpdateStatus()
    const ping = internals.pingLightRagServer()
    expect(requestUrl).toHaveBeenCalledTimes(1)

    await plugin.setSettings({
      ...settings,
      lightRagServerUrl: 'http://127.0.0.1:9721',
    })
    updateStatusUI.mockClear()
    expect(Notice).toHaveBeenCalledTimes(1)
    request.resolve(
      response(200, {
        status: 'healthy',
        pipeline_busy: false,
        core_version: 'old-backend-version',
      }),
    )

    await expect(health).resolves.toEqual({ kind: 'stale' })
    await status
    await ping

    expect(updateStatusUI).not.toHaveBeenCalled()
    expect(plugin.lightRagServerVersion).toBeNull()
    expect(noticeMessages()).toHaveLength(1)
    expect(noticeMessages()[0]).toMatch(/changed|retry|again/i)
    expect(noticeMessages()[0]).not.toContain('test-api-key')
  })

  it('marks a pending result stale on unload without updating UI or showing a late notice', async () => {
    const request = deferred<RequestResponse>()
    jest
      .mocked(requestUrl)
      .mockReturnValueOnce(request.promise as RequestUrlResponsePromise)
    const { internals, plugin, updateStatusUI } = createPlugin()

    const health = internals.checkLightRagHealth()
    const ping = internals.pingLightRagServer()
    const [notice] = noticeInstances()
    expect(notice).toBeDefined()
    expect(requestUrl).toHaveBeenCalledTimes(1)

    plugin.onunload()
    updateStatusUI.mockClear()
    expect(Notice).toHaveBeenCalledTimes(1)
    request.resolve(
      response(200, {
        status: 'healthy',
        pipeline_busy: false,
        core_version: 'late-version',
      }),
    )

    await expect(health).resolves.toEqual({ kind: 'stale' })
    await ping

    expect(updateStatusUI).not.toHaveBeenCalled()
    expect(plugin.lightRagServerVersion).toBeNull()
    expect(Notice).toHaveBeenCalledTimes(1)
    expect(notice.setMessage).not.toHaveBeenCalled()
    expect(notice.hide).toHaveBeenCalled()
  })
})
