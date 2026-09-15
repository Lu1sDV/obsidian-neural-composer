import Graph from 'graphology'
import FA2Layout from 'graphology-layout-forceatlas2/worker'
import { Platform, requestUrl } from 'obsidian'
import Sigma from 'sigma'

import { NativeGraphView } from './NativeGraphView'

jest.mock('graphology', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('graphology-layout-forceatlas2', () => ({
  __esModule: true,
  default: { inferSettings: jest.fn() },
}))
jest.mock('graphology-layout-forceatlas2/worker', () => ({
  __esModule: true,
  default: jest.fn(),
}))
jest.mock('sigma', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('obsidian', () => ({
  App: class {},
  ButtonComponent: class {},
  ItemView: class {
    async onOpen() {}
  },
  Modal: class {},
  Notice: jest.fn(),
  Platform: { isDesktop: true, isPhone: false, isTablet: false },
  TextAreaComponent: class {},
  TextComponent: class {},
  WorkspaceLeaf: class {},
  requestUrl: jest.fn(),
  setIcon: jest.fn(),
  setTooltip: jest.fn(),
}))

type TestSettings = {
  graphViewMode: '2d' | '3d'
  lightRagApiKey: string
  lightRagBackendIdentity: string
  lightRagServerUrl: string
  lightRagUseRemote: boolean
  lightRagWorkDir: string
}

type SettingsListener = (newSettings: TestSettings) => void

type TestPlugin = {
  settings: TestSettings
  _nodeFs: {
    existsSync: jest.Mock<boolean, [string]>
    readFileSync: jest.Mock<string, [string, string]>
  }
  _nodePath: {
    join: (...parts: string[]) => string
  }
  addSettingsChangeListener: jest.Mock<() => void, [SettingsListener]>
  emitSettings: (settings: Partial<TestSettings>) => void
  settingsListenerCount: () => number
}

type GraphResponseFixture = {
  status: number
  json: {
    nodes: Array<{
      id: string
      labels: string[]
      properties: Record<string, unknown>
    }>
    edges: Array<{ source: string; target: string }>
  }
}

type GraphDataFixture = {
  nodes: Array<{
    id: string
    type: string
    desc: string
    source_id: string
    val: number
    file_paths: string[]
  }>
  edges: Array<{
    source: string
    target: string
    normalizedSource: string
    normalizedTarget: string
  }>
}

const makePlugin = (
  files: Record<string, string>,
  settings: Partial<TestPlugin['settings']> = {},
): TestPlugin => {
  const listeners = new Set<SettingsListener>()
  const plugin: TestPlugin = {
    settings: {
      graphViewMode: '2d',
      lightRagApiKey: '',
      lightRagBackendIdentity: 'backend-a',
      lightRagServerUrl: 'http://localhost:9621',
      lightRagUseRemote: false,
      lightRagWorkDir: '/backend-a',
      ...settings,
    },
    _nodeFs: {
      existsSync: jest.fn((path) => files[path] !== undefined),
      readFileSync: jest.fn((path: string, _encoding: string) => {
        const contents = files[path]
        if (contents === undefined) throw new Error(`Missing fixture: ${path}`)
        return contents
      }),
    },
    _nodePath: {
      join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
    },
    addSettingsChangeListener: jest.fn((listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
    emitSettings(nextSettings) {
      Object.assign(plugin.settings, nextSettings)
      listeners.forEach((listener) => listener(plugin.settings))
    },
    settingsListenerCount: () => listeners.size,
  }
  return plugin
}

const makeView = (
  plugin: TestPlugin,
  maps: {
    chunkToDocMap?: Record<string, Record<string, unknown>>
    docToNameMap?: Record<string, Record<string, unknown>>
  } = {},
): NativeGraphView => {
  const view = new NativeGraphView({} as never, plugin as never)
  return Object.assign(view, {
    chunkToDocMap: maps.chunkToDocMap ?? {},
    docToNameMap: maps.docToNameMap ?? {},
  })
}

const graphResponse = (
  properties: Record<string, unknown>,
): GraphResponseFixture => ({
  status: 200,
  json: {
    nodes: [{ id: 'Entity', labels: ['CONCEPT'], properties }],
    edges: [],
  },
})

const graphData = (id: string, filePaths: string[] = []): GraphDataFixture => ({
  nodes: [
    {
      id,
      type: 'CONCEPT',
      desc: '',
      source_id: '',
      val: 1,
      file_paths: filePaths,
    },
  ],
  edges: [],
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const makeRenderContainer = () => {
  const container = {
    empty: jest.fn(),
    createDiv: jest.fn(() => {
      const element = {
        setText: jest.fn(),
        remove: jest.fn(),
      }
      element.setText.mockReturnValue(element)
      return element
    }),
  }
  return container as unknown as HTMLElement
}

const mutablePlatform = Platform as { isDesktop: boolean }

describe('NativeGraphView source provenance', () => {
  const requestUrlMock = jest.mocked(requestUrl)

  beforeEach(() => {
    jest.clearAllMocks()
    mutablePlatform.isDesktop = true
  })

  afterEach(() => {
    mutablePlatform.isDesktop = true
  })

  it('retires local source maps when backend identity and key rotate at the same URL and workdir', () => {
    const plugin = makePlugin(
      {
        '/backend-a/kv_store_text_chunks.json': JSON.stringify({
          'chunk-a': { full_doc_id: 'doc-a' },
        }),
        '/backend-a/kv_store_doc_status.json': JSON.stringify({
          'Folder/A.md': { id: 'doc-a' },
        }),
      },
      { lightRagApiKey: 'key-a' },
    )
    const view = makeView(plugin)

    view.loadReferenceMaps()
    expect(view.getFilenames('chunk-a')).toEqual(['Folder/A.md'])

    Object.assign(plugin.settings, {
      lightRagApiKey: 'key-b',
      lightRagBackendIdentity: 'backend-b',
    })

    expect(plugin.settings.lightRagServerUrl).toBe('http://localhost:9621')
    expect(plugin.settings.lightRagWorkDir).toBe('/backend-a')
    expect(view.getFilenames('chunk-a')).toEqual([])
  })

  it('rejects a delayed graph response after backend identity and key drift', async () => {
    const plugin = makePlugin(
      {},
      {
        lightRagApiKey: 'key-a',
        lightRagUseRemote: true,
      },
    )
    const view = makeView(plugin)
    const response = deferred<GraphResponseFixture>()
    requestUrlMock.mockImplementationOnce(() => response.promise as never)

    const graphPromise = view.fetchGraphData('Entity')
    expect(requestUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { 'X-API-Key': 'key-a' },
        url: expect.stringContaining(
          'http://localhost:9621/graphs?',
        ) as unknown,
      }),
    )

    Object.assign(plugin.settings, {
      lightRagApiKey: 'key-b',
      lightRagBackendIdentity: 'backend-b',
    })
    response.resolve(graphResponse({ file_path: 'Backend A/Private.md' }))

    await expect(graphPromise).resolves.toBeNull()
  })

  it('prevents an older overlapping render from replacing the newer result', async () => {
    const plugin = makePlugin({}, { lightRagUseRemote: true })
    const view = makeView(plugin)
    const first = deferred<GraphDataFixture>()
    const second = deferred<GraphDataFixture>()
    const fetchGraphData = jest
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const render2D = jest.fn<void, [HTMLElement, GraphDataFixture['nodes']]>()
    const container = makeRenderContainer()
    Object.assign(view, {
      currentRootLabel: 'Entity',
      fetchGraphData,
      render2D,
      updateSidebarList: jest.fn(),
    })

    const firstRender = view.render(container)
    const secondRender = view.render(container)
    second.resolve(graphData('New'))
    await secondRender
    first.resolve(graphData('Old'))
    await firstRender

    expect(render2D).toHaveBeenCalledTimes(1)
    expect(render2D.mock.calls[0][1]).toEqual([
      expect.objectContaining({ id: 'New' }),
    ])
    const viewState = view as unknown as {
      allNodes: Array<{ id: string }>
    }
    expect(viewState.allNodes).toEqual([expect.objectContaining({ id: 'New' })])
  })

  it('invalidates an open view on ownership changes and disposes its settings listener', async () => {
    const plugin = makePlugin(
      {
        '/backend-a/kv_store_text_chunks.json': JSON.stringify({
          'chunk-a': { full_doc_id: 'doc-a' },
        }),
        '/backend-a/kv_store_doc_status.json': JSON.stringify({
          'Folder/A.md': { id: 'doc-a' },
        }),
      },
      { lightRagApiKey: 'key-a' },
    )
    const view = makeView(plugin)
    const graphContainer = { id: '', empty: jest.fn() }
    const graphZone = { createDiv: jest.fn(() => graphContainer) }
    const contentEl = {
      empty: jest.fn(),
      addClass: jest.fn(),
      createDiv: jest
        .fn()
        .mockReturnValueOnce(graphZone)
        .mockReturnValueOnce({}),
    }
    const detailsPanel = {
      empty: jest.fn(),
      removeClass: jest.fn(),
    }
    const render = jest.fn().mockResolvedValue(undefined)
    Object.assign(view, {
      contentEl,
      createGraphToolbar: jest.fn(),
      createDetailsPanel: jest.fn(),
      buildSidebar: jest.fn(),
      installKeyboardCanvasGuard: jest.fn(),
      render,
      detailsPanel,
    })

    await view.onOpen()

    expect(plugin.settingsListenerCount()).toBe(1)
    expect(view.getFilenames('chunk-a')).toEqual(['Folder/A.md'])
    const priorRenderCalls = render.mock.calls.length
    const priorGraphClears = graphContainer.empty.mock.calls.length

    plugin.emitSettings({
      lightRagApiKey: 'key-b',
      lightRagBackendIdentity: 'backend-b',
    })

    expect(view.getFilenames('chunk-a')).toEqual([])
    expect(
      render.mock.calls.length > priorRenderCalls ||
        graphContainer.empty.mock.calls.length > priorGraphClears,
    ).toBe(true)
    expect(
      detailsPanel.empty.mock.calls.length +
        detailsPanel.removeClass.mock.calls.length,
    ).toBeGreaterThan(0)

    await view.onClose()
    expect(plugin.settingsListenerCount()).toBe(0)
  })

  it('does not read or use local reference maps on a non-desktop local backend', async () => {
    mutablePlatform.isDesktop = false
    const plugin = makePlugin({
      '/backend-a/kv_store_text_chunks.json': JSON.stringify({
        'chunk-a': { full_doc_id: 'doc-a' },
      }),
      '/backend-a/kv_store_doc_status.json': JSON.stringify({
        'Folder/A.md': { id: 'doc-a' },
      }),
    })
    const view = makeView(plugin, {
      chunkToDocMap: { 'chunk-a': { full_doc_id: 'doc-a' } },
      docToNameMap: { 'doc-a': { file_path: 'Folder/A.md' } },
    })

    view.loadReferenceMaps()

    expect(plugin._nodeFs.existsSync).not.toHaveBeenCalled()
    expect(plugin._nodeFs.readFileSync).not.toHaveBeenCalled()

    requestUrlMock.mockResolvedValueOnce(
      graphResponse({ source_id: 'chunk-a' }) as never,
    )
    const graph = await view.fetchGraphData('Entity')

    expect(graph?.nodes[0].file_paths).toEqual([])
  })

  it('retains local source mappings across repeated same-scope renders', async () => {
    const plugin = makePlugin({
      '/backend-a/kv_store_text_chunks.json': JSON.stringify({
        'chunk-a': { full_doc_id: 'doc-a' },
      }),
      '/backend-a/kv_store_doc_status.json': JSON.stringify({
        'Folder/A.md': { id: 'doc-a' },
      }),
    })
    const view = makeView(plugin)
    const render2D = jest.fn<void, [HTMLElement, GraphDataFixture['nodes']]>()
    const container = makeRenderContainer()
    Object.assign(view, {
      currentRootLabel: 'Entity',
      render2D,
      updateSidebarList: jest.fn(),
    })
    requestUrlMock
      .mockResolvedValueOnce(graphResponse({ source_id: 'chunk-a' }) as never)
      .mockResolvedValueOnce(graphResponse({ source_id: 'chunk-a' }) as never)

    view.loadReferenceMaps()
    await view.render(container)
    await view.render(container)

    expect(render2D).toHaveBeenCalledTimes(2)
    expect(render2D.mock.calls[0][1][0].file_paths).toEqual(['Folder/A.md'])
    expect(render2D.mock.calls[1][1][0].file_paths).toEqual(['Folder/A.md'])
    expect(plugin._nodeFs.readFileSync).toHaveBeenCalledTimes(2)
  })

  it('does not load or use local reference maps for a desktop remote backend', async () => {
    const plugin = makePlugin(
      {
        '/local/kv_store_text_chunks.json': JSON.stringify({
          'shared-chunk': { full_doc_id: 'local-doc' },
        }),
        '/local/kv_store_doc_status.json': JSON.stringify({
          'Local/Private.md': { id: 'local-doc' },
        }),
      },
      { lightRagUseRemote: true, lightRagWorkDir: '/local' },
    )
    const view = makeView(plugin, {
      chunkToDocMap: {
        'shared-chunk': { full_doc_id: 'local-doc' },
      },
      docToNameMap: {
        'local-doc': { file_path: 'Local/Private.md' },
      },
    })

    view.loadReferenceMaps()

    expect(plugin._nodeFs.existsSync).not.toHaveBeenCalled()
    expect(plugin._nodeFs.readFileSync).not.toHaveBeenCalled()

    requestUrlMock.mockResolvedValueOnce(
      graphResponse({ source_id: 'shared-chunk' }) as never,
    )

    const graph = await view.fetchGraphData('Entity')

    expect(graph?.nodes[0].file_paths).toEqual([])
  })

  it('retires local source maps when the workdir changes to missing mapping files', () => {
    const plugin = makePlugin({
      '/backend-a/kv_store_text_chunks.json': JSON.stringify({
        'chunk-a': { full_doc_id: 'doc-a' },
      }),
      '/backend-a/kv_store_doc_status.json': JSON.stringify({
        'Folder/A.md': { id: 'doc-a' },
      }),
    })
    const view = makeView(plugin)

    view.loadReferenceMaps()
    expect(view.getFilenames('chunk-a')).toEqual(['Folder/A.md'])

    plugin.settings.lightRagServerUrl = 'http://localhost:19621'
    expect(view.getFilenames('chunk-a')).toEqual([])
    plugin.settings.lightRagServerUrl = 'http://localhost:9621'
    expect(view.getFilenames('chunk-a')).toEqual([])

    view.loadReferenceMaps()
    expect(view.getFilenames('chunk-a')).toEqual(['Folder/A.md'])

    plugin.settings.lightRagWorkDir = '/backend-b'
    expect(view.getFilenames('chunk-a')).toEqual([])
    plugin._nodeFs.existsSync.mockClear()
    view.loadReferenceMaps()

    expect(plugin._nodeFs.existsSync).toHaveBeenCalledWith(
      '/backend-b/kv_store_text_chunks.json',
    )
    expect(plugin._nodeFs.existsSync).toHaveBeenCalledWith(
      '/backend-b/kv_store_doc_status.json',
    )
    expect(view.getFilenames('chunk-a')).toEqual([])
  })

  it('clears local source provenance when the view is cleaned up', () => {
    const plugin = makePlugin({
      '/backend-a/kv_store_text_chunks.json': JSON.stringify({
        'chunk-a': { full_doc_id: 'doc-a' },
      }),
      '/backend-a/kv_store_doc_status.json': JSON.stringify({
        'Folder/A.md': { id: 'doc-a' },
      }),
    })
    const view = makeView(plugin)

    view.loadReferenceMaps()
    expect(view.getFilenames('chunk-a')).toEqual(['Folder/A.md'])

    view.cleanup()

    expect(view.getFilenames('chunk-a')).toEqual([])
  })

  it('preserves API source identities literally while splitting only documented separators', async () => {
    const plugin = makePlugin({}, { lightRagUseRemote: true })
    const view = makeView(plugin)
    const hashedSource = `nc-${'a'.repeat(64)}.md`
    const sources = [
      '[Drafts]/Overview].md',
      `"Quoted"/Research's [notes].md`,
      hashedSource,
      'Overview.md',
    ]
    requestUrlMock.mockResolvedValueOnce(
      graphResponse({
        file_path: sources.join('<SEP>'),
        source_id: 'must-not-be-guessed',
      }) as never,
    )

    const graph = await view.fetchGraphData('Entity')

    expect(graph?.nodes[0].file_paths).toEqual(sources)
  })
})

describe('NativeGraphView renderer ownership', () => {
  let windowDescriptor: PropertyDescriptor | undefined
  let activeDocumentDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
    activeDocumentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'activeDocument',
    )
    Object.defineProperty(globalThis, 'activeDocument', {
      configurable: true,
      value: {
        body: {
          classList: { contains: jest.fn(() => false) },
        },
      },
    })
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    if (windowDescriptor) {
      Object.defineProperty(globalThis, 'window', windowDescriptor)
    } else {
      Reflect.deleteProperty(globalThis, 'window')
    }
    if (activeDocumentDescriptor) {
      Object.defineProperty(
        globalThis,
        'activeDocument',
        activeDocumentDescriptor,
      )
    } else {
      Reflect.deleteProperty(globalThis, 'activeDocument')
    }
  })

  const makeLayout = () => {
    let running = false
    return {
      isRunning: jest.fn(() => running),
      start: jest.fn(() => {
        running = true
      }),
      stop: jest.fn(() => {
        running = false
      }),
    }
  }

  const install2DRendererMocks = () => {
    const graph = { forEachNode: jest.fn() }
    const sigma = { kill: jest.fn(), on: jest.fn() }
    jest.mocked(Graph).mockImplementation(() => graph as never)
    jest.mocked(Sigma).mockImplementation(() => sigma as never)
    return { sigma }
  }

  it("does not let an older render's layout deadline stop the current layout", () => {
    const plugin = makePlugin({})
    const view = makeView(plugin)
    const layoutA = makeLayout()
    const layoutB = makeLayout()
    const { sigma } = install2DRendererMocks()
    jest
      .mocked(FA2Layout as unknown as jest.Mock<typeof layoutA, unknown[]>)
      .mockImplementationOnce(() => layoutA as never)
      .mockImplementationOnce(() => layoutB as never)
    const requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        requestAnimationFrame,
        setTimeout: globalThis.setTimeout,
      },
    })
    const container = {
      clientHeight: 100,
      clientWidth: 100,
      setCssStyles: jest.fn(),
    } as unknown as HTMLElement

    view.render2D(container, [], [])
    expect(layoutA.start).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(1000)
    view.cleanup()
    expect(layoutA.stop).toHaveBeenCalledTimes(1)
    expect(sigma.kill).toHaveBeenCalledTimes(1)

    view.render2D(container, [], [])
    expect(layoutB.start).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(3000)
    expect(layoutB.stop).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1000)
    expect(layoutB.stop).toHaveBeenCalledTimes(1)
  })

  it('abandons a deferred 2D initialization after its render is disposed', () => {
    const plugin = makePlugin({})
    const view = makeView(plugin)
    install2DRendererMocks()
    const callbacks: FrameRequestCallback[] = []
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        requestAnimationFrame: jest.fn((callback: FrameRequestCallback) => {
          callbacks.push(callback)
          return callbacks.length
        }),
        setTimeout: globalThis.setTimeout,
      },
    })
    const container = {
      clientHeight: 100,
      clientWidth: 0,
      setCssStyles: jest.fn(),
    }

    view.render2D(container as unknown as HTMLElement, [], [])
    callbacks.shift()?.(0)
    expect(callbacks).toHaveLength(1)

    view.cleanup()
    container.clientWidth = 100
    callbacks.shift()?.(0)

    expect(Sigma).not.toHaveBeenCalled()
    expect(FA2Layout).not.toHaveBeenCalled()
  })
})
