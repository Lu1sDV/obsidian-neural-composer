import { obsidianRequestUrlFetch } from '../../utils/fetch-utils'

import { ModelCatalog, ModelDiscovery } from './modelCatalog'

jest.mock('../../utils/fetch-utils', () => ({
  obsidianRequestUrlFetch: jest.fn(),
}))

const fetchModels = jest.mocked(obsidianRequestUrlFetch)
const DAY = 24 * 60 * 60 * 1000
const COOLDOWN = 15 * 60 * 1000

type Provider = {
  id: string
  type: string
  apiKey?: string
  baseUrl?: string
  modelDiscovery?: ModelDiscovery
}

type Settings = {
  providers: Provider[]
  chatModels: unknown[]
  other: string
}

type TestHost = {
  settings: Settings
  setSettings(settings: Settings): Promise<void>
  addSettingsChangeListener(listener: () => void): () => void
}

function host(
  providers: Provider[] = [
    {
      id: 'custom',
      type: 'openai-compatible',
      baseUrl: 'https://models.example/v1',
      apiKey: 'secret-one',
    },
  ],
): TestHost {
  const listeners = new Set<() => void>()
  return {
    settings: {
      providers,
      chatModels: ['configured-model'],
      other: 'original',
    } as Settings,
    async setSettings(this: TestHost, settings: Settings) {
      this.settings = settings
      listeners.forEach((listener) => listener())
    },
    addSettingsChangeListener(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function response(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers })
}

function listed(...ids: string[]) {
  return response({ data: ids.map((id) => ({ id })) })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function changeProvider(plugin: TestHost, changes: Partial<Provider>) {
  await plugin.setSettings({
    ...plugin.settings,
    providers: plugin.settings.providers.map((provider) => ({
      ...provider,
      ...changes,
    })),
  })
}

function pendingFetch(response: Promise<Response>) {
  const started = deferred<void>()
  fetchModels.mockImplementationOnce(() => {
    started.resolve()
    return response
  })
  return started.promise
}

describe('ModelCatalog', () => {
  let now: number
  const catalogs: ModelCatalog[] = []
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')

  function catalog(plugin: TestHost) {
    const instance = new ModelCatalog(plugin)
    catalogs.push(instance)
    return instance
  }

  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', {
      value: jest.requireActual<{ webcrypto: Crypto }>('crypto').webcrypto,
      configurable: true,
    })
  })

  afterAll(() => {
    if (originalCrypto)
      Object.defineProperty(globalThis, 'crypto', originalCrypto)
    else Reflect.deleteProperty(globalThis, 'crypto')
  })

  beforeEach(() => {
    now = Date.UTC(2026, 8, 13)
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    fetchModels.mockReset()
  })

  afterEach(() => {
    catalogs.splice(0).forEach((instance) => instance.dispose())
    jest.restoreAllMocks()
  })

  test('successful discovery adds every new model to the configured model list', async () => {
    const plugin = host([
      {
        id: 'zai',
        type: 'openai-compatible',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        apiKey: 'key',
      },
    ])
    plugin.settings.chatModels = [
      {
        id: 'existing',
        providerId: 'zai',
        providerType: 'openai-compatible',
        model: 'glm-existing',
      },
      {
        id: 'zai/glm-new',
        providerId: 'other',
        providerType: 'openai',
        model: 'different',
      },
    ]
    fetchModels.mockResolvedValue(listed('glm-existing', 'glm-new', 'glm-next'))

    await catalog(plugin).refresh('zai')

    expect(plugin.settings.chatModels).toEqual([
      {
        id: 'existing',
        providerId: 'zai',
        providerType: 'openai-compatible',
        model: 'glm-existing',
      },
      {
        id: 'zai/glm-new',
        providerId: 'other',
        providerType: 'openai',
        model: 'different',
      },
      {
        id: 'zai/glm-new-2',
        providerId: 'zai',
        providerType: 'openai-compatible',
        model: 'glm-new',
        enable: true,
      },
      {
        id: 'zai/glm-next',
        providerId: 'zai',
        providerType: 'openai-compatible',
        model: 'glm-next',
        enable: true,
      },
    ])
  })

  test('fresh persisted catalogs populate missing configured models without another request', async () => {
    const plugin = host()
    fetchModels.mockResolvedValue(listed('cached-model'))
    const first = catalog(plugin)
    await first.refresh('custom')
    plugin.settings.chatModels = []
    first.dispose()

    await catalog(plugin).refresh('custom')

    expect(fetchModels).toHaveBeenCalledTimes(1)
    expect(plugin.settings.chatModels).toEqual([
      {
        id: 'custom/cached-model',
        providerId: 'custom',
        providerType: 'openai-compatible',
        model: 'cached-model',
        enable: true,
      },
    ])
  })
  test('authenticated 404 remains unsupported through restart, expiry, force refresh, and changed keys', async () => {
    const plugin = host()
    const first = catalog(plugin)
    fetchModels.mockResolvedValue(response({}, 404))
    await first.refresh('custom')
    expect(first.get('custom').status).toBe('unsupported')
    expect(plugin.settings.chatModels).toEqual(['configured-model'])
    first.dispose()

    plugin.settings = JSON.parse(JSON.stringify(plugin.settings)) as Settings
    const restarted = catalog(plugin)
    now += 365 * DAY
    await restarted.refresh('custom')
    await restarted.refresh('custom', true)
    await changeProvider(plugin, { apiKey: 'secret-two' })
    await restarted.refresh('custom', true)
    expect(restarted.get('custom').status).toBe('unsupported')
    expect(fetchModels).toHaveBeenCalledTimes(1)
    expect(
      JSON.stringify(plugin.settings.providers[0].modelDiscovery),
    ).not.toContain('secret-')
  })

  test('Reset clears persisted unsupported state and explicitly fetches', async () => {
    const plugin = host()
    const service = catalog(plugin)
    fetchModels
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(listed('recovered'))
    await service.refresh('custom')
    await service.reset('custom')
    expect(service.get('custom')).toMatchObject({
      status: 'ready',
      models: [{ id: 'recovered' }],
    })
    expect(plugin.settings.providers[0].modelDiscovery?.status).toBe('ready')
    expect(fetchModels).toHaveBeenCalledTimes(2)
  })

  test('changing endpoint or native protocol permits discovery after unsupported', async () => {
    const plugin = host()
    const service = catalog(plugin)
    fetchModels
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response({}, 404))
    await service.refresh('custom')
    await changeProvider(plugin, { baseUrl: 'https://other.example/v1' })
    await service.refresh('custom')
    expect(fetchModels).toHaveBeenCalledTimes(2)
    fetchModels.mockResolvedValueOnce(
      response({
        data: [{ id: 'claude', display_name: 'Claude' }],
        has_more: false,
      }),
    )
    await changeProvider(plugin, {
      type: 'anthropic',
      baseUrl: 'https://other.example',
    })
    await service.refresh('custom')
    expect(service.get('custom').models).toEqual([
      { id: 'claude', name: 'Claude' },
    ])
    expect(fetchModels.mock.calls[2][0].toString()).toBe(
      'https://other.example/v1/models?limit=1000',
    )
  })

  test('success survives restart until 24-hour expiry, with no constructor fetch or polling', async () => {
    const plugin = host()
    const service = catalog(plugin)
    expect(fetchModels).not.toHaveBeenCalled()
    fetchModels
      .mockResolvedValueOnce(listed('old'))
      .mockResolvedValueOnce(listed('new'))
    await service.refresh('custom')
    service.dispose()
    const restarted = catalog(plugin)
    now += DAY - 1
    await restarted.refresh('custom')
    expect(restarted.get('custom').models).toEqual([{ id: 'old' }])
    expect(fetchModels).toHaveBeenCalledTimes(1)
    now++
    expect(restarted.get('custom').status).toBe('stale')
    expect(fetchModels).toHaveBeenCalledTimes(1)
    await restarted.refresh('custom')
    expect(restarted.get('custom').models).toEqual([{ id: 'new' }])
  })

  test('changed credentials invalidate successful cache, including changes made before restart', async () => {
    const plugin = host()
    const service = catalog(plugin)
    fetchModels
      .mockResolvedValueOnce(listed('old'))
      .mockResolvedValueOnce(listed('new'))
    await service.refresh('custom')
    service.dispose()
    plugin.settings.providers[0].apiKey = 'secret-two'
    const restarted = catalog(plugin)
    await restarted.refresh('custom')
    expect(restarted.get('custom').models).toEqual([{ id: 'new' }])
    expect(
      JSON.stringify(plugin.settings.providers[0].modelDiscovery),
    ).not.toContain('secret-')
    expect(fetchModels).toHaveBeenCalledTimes(2)
  })

  test('coalesces concurrent callers and merges into the latest settings without replacing configured models', async () => {
    const plugin = host()
    const service = catalog(plugin)
    const pending = deferred<Response>()
    const started = pendingFetch(pending.promise)
    const first = service.refresh('custom')
    const second = service.refresh('custom', true)
    await started
    expect(service.get('custom').status).toBe('loading')
    await plugin.setSettings({
      ...plugin.settings,
      chatModels: ['newly-configured'],
      other: 'edited',
    })
    pending.resolve(listed('discovered'))
    await Promise.all([first, second])
    expect(fetchModels).toHaveBeenCalledTimes(1)
    expect(plugin.settings).toMatchObject({
      chatModels: [
        'newly-configured',
        {
          id: 'custom/discovered',
          providerId: 'custom',
          providerType: 'openai-compatible',
          model: 'discovered',
          enable: true,
        },
      ],
      other: 'edited',
    })
  })

  test('ignores late responses after saved key changes without suppressing the new request', async () => {
    const plugin = host()
    const service = catalog(plugin)
    const old = deferred<Response>()
    const started = pendingFetch(old.promise)
    fetchModels.mockResolvedValueOnce(listed('new-key-model'))
    const first = service.refresh('custom')
    await started
    await changeProvider(plugin, { apiKey: 'secret-two' })
    await service.refresh('custom')
    old.resolve(response({}, 404))
    await first
    expect(service.get('custom')).toMatchObject({
      status: 'ready',
      models: [{ id: 'new-key-model' }],
    })
    expect(plugin.settings.providers[0].modelDiscovery?.status).toBe('ready')
  })

  test('a removed provider or disposed service cannot publish or persist a late response', async () => {
    const plugin = host()
    const service = catalog(plugin)
    const pending = deferred<Response>()
    const notify = jest.fn()
    service.subscribe(notify)
    const started = pendingFetch(pending.promise)
    const work = service.refresh('custom')
    await started
    await plugin.setSettings({ ...plugin.settings, providers: [] })
    service.dispose()
    notify.mockClear()
    pending.resolve(listed('late'))
    await work
    expect(plugin.settings.providers).toEqual([])
    expect(notify).not.toHaveBeenCalled()
    await plugin.setSettings({
      ...plugin.settings,
      providers: [{ id: 'new', type: 'openai', apiKey: 'new-key' }],
    })
    expect(fetchModels).toHaveBeenCalledTimes(1)
  })

  test.each([401, 403])(
    'HTTP %i pauses across restart until explicit retry or key change',
    async (status) => {
      const plugin = host()
      const service = catalog(plugin)
      fetchModels
        .mockResolvedValueOnce(response({}, status))
        .mockResolvedValueOnce(response({}, status))
        .mockResolvedValueOnce(listed('authorized'))
      await service.refresh('custom')
      expect(service.get('custom').status).toBe('auth-error')
      service.dispose()
      const restarted = catalog(plugin)
      now += 30 * DAY
      await restarted.refresh('custom')
      expect(fetchModels).toHaveBeenCalledTimes(1)
      await restarted.refresh('custom', true)
      expect(fetchModels).toHaveBeenCalledTimes(2)
      await changeProvider(plugin, { apiKey: 'valid-key' })
      await restarted.refresh('custom')
      expect(restarted.get('custom').models).toEqual([{ id: 'authorized' }])
    },
  )

  test.each(['120', 'date'])(
    'HTTP 429 honors Retry-After %s even for forced refresh',
    async (header) => {
      const plugin = host()
      const service = catalog(plugin)
      fetchModels
        .mockResolvedValueOnce(
          response({}, 429, {
            'Retry-After':
              header === 'date' ? new Date(now + 120000).toUTCString() : header,
          }),
        )
        .mockResolvedValueOnce(listed('after-wait'))
      await service.refresh('custom')
      expect(service.get('custom').status).toBe('rate-limited')
      now += 119999
      await service.refresh('custom', true)
      expect(fetchModels).toHaveBeenCalledTimes(1)
      now++
      await service.refresh('custom')
      expect(service.get('custom').models).toEqual([{ id: 'after-wait' }])
    },
  )

  test('ordinary failures retain stale models with a 15-minute cooldown and safe observable error', async () => {
    const plugin = host()
    const service = catalog(plugin)
    fetchModels
      .mockResolvedValueOnce(listed('cached'))
      .mockRejectedValueOnce(new Error('network error containing secret-one'))
      .mockResolvedValueOnce(listed('recovered'))
    await service.refresh('custom')
    now += DAY
    await service.refresh('custom')
    expect(service.get('custom')).toMatchObject({
      status: 'error',
      models: [{ id: 'cached' }],
    })
    expect(service.get('custom').error).toBeTruthy()
    expect(
      JSON.stringify(plugin.settings.providers[0].modelDiscovery),
    ).not.toContain('secret-one')
    now += COOLDOWN - 1
    await service.refresh('custom')
    expect(fetchModels).toHaveBeenCalledTimes(2)
    now++
    await service.refresh('custom')
    expect(service.get('custom').models).toEqual([{ id: 'recovered' }])
  })

  test('unauthenticated 404 is a retryable error rather than durable unsupported', async () => {
    const plugin = host([{ id: 'local', type: 'ollama' }])
    const service = catalog(plugin)
    fetchModels
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(listed('installed'))
    await service.refresh('local')
    expect(service.get('local').status).toBe('error')
    await service.refresh('local', true)
    expect(service.get('local').models).toEqual([{ id: 'installed' }])
  })

  test.each([
    ['openai', undefined, 'https://api.openai.com/v1/models'],
    ['openrouter', undefined, 'https://openrouter.ai/api/v1/models'],
    ['deepseek', undefined, 'https://api.deepseek.com/models'],
    ['perplexity', undefined, 'https://api.perplexity.ai/models'],
    ['groq', undefined, 'https://api.groq.com/openai/v1/models'],
    ['mistral', undefined, 'https://api.mistral.ai/v1/models'],
    ['morph', undefined, 'https://api.morphllm.com/v1/models'],
    ['ollama', undefined, 'http://127.0.0.1:11434/v1/models'],
    ['lm-studio', undefined, 'http://127.0.0.1:1234/v1/models'],
    [
      'ollama',
      'https://proxy.example/nested///',
      'https://proxy.example/nested/v1/models',
    ],
    ['morph', 'https://proxy.example/v1', 'https://proxy.example/v1/v1/models'],
    [
      'openai-compatible',
      'https://api.z.ai/api/paas/v4/',
      'https://api.z.ai/api/paas/v4/models',
    ],
  ])(
    'resolves %s endpoints consistently with its chat client',
    async (type, baseUrl, expected) => {
      const plugin = host([{ id: 'provider', type, baseUrl, apiKey: 'key' }])
      const service = catalog(plugin)
      fetchModels.mockResolvedValueOnce(listed('available'))
      await service.refresh('provider')
      expect(fetchModels.mock.calls[0][0].toString()).toBe(expected)
      expect(
        new Headers(fetchModels.mock.calls[0][1]?.headers).get('Authorization'),
      ).toBe('Bearer key')
    },
  )

  test('Azure stays manual; cloud providers and Z.ai need keys; native Gemini rejects unsupported custom endpoints', async () => {
    const plugin = host([
      {
        id: 'azure',
        type: 'azure-openai',
        apiKey: 'key',
        baseUrl: 'https://azure.example',
      },
      { id: 'openai', type: 'openai' },
      {
        id: 'zai',
        type: 'openai-compatible',
        baseUrl: 'https://api.z.ai/api/paas/v4',
      },
      {
        id: 'gemini',
        type: 'gemini',
        apiKey: 'key',
        baseUrl: 'https://wrong.example',
      },
    ])
    const service = catalog(plugin)
    await Promise.all(
      plugin.settings.providers.map((provider) => service.refresh(provider.id)),
    )
    expect(service.get('azure').status).toBe('manual')
    expect(service.get('openai').status).toBe('missing-key')
    expect(service.get('zai').status).toBe('missing-key')
    expect(service.get('gemini').status).toBe('error')
    expect(fetchModels).not.toHaveBeenCalled()
  })

  test('Anthropic follows native cursors with required headers and deduplicates model IDs', async () => {
    const plugin = host([
      { id: 'anthropic', type: 'anthropic', apiKey: 'anthropic-key' },
    ])
    const service = catalog(plugin)
    fetchModels
      .mockResolvedValueOnce(
        response({
          data: [{ id: 'claude-a', display_name: 'Claude A' }],
          has_more: true,
          last_id: 'claude-a',
        }),
      )
      .mockResolvedValueOnce(
        response({
          data: [
            { id: 'claude-a', display_name: 'Claude A' },
            { id: 'claude-b', display_name: 'Claude B' },
          ],
          has_more: false,
        }),
      )
    await service.refresh('anthropic')
    expect(service.get('anthropic').models).toEqual([
      { id: 'claude-a', name: 'Claude A' },
      { id: 'claude-b', name: 'Claude B' },
    ])
    const headers = new Headers(fetchModels.mock.calls[0][1]?.headers)
    expect(headers.get('x-api-key')).toBe('anthropic-key')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(
      new URL(fetchModels.mock.calls[1][0]).searchParams.get('after_id'),
    ).toBe('claude-a')
  })

  test('Gemini follows native page tokens and normalizes model resource names without credentials in URLs', async () => {
    const plugin = host([
      { id: 'gemini', type: 'gemini', apiKey: 'gemini-key' },
    ])
    const service = catalog(plugin)
    fetchModels
      .mockResolvedValueOnce(
        response({
          models: [
            { name: 'models/gemini-flash', displayName: 'Gemini Flash' },
          ],
          nextPageToken: 'next+page',
        }),
      )
      .mockResolvedValueOnce(
        response({
          models: [
            {
              name: 'models/gemini-embedding',
              displayName: 'Gemini Embedding',
            },
          ],
        }),
      )
    await service.refresh('gemini')
    expect(service.get('gemini').models).toEqual([
      { id: 'gemini-flash', name: 'Gemini Flash' },
      { id: 'gemini-embedding', name: 'Gemini Embedding' },
    ])
    const url = new URL(fetchModels.mock.calls[1][0])
    expect(url.origin + url.pathname).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models',
    )
    expect(url.searchParams.get('pageToken')).toBe('next+page')
    expect(url.searchParams.has('key')).toBe(false)
    expect(
      new Headers(fetchModels.mock.calls[0][1]?.headers).get('x-goog-api-key'),
    ).toBe('gemini-key')
  })

  test.each([
    { data: [{ id: '' }] },
    { data: [{ id: 'valid' }, { id: 4 }] },
    { models: [] },
    { data: [], has_more: true },
  ])(
    'rejects malformed or incomplete OpenAI listings without replacing cached models: %j',
    async (malformed) => {
      const plugin = host()
      const service = catalog(plugin)
      fetchModels
        .mockResolvedValueOnce(listed('cached'))
        .mockResolvedValueOnce(response(malformed))
      await service.refresh('custom')
      await service.refresh('custom', true)
      expect(service.get('custom')).toMatchObject({
        status: 'error',
        models: [{ id: 'cached' }],
      })
    },
  )

  test('repeated native cursors fail instead of looping or publishing partial lists', async () => {
    const plugin = host([{ id: 'anthropic', type: 'anthropic', apiKey: 'key' }])
    const service = catalog(plugin)
    fetchModels.mockImplementation(async () =>
      response({
        data: [{ id: 'repeated' }],
        has_more: true,
        last_id: 'repeated',
      }),
    )
    await service.refresh('anthropic')
    expect(service.get('anthropic')).toMatchObject({
      status: 'error',
      models: [],
    })
    expect(fetchModels).toHaveBeenCalledTimes(2)
  })

  test('unbounded native pagination fails after a finite page limit', async () => {
    const plugin = host([{ id: 'gemini', type: 'gemini', apiKey: 'key' }])
    const service = catalog(plugin)
    let page = 0
    fetchModels.mockImplementation(async () => {
      page++
      return response({
        models: [{ name: `models/page-${page}` }],
        nextPageToken: `page-${page + 1}`,
      })
    })
    await service.refresh('gemini')
    expect(service.get('gemini')).toMatchObject({ status: 'error', models: [] })
    expect(page).toBeLessThanOrEqual(100)
  })

  test('Reset during a request waits for the physical request and discards its late unsupported result', async () => {
    const plugin = host()
    const service = catalog(plugin)
    const pending = deferred<Response>()
    const started = pendingFetch(pending.promise)
    fetchModels.mockResolvedValueOnce(listed('after-reset'))
    const work = service.refresh('custom')
    await started
    const reset = service.reset('custom')
    expect(fetchModels).toHaveBeenCalledTimes(1)
    pending.resolve(response({}, 404))
    await Promise.all([work, reset])
    expect(service.get('custom')).toMatchObject({
      status: 'ready',
      models: [{ id: 'after-reset' }],
    })
    expect(fetchModels).toHaveBeenCalledTimes(2)
  })

  test('returning to an in-flight configuration never overlaps another request for it', async () => {
    const plugin = host()
    const service = catalog(plugin)
    const first = deferred<Response>()
    const started = pendingFetch(first.promise)
    fetchModels
      .mockResolvedValueOnce(listed('key-b'))
      .mockResolvedValueOnce(listed('fresh-key-a'))
    const work = service.refresh('custom')
    await started
    await changeProvider(plugin, { apiKey: 'key-b' })
    await service.refresh('custom')
    await changeProvider(plugin, { apiKey: 'secret-one' })
    const returned = service.refresh('custom')
    expect(fetchModels).toHaveBeenCalledTimes(2)
    first.resolve(listed('outdated-key-a'))
    await Promise.all([work, returned])
    expect(service.get('custom').models).toEqual([{ id: 'fresh-key-a' }])
    expect(fetchModels).toHaveBeenCalledTimes(3)
  })

  test('independent provider results preserve both caches and concurrent settings edits', async () => {
    const plugin = host([
      { id: 'one', type: 'openai', apiKey: 'key-one' },
      { id: 'two', type: 'openai', apiKey: 'key-two' },
    ])
    const service = catalog(plugin)
    const one = deferred<Response>()
    const two = deferred<Response>()
    fetchModels.mockImplementation((_url, init) =>
      new Headers(init?.headers).get('Authorization') === 'Bearer key-one'
        ? one.promise
        : two.promise,
    )
    const work = [service.refresh('one'), service.refresh('two')]
    await untilRequested(2)
    await plugin.setSettings({
      ...plugin.settings,
      other: 'saved-during-discovery',
    })
    two.resolve(listed('model-two'))
    await work[1]
    one.resolve(listed('model-one'))
    await work[0]
    expect(
      plugin.settings.providers.map(
        (provider) => provider.modelDiscovery?.models,
      ),
    ).toEqual([[{ id: 'model-one' }], [{ id: 'model-two' }]])
    expect(plugin.settings.other).toBe('saved-during-discovery')
    expect(plugin.settings.chatModels).toEqual([
      'configured-model',
      {
        id: 'two/model-two',
        providerId: 'two',
        providerType: 'openai',
        model: 'model-two',
        enable: true,
      },
      {
        id: 'one/model-one',
        providerId: 'one',
        providerType: 'openai',
        model: 'model-one',
        enable: true,
      },
    ])
  })

  test('server errors and invalid JSON stay retryable without replacing the saved catalog', async () => {
    const plugin = host()
    const service = catalog(plugin)
    fetchModels
      .mockResolvedValueOnce(listed('cached'))
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(new Response('<html>not JSON</html>'))
      .mockResolvedValueOnce(listed('recovered'))
    await service.refresh('custom')
    await service.refresh('custom', true)
    expect(service.get('custom')).toMatchObject({
      status: 'error',
      models: [{ id: 'cached' }],
    })
    await service.refresh('custom', true)
    expect(service.get('custom')).toMatchObject({
      status: 'error',
      models: [{ id: 'cached' }],
    })
    await service.refresh('custom', true)
    expect(service.get('custom').models).toEqual([{ id: 'recovered' }])
  })

  test('a failed persistence write is observable without an unhandled refresh rejection', async () => {
    const plugin = host()
    const service = catalog(plugin)
    fetchModels.mockResolvedValueOnce(listed('available'))
    jest
      .spyOn(plugin, 'setSettings')
      .mockRejectedValueOnce(new Error('disk unavailable'))
    await service.refresh('custom')
    expect(service.get('custom')).toMatchObject({
      status: 'error',
      models: [{ id: 'available' }],
    })
    expect(service.get('custom').error).toBeTruthy()
    expect(plugin.settings.providers[0].modelDiscovery).toBeUndefined()
    expect(plugin.settings.chatModels).toEqual(['configured-model'])
  })
})
