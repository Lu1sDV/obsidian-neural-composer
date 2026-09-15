import { requestUrl } from 'obsidian'

import type NeuralComposerPlugin from '../../main'

import {
  type PendingDocumentOperation,
  type ProcessingPolicy,
  documentSourceName,
} from './documentProcessing'

export type DocStatus =
  | 'processed'
  | 'processing'
  | 'failed'
  | 'removed'
  | 'unknown'

export type DocRecord = {
  status: DocStatus
  docId?: string
  mtime?: number
  source?: string
  policy?: ProcessingPolicy
  pending?: PendingDocumentOperation
  aliases?: string[]
  removeRequested?: boolean
}

export type LRDoc = {
  id: string
  file_path: string
  status: string
  content_summary?: string
  content_length?: number
  created_at?: string
  updated_at?: string
  track_id?: string | null
  chunks_count?: number | null
  metadata?: Record<string, unknown> | null
  error_msg?: string | null
}

export type SaveRecordOptions = {
  previousPath?: string
  clearRemovalIntent?: boolean
}

type BackendRequestScope = {
  backendId: string
  serverUrl: string
  apiKey: string
  headers: Record<string, string>
}

type DocumentListing = {
  documents: LRDoc[]
  authoritative: boolean
}

type BackendRecords = { records: Record<string, DocRecord> }
type DocumentStore = {
  version: 2
  backends: Record<string, BackendRecords>
}

type Pagination = {
  page: number
  page_size: number
  total_count: number
  total_pages: number
  has_next: boolean
  has_prev: boolean
}

const STORE_VERSION = 2 as const
const SOURCE_FILE_SUFFIX = '.backup'
const PENDING_FILE_SUFFIX = '.pending'
const PAGE_SIZE = 200

const emptyStore = (): DocumentStore => ({
  version: STORE_VERSION,
  backends: {},
})

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isStatus(value: unknown): value is DocStatus {
  return (
    value === 'processed' ||
    value === 'processing' ||
    value === 'failed' ||
    value === 'removed' ||
    value === 'unknown'
  )
}

function isPolicy(value: unknown): value is ProcessingPolicy {
  if (!isObject(value)) return false
  const { mode, chunkSize, chunkOverlap } = value
  return (
    (mode === 'legacy' || mode === 'paragraph') &&
    Number.isFinite(chunkSize) &&
    Number.isInteger(chunkSize) &&
    (chunkSize as number) >= 1 &&
    Number.isFinite(chunkOverlap) &&
    Number.isInteger(chunkOverlap) &&
    (chunkOverlap as number) >= 0 &&
    (chunkOverlap as number) < (chunkSize as number)
  )
}

function isPendingOperation(
  value: unknown,
  backendId?: string,
): value is PendingDocumentOperation {
  if (!isObject(value) || !isPolicy(value.policy)) return false
  const validKind =
    value.kind === 'ingest' ||
    value.kind === 'replace' ||
    value.kind === 'rename'
  const validStage =
    value.stage === 'prepared' ||
    value.stage === 'delete_requested' ||
    value.stage === 'delete_confirmed' ||
    value.stage === 'upload_requested' ||
    value.stage === 'tracking'
  return (
    typeof value.backendId === 'string' &&
    value.backendId.length > 0 &&
    (backendId === undefined || value.backendId === backendId) &&
    validKind &&
    validStage &&
    typeof value.mtime === 'number' &&
    Number.isFinite(value.mtime) &&
    typeof value.source === 'string' &&
    value.source.length > 0 &&
    (value.docId === undefined || typeof value.docId === 'string') &&
    (value.trackId === undefined || typeof value.trackId === 'string') &&
    (value.previousPath === undefined ||
      typeof value.previousPath === 'string') &&
    (value.previousDocId === undefined ||
      typeof value.previousDocId === 'string') &&
    (value.paused === undefined || typeof value.paused === 'boolean') &&
    (value.error === undefined || typeof value.error === 'string')
  )
}

