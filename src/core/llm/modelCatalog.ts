import { z } from 'zod'

import { obsidianRequestUrlFetch } from '../../utils/fetch-utils'

const CACHE_TTL = 24 * 60 * 60 * 1000
const FAILURE_COOLDOWN = 15 * 60 * 1000
const MAX_MODELS = 10000
const MAX_PAGES = 50

const modelIdSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    if (value !== value.trim()) return false
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code <= 0x1f || code === 0x7f) return false
    }
    return true
  })
const modelNameSchema = z.string().min(1).max(1024)
const catalogModelSchema = z.object({
  id: modelIdSchema,
  name: modelNameSchema.optional(),
})
const protocolSchema = z.enum(['openai', 'anthropic', 'gemini'])
const timestampSchema = z.number().finite().nonnegative()

export const modelDiscoverySchema = z.object({
  version: z.literal(1),
  endpoint: z.string().url(),
  protocol: protocolSchema,
  credentialHash: z.string().regex(/^[a-f0-9]{64}$/),
  models: z.array(catalogModelSchema).max(MAX_MODELS),
  status: z.enum([
    'ready',
    'unsupported',
    'auth-error',
    'rate-limited',
    'error',
  ]),
  updatedAt: timestampSchema.optional(),
  retryAt: timestampSchema.optional(),
  error: z.string().max(1024).optional(),
})

export type ModelDiscovery = z.infer<typeof modelDiscoverySchema>
export type CatalogModel = z.infer<typeof catalogModelSchema>
export type ModelCatalogStatus =
  | ModelDiscovery['status']
  | 'idle'
  | 'loading'
  | 'stale'
  | 'missing-key'
  | 'manual'
export type ModelCatalogSnapshot = {
  models: CatalogModel[]
  status: ModelCatalogStatus
  error?: string
  updatedAt?: number
}

type CatalogProvider = {
  id: string
  type: string
  apiKey?: string
  baseUrl?: string
  modelDiscovery?: ModelDiscovery
}
type CatalogSettings = {
  providers: CatalogProvider[]
  chatModels?: unknown[]
}
type CatalogHost = {
  settings: CatalogSettings
  setSettings(settings: CatalogSettings): Promise<void>
  addSettingsChangeListener(listener: () => void): () => void
}
type Configuration = {
  endpoint: string
  protocol: z.infer<typeof protocolSchema>
  key: string
  status?: 'manual' | 'missing-key' | 'error'
  error?: string
}
type Entry = {
  id: string
  config: Configuration
  initialized: Promise<void>
  credentialHash?: string
  state?: ModelDiscovery
  initializationError?: string
  loading: boolean
  task?: Promise<void>
}

type ConfiguredChatModel = {
  id: string
  providerId: string
  model: string
}

function isConfiguredChatModel(value: unknown): value is ConfiguredChatModel {
  if (typeof value !== 'object' || value === null) return false
  const model = value as Partial<ConfiguredChatModel>
  return (
    typeof model.id === 'string' &&
    typeof model.providerId === 'string' &&
    typeof model.model === 'string'
  )
}

function addDiscoveredChatModels(
  configured: unknown[] | undefined,
  provider: CatalogProvider,
  discovered: CatalogModel[],
): unknown[] | undefined {
  if (!configured) return configured
  let result = configured
  const ids = new Set(
    configured.filter(isConfiguredChatModel).map((model) => model.id),
  )
  const models = new Set(
    configured
      .filter(isConfiguredChatModel)
      .filter((model) => model.providerId === provider.id)
      .map((model) => model.model),
  )
  for (const model of discovered) {
    if (models.has(model.id)) continue
    const baseId = `${provider.id}/${model.id}`
    let id = baseId
    for (let suffix = 2; ids.has(id); suffix++) id = `${baseId}-${suffix}`
    if (result === configured) result = [...configured]
    result.push({
      id,
      providerId: provider.id,
      providerType: provider.type,
      model: model.id,
      enable: true,
    })
    ids.add(id)
    models.add(model.id)
  }
  return result
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  deepseek: 'https://api.deepseek.com',
  perplexity: 'https://api.perplexity.ai',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://127.0.0.1:11434',
  'lm-studio': 'http://127.0.0.1:1234',
  morph: 'https://api.morphllm.com',
}