function isDocRecord(value: unknown, backendId?: string): value is DocRecord {
  if (!isObject(value) || !isStatus(value.status)) return false
  return (
    (value.docId === undefined ||
      (typeof value.docId === 'string' && value.docId.length > 0)) &&
    (value.mtime === undefined ||
      (typeof value.mtime === 'number' && Number.isFinite(value.mtime))) &&
    (value.source === undefined ||
      (typeof value.source === 'string' && value.source.length > 0)) &&
    (value.policy === undefined || isPolicy(value.policy)) &&
    (value.pending === undefined ||
      isPendingOperation(value.pending, backendId)) &&
    (value.removeRequested === undefined ||
      typeof value.removeRequested === 'boolean') &&
    (value.aliases === undefined ||
      (Array.isArray(value.aliases) &&
        value.aliases.every(
          (alias) => typeof alias === 'string' && alias.length > 0,
        )))
  )
}

function parseRecords(
  value: unknown,
  backendId?: string,
): Record<string, DocRecord> {
  if (!isObject(value)) throw new Error('Document records must be an object')
  const records: Record<string, DocRecord> = {}
  for (const [path, record] of Object.entries(value)) {
    if (!path || !isDocRecord(record, backendId)) {
      throw new Error(
        `Invalid document index record: ${path || '<empty path>'}`,
      )
    }
    records[path] = cloneRecord(record)
  }
  return records
}

function parseStore(value: unknown): DocumentStore {
  if (
    !isObject(value) ||
    value.version !== STORE_VERSION ||
    !isObject(value.backends)
  ) {
    throw new Error('Unsupported document index schema')
  }
  const backends: Record<string, BackendRecords> = {}
  for (const [backendId, bucket] of Object.entries(value.backends)) {
    if (!backendId || !isObject(bucket)) {
      throw new Error('Invalid document index backend scope')
    }
    backends[backendId] = { records: parseRecords(bucket.records, backendId) }
  }
  return { version: STORE_VERSION, backends }
}

function clonePolicy(policy: ProcessingPolicy): ProcessingPolicy {
  return { ...policy }
}

function clonePending(
  pending: PendingDocumentOperation,
): PendingDocumentOperation {
  return { ...pending, policy: clonePolicy(pending.policy) }
}

function cloneRecord(record: DocRecord): DocRecord {
  return {
    ...record,
    policy: record.policy ? clonePolicy(record.policy) : undefined,
    pending: record.pending ? clonePending(record.pending) : undefined,
    aliases: record.aliases ? [...record.aliases] : undefined,
  }
}

function cloneStore(store: DocumentStore): DocumentStore {
  const backends: Record<string, BackendRecords> = {}
  for (const [backendId, bucket] of Object.entries(store.backends)) {
    const records: Record<string, DocRecord> = {}
    for (const [path, record] of Object.entries(bucket.records)) {
      records[path] = cloneRecord(record)
    }
    backends[backendId] = { records }
  }
  return { version: STORE_VERSION, backends }
}

function isLRDoc(value: unknown): value is LRDoc {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.file_path === 'string' &&
    value.file_path.length > 0 &&
    typeof value.status === 'string' &&
    (value.metadata === undefined ||
      value.metadata === null ||
      isObject(value.metadata)) &&
    (value.error_msg === undefined ||
      value.error_msg === null ||
      typeof value.error_msg === 'string')
  )
}

/** Durable, backend-scoped registry for every document ingested by the plugin. */
export class DocIndexService {
  private store: DocumentStore = emptyStore()
  private loaded = false
  private writeLocked = false
  private destroyed = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private pipelineTimer: ReturnType<typeof setTimeout> | null = null
  private onUpdate: (() => void) | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly statusFilePath: string
  private readonly backupFilePath: string
  private readonly pendingFilePath: string
  private sourceMap = new Map<string, string | null>()
  private readonly legacyBackupFilePath: string
  private sourceMapBackendId = ''
  private vaultSources = new Map<string, string>()
  private unambiguousRootPaths = new Set<string>()
  private sourceNamespace = ''
  private sourceMapGeneration = 0

  constructor(private plugin: NeuralComposerPlugin) {
    this.statusFilePath = `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/doc-status.json`
    this.backupFilePath = this.statusFilePath + SOURCE_FILE_SUFFIX
    this.pendingFilePath = this.statusFilePath + PENDING_FILE_SUFFIX
    this.legacyBackupFilePath = this.statusFilePath + '.legacy-backup'
  }

  setUpdateCallback(fn: () => void): void {
    this.onUpdate = fn
  }

  private currentBackendId(): string {
    return this.plugin.settings.lightRagBackendIdentity
  }

  private currentRecords(): Record<string, DocRecord> {
    const backendId = this.currentBackendId()
    if (!backendId) return {}
    return this.store.backends[backendId]?.records ?? {}
  }

  async load(): Promise<void> {
    if (this.loaded) return
    if (this.writeLocked) throw new Error('Document index writes are locked')

    const adapter = this.plugin.app.vault.adapter
    try {
      const primaryExists = await adapter.exists(this.statusFilePath)
      const pendingExists = await adapter.exists(this.pendingFilePath)
      if (!primaryExists) {
        if (pendingExists) {
          const pendingRaw = await adapter.read(this.pendingFilePath)
          const recovered = parseStore(JSON.parse(pendingRaw) as unknown)
          await this.persistSnapshot(recovered)
          this.store = recovered
          this.loaded = true
          await this.rebuildSourceMap()
          return
        }
        if (await adapter.exists(this.backupFilePath)) {
          throw new Error('Document index primary is missing; backup retained')
        }
        this.store = emptyStore()
        this.loaded = true
        await this.rebuildSourceMap()
        return
      }

      const raw = await adapter.read(this.statusFilePath)
      const parsed = JSON.parse(raw) as unknown
      let next: DocumentStore
      let migrated = false
      if (isObject(parsed) && typeof parsed.version === 'number') {
        next = parseStore(parsed)
      } else {
        const backendId = this.currentBackendId()
        if (!backendId) {
          throw new Error(
            'Backend identity is required to migrate document index',
          )
        }
        next = emptyStore()
        next.backends[backendId] = { records: parseRecords(parsed) }
        migrated = true
      }

      if (migrated) {
        if (!(await adapter.exists(this.legacyBackupFilePath))) {
          await adapter.write(this.legacyBackupFilePath, raw)
          if ((await adapter.read(this.legacyBackupFilePath)) !== raw) {
            throw new Error('Failed to verify legacy document index backup')
          }
        }
        if (pendingExists) {
          const pendingRaw = await adapter.read(this.pendingFilePath)
          next = parseStore(JSON.parse(pendingRaw) as unknown)
        }
        await this.persistSnapshot(next)
      } else if (pendingExists) {
        const pendingRaw = await adapter.read(this.pendingFilePath)
        if (pendingRaw !== raw) {
          next = parseStore(JSON.parse(pendingRaw) as unknown)
          await this.persistSnapshot(next)
        }
      }
      this.store = next
      this.loaded = true
      await this.rebuildSourceMap()
    } catch (error) {
      this.writeLocked = true
      throw error
    }
  }

  private async persistSnapshot(next: DocumentStore): Promise<void> {
    if (this.writeLocked) throw new Error('Document index writes are locked')
    const adapter = this.plugin.app.vault.adapter
    const serialized = JSON.stringify(next, null, 2)
    try {
      if (await adapter.exists(this.statusFilePath)) {
        const oldBytes = await adapter.read(this.statusFilePath)
        await adapter.write(this.backupFilePath, oldBytes)
        if ((await adapter.read(this.backupFilePath)) !== oldBytes) {
          throw new Error('Failed to verify document index backup')
        }
      }

      await adapter.write(this.pendingFilePath, serialized)
      if ((await adapter.read(this.pendingFilePath)) !== serialized) {
        throw new Error('Failed to verify pending document index write')
      }
      await adapter.write(this.statusFilePath, serialized)
      if ((await adapter.read(this.statusFilePath)) !== serialized) {
        throw new Error('Failed to verify document index write')
      }
      if (typeof adapter.remove === 'function') {
        await adapter.remove(this.pendingFilePath)
      }
    } catch (error) {
      this.writeLocked = true
      throw error
    }
  }