function configuration(provider: CatalogProvider): Configuration {
  const protocol =
    provider.type === 'anthropic' || provider.type === 'gemini'
      ? provider.type
      : 'openai'
  const config: Configuration = {
    endpoint: '',
    protocol,
    key: provider.apiKey ?? '',
  }
  if (
    provider.type === 'azure-openai' ||
    !(
      provider.type in DEFAULT_BASE_URLS ||
      provider.type === 'gemini' ||
      provider.type === 'openai-compatible'
    )
  ) {
    return {
      ...config,
      status: 'manual',
      error: 'This provider requires manually configured models.',
    }
  }
  if (provider.type === 'gemini' && provider.baseUrl) {
    return {
      ...config,
      status: 'error',
      error:
        'Native Gemini does not support a custom base URL. Use an OpenAI-compatible provider for a compatible gateway.',
    }
  }

  const base = provider.baseUrl || DEFAULT_BASE_URLS[provider.type] || ''
  const suffix = ['anthropic', 'ollama', 'lm-studio', 'morph'].includes(
    provider.type,
  )
    ? '/v1/models'
    : '/models'
  try {
    if (provider.type !== 'gemini' && (!base || base !== base.trim()))
      throw new Error()
    const url = new URL(
      provider.type === 'gemini'
        ? 'https://generativelanguage.googleapis.com/v1beta/models'
        : `${base.replace(/\/+$/, '')}${suffix}`,
    )
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error()
    config.endpoint = url.toString()
  } catch {
    return {
      ...config,
      status: 'error',
      error:
        'Set a valid HTTP(S) base URL without credentials, query parameters, or a fragment.',
    }
  }

  const optionalKey =
    provider.type === 'ollama' ||
    provider.type === 'lm-studio' ||
    (provider.type === 'openai-compatible' && provider.id !== 'zai')
  if (!optionalKey && !config.key.trim()) {
    return {
      ...config,
      status: 'missing-key',
      error: 'Save an API key to discover available models.',
    }
  }
  return config
}

function sameConfiguration(left: Configuration, right: Configuration) {
  return (
    left.endpoint === right.endpoint &&
    left.protocol === right.protocol &&
    left.key === right.key &&
    left.status === right.status &&
    left.error === right.error
  )
}