  private enqueueStoreUpdate(
    update: (next: DocumentStore) => void,
  ): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      if (this.writeLocked) throw new Error('Document index writes are locked')
      if (!this.loaded) throw new Error('Document index has not been loaded')
      const next = cloneStore(this.store)
      update(next)
      await this.persistSnapshot(next)
      this.store = next
      this.rebuildSourceMapSync()
      this.notify()
    })
    this.writeQueue = operation.catch(() => undefined)
    return operation
  }

  async saveRecord(
    path: string,
    record: DocRecord,
    backendId = this.currentBackendId(),
    options: SaveRecordOptions = {},
  ): Promise<void> {
    if (
      !path ||
      !backendId ||
      !isDocRecord(record, backendId) ||
      !isObject(options) ||
      (options.previousPath !== undefined &&
        (typeof options.previousPath !== 'string' ||
          options.previousPath.length === 0)) ||
      (options.clearRemovalIntent !== undefined &&
        typeof options.clearRemovalIntent !== 'boolean')
    ) {
      throw new Error('Invalid backend-scoped document record')
    }
    const saved = cloneRecord(record)
    const previousPath = options.previousPath
    const clearRemovalIntent = options.clearRemovalIntent === true
    const explicitPreparation =
      clearRemovalIntent && saved.pending?.stage === 'prepared'
    if (clearRemovalIntent && !explicitPreparation) {
      throw new Error(
        'Removal intent can only be cleared by explicit preparation',
      )
    }
    await this.enqueueStoreUpdate((next) => {
      const bucket = next.backends[backendId] ?? { records: {} }
      const sourcePath =
        previousPath && previousPath !== path ? previousPath : undefined
      let current = bucket.records[path]
      if (sourcePath) {
        current = bucket.records[sourcePath]
        if (!current || bucket.records[path]) {
          throw new Error(
            'Document rename ownership changed before persistence',
          )
        }
      }
      const confirmedRemoved = current?.status === 'removed' && !current.pending
      if (
        confirmedRemoved &&
        saved.status !== 'removed' &&
        !explicitPreparation
      ) {
        throw new Error(
          'A stale document update cannot replace a confirmed removal',
        )
      }
      if (sourcePath) delete bucket.records[sourcePath]
      if (saved.status === 'removed' || clearRemovalIntent) {
        saved.removeRequested = undefined
      } else if (current?.removeRequested) {
        saved.removeRequested = true
      }
      bucket.records[path] = saved
      next.backends[backendId] = bucket
    })
  }

  getRecord(
    path: string,
    backendId = this.currentBackendId(),
  ): DocRecord | undefined {
    const record = this.store.backends[backendId]?.records[path]
    return record ? cloneRecord(record) : undefined
  }

  getRecords(backendId = this.currentBackendId()): Record<string, DocRecord> {
    const result: Record<string, DocRecord> = {}
    const records = this.store.backends[backendId]?.records ?? {}
    for (const [path, record] of Object.entries(records)) {
      result[path] = cloneRecord(record)
    }
    return result
  }

  getStatus(vaultPath: string): DocStatus {
    return this.currentRecords()[vaultPath]?.status ?? 'unknown'
  }

  getMtime(vaultPath: string): number | undefined {
    return this.currentRecords()[vaultPath]?.mtime
  }

  hasProcessingDocs(): boolean {
    return Object.values(this.currentRecords()).some(
      (record) => record.status === 'processing',
    )
  }

  needsIngestion(vaultPath: string, currentMtime: number): boolean {
    const record = this.currentRecords()[vaultPath]
    if (!record) return true
    if (record.removeRequested) return false
    if (record.pending) return false
    if (
      record.status === 'processing' ||
      record.status === 'failed' ||
      record.status === 'removed'
    ) {
      return false
    }
    if (record.status === 'processed') {
      if (!record.policy) return false
      return record.mtime !== undefined && currentMtime > record.mtime
    }
    return !record.docId && !record.source
  }

  private mutateLegacy(
    path: string,
    update: (record: DocRecord) => DocRecord,
  ): void {
    const backendId = this.currentBackendId()
    if (!backendId || this.writeLocked || this.destroyed) return
    const bucket = this.store.backends[backendId] ?? { records: {} }
    bucket.records[path] = update(bucket.records[path] ?? { status: 'unknown' })
    this.store.backends[backendId] = bucket
    this.rebuildSourceMapSync()
    this.notify()
    this.scheduleSave()
  }

  setProcessing(vaultPath: string, mtime: number): void {
    this.mutateLegacy(vaultPath, (record) => ({
      ...record,
      status: 'processing',
      mtime,
    }))
  }

  setProcessed(vaultPath: string, docId?: string): void {
    this.mutateLegacy(vaultPath, (record) => ({
      ...record,
      status: 'processed',
      docId: docId ?? record.docId,
    }))
  }

  setFailed(vaultPath: string): void {
    this.mutateLegacy(vaultPath, (record) => ({ ...record, status: 'failed' }))
  }

  setRemoved(vaultPath: string): void {
    this.mutateLegacy(vaultPath, (record) => ({
      ...record,
      status: 'removed',
      docId: undefined,
      pending: undefined,
      removeRequested: undefined,
    }))
  }

  removeEntry(vaultPath: string): void {
    // Retain identity/history after confirmed removal; status is the tombstone.
    this.setRemoved(vaultPath)
  }

  computeFolderStatus(vaultFilePaths: string[]): DocStatus {
    let hasProcessing = false
    let hasFailed = false
    let hasRemoved = false
    let hasUnknown = false
    let processedCount = 0
    for (const path of vaultFilePaths) {
      const status = this.getStatus(path)
      if (status === 'processing') hasProcessing = true
      else if (status === 'failed') hasFailed = true
      else if (status === 'removed') hasRemoved = true
      else if (status === 'unknown') hasUnknown = true
      else processedCount++
    }
    if (hasProcessing) return 'processing'
    if (hasFailed) return 'failed'
    if (hasRemoved) return 'removed'
    if (processedCount === vaultFilePaths.length && vaultFilePaths.length > 0) {
      return 'processed'
    }
    if (hasUnknown) return 'unknown'
    return 'unknown'
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      const operation = this.writeQueue.then(async () => {
        await this.persistSnapshot(cloneStore(this.store))
      })
      this.writeQueue = operation.catch(() => undefined)
      void operation.catch((error) => {
        console.error(
          '[NeuralComposer] DocIndex: failed to save status file',
          error,
        )
      })
    }, 2000)
  }

  private registerSource(source: string | undefined, path: string): void {
    if (!source) return
    const existing = this.sourceMap.get(source)
    if (existing === undefined) this.sourceMap.set(source, path)
    else if (existing !== path) this.sourceMap.set(source, null)
  }

  private rebuildSourceMapSync(): void {
    this.sourceMap.clear()
    if (this.sourceNamespace === this.plugin.settings.lightRagVaultNamespace) {
      for (const [path, source] of this.vaultSources) {
        this.registerSource(source, path)
        if (path.includes('/') || this.unambiguousRootPaths.has(path)) {
          this.registerSource(path, path)
        }
      }
    }
    for (const [path, record] of Object.entries(this.currentRecords())) {
      this.registerSource(record.source, path)
      this.registerSource(record.docId, path)
      for (const alias of record.aliases ?? []) this.registerSource(alias, path)
      if (
        record.pending?.stage === 'upload_requested' ||
        record.pending?.stage === 'tracking'
      ) {
        this.registerSource(record.pending.source, path)
        this.registerSource(record.pending.docId, path)
      }
    }
    this.sourceMapBackendId = this.currentBackendId()
  }

  resolveSource(source: string): string | null {
    if (this.sourceMapBackendId !== this.currentBackendId()) {
      this.rebuildSourceMapSync()
    }
    if (!source) return null
    return this.sourceMap.get(source) ?? null
  }

  async rebuildSourceMap(): Promise<void> {
    if (!this.loaded) throw new Error('Document index has not been loaded')
    const backendId = this.currentBackendId()
    const namespace = this.plugin.settings.lightRagVaultNamespace
    const generation = ++this.sourceMapGeneration
    if (!backendId || !namespace) {
      this.rebuildSourceMapSync()
      return
    }
    const sources = new Map<string, string>()
    const basenameCounts = new Map<string, number>()
    const additions: Record<string, string> = {}
    for (const file of this.plugin.app.vault.getFiles()) {
      basenameCounts.set(file.name, (basenameCounts.get(file.name) ?? 0) + 1)
      const cached =
        namespace === this.sourceNamespace
          ? this.vaultSources.get(file.path)
          : undefined
      const source = cached ?? (await documentSourceName(namespace, file.path))
      sources.set(file.path, source)
      const record = this.currentRecords()[file.path]
      if (record && !record.source) additions[file.path] = source
    }
    if (
      this.destroyed ||
      generation !== this.sourceMapGeneration ||
      backendId !== this.currentBackendId() ||
      namespace !== this.plugin.settings.lightRagVaultNamespace
    ) {
      return
    }
    this.vaultSources = sources
    this.unambiguousRootPaths = new Set(
      [...sources.keys()].filter(
        (path) => !path.includes('/') && basenameCounts.get(path) === 1,
      ),
    )
    this.sourceNamespace = namespace
    if (Object.keys(additions).length === 0) {
      this.rebuildSourceMapSync()
      return
    }
    await this.enqueueStoreUpdate((next) => {
      const records = next.backends[backendId]?.records
      if (!records) return
      for (const [path, source] of Object.entries(additions)) {
        if (records[path] && !records[path].source)
          records[path].source = source
      }
    })
  }

  private notify(): void {
    this.onUpdate?.()
  }

  private getHeaders(
    apiKey = this.plugin.settings.lightRagApiKey,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (apiKey) headers['X-API-Key'] = apiKey
    return headers
  }

  private captureRequestScope(
    backendId = this.currentBackendId(),
  ): BackendRequestScope {
    if (!backendId || backendId !== this.currentBackendId()) {
      throw new Error('Document backend configuration changed before listing')
    }
    const serverUrl = this.plugin.settings.lightRagServerUrl
    const apiKey = this.plugin.settings.lightRagApiKey
    return {
      backendId,
      serverUrl,
      apiKey,
      headers: this.getHeaders(apiKey),
    }
  }

  private assertRequestScope(scope: BackendRequestScope): void {
    if (
      scope.backendId !== this.currentBackendId() ||
      scope.serverUrl !== this.plugin.settings.lightRagServerUrl ||
      scope.apiKey !== this.plugin.settings.lightRagApiKey
    ) {
      throw new Error('Document backend configuration changed during listing')
    }
  }

  async isServerOnline(): Promise<boolean> {
    try {
      const response = await requestUrl({
        url: `${this.plugin.settings.lightRagServerUrl}/health`,
        method: 'GET',
        headers: this.getHeaders(),
        throw: false,
      })
      return response.status === 200
    } catch {
      return false
    }
  }

  private parseDocuments(value: unknown): LRDoc[] {
    if (!Array.isArray(value) || !value.every(isLRDoc)) {
      throw new Error('Invalid document-list response')
    }
    return value
  }

  private async fetchViaPaginated(
    scope: BackendRequestScope,
  ): Promise<LRDoc[] | null> {
    const all: LRDoc[] = []
    const seenIds = new Set<string>()
    let expectedTotal: number | null = null
    let page = 1
    for (;;) {
      this.assertRequestScope(scope)
      const response = await requestUrl({
        url: `${scope.serverUrl}/documents/paginated`,
        method: 'POST',
        headers: scope.headers,
        body: JSON.stringify({
          page,
          page_size: PAGE_SIZE,
          sort_field: 'file_path',
          sort_direction: 'asc',
        }),
        throw: false,
      })
      this.assertRequestScope(scope)
      if (
        response.status === 404 ||
        response.status === 405 ||
        response.status === 501
      ) {
        if (page === 1) return null
        throw new Error('Paginated document listing became unavailable')
      }
      if (response.status >= 400) {
        throw new Error(`Document listing failed with HTTP ${response.status}`)
      }
      const body = response.json as unknown
      if (!isObject(body) || !isObject(body.pagination)) {
        throw new Error('Invalid paginated document response')
      }
      const pagination = body.pagination as unknown as Pagination
      if (
        !Number.isSafeInteger(pagination.page) ||
        !Number.isSafeInteger(pagination.page_size) ||
        !Number.isSafeInteger(pagination.total_count) ||
        !Number.isSafeInteger(pagination.total_pages) ||
        typeof pagination.has_next !== 'boolean' ||
        typeof pagination.has_prev !== 'boolean' ||
        pagination.page !== page ||
        pagination.page_size !== PAGE_SIZE ||
        pagination.total_count < 0 ||
        pagination.total_pages < 0
      ) {
        throw new Error('Invalid document pagination metadata')
      }
      if (expectedTotal === null) expectedTotal = pagination.total_count
      else if (pagination.total_count !== expectedTotal) {
        throw new Error('Document count changed during pagination')
      }
      const expectedPages =
        pagination.total_count === 0
          ? 0
          : Math.ceil(pagination.total_count / PAGE_SIZE)
      const hasExpectedPosition =
        pagination.total_pages === expectedPages &&
        page <= Math.max(1, expectedPages) &&
        pagination.has_prev === page > 1 &&
        pagination.has_next === page < expectedPages
      if (!hasExpectedPosition) {
        throw new Error('Inconsistent document pagination metadata')
      }

      const pageDocuments = this.parseDocuments(body.documents)
      const expectedPageCount = pagination.has_next
        ? PAGE_SIZE
        : pagination.total_count - PAGE_SIZE * (page - 1)
      if (expectedPageCount < 0 || pageDocuments.length !== expectedPageCount) {
        throw new Error('Incomplete paginated document response')
      }
      for (const document of pageDocuments) {
        if (seenIds.has(document.id)) {
          throw new Error('Duplicate document in paginated response')
        }
        seenIds.add(document.id)
      }
      all.push(...pageDocuments)
      this.assertRequestScope(scope)
      if (!pagination.has_next) {
        if (all.length !== pagination.total_count) {
          throw new Error('Incomplete paginated document response')
        }
        return all
      }
      page++
    }
  }

  private async fetchViaGrouped(scope: BackendRequestScope): Promise<LRDoc[]> {
    this.assertRequestScope(scope)
    const response = await requestUrl({
      url: `${scope.serverUrl}/documents`,
      method: 'GET',
      headers: scope.headers,
      throw: false,
    })
    this.assertRequestScope(scope)
    if (response.status >= 400) {
      throw new Error(`Document listing failed with HTTP ${response.status}`)
    }
    const body = response.json as unknown
    if (!isObject(body)) throw new Error('Invalid grouped document response')
    const values = Object.values(body)
    if (values.length === 0 || values.some((value) => !Array.isArray(value))) {
      throw new Error('Incomplete grouped document response')
    }
    const documents: LRDoc[] = []
    const seenIds = new Set<string>()
    for (const value of values) {
      for (const document of this.parseDocuments(value)) {
        if (seenIds.has(document.id)) {
          throw new Error('Duplicate document in grouped response')
        }
        seenIds.add(document.id)
        documents.push(document)
      }
    }
    this.assertRequestScope(scope)
    return documents
  }

  async listDocuments(backendId = this.currentBackendId()): Promise<LRDoc[]> {
    const scope = this.captureRequestScope(backendId)
    const documents = await this.fetchViaPaginated(scope)
    if (!documents) {
      throw new Error('Authoritative document listing is unavailable')
    }
    this.assertRequestScope(scope)
    return documents
  }

  private async fetchForSync(
    scope: BackendRequestScope,
  ): Promise<DocumentListing> {
    const paginated = await this.fetchViaPaginated(scope)
    if (paginated) return { documents: paginated, authoritative: true }
    return {
      documents: await this.fetchViaGrouped(scope),
      authoritative: false,
    }
  }

  private mapStatus(status: string): DocStatus {
    const upper = status.toUpperCase()
    if (upper === 'PROCESSED') return 'processed'
    if (upper === 'FAILED') return 'failed'
    if (
      upper === 'PENDING' ||
      upper === 'PARSING' ||
      upper === 'ANALYZING' ||
      upper === 'PREPROCESSED' ||
      upper === 'PROCESSING'
    ) {
      return 'processing'
    }
    return 'unknown'
  }

  async syncFromServer(): Promise<void> {
    const backendId = this.currentBackendId()
    if (!backendId || !this.loaded || this.writeLocked || this.destroyed) return
    const observedRecords = this.currentRecords()
    try {
      const scope = this.captureRequestScope(backendId)
      const { documents, authoritative } = await this.fetchForSync(scope)
      if (backendId !== this.currentBackendId()) return
      const records = this.currentRecords()
      const reconciled: Record<string, DocRecord> = {}
      let anyProcessing = false

      for (const [path, original] of Object.entries(records)) {
        if (
          !original.removeRequested &&
          (original.status === 'removed' ||
            (original.status === 'failed' && !original.pending))
        ) {
          reconciled[path] = cloneRecord(original)
          continue
        }
        const matches = new Map<string, LRDoc>()
        const acceptedPending =
          original.pending?.stage === 'upload_requested' ||
          original.pending?.stage === 'tracking'
        for (const document of documents) {
          const exactId = original.docId && document.id === original.docId
          const exactSource =
            original.source && document.file_path === original.source
          const exactAlias =
            original.aliases?.includes(document.file_path) ?? false
          const exactPending =
            acceptedPending &&
            (document.id === original.pending?.docId ||
              document.file_path === original.pending?.source)
          if (exactId || exactSource || exactAlias || exactPending) {
            matches.set(document.id, document)
          }
        }

        if (matches.size > 1) {
          reconciled[path] = cloneRecord(original)
          continue
        }
        const match = matches.values().next().value as LRDoc | undefined
        if (!match && (!authoritative || acceptedPending)) {
          reconciled[path] = cloneRecord(original)
          continue
        }
        if (original.removeRequested) {
          if (match) {
            const status = this.mapStatus(match.status)
            reconciled[path] = {
              ...cloneRecord(original),
              status,
              docId: match.id,
            }
            if (status === 'processing') anyProcessing = true
          } else {
            reconciled[path] = {
              ...cloneRecord(original),
              status: 'removed',
              docId: undefined,
              pending: undefined,
              removeRequested: undefined,
            }
          }
          continue
        }
        if (match) {
          const status = this.mapStatus(match.status)
          reconciled[path] = {
            ...cloneRecord(original),
            status,
            docId: match.id,
          }
          if (status === 'processing') anyProcessing = true
        } else if (original.pending) {
          reconciled[path] = cloneRecord(original)
        } else {
          reconciled[path] = { ...cloneRecord(original), status: 'unknown' }
        }
      }

      await this.enqueueStoreUpdate((next) => {
        // A status snapshot cannot replace a newer durable operation journal.
        if (this.currentRecords() !== observedRecords) return
        next.backends[backendId] = { records: reconciled }
      })
      if (anyProcessing && !this.pipelineTimer) this.startPipelineWatch(2000)
    } catch (error) {
      console.error('[NeuralComposer] DocIndex: syncFromServer error', error)
    }
  }

  startPipelineWatch(intervalMs = 1000): void {
    this.stopPipelineWatch()
    if (!this.destroyed) this.schedulePipelinePoll(intervalMs)
  }

  private schedulePipelinePoll(intervalMs: number): void {
    this.pipelineTimer = setTimeout(() => {
      this.pipelineTimer = null
      void this.doPipelinePoll(intervalMs)
    }, intervalMs)
  }

  private async doPipelinePoll(intervalMs: number): Promise<void> {
    if (this.destroyed) return
    try {
      const response = await requestUrl({
        url: `${this.plugin.settings.lightRagServerUrl}/documents/pipeline_status`,
        method: 'GET',
        headers: this.getHeaders(),
        throw: false,
      })
      if (response.status === 200 && isObject(response.json)) {
        if (response.json.busy === false) {
          await this.syncFromServer()
          return
        }
      }
    } catch {
      // A transient failure is not proof that accepted backend work stopped.
    }
    if (!this.destroyed) this.schedulePipelinePoll(intervalMs)
  }

  stopPipelineWatch(): void {
    if (this.pipelineTimer) {
      clearTimeout(this.pipelineTimer)
      this.pipelineTimer = null
    }
  }

  destroy(): void {
    this.destroyed = true
    this.stopPipelineWatch()
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      const operation = this.writeQueue.then(() =>
        this.persistSnapshot(cloneStore(this.store)),
      )
      this.writeQueue = operation.catch(() => undefined)
      void operation.catch((error) => {
        console.error(
          '[NeuralComposer] DocIndex: failed to flush status file',
          error,
        )
      })
    }
    this.onUpdate = null
    this.sourceMap.clear()
    this.vaultSources.clear()
    this.unambiguousRootPaths.clear()
  }
}