async function hashCredential(key: string) {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(key),
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

const openaiPageSchema = z.object({
  data: z.array(catalogModelSchema).max(MAX_MODELS),
  has_more: z.boolean().optional(),
})
const anthropicPageSchema = z.object({
  data: z
    .array(
      z.object({ id: modelIdSchema, display_name: modelNameSchema.optional() }),
    )
    .max(MAX_MODELS),
  has_more: z.boolean(),
  last_id: modelIdSchema.nullable().optional(),
})
const geminiPageSchema = z.object({
  models: z
    .array(
      z.object({
        name: modelIdSchema.refine(
          (value) => value.startsWith('models/') && value.length > 7,
        ),
        displayName: modelNameSchema.optional(),
      }),
    )
    .max(MAX_MODELS),
  nextPageToken: z.string().max(4096).optional(),
})

class DiscoveryFailure extends Error {
  constructor(
    message: string,
    readonly status: ModelDiscovery['status'] = 'error',
    readonly retryAt?: number,
  ) {
    super(message)
  }
}

function httpFailure(response: Response, authenticated: boolean) {
  if (response.status === 401 || response.status === 403) {
    return new DiscoveryFailure(
      'Model listing was not authorized. Check the saved API key and permissions, then refresh.',
      'auth-error',
    )
  }
  if (response.status === 404 && authenticated) {
    return new DiscoveryFailure(
      'Model listing returned 404; automatic discovery disabled. Use manual models, or Reset model discovery to try again.',
      'unsupported',
    )
  }
  if (response.status === 429) {
    const header = response.headers.get('Retry-After')
    const seconds =
      header && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : NaN
    const date = header ? Date.parse(header) : NaN
    const retryAt = Number.isFinite(seconds)
      ? Date.now() + seconds * 1000
      : Number.isFinite(date)
        ? Math.max(Date.now(), date)
        : Date.now() + FAILURE_COOLDOWN
    return new DiscoveryFailure(
      'Model listing was rate limited. Retry after the server cooldown.',
      'rate-limited',
      Number.isFinite(retryAt) ? retryAt : Date.now() + FAILURE_COOLDOWN,
    )
  }
  return new DiscoveryFailure(
    `Model listing failed (HTTP ${response.status}). Refresh to retry.`,
  )
}

async function listModels(config: Configuration, current: () => boolean) {
  const models = new Map<string, CatalogModel>()
  const cursors = new Set<string>()
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (config.protocol === 'anthropic') {
    headers['x-api-key'] = config.key
    headers['anthropic-version'] = '2023-06-01'
  } else if (config.protocol === 'gemini') {
    headers['x-goog-api-key'] = config.key
  } else if (config.key) {
    headers.Authorization = `Bearer ${config.key}`
  }
  let cursor: string | undefined
  let count = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    if (!current()) return
    const url = new URL(config.endpoint)
    if (config.protocol === 'anthropic') {
      url.searchParams.set('limit', '1000')
      if (cursor) url.searchParams.set('after_id', cursor)
    } else if (config.protocol === 'gemini') {
      url.searchParams.set('pageSize', '1000')
      if (cursor) url.searchParams.set('pageToken', cursor)
    }
    const response = await obsidianRequestUrlFetch(url, {
      method: 'GET',
      headers,
    })
    if (!current()) return
    if (!response.ok) throw httpFailure(response, Boolean(config.key.trim()))
    const text = await response.text()
    if (!current()) return
    if (text.length > 5 * 1024 * 1024)
      throw new DiscoveryFailure(
        'Model listing exceeded the response size limit.',
      )
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      throw new DiscoveryFailure('Model listing returned invalid JSON.')
    }
    let batch: CatalogModel[]
    let next: string | undefined
    if (config.protocol === 'anthropic') {
      const result = anthropicPageSchema.parse(data)
      batch = result.data.map((model) => ({
        id: model.id,
        ...(model.display_name ? { name: model.display_name } : {}),
      }))
      if (result.has_more) {
        if (!result.last_id)
          throw new DiscoveryFailure(
            'Model listing returned an invalid pagination cursor.',
          )
        next = result.last_id
      }
    } else if (config.protocol === 'gemini') {
      const result = geminiPageSchema.parse(data)
      batch = result.models.map((model) => ({
        id: model.name.slice(7),
        ...(model.displayName ? { name: model.displayName } : {}),
      }))
      next = result.nextPageToken || undefined
    } else {
      const result = openaiPageSchema.parse(data)
      if (result.has_more)
        throw new DiscoveryFailure(
          'The OpenAI-compatible model listing returned unsupported pagination.',
        )
      batch = result.data
    }
    count += batch.length
    if (count > MAX_MODELS)
      throw new DiscoveryFailure('Model listing exceeded the model limit.')
    for (const model of batch) {
      if (!models.has(model.id)) models.set(model.id, model)
    }
    if (!next) return Array.from(models.values())
    if (!batch.length || cursors.has(next))
      throw new DiscoveryFailure(
        'Model listing returned a repeated or empty page.',
      )
    cursors.add(next)
    cursor = next
  }
  throw new DiscoveryFailure('Model listing exceeded the pagination limit.')
}

export class ModelCatalog {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private readonly requests = new Map<string, Promise<void>>()
  private readonly removeSettingsListener: () => void
  private disposed = false

  constructor(private readonly plugin: CatalogHost) {
    this.synchronize(false)
    this.removeSettingsListener = plugin.addSettingsChangeListener(() =>
      this.synchronize(true),
    )
  }

  get(providerId: string): ModelCatalogSnapshot {
    const entry = this.entries.get(providerId)
    if (!entry || this.disposed) return { models: [], status: 'idle' }
    const state = entry.state
    if (state?.status === 'unsupported')
      return {
        models: state.models,
        status: state.status,
        error: state.error,
        updatedAt: state.updatedAt,
      }
    if (entry.config.status)
      return {
        models: [],
        status: entry.config.status,
        error: entry.config.error,
      }
    if (entry.initializationError)
      return { models: [], status: 'error', error: entry.initializationError }
    if (entry.loading)
      return {
        models: state?.models ?? [],
        status: 'loading',
        updatedAt: state?.updatedAt,
      }
    if (!state) return { models: [], status: 'idle' }
    const snapshot: ModelCatalogSnapshot = {
      models: state.models,
      status: state.status,
      error: state.error,
      updatedAt: state.updatedAt,
    }
    if (
      state.status === 'ready' &&
      (state.updatedAt === undefined ||
        Date.now() - state.updatedAt >= CACHE_TTL)
    )
      snapshot.status = 'stale'
    return snapshot
  }

  refresh(providerId: string, force = false): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const entry = this.entries.get(providerId)
    if (!entry) return Promise.resolve()
    if (entry.task) return entry.task
    // requestUrl cannot abort: a configuration revisited mid-request waits for its old request to finish.
    const requestKey = JSON.stringify([providerId, entry.config])
    const previous = this.requests.get(requestKey) ?? Promise.resolve()
    const task = previous
      .then(() => this.performRefresh(entry, force))
      .finally(() => {
        if (entry.task === task) entry.task = undefined
        if (this.requests.get(requestKey) === task)
          this.requests.delete(requestKey)
      })
    entry.task = task
    this.requests.set(requestKey, task)
    return task
  }

  async reset(providerId: string): Promise<void> {
    if (this.disposed) return
    const provider = this.plugin.settings.providers.find(
      (candidate) => candidate.id === providerId,
    )
    if (!provider) return
    const entry = this.createEntry({ ...provider, modelDiscovery: undefined })
    this.entries.set(providerId, entry)
    this.emit()
    try {
      await this.persist(entry, undefined)
    } catch {
      if (this.current(entry)) {
        entry.initializationError =
          'Could not save the discovery reset. Try Reset again.'
        this.emit()
      }
      return
    }
    if (this.current(entry)) await this.refresh(providerId, true)
  }

  subscribe(listener: () => void) {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.removeSettingsListener()
    this.listeners.clear()
    this.entries.clear()
    this.requests.clear()
  }

  private createEntry(provider: CatalogProvider): Entry {
    const config = configuration(provider)
    const parsed = modelDiscoverySchema.safeParse(provider.modelDiscovery)
    const saved =
      parsed.success &&
      parsed.data.endpoint === config.endpoint &&
      parsed.data.protocol === config.protocol
        ? parsed.data
        : undefined
    const entry: Entry = {
      id: provider.id,
      config,
      initialized: Promise.resolve(),
      loading: false,
    }
    // Unsupported belongs to the endpoint, not the credential used to discover it.
    if (saved?.status === 'unsupported')
      entry.state = { ...saved, models: [], updatedAt: undefined }
    if (config.status === 'manual' || !config.endpoint) return entry
    entry.initialized = hashCredential(config.key)
      .then((hash) => {
        entry.credentialHash = hash
        if (saved?.credentialHash === hash) entry.state = saved
        if (this.current(entry)) this.emit()
      })
      .catch(() => {
        entry.initializationError =
          'Could not initialize model discovery credential hashing.'
        if (this.current(entry)) this.emit()
      })
    return entry
  }

  private synchronize(discoverChanges: boolean) {
    if (this.disposed) return
    const present = new Set<string>()
    const changed: string[] = []
    for (const provider of this.plugin.settings.providers) {
      present.add(provider.id)
      const existing = this.entries.get(provider.id)
      if (
        !existing ||
        !sameConfiguration(existing.config, configuration(provider))
      ) {
        this.entries.set(provider.id, this.createEntry(provider))
        changed.push(provider.id)
      }
    }
    let removed = false
    for (const id of this.entries.keys()) {
      if (!present.has(id)) {
        this.entries.delete(id)
        removed = true
      }
    }
    if (changed.length || removed) this.emit()
    if (discoverChanges)
      changed.forEach((id) => {
        void this.refresh(id)
      })
  }

  private current(entry: Entry) {
    if (this.disposed || this.entries.get(entry.id) !== entry) return false
    const provider = this.plugin.settings.providers.find(
      (candidate) => candidate.id === entry.id,
    )
    return Boolean(
      provider && sameConfiguration(entry.config, configuration(provider)),
    )
  }

  private async performRefresh(entry: Entry, force: boolean) {
    await entry.initialized
    if (!this.current(entry) || entry.config.status || !entry.credentialHash)
      return
    const saved = entry.state
    if (saved?.status === 'unsupported') return
    if (saved?.status === 'rate-limited' && (saved.retryAt ?? 0) > Date.now())
      return
    if (!force && saved) {
      if (saved.status === 'auth-error') return
      if ((saved.retryAt ?? 0) > Date.now()) return
      if (
        saved.status === 'ready' &&
        saved.updatedAt !== undefined &&
        Date.now() - saved.updatedAt < CACHE_TTL
      ) {
        await this.persist(entry, saved)
        return
      }
    }
    entry.loading = true
    this.emit()
    let next: ModelDiscovery
    try {
      const models = await listModels(entry.config, () => this.current(entry))
      if (!models || !this.current(entry)) return
      next = {
        version: 1,
        endpoint: entry.config.endpoint,
        protocol: entry.config.protocol,
        credentialHash: entry.credentialHash,
        models,
        status: 'ready',
        updatedAt: Date.now(),
      }
    } catch (error) {
      if (!this.current(entry)) return
      const failure =
        error instanceof DiscoveryFailure
          ? error
          : new DiscoveryFailure(
              error instanceof z.ZodError
                ? 'Model listing returned malformed model data.'
                : 'Could not fetch models. Check the connection and endpoint, then refresh.',
            )
      next = {
        version: 1,
        endpoint: entry.config.endpoint,
        protocol: entry.config.protocol,
        credentialHash: entry.credentialHash,
        models: saved?.models ?? [],
        updatedAt: saved?.updatedAt,
        status: failure.status,
        error: failure.message,
        retryAt:
          failure.status === 'error'
            ? Date.now() + FAILURE_COOLDOWN
            : failure.retryAt,
      }
    } finally {
      entry.loading = false
      if (this.current(entry)) this.emit()
    }
    if (!this.current(entry)) return
    entry.state = next
    this.emit()
    try {
      await this.persist(entry, next)
    } catch {
      if (this.current(entry)) {
        entry.state = {
          ...next,
          status: next.status === 'ready' ? 'error' : next.status,
          error: 'Could not save model discovery. Refresh or Reset to retry.',
          retryAt: next.retryAt ?? Date.now() + FAILURE_COOLDOWN,
        }
        this.emit()
      }
    }
  }

  private async persist(entry: Entry, state: ModelDiscovery | undefined) {
    if (!this.current(entry)) return
    // Read at commit time; an in-flight listing must not overwrite other saved settings or manual models.
    const settings = this.plugin.settings
    const provider = settings.providers.find(
      (candidate) => candidate.id === entry.id,
    )
    if (!provider) return
    const chatModels =
      state?.status === 'ready'
        ? addDiscoveredChatModels(settings.chatModels, provider, state.models)
        : settings.chatModels
    if (provider.modelDiscovery === state && chatModels === settings.chatModels)
      return
    await this.plugin.setSettings({
      ...settings,
      providers: settings.providers.map((candidate) =>
        candidate.id === entry.id
          ? { ...candidate, modelDiscovery: state }
          : candidate,
      ),
      chatModels,
    })
  }

  private emit() {
    if (!this.disposed) this.listeners.forEach((listener) => listener())
  }
}
