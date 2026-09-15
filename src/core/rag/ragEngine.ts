import { App, Notice, TFile, requestUrl } from 'obsidian'
import type { RequestUrlResponse } from 'obsidian'

import { QueryProgressState } from '../../components/chat-view/QueryProgress'
import { VectorManager } from '../../database/modules/vector/VectorManager'
import { SelectEmbedding } from '../../database/schema'
import { NeuralComposerSettings } from '../../settings/schema/setting.types'
import { EmbeddingModelClient } from '../../types/embedding'
import { isExcludedFromGraphSync } from '../../utils/glob-utils'

import { DocIndexService, DocRecord, DocStatus } from './docIndexService'
import {
  IngestionResult,
  ParagraphCompatibility,
  PendingDocumentOperation,
  ProcessingPolicy,
  documentSourceName,
  isParagraphFile,
  paragraphUploadName,
  processingPolicy,
  sameProcessingPolicy,
} from './documentProcessing'
import { getEmbeddingModelClient } from './embedding'

// Helper type matching the method signature to avoid 'any' casting
type RagQueryResult = (Omit<SelectEmbedding, 'embedding'> & {
  similarity: number
})[]

/**
 * Releases whose native Markdown parser omits pipe-table header rows from the
 * block content that paragraph-semantic chunking consumes. Established by the
 * parser-only preservation corpus in `scripts/verify-paragraph-backend.py`
 * against every published release and unreleased `main`; none passed.
 */
const KNOWN_TABLE_HEADER_LOSING_VERSIONS: Record<string, true> = {
  '1.5.4': true,
  '1.5.5': true,
  '1.5.6': true,
  '1.5.7': true,
}

// Interface for internal results
type RagResult = {
  id: number
  model?: string
  path: string
  content: string
  similarity: number
  mtime?: number
  metadata?: {
    startLine: number
    endLine: number
    fileName?: string
    content?: string
  }
} & Partial<SelectEmbedding>

// FIX: New interface to type the API response and avoid 'any'
type LightRagAPIResponse = {
  response?: string
  references?: {
    reference_id?: string
    file_path?: string
    content?: string
  }[]
  [key: string]: unknown // Allow other props safely
}

/**
 * Count how many times reference [N] is explicitly cited in the response text.
 * LightRAG embeds markers like "[1]", "[2]" in the generated answer when
 * include_references=true, so this gives us a real signal of how much each
 * source contributed to the response.
 */
function countCitations(responseText: string, refNumber: number): number {
  const matches = responseText.match(new RegExp(`\\[${refNumber}\\]`, 'g'))
  return matches ? matches.length : 0
}

type IngestOptions = {
  intent?: 'new' | 'sync' | 'reprocess' | 'retry'
  policy?: ProcessingPolicy
  previousPath?: string
  signal?: AbortSignal
}

type LightRagDocument = {
  id: string
  file_path?: string | null
  status?: string
  track_id?: string | null
  error_msg?: string | null
  metadata?: Record<string, unknown> | null
}

function isLightRagDocument(value: unknown): value is LightRagDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string'
  )
}

type OperationOwnership = {
  backendId: string
  namespace: string
  serverUrl: string
  apiKey: string
}

type PreparedDocument = {
  data: ArrayBuffer
  mtime: number
  text?: string
}

type TrackOutcome =
  | {
      status: 'processed'
      document: LightRagDocument
      policyVerified: boolean
    }
  | {
      status: 'failed' | 'paused'
      message: string
      document?: LightRagDocument
    }

type PollTimer = number | NodeJS.Timeout
const TEXT_BASED_EXTENSIONS: Record<string, true> = {
  md: true,
  txt: true,
  html: true,
  htm: true,
  xml: true,
  json: true,
  yaml: true,
  yml: true,
  csv: true,
  tex: true,
  log: true,
  conf: true,
  ini: true,
  properties: true,
  sql: true,
  bat: true,
  sh: true,
  c: true,
  cpp: true,
  py: true,
  java: true,
  js: true,
  ts: true,
  swift: true,
  go: true,
  rb: true,
  php: true,
  css: true,
  scss: true,
  less: true,
}

const TRACK_ATTEMPTS = 120
const DELETE_CONFIRM_ATTEMPTS = 120
const POLL_INTERVAL_MS = 500

const CANONICAL_TRANSPORT_SOURCE = /^nc-[0-9a-f]{64}\.[a-z0-9]{1,16}$/

class SubmissionRejectedError extends Error {}

class AmbiguousMutationError extends Error {}

export class RAGEngine {
  private app: App
  private settings: NeuralComposerSettings
  private vectorManager: VectorManager | null = null
  private embeddingModel: EmbeddingModelClient | null = null
  private docIndexService: DocIndexService
  private restartServerCallback: () => Promise<void>
  private disposed = false
  private pollWaiters = new Map<PollTimer, () => void>()
  private compatibilityCache:
    | {
        backendId: string
        serverUrl: string
        apiKey: string
        value: ParagraphCompatibility
      }
    | undefined

  constructor(
    app: App,
    settings: NeuralComposerSettings,
    vectorManager: VectorManager,
    docIndexService: DocIndexService,
    restartServerCallback?: () => Promise<void>,
  ) {
    this.app = app
    this.settings = settings
    this.vectorManager = vectorManager
    this.docIndexService = docIndexService
    this.restartServerCallback =
      restartServerCallback || (() => Promise.resolve())
    this.embeddingModel = getEmbeddingModelClient({
      settings,
      embeddingModelId: settings.embeddingModelId,
    })
  }

  cleanup(): void {
    this.disposed = true
    for (const [timer, resolve] of this.pollWaiters ?? []) {
      clearTimeout(timer)
      resolve()
    }
    this.pollWaiters?.clear()
    this.embeddingModel = null
    this.vectorManager = null
  }

  setSettings(settings: NeuralComposerSettings): void {
    const backendChanged =
      settings.lightRagBackendIdentity !==
        this.settings.lightRagBackendIdentity ||
      settings.lightRagServerUrl !== this.settings.lightRagServerUrl ||
      settings.lightRagApiKey !== this.settings.lightRagApiKey
    this.settings = settings
    if (backendChanged) this.compatibilityCache = undefined
    this.embeddingModel = getEmbeddingModelClient({
      settings,
      embeddingModelId: settings.embeddingModelId,
    })
  }

  private getLightRagHeaders(
    contentType = 'application/json',
    apiKey = this.settings.lightRagApiKey,
  ): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': contentType }
    if (apiKey) headers['X-API-Key'] = apiKey
    return headers
  }

  private captureOwnership(): OperationOwnership {
    return {
      backendId: this.settings.lightRagBackendIdentity,
      namespace: this.settings.lightRagVaultNamespace,
      serverUrl: this.settings.lightRagServerUrl,
      apiKey: this.settings.lightRagApiKey,
    }
  }

  private isOwnershipStopped(
    ownership: OperationOwnership,
    signal?: AbortSignal,
  ): boolean {
    return (
      this.isStopped(signal, ownership.backendId) ||
      ownership.namespace !== this.settings.lightRagVaultNamespace ||
      ownership.serverUrl !== this.settings.lightRagServerUrl ||
      ownership.apiKey !== this.settings.lightRagApiKey
    )
  }

  private isStopped(signal?: AbortSignal, backendId?: string): boolean {
    return (
      this.disposed === true ||
      signal?.aborted === true ||
      (backendId !== undefined &&
        backendId !== this.settings.lightRagBackendIdentity)
    )
  }

  private waitForPoll(signal?: AbortSignal): Promise<void> {
    if (this.isStopped(signal)) return Promise.resolve()
    if (!this.pollWaiters) this.pollWaiters = new Map()
    return new Promise((resolve) => {
      const finish = () => {
        this.pollWaiters.delete(timer)
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, POLL_INTERVAL_MS)
      this.pollWaiters.set(timer, finish)
      signal?.addEventListener('abort', finish, { once: true })
    })
  }

  updateVaultIndex(
    _options: { reindexAll: boolean } = { reindexAll: false },
    _onQueryProgressChange?: (queryProgress: QueryProgressState) => void,
  ): Promise<void> {
    if (!this.embeddingModel)
      return Promise.reject(new Error('Embedding model is not set'))
    return Promise.resolve()
  }

  private async postMultipart(
    data: ArrayBuffer,
    filename: string,
    ownership: OperationOwnership,
  ): Promise<RequestUrlResponse> {
    const boundary = `----ObsidianBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
    const prePart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    const postPart = `\r\n--${boundary}--\r\n`
    const preBuffer = new TextEncoder().encode(prePart)
    const postBuffer = new TextEncoder().encode(postPart)
    const bodyBuffer = new Uint8Array(
      preBuffer.length + data.byteLength + postBuffer.length,
    )
    bodyBuffer.set(preBuffer)
    bodyBuffer.set(new Uint8Array(data), preBuffer.length)
    bodyBuffer.set(postBuffer, preBuffer.length + data.byteLength)

    return requestUrl({
      url: `${ownership.serverUrl}/documents/upload`,
      method: 'POST',
      headers: this.getLightRagHeaders(
        `multipart/form-data; boundary=${boundary}`,
        ownership.apiKey,
      ),
      body: bodyBuffer.buffer,
      throw: false,
    })
  }

  private uniqueLegacyPaths(
    documents: LightRagDocument[],
  ): Map<string, string> {
    const documentCounts = new Map<string, number>()
    for (const document of documents) {
      if (!document.file_path) continue
      const source = document.file_path.replace(/\\/g, '/')
      if (!source.includes('/')) {
        documentCounts.set(source, (documentCounts.get(source) ?? 0) + 1)
      }
    }

    const vaultFiles = new Map<string, TFile | null>()
    if (typeof this.app.vault.getFiles !== 'function') return new Map()
    for (const file of this.app.vault.getFiles()) {
      vaultFiles.set(file.name, vaultFiles.has(file.name) ? null : file)
    }

    const paths = new Map<string, string>()
    for (const [source, count] of documentCounts) {
      const file = vaultFiles.get(source)
      if (count === 1 && file) paths.set(source, file.path)
    }
    return paths
  }
  private resolveListedSource(
    source: string,
    legacyPaths: Map<string, string>,
  ): string | null {
    const managed = this.docIndexService.resolveSource(source)
    if (managed) return managed
    const normalized = source.replace(/\\/g, '/')
    if (normalized.includes('/')) {
      const exact = this.app.vault.getAbstractFileByPath(normalized)
      if (exact instanceof TFile) return exact.path
    }
    return legacyPaths.get(source) ?? null
  }

  async listAllDocumentPaths(): Promise<string[]> {
    const backendId = this.settings.lightRagBackendIdentity
    const documents = await this.docIndexService.listDocuments(backendId)
    if (this.isStopped(undefined, backendId)) return []
    const legacyPaths = this.uniqueLegacyPaths(documents)
    const paths = new Set<string>()
    for (const document of documents) {
      if (!document.file_path) continue
      const resolved = this.resolveListedSource(document.file_path, legacyPaths)
      if (resolved) paths.add(resolved)
    }
    return [...paths]
  }

  async getDocIdMap(): Promise<Map<string, string>> {
    const backendId = this.settings.lightRagBackendIdentity
    const documents = await this.docIndexService.listDocuments(backendId)
    if (this.isStopped(undefined, backendId)) return new Map()
    const legacyPaths = this.uniqueLegacyPaths(documents)
    const map = new Map<string, string>()
    for (const document of documents) {
      if (!document.file_path) continue
      const resolved = this.resolveListedSource(document.file_path, legacyPaths)
      if (resolved) {
        map.set(resolved, document.id)
        if (legacyPaths.get(document.file_path) === resolved) {
          map.set(document.file_path, document.id)
        }
      }
    }
    return map
  }

  async findDocIdByFilePath(
    filePath: string,
    fileName: string,
  ): Promise<string | null> {
    const backendId = this.settings.lightRagBackendIdentity
    const stored = this.docIndexService.getRecord(filePath, backendId)
    if (stored?.docId) return stored.docId

    const documents = await this.docIndexService.listDocuments(backendId)
    if (this.isStopped(undefined, backendId)) return null
    const exact = documents.filter(
      (document) =>
        document.file_path === filePath ||
        (document.file_path !== undefined &&
          document.file_path !== null &&
          this.docIndexService.resolveSource(document.file_path) === filePath),
    )
    if (exact.length === 1) return exact[0].id
    if (exact.length > 1) return null

    const legacy = documents.filter(
      (document) => document.file_path === fileName,
    )
    return legacy.length === 1 &&
      this.uniqueLegacyPaths(documents).get(fileName) === filePath
      ? legacy[0].id
      : null
  }

  private async requestDeletion(
    docIds: string[],
    ownership: OperationOwnership,
    signal?: AbortSignal,
  ): Promise<'started' | 'busy'> {
    if (this.isOwnershipStopped(ownership, signal)) {
      throw new SubmissionRejectedError('Deletion stopped before submission.')
    }
    let response: RequestUrlResponse
    try {
      response = await requestUrl({
        url: `${ownership.serverUrl}/documents/delete_document`,
        method: 'DELETE',
        headers: this.getLightRagHeaders('application/json', ownership.apiKey),
        body: JSON.stringify({
          doc_ids: docIds,
          delete_file: false,
          delete_llm_cache: true,
        }),
        throw: false,
      })
    } catch (error) {
      throw new AmbiguousMutationError(
        `Deletion acknowledgement was lost: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SubmissionRejectedError(
        `Deletion failed with ${response.status}: ${response.text}`,
      )
    }
    const data = response.json as { status?: unknown; message?: unknown }
    if (data.status === 'deletion_started') return 'started'
    if (data.status === 'busy' || data.status === 'not_allowed') return 'busy'
    throw new SubmissionRejectedError('Deletion returned an unknown status')
  }

  private async waitForDocumentsAbsent(
    docIds: string[],
    signal: AbortSignal | undefined,
    ownership: OperationOwnership,
  ): Promise<boolean> {
    const remaining = new Set(docIds)
    for (let attempt = 0; attempt < DELETE_CONFIRM_ATTEMPTS; attempt++) {
      if (this.isOwnershipStopped(ownership, signal)) return false
      const documents = await this.docIndexService.listDocuments(
        ownership.backendId,
      )
      if (this.isOwnershipStopped(ownership, signal)) return false
      if (!documents.some((document) => remaining.has(document.id))) return true
      await this.waitForPoll(signal)
    }
    return false
  }

  private recordHasSource(record: DocRecord, source: string): boolean {
    const normalized = source.replace(/\\/g, '/')
    const matches = (candidate: string | undefined): boolean =>
      candidate?.replace(/\\/g, '/') === normalized
    return (
      matches(record.source) ||
      matches(record.pending?.source) ||
      record.aliases?.some(matches) === true
    )
  }

  private hasAmbiguousBareSource(
    documents: LightRagDocument[],
    path: string,
    record: DocRecord,
    legacyPaths: Map<string, string>,
  ): boolean {
    if (
      record.docId ||
      record.pending?.docId ||
      record.pending?.previousDocId
    ) {
      return false
    }
    const sources = [
      record.source,
      record.pending?.source,
      ...(record.aliases ?? []),
    ]
    return sources.some((candidate) => {
      if (!candidate) return false
      const source = candidate.replace(/\\/g, '/')
      if (source.includes('/') || CANONICAL_TRANSPORT_SOURCE.test(source)) {
        return false
      }
      return (
        legacyPaths.get(source) !== path &&
        documents.some(
          (document) => document.file_path?.replace(/\\/g, '/') === source,
        )
      )
    })
  }

  private documentMatchesPath(
    document: LightRagDocument,
    path: string,
    record: DocRecord,
    legacyPaths: Map<string, string>,
  ): boolean {
    if (
      document.id === record.docId ||
      document.id === record.pending?.docId ||
      document.id === record.pending?.previousDocId
    ) {
      return true
    }
    if (!document.file_path) return false
    const source = document.file_path.replace(/\\/g, '/')
    if (CANONICAL_TRANSPORT_SOURCE.test(source)) {
      return (
        this.recordHasSource(record, source) ||
        this.docIndexService.resolveSource(document.file_path) === path
      )
    }
    if (source.includes('/')) {
      return (
        source === path ||
        this.recordHasSource(record, source) ||
        this.docIndexService.resolveSource(document.file_path) === path
      )
    }
    if (
      record.docId ||
      record.pending?.docId ||
      record.pending?.previousDocId
    ) {
      return false
    }
    return legacyPaths.get(source) === path
  }

  private removedRecord(record: DocRecord): DocRecord {
    return {
      ...record,
      status: 'removed',
      docId: undefined,
      pending: undefined,
      removeRequested: undefined,
    }
  }

  async deleteDocumentsByPaths(paths: string[]): Promise<boolean> {
    return this.deleteDocumentsByPathsWithOwnership(
      paths,
      this.captureOwnership(),
    )
  }

  private async deleteDocumentsByPathsWithOwnership(
    paths: string[],
    ownership: OperationOwnership,
  ): Promise<boolean> {
    if (paths.length === 0) return true
    if (paths.some((path) => path.length === 0)) return false
    if (this.isOwnershipStopped(ownership)) return false
    const uniquePaths = [...new Set(paths)]
    const backendId = ownership.backendId
    try {
      for (const path of uniquePaths) {
        if (this.isOwnershipStopped(ownership)) return false
        let record = this.docIndexService.getRecord(path, backendId)
        if (!record) {
          const source = await documentSourceName(ownership.namespace, path)
          if (this.isOwnershipStopped(ownership)) return false
          record = { status: 'unknown', source }
        }
        if (record.status !== 'removed') {
          await this.docIndexService.saveRecord(
            path,
            { ...record, removeRequested: true },
            backendId,
          )
        }
        if (this.isOwnershipStopped(ownership)) return false
      }

      const documents = await this.docIndexService.listDocuments(backendId)
      if (this.isOwnershipStopped(ownership)) return false
      const legacyPaths = this.uniqueLegacyPaths(documents)
      const matchedIds = new Set<string>()
      const settledAcceptedPaths = new Set<string>()

      for (const path of uniquePaths) {
        const record = this.docIndexService.getRecord(path, backendId)
        if (!record) return false
        const matches = documents.filter((document) =>
          this.documentMatchesPath(document, path, record, legacyPaths),
        )
        if (
          matches.length === 0 &&
          this.hasAmbiguousBareSource(documents, path, record, legacyPaths)
        ) {
          return false
        }
        for (const document of matches) matchedIds.add(document.id)
        const accepted =
          record.pending?.stage === 'upload_requested' ||
          record.pending?.stage === 'tracking'
        if (accepted) {
          if (matches.length === 0) return false
          settledAcceptedPaths.add(path)
        }
      }

      if (matchedIds.size > 0) {
        let confirmed = false
        const ids = [...matchedIds]
        try {
          const outcome = await this.requestDeletion(ids, ownership)
          if (outcome !== 'started') return false
          confirmed = await this.waitForDocumentsAbsent(
            ids,
            undefined,
            ownership,
          )
        } catch (error) {
          if (!(error instanceof AmbiguousMutationError)) return false
          if (this.isOwnershipStopped(ownership)) return false
          const current = await this.docIndexService.listDocuments(backendId)
          if (this.isOwnershipStopped(ownership)) return false
          confirmed = !current.some((document) => matchedIds.has(document.id))
        }
        if (!confirmed) return false
      }

      const finalDocuments =
        matchedIds.size > 0
          ? await this.docIndexService.listDocuments(backendId)
          : documents
      if (this.isOwnershipStopped(ownership)) return false
      const finalLegacyPaths = this.uniqueLegacyPaths(finalDocuments)
      for (const path of uniquePaths) {
        const latest = this.docIndexService.getRecord(path, backendId)
        if (!latest || (!latest.removeRequested && latest.status !== 'removed'))
          return false
        if (
          finalDocuments.some((document) =>
            this.documentMatchesPath(document, path, latest, finalLegacyPaths),
          )
        ) {
          return false
        }
        const accepted =
          latest.pending?.stage === 'upload_requested' ||
          latest.pending?.stage === 'tracking'
        if (accepted && !settledAcceptedPaths.has(path)) return false
      }

      for (const path of uniquePaths) {
        const latest = this.docIndexService.getRecord(path, backendId)
        if (!latest || (!latest.removeRequested && latest.status !== 'removed'))
          return false
        await this.docIndexService.saveRecord(
          path,
          this.removedRecord(latest),
          backendId,
        )
        if (this.isOwnershipStopped(ownership)) return false
      }
      return true
    } catch {
      return false
    }
  }

  async deleteDocumentsByIds(docIds: string[]): Promise<boolean> {
    const uniqueIds = [...new Set(docIds)]
    if (uniqueIds.length === 0) return true
    const requested = new Set(uniqueIds)
    const ownership = this.captureOwnership()
    const backendId = ownership.backendId
    const records = Object.entries(
      this.docIndexService.getRecords(backendId),
    ).filter(
      ([, record]) =>
        (record.docId && requested.has(record.docId)) ||
        (record.pending?.docId && requested.has(record.pending.docId)),
    )
    try {
      for (const [path, record] of records) {
        await this.docIndexService.saveRecord(
          path,
          { ...record, removeRequested: true },
          backendId,
        )
      }
      if (this.isOwnershipStopped(ownership)) return false

      let documents = await this.docIndexService.listDocuments(backendId)
      if (this.isOwnershipStopped(ownership)) return false
      const presentIds = uniqueIds.filter((id) =>
        documents.some((document) => document.id === id),
      )
      if (presentIds.length > 0) {
        let confirmed = false
        try {
          const outcome = await this.requestDeletion(presentIds, ownership)
          if (outcome !== 'started') return false
          confirmed = await this.waitForDocumentsAbsent(
            presentIds,
            undefined,
            ownership,
          )
        } catch (error) {
          if (!(error instanceof AmbiguousMutationError)) return false
          if (this.isOwnershipStopped(ownership)) return false
          documents = await this.docIndexService.listDocuments(backendId)
          if (this.isOwnershipStopped(ownership)) return false
          confirmed = !documents.some((document) => requested.has(document.id))
        }
        if (!confirmed) return false
      }

      for (const [path, record] of records) {
        const latest = this.docIndexService.getRecord(path, backendId) ?? record
        await this.docIndexService.saveRecord(
          path,
          this.removedRecord(latest),
          backendId,
        )
      }
      return !this.isOwnershipStopped(ownership)
    } catch {
      return false
    }
  }

  async deleteDocumentByFilePath(
    filePath: string,
    _fileName: string,
  ): Promise<boolean> {
    return this.deleteDocumentsByPaths([filePath])
  }

  async listDocumentCandidates(
    file: TFile,
  ): Promise<{ id: string; source: string; status: string }[]> {
    const backendId = this.settings.lightRagBackendIdentity
    const documents = await this.docIndexService.listDocuments(backendId)
    if (this.isStopped(undefined, backendId)) return []
    const candidates: { id: string; source: string; status: string }[] = []
    for (const document of documents) {
      if (!document.file_path) continue
      const normalized = document.file_path.replace(/\\/g, '/')
      if (
        normalized === file.path ||
        normalized.slice(normalized.lastIndexOf('/') + 1) === file.name
      ) {
        candidates.push({
          id: document.id,
          source: document.file_path,
          status: document.status ?? 'UNKNOWN',
        })
      }
    }
    return candidates
  }

  async bindDocument(file: TFile, docId: string): Promise<void> {
    const backendId = this.settings.lightRagBackendIdentity
    const documents = await this.docIndexService.listDocuments(backendId)
    if (this.isStopped(undefined, backendId)) {
      throw new Error('Backend ownership changed during document binding')
    }
    const exact = documents.filter((document) => document.id === docId)
    if (exact.length !== 1) {
      throw new Error(
        `Document ${docId} is not uniquely present on the backend`,
      )
    }
    const document = exact[0]
    if (!document.file_path) {
      throw new Error(`Document ${docId} has no authoritative source`)
    }
    const source = document.file_path
    const normalized = source.replace(/\\/g, '/')
    if (
      normalized !== file.path &&
      normalized.slice(normalized.lastIndexOf('/') + 1) !== file.name
    ) {
      throw new Error(`Document ${docId} is not a candidate for ${file.path}`)
    }
    for (const [path, record] of Object.entries(
      this.docIndexService.getRecords(backendId),
    )) {
      if (
        path !== file.path &&
        (record.docId === docId ||
          record.source === source ||
          record.aliases?.includes(source) === true ||
          record.pending?.docId === docId ||
          record.pending?.source === source)
      ) {
        throw new Error(`Document ${docId} is already mapped to ${path}`)
      }
    }
    const current = this.docIndexService.getRecord(file.path, backendId)
    const recoveredPolicy = this.policyFromDocument(document)
    await this.docIndexService.saveRecord(
      file.path,
      {
        ...current,
        status: this.mapServerStatus(document.status),
        docId,
        source,
        policy: recoveredPolicy,
        pending: undefined,
      },
      backendId,
    )
  }

  async getParagraphCompatibility(): Promise<ParagraphCompatibility> {
    const ownership = this.captureOwnership()
    if (
      this.compatibilityCache &&
      this.compatibilityCache.backendId === ownership.backendId &&
      this.compatibilityCache.serverUrl === ownership.serverUrl &&
      this.compatibilityCache.apiKey === ownership.apiKey
    ) {
      return this.compatibilityCache.value
    }

    let value: ParagraphCompatibility
    try {
      const headers = this.getLightRagHeaders(
        'application/json',
        ownership.apiKey,
      )
      const health = await requestUrl({
        url: `${ownership.serverUrl}/health`,
        method: 'GET',
        headers,
        throw: false,
      })
      if (this.isOwnershipStopped(ownership)) {
        return {
          status: 'unverified',
          message: 'Backend ownership changed during compatibility discovery.',
        }
      }
      if (health.status < 200 || health.status >= 300) {
        throw new Error(`Health check returned ${health.status}`)
      }
      const healthBody = health.json as { core_version?: unknown }
      const version =
        typeof healthBody.core_version === 'string'
          ? healthBody.core_version.replace(/^v/, '')
          : undefined

      const supported = await requestUrl({
        url: `${ownership.serverUrl}/documents/supported_file_types`,
        method: 'GET',
        headers,
        throw: false,
      })
      if (this.isOwnershipStopped(ownership)) {
        return {
          status: 'unverified',
          message: 'Backend ownership changed during compatibility discovery.',
        }
      }
      if (supported.status < 200 || supported.status >= 300) {
        throw new Error(`Supported-file check returned ${supported.status}`)
      }
      const supportedBody = supported.json as {
        engines?: Record<string, unknown>
      }
      const native = supportedBody.engines?.native
      const nativeTypes = Array.isArray(native)
        ? native.filter((extension): extension is string => {
            return typeof extension === 'string'
          })
        : []
      if (!nativeTypes.includes('.md') || !nativeTypes.includes('.docx')) {
        value = {
          status: 'unsupported',
          version,
          message:
            'This backend does not advertise native Markdown and DOCX parsing.',
        }
      } else if (
        version !== undefined &&
        KNOWN_TABLE_HEADER_LOSING_VERSIONS[version]
      ) {
        value = {
          status: 'unsupported',
          version,
          message: `LightRAG ${version} omits Markdown table headers from native paragraph chunks, as do 1.5.4 through 1.5.7 and unreleased main. Ingestion is blocked until an upstream fix passes preservation checks.`,
        }
      } else {
        value = {
          status: 'unverified',
          version,
          message:
            'No upstream release has passed paragraph content-preservation checks. Every release that supports native Markdown (1.5.4 through 1.5.7) and unreleased main lose Markdown table headers.',
        }
      }
    } catch (error) {
      value = {
        status: 'unverified',
        message: `Could not verify native paragraph support: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    this.compatibilityCache =
      value.status === 'unverified' || this.isOwnershipStopped(ownership)
        ? undefined
        : {
            backendId: ownership.backendId,
            serverUrl: ownership.serverUrl,
            apiKey: ownership.apiKey,
            value,
          }
    return value
  }

  private async prepareFile(
    file: TFile,
    policy: ProcessingPolicy,
  ): Promise<PreparedDocument> {
    const extension = file.extension.toLowerCase()
    const asText =
      policy.mode === 'legacy' && extension in TEXT_BASED_EXTENSIONS
    let mtime = file.stat.mtime
    for (let attempt = 0; attempt < 3; attempt++) {
      if (asText) {
        const text = await this.app.vault.read(file)
        if (file.stat.mtime === mtime) {
          const finalText =
            policy.mode === 'legacy' && extension === 'md'
              ? `Title: ${file.basename}\n\n${text}`
              : text
          const bytes = new TextEncoder().encode(finalText)
          const data = new ArrayBuffer(bytes.byteLength)
          new Uint8Array(data).set(bytes)
          return {
            text: finalText,
            data,
            mtime,
          }
        }
      } else {
        const data = await this.app.vault.readBinary(file)
        if (file.stat.mtime === mtime) return { data, mtime }
      }
      mtime = file.stat.mtime
    }
    throw new Error('Source kept changing while it was being read')
  }

  private async submitPrepared(
    prepared: PreparedDocument,
    source: string,
    policy: ProcessingPolicy,
    ownership: OperationOwnership,
    signal?: AbortSignal,
  ): Promise<string> {
    if (
      this.isOwnershipStopped(ownership, signal) ||
      (policy.mode === 'paragraph' &&
        this.settings.lightRagImageDownloadsDisabledFor !== ownership.backendId)
    ) {
      throw new SubmissionRejectedError('Upload stopped before submission.')
    }
    let response: RequestUrlResponse
    try {
      if (policy.mode === 'paragraph') {
        response = await this.postMultipart(
          prepared.data,
          paragraphUploadName(source, policy),
          ownership,
        )
      } else if (prepared.text !== undefined) {
        response = await requestUrl({
          url: `${ownership.serverUrl}/documents/texts`,
          method: 'POST',
          headers: this.getLightRagHeaders(
            'application/json',
            ownership.apiKey,
          ),
          body: JSON.stringify({
            texts: [prepared.text],
            file_sources: [source],
            chunking: {
              strategy: 'fixed_token',
              params: {
                chunk_token_size: policy.chunkSize,
                chunk_overlap_token_size: policy.chunkOverlap,
              },
            },
          }),
          throw: false,
        })
      } else {
        response = await this.postMultipart(prepared.data, source, ownership)
      }
    } catch (error) {
      throw new AmbiguousMutationError(
        `Submission acknowledgement was lost: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (response.status < 200 || response.status >= 300) {
      throw new SubmissionRejectedError(
        `Submission failed with ${response.status}: ${response.text}`,
      )
    }
    const data = response.json as {
      status?: unknown
      track_id?: unknown
      message?: unknown
    }
    if (
      data.status !== 'success' ||
      typeof data.track_id !== 'string' ||
      !data.track_id
    ) {
      throw new SubmissionRejectedError(
        typeof data.message === 'string'
          ? data.message
          : 'Submission was not accepted for tracking',
      )
    }
    return data.track_id
  }

  private policyFromDocument(
    document: LightRagDocument,
  ): ProcessingPolicy | undefined {
    const metadata = document.metadata
    if (typeof metadata?.chunk_opts !== 'string') return undefined
    let chunkSize: number | undefined
    let chunkOverlap: number | undefined
    let dropReferences: string | undefined
    for (const option of metadata.chunk_opts.split(', ')) {
      const separator = option.indexOf('=')
      if (separator < 1) continue
      const key = option.slice(0, separator)
      const value = option.slice(separator + 1)
      if (key === 'size') chunkSize = Number(value)
      else if (key === 'overlap') chunkOverlap = Number(value)
      else if (key === 'drop_rf') dropReferences = value
    }
    if (
      chunkSize === undefined ||
      chunkOverlap === undefined ||
      !Number.isInteger(chunkSize) ||
      !Number.isInteger(chunkOverlap) ||
      chunkSize < 1 ||
      chunkOverlap < 0 ||
      chunkOverlap >= chunkSize
    ) {
      return undefined
    }

    const parseEngine = metadata.parse_engine
    const processOptions = metadata.process_options
    if (
      typeof parseEngine === 'string' &&
      (parseEngine === 'native' || parseEngine.startsWith('native(')) &&
      typeof processOptions === 'string' &&
      processOptions.includes('P') &&
      metadata.parse_format === 'lightrag' &&
      metadata.chunk_method === 'paragraph_semantic' &&
      dropReferences === 'False'
    ) {
      return {
        mode: 'paragraph',
        chunkSize,
        chunkOverlap,
      }
    }
    if (metadata.chunk_method === 'fixed_token' && processOptions === 'F') {
      return {
        mode: 'legacy',
        chunkSize,
        chunkOverlap,
      }
    }
    return undefined
  }

  private paragraphResultMatches(
    document: LightRagDocument,
    policy: ProcessingPolicy,
  ): boolean {
    const recovered = this.policyFromDocument(document)
    return (
      recovered?.mode === 'paragraph' && sameProcessingPolicy(recovered, policy)
    )
  }

  private ambiguousPolicyMatches(
    document: LightRagDocument,
    source: string,
    policy: ProcessingPolicy,
  ): boolean {
    if (document.file_path !== source) return false
    const recovered = this.policyFromDocument(document)
    if (!recovered || !sameProcessingPolicy(recovered, policy)) return false
    if (policy.mode === 'legacy') return recovered.mode === 'legacy'
    return (
      recovered.mode === 'paragraph' &&
      document.metadata?.source_file === paragraphUploadName(source, policy)
    )
  }
  private async trackSubmission(
    trackId: string,
    source: string,
    policy: ProcessingPolicy,
    signal: AbortSignal | undefined,
    ownership: OperationOwnership,
  ): Promise<TrackOutcome> {
    for (let attempt = 0; attempt < TRACK_ATTEMPTS; attempt++) {
      if (this.isOwnershipStopped(ownership, signal)) {
        return {
          status: 'paused',
          message: 'Tracking paused after cancellation or backend change.',
        }
      }
      let response: RequestUrlResponse
      try {
        response = await requestUrl({
          url: `${ownership.serverUrl}/documents/track_status/${encodeURIComponent(trackId)}`,
          method: 'GET',
          headers: this.getLightRagHeaders(
            'application/json',
            ownership.apiKey,
          ),
          throw: false,
        })
      } catch (error) {
        return {
          status: 'paused',
          message: `Tracking became unavailable: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      if (this.isOwnershipStopped(ownership, signal)) {
        return {
          status: 'paused',
          message: 'Tracking paused after cancellation or backend change.',
        }
      }
      if (response.status < 200 || response.status >= 300) {
        return {
          status: 'paused',
          message: `Tracking failed with ${response.status}: ${response.text}`,
        }
      }
      const body = response.json as { documents?: unknown }
      if (
        !Array.isArray(body.documents) ||
        !body.documents.every(isLightRagDocument)
      ) {
        return {
          status: 'paused',
          message: 'Tracking returned an incomplete response.',
        }
      }
      const documents = body.documents
      const exact = documents.filter(
        (document) => document.file_path === source,
      )
      if (exact.length > 1) {
        return {
          status: 'paused',
          message: 'Tracking found conflicting documents for the source.',
        }
      }
      if (documents.length > 0 && exact.length === 0) {
        return {
          status: 'paused',
          message: 'Tracking resolved to an unexpected document source.',
        }
      }
      if (exact.length === 1) {
        const document = exact[0]
        const status = (document.status ?? '').toUpperCase()
        if (status === 'PROCESSED') {
          const recovered = this.policyFromDocument(document)
          if (
            policy.mode === 'paragraph' &&
            !this.paragraphResultMatches(document, policy)
          ) {
            return {
              status: 'paused',
              document,
              message:
                'The backend processed the document without verified native paragraph parsing.',
            }
          }
          if (recovered && !sameProcessingPolicy(recovered, policy)) {
            return {
              status: 'paused',
              document,
              message:
                'The backend processed the document with a different policy.',
            }
          }
          return {
            status: 'processed',
            document,
            policyVerified: recovered !== undefined,
          }
        }
        if (status === 'FAILED') {
          return {
            status: 'failed',
            document,
            message: document.error_msg || 'LightRAG processing failed.',
          }
        }
      }
      await this.waitForPoll(signal)
    }
    return {
      status: 'paused',
      message: 'Document processing did not reach a terminal state in time.',
    }
  }

  private mapServerStatus(status: string | undefined): DocStatus {
    const normalized = (status ?? '').toUpperCase()
    if (normalized === 'PROCESSED') return 'processed'
    if (normalized === 'FAILED') return 'failed'
    return 'processing'
  }

  private recordWithPending(
    record: DocRecord,
    pending: PendingDocumentOperation,
    status?: DocStatus,
  ): DocRecord {
    const operationStatus =
      status ??
      (record.removeRequested
        ? record.status
        : pending.kind === 'ingest' ||
            pending.stage === 'delete_confirmed' ||
            pending.stage === 'upload_requested' ||
            pending.stage === 'tracking'
          ? 'processing'
          : record.status)
    return {
      ...record,
      status: operationStatus,
      source:
        record.source ??
        (pending.kind === 'ingest' ? pending.source : undefined),
      pending,
    }
  }

  private async pauseOperation(
    path: string,
    record: DocRecord,
    pending: PendingDocumentOperation,
    message: string,
  ): Promise<IngestionResult> {
    const paused = { ...pending, paused: true, error: message }
    await this.docIndexService.saveRecord(
      path,
      this.recordWithPending(record, paused),
      pending.backendId,
    )
    return { status: 'paused', path, message }
  }

  private async finishTrackedOperation(
    path: string,
    record: DocRecord,
    pending: PendingDocumentOperation,
    outcome: TrackOutcome,
    ownership: OperationOwnership,
  ): Promise<IngestionResult> {
    const latest =
      this.docIndexService.getRecord(path, pending.backendId) ?? record
    if (latest.status === 'removed') {
      return {
        status: 'paused',
        path,
        message:
          'Tracking completed after authoritative removal; the tombstone was preserved.',
      }
    }
    if (
      outcome.status === 'paused' &&
      !outcome.document &&
      !this.isOwnershipStopped(ownership)
    ) {
      return this.reconcileAmbiguousUpload(
        path,
        latest,
        pending,
        outcome.message,
        ownership,
      )
    }
    if (outcome.status !== 'processed') {
      const paused = {
        ...pending,
        paused: true,
        error: outcome.message,
        docId: outcome.document?.id ?? pending.docId,
      }
      const failedRecord = this.recordWithPending(
        {
          ...latest,
          docId: outcome.document?.id ?? latest.docId,
        },
        paused,
        outcome.status === 'failed' ? 'failed' : undefined,
      )
      await this.docIndexService.saveRecord(
        path,
        failedRecord,
        pending.backendId,
      )
      if (latest.removeRequested) {
        if (!this.isOwnershipStopped(ownership)) {
          await this.deleteDocumentsByPathsWithOwnership([path], ownership)
        }
        return {
          status: 'paused',
          path,
          docId: outcome.document?.id,
          message: 'Tracking settled; explicit removal remains pending.',
        }
      }
      return {
        status: outcome.status,
        path,
        docId: outcome.document?.id,
        message: outcome.message,
      }
    }

    const aliases = new Set(latest.aliases ?? [])
    if (latest.source && latest.source !== pending.source) {
      aliases.add(latest.source)
    }
    const completed: DocRecord = {
      ...latest,
      status: 'processed',
      docId: outcome.document.id,
      mtime: pending.mtime,
      source: pending.source,
      policy: outcome.policyVerified ? pending.policy : undefined,
      pending: undefined,
      removeRequested: latest.removeRequested,
      aliases: aliases.size > 0 ? [...aliases] : latest.aliases,
    }
    await this.docIndexService.saveRecord(path, completed, pending.backendId)
    if (latest.removeRequested) {
      if (!this.isOwnershipStopped(ownership)) {
        await this.deleteDocumentsByPathsWithOwnership([path], ownership)
      }
      return {
        status: 'paused',
        path,
        docId: outcome.document.id,
        message: 'Tracking completed; explicit removal remains pending.',
      }
    }
    const result: IngestionResult = {
      status: 'processed',
      path,
      docId: outcome.document.id,
    }
    if (!outcome.policyVerified) {
      result.message =
        'Processing completed, but the backend did not expose enough metadata to verify the captured policy; automatic replacement is paused.'
    }
    const vaultFile = this.app.vault.getAbstractFileByPath(path)
    if (vaultFile instanceof TFile && vaultFile.stat.mtime !== pending.mtime) {
      const changed =
        'The indexed snapshot completed, but the note has changed and remains eligible for synchronization.'
      result.message = result.message ? `${result.message} ${changed}` : changed
    }
    return result
  }

  private async reconcileAmbiguousUpload(
    path: string,
    record: DocRecord,
    pending: PendingDocumentOperation,
    message: string,
    ownership: OperationOwnership,
  ): Promise<IngestionResult> {
    if (this.isOwnershipStopped(ownership)) {
      return this.pauseOperation(
        path,
        record,
        pending,
        'Backend ownership changed; reconciliation is paused.',
      )
    }
    try {
      const documents = await this.docIndexService.listDocuments(
        pending.backendId,
      )
      if (this.isOwnershipStopped(ownership)) {
        return this.pauseOperation(
          path,
          record,
          pending,
          'Backend ownership changed; reconciliation is paused.',
        )
      }
      const exact = documents.filter(
        (document) => document.file_path === pending.source,
      )
      if (exact.length === 1) {
        const document = exact[0]
        const status = (document.status ?? '').toUpperCase()
        if (
          status === 'PROCESSED' &&
          this.ambiguousPolicyMatches(document, pending.source, pending.policy)
        ) {
          return this.finishTrackedOperation(
            path,
            record,
            pending,
            {
              status: 'processed',
              document,
              policyVerified: true,
            },
            ownership,
          )
        }
        if (status === 'FAILED') {
          return this.finishTrackedOperation(
            path,
            record,
            pending,
            {
              status: 'failed',
              document,
              message: document.error_msg || 'LightRAG processing failed.',
            },
            ownership,
          )
        }
        const reconciled: PendingDocumentOperation = {
          ...pending,
          stage: 'tracking',
          docId: document.id,
        }
        return this.pauseOperation(
          path,
          record,
          reconciled,
          status === 'PROCESSED'
            ? 'The accepted document does not prove the captured processing policy.'
            : `${message} The accepted document is still ${status || 'pending'}.`,
        )
      }
      const conflict =
        exact.length > 1
          ? ' Conflicting documents now use the transport source.'
          : ''
      return this.pauseOperation(path, record, pending, message + conflict)
    } catch (error) {
      return this.pauseOperation(
        path,
        record,
        pending,
        `${message} Reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async uploadAndTrack(
    file: TFile,
    operationPath: string,
    prepared: PreparedDocument,
    record: DocRecord,
    pending: PendingDocumentOperation,
    signal: AbortSignal | undefined,
    ownership: OperationOwnership,
  ): Promise<IngestionResult> {
    if (
      ownership.backendId !== pending.backendId ||
      this.isOwnershipStopped(ownership, signal)
    ) {
      return this.pauseOperation(
        operationPath,
        record,
        pending,
        'Backend ownership changed before upload.',
      )
    }
    if (
      isExcludedFromGraphSync(operationPath, {
        excludePatterns: this.settings.lightRagExcludePatterns,
        excludeHiddenFiles: this.settings.lightRagExcludeHiddenFiles,
      })
    ) {
      return this.pauseOperation(
        operationPath,
        record,
        pending,
        'The source is excluded; no upload was scheduled.',
      )
    }
    if (pending.policy.mode === 'paragraph') {
      if (
        this.settings.lightRagImageDownloadsDisabledFor !== pending.backendId
      ) {
        return this.pauseOperation(
          operationPath,
          record,
          pending,
          'Paragraph privacy acknowledgement changed before upload.',
        )
      }
      const compatibility = await this.getParagraphCompatibility()
      if (compatibility.status !== 'supported') {
        return this.pauseOperation(
          operationPath,
          record,
          pending,
          compatibility.message,
        )
      }
      if (this.isOwnershipStopped(ownership, signal)) {
        return this.pauseOperation(
          operationPath,
          record,
          pending,
          'Backend ownership changed during compatibility discovery.',
        )
      }
    }
    if (this.isOwnershipStopped(ownership, signal)) {
      return this.pauseOperation(
        operationPath,
        record,
        pending,
        'The operation was cancelled before upload.',
      )
    }
    if (file.stat.mtime !== prepared.mtime) {
      prepared = await this.prepareFile(file, pending.policy)
      pending = { ...pending, mtime: prepared.mtime }
      if (this.isOwnershipStopped(ownership, signal)) {
        return this.pauseOperation(
          operationPath,
          record,
          pending,
          'Backend ownership changed while reading the source.',
        )
      }
    }
    const beforeRequest = this.docIndexService.getRecord(
      operationPath,
      pending.backendId,
    )
    if (beforeRequest?.removeRequested || beforeRequest?.status === 'removed') {
      return {
        status: 'paused',
        path: operationPath,
        message: 'Explicit removal took precedence before upload.',
      }
    }
    pending = {
      ...pending,
      stage: 'upload_requested',
      paused: undefined,
      error: undefined,
    }
    await this.docIndexService.saveRecord(
      operationPath,
      this.recordWithPending(record, pending),
      pending.backendId,
    )
    if (this.isOwnershipStopped(ownership, signal)) {
      return this.pauseOperation(
        operationPath,
        record,
        {
          ...pending,
          stage: pending.kind === 'ingest' ? 'prepared' : 'delete_confirmed',
        },
        'Upload stopped before submission.',
      )
    }
    const afterCheckpoint = this.docIndexService.getRecord(
      operationPath,
      pending.backendId,
    )
    if (afterCheckpoint?.status === 'removed') {
      return {
        status: 'paused',
        path: operationPath,
        message: 'Authoritative removal completed before upload.',
      }
    }
    if (afterCheckpoint?.removeRequested) {
      const stopped = {
        ...pending,
        stage:
          pending.kind === 'ingest'
            ? ('prepared' as const)
            : ('delete_confirmed' as const),
        paused: true,
        error: 'Explicit removal took precedence before upload.',
      }
      await this.docIndexService.saveRecord(
        operationPath,
        this.recordWithPending(afterCheckpoint, stopped),
        pending.backendId,
      )
      return {
        status: 'paused',
        path: operationPath,
        message: stopped.error,
      }
    }

    let trackId: string
    try {
      trackId = await this.submitPrepared(
        prepared,
        pending.source,
        pending.policy,
        ownership,
        signal,
      )
    } catch (error) {
      if (error instanceof AmbiguousMutationError) {
        return this.reconcileAmbiguousUpload(
          operationPath,
          record,
          pending,
          error.message,
          ownership,
        )
      }
      const message = error instanceof Error ? error.message : String(error)
      const rejected: PendingDocumentOperation = {
        ...pending,
        stage: pending.kind === 'ingest' ? 'prepared' : 'delete_confirmed',
        paused: true,
        error: message,
      }
      await this.docIndexService.saveRecord(
        operationPath,
        this.recordWithPending(record, rejected, 'failed'),
        pending.backendId,
      )
      return { status: 'failed', path: operationPath, message }
    }

    pending = { ...pending, stage: 'tracking', trackId }
    await this.docIndexService.saveRecord(
      operationPath,
      this.recordWithPending(record, pending),
      pending.backendId,
    )
    if (this.isOwnershipStopped(ownership, signal)) {
      return this.pauseOperation(
        operationPath,
        record,
        pending,
        'Upload was accepted; tracking is paused after cancellation or backend change.',
      )
    }
    const outcome = await this.trackSubmission(
      trackId,
      pending.source,
      pending.policy,
      signal,
      ownership,
    )
    return this.finishTrackedOperation(
      operationPath,
      record,
      pending,
      outcome,
      ownership,
    )
  }

  private async discoverExistingSource(
    operationPath: string,
    source: string,
    ownership: OperationOwnership,
  ): Promise<IngestionResult | undefined> {
    let documents: LightRagDocument[]
    try {
      documents = await this.docIndexService.listDocuments(ownership.backendId)
    } catch (error) {
      return {
        status: 'paused',
        path: operationPath,
        message: `Existing document identity could not be checked: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (this.isOwnershipStopped(ownership)) {
      return {
        status: 'paused',
        path: operationPath,
        message: 'Backend ownership changed during document discovery.',
      }
    }
    const exact = documents.filter((document) => document.file_path === source)
    if (exact.length === 1) {
      const recoveredPolicy = this.policyFromDocument(exact[0])
      await this.docIndexService.saveRecord(
        operationPath,
        {
          status: this.mapServerStatus(exact[0].status),
          docId: exact[0].id,
          source,
          policy: recoveredPolicy,
        },
        ownership.backendId,
      )
      return {
        status: 'paused',
        path: operationPath,
        docId: exact[0].id,
        message: recoveredPolicy
          ? 'The processing policy was recovered, but the indexed source revision is unknown; explicitly reprocess before synchronization.'
          : 'An existing managed source was found, but its historical processing policy is unknown.',
      }
    }
    if (exact.length > 1) {
      return {
        status: 'paused',
        path: operationPath,
        message: 'Multiple backend documents conflict on the managed source.',
      }
    }
    const fileName = operationPath.slice(operationPath.lastIndexOf('/') + 1)
    const legacy = documents.filter((document) => {
      if (!document.file_path) return false
      const normalized = document.file_path.replace(/\\/g, '/')
      return normalized.slice(normalized.lastIndexOf('/') + 1) === fileName
    })
    if (legacy.length > 0) {
      return {
        status: 'paused',
        path: operationPath,
        message:
          'Possible legacy documents require an explicit source mapping before ingestion.',
      }
    }
    return undefined
  }

  async ingestFile(
    file: TFile,
    options: IngestOptions = {},
  ): Promise<IngestionResult> {
    const operationPath = file.path
    const intent = options.intent ?? 'new'
    const ownership = this.captureOwnership()
    const backendId = ownership.backendId
    if (
      isExcludedFromGraphSync(operationPath, {
        excludePatterns: this.settings.lightRagExcludePatterns,
        excludeHiddenFiles: this.settings.lightRagExcludeHiddenFiles,
      })
    ) {
      return {
        status: 'skipped',
        path: operationPath,
        message: 'The source is excluded from graph ingestion.',
      }
    }
    if (this.isOwnershipStopped(ownership, options.signal)) {
      return {
        status: 'paused',
        path: operationPath,
        message: 'The operation was cancelled before preparation.',
      }
    }

    const previous = options.previousPath
      ? this.docIndexService.getRecord(options.previousPath, backendId)
      : undefined
    const current = this.docIndexService.getRecord(operationPath, backendId)
    if (
      options.previousPath &&
      options.previousPath !== operationPath &&
      previous &&
      current
    ) {
      return {
        status: 'paused',
        path: operationPath,
        message:
          'The rename destination is already owned by another document record.',
      }
    }
    const record = current ?? previous
    if (record?.removeRequested && intent !== 'reprocess') {
      return {
        status: 'skipped',
        path: operationPath,
        message: 'Explicit graph removal is pending for this document.',
      }
    }
    if (record?.status === 'removed' && intent !== 'reprocess') {
      return {
        status: 'skipped',
        path: operationPath,
        message:
          'This document was intentionally removed; use an explicit re-add action.',
      }
    }
    if (record?.pending && intent !== 'retry') {
      return {
        status: 'paused',
        path: operationPath,
        message: 'A recoverable document operation is already pending.',
      }
    }
    if (intent === 'retry' && !record?.pending) {
      return {
        status: 'paused',
        path: operationPath,
        docId: record?.docId,
        message: 'There is no pending document operation to retry.',
      }
    }
    if (intent === 'new' && record) {
      return {
        status: 'skipped',
        path: operationPath,
        docId: record.docId,
        message:
          'This document is already registered. Use explicit reprocessing to change its policy.',
      }
    }

    let policy: ProcessingPolicy
    try {
      if (intent === 'sync' && record) {
        if (!record.policy) {
          return {
            status: 'paused',
            path: operationPath,
            docId: record.docId,
            message:
              'Historical processing settings are unknown; explicitly reprocess to adopt a policy.',
          }
        }
        policy = record.policy
      } else if (intent === 'retry') {
        const retry = record?.pending
        if (!record || !retry) {
          return {
            status: 'paused',
            path: operationPath,
            docId: record?.docId,
            message: 'There is no pending document operation to retry.',
          }
        }
        policy = retry.policy
        if (retry.mtime !== file.stat.mtime) {
          return {
            status: 'paused',
            path: operationPath,
            docId: record.docId,
            message:
              'The source changed after the failed operation; review it before retrying.',
          }
        }
        if (retry.stage === 'delete_requested') {
          return this.pauseOperation(
            operationPath,
            record,
            retry,
            'The prior deletion outcome must be reconciled before retrying.',
          )
        }
        if (
          retry.stage === 'tracking' &&
          retry.trackId &&
          record.status !== 'failed'
        ) {
          return this.reconcileAmbiguousUpload(
            operationPath,
            record,
            retry,
            'The accepted upload has not failed; reconciling without resubmission.',
            ownership,
          )
        }
        if (
          (retry.stage === 'upload_requested' || retry.stage === 'tracking') &&
          !retry.trackId
        ) {
          return this.reconcileAmbiguousUpload(
            operationPath,
            record,
            retry,
            'The prior upload acknowledgement is ambiguous; reconcile it before retrying.',
            ownership,
          )
        }
      } else {
        policy = options.policy ?? processingPolicy(this.settings)
      }
      if (policy.mode === 'paragraph') {
        if (!isParagraphFile(file.extension)) {
          return {
            status: 'skipped',
            path: operationPath,
            message:
              'Native paragraph processing supports Markdown and DOCX only.',
          }
        }
        if (
          !backendId ||
          this.settings.lightRagImageDownloadsDisabledFor !== backendId
        ) {
          return {
            status: 'paused',
            path: operationPath,
            message:
              'Confirm that native Markdown image downloading is disabled for this backend.',
          }
        }
        const compatibility = await this.getParagraphCompatibility()
        if (this.isOwnershipStopped(ownership, options.signal)) {
          return {
            status: 'paused',
            path: operationPath,
            message:
              'Backend ownership changed during compatibility discovery.',
          }
        }
        if (compatibility.status !== 'supported') {
          return {
            status: 'paused',
            path: operationPath,
            message: compatibility.message,
          }
        }
      }
    } catch (error) {
      return {
        status: 'failed',
        path: operationPath,
        message: error instanceof Error ? error.message : String(error),
      }
    }

    let prepared: PreparedDocument
    let source: string
    try {
      prepared = await this.prepareFile(file, policy)
      if (this.isOwnershipStopped(ownership, options.signal)) {
        return {
          status: 'paused',
          path: operationPath,
          message: 'Backend ownership changed while reading the source.',
        }
      }
      source =
        intent === 'retry' && record?.pending
          ? record.pending.source
          : !options.previousPath &&
              record?.source &&
              CANONICAL_TRANSPORT_SOURCE.test(record.source)
            ? record.source
            : await documentSourceName(ownership.namespace, operationPath)
      if (this.isOwnershipStopped(ownership, options.signal)) {
        return {
          status: 'paused',
          path: operationPath,
          message: 'Backend ownership changed while hashing the source.',
        }
      }
    } catch (error) {
      return {
        status: 'failed',
        path: operationPath,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    if (
      record?.source === source &&
      Object.entries(this.docIndexService.getRecords(backendId)).some(
        ([path, candidate]) =>
          path !== operationPath &&
          (candidate.source === source ||
            candidate.aliases?.includes(source) === true),
      )
    ) {
      return {
        status: 'paused',
        path: operationPath,
        message:
          'The stored transport identity is already owned by another vault path.',
      }
    }

    if (intent === 'retry' && record?.pending?.stage === 'delete_confirmed') {
      return this.uploadAndTrack(
        file,
        operationPath,
        prepared,
        record,
        record.pending,
        options.signal,
        ownership,
      )
    }

    if (!record) {
      const conflict = await this.discoverExistingSource(
        operationPath,
        source,
        ownership,
      )
      if (conflict) return conflict
    }
    if (this.isOwnershipStopped(ownership, options.signal)) {
      return {
        status: 'paused',
        path: operationPath,
        message: 'Backend ownership changed before ingestion persistence.',
      }
    }

    const aliases = new Set(record?.aliases ?? [])
    if (record?.source && record.source !== source) aliases.add(record.source)
    const baseRecord: DocRecord = {
      ...(record ?? { status: 'unknown' }),
      aliases: aliases.size > 0 ? [...aliases] : undefined,
      removeRequested:
        intent === 'reprocess' ? undefined : record?.removeRequested,
    }
    let pending: PendingDocumentOperation = {
      backendId,
      kind: options.previousPath
        ? 'rename'
        : baseRecord.docId
          ? 'replace'
          : 'ingest',
      stage: 'prepared',
      policy,
      mtime: prepared.mtime,
      source,
      docId: baseRecord.docId,
      previousPath: options.previousPath,
      previousDocId: previous?.docId,
    }
    try {
      await this.docIndexService.saveRecord(
        operationPath,
        this.recordWithPending(baseRecord, pending),
        backendId,
        {
          ...(previous && !current && options.previousPath
            ? { previousPath: options.previousPath }
            : {}),
          ...(intent === 'reprocess' ? { clearRemovalIntent: true } : {}),
        },
      )
    } catch (error) {
      return {
        status: 'failed',
        path: operationPath,
        message: `Could not persist ingestion intent: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (this.isOwnershipStopped(ownership, options.signal)) {
      return {
        status: 'paused',
        path: operationPath,
        message: 'Backend ownership changed after ingestion persistence.',
      }
    }

    const oldDocId = previous?.docId ?? baseRecord.docId
    if (oldDocId) {
      pending = {
        ...pending,
        stage: 'delete_requested',
        docId: oldDocId,
      }
      await this.docIndexService.saveRecord(
        operationPath,
        this.recordWithPending(baseRecord, pending),
        backendId,
      )
      if (this.isOwnershipStopped(ownership, options.signal)) {
        return this.pauseOperation(
          operationPath,
          baseRecord,
          { ...pending, stage: 'prepared' },
          'Deletion stopped before submission.',
        )
      }
      let deletion: 'started' | 'busy'
      try {
        deletion = await this.requestDeletion(
          [oldDocId],
          ownership,
          options.signal,
        )
      } catch (error) {
        if (error instanceof AmbiguousMutationError) {
          if (this.isOwnershipStopped(ownership, options.signal)) {
            return this.pauseOperation(
              operationPath,
              baseRecord,
              pending,
              error.message,
            )
          }
          try {
            const documents =
              await this.docIndexService.listDocuments(backendId)
            if (this.isOwnershipStopped(ownership, options.signal)) {
              return this.pauseOperation(
                operationPath,
                baseRecord,
                pending,
                error.message,
              )
            }
            if (documents.some((document) => document.id === oldDocId)) {
              return this.pauseOperation(
                operationPath,
                baseRecord,
                pending,
                error.message,
              )
            }
            deletion = 'started'
          } catch (readError) {
            return this.pauseOperation(
              operationPath,
              baseRecord,
              pending,
              `${error.message} Reconciliation failed: ${readError instanceof Error ? readError.message : String(readError)}`,
            )
          }
        } else {
          const message = error instanceof Error ? error.message : String(error)
          const rejected: PendingDocumentOperation = {
            ...pending,
            stage: 'prepared',
            paused: true,
            error: message,
          }
          await this.docIndexService.saveRecord(
            operationPath,
            this.recordWithPending(baseRecord, rejected),
            backendId,
          )
          return { status: 'failed', path: operationPath, message }
        }
      }
      if (this.isOwnershipStopped(ownership, options.signal)) {
        return this.pauseOperation(
          operationPath,
          baseRecord,
          pending,
          'Backend ownership changed while deletion was being submitted.',
        )
      }
      if (deletion === 'busy') {
        pending = {
          ...pending,
          stage: 'prepared',
          paused: true,
          error: 'The backend is busy; deletion was not scheduled.',
        }
        await this.docIndexService.saveRecord(
          operationPath,
          this.recordWithPending(baseRecord, pending),
          backendId,
        )
        return {
          status: 'paused',
          path: operationPath,
          message: pending.error,
        }
      }
      let removed: boolean
      try {
        removed = await this.waitForDocumentsAbsent(
          [oldDocId],
          options.signal,
          ownership,
        )
      } catch (error) {
        return this.pauseOperation(
          operationPath,
          baseRecord,
          pending,
          `Deletion completion could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (!removed) {
        return this.pauseOperation(
          operationPath,
          baseRecord,
          pending,
          'Deletion did not reach confirmed completion.',
        )
      }
      pending = {
        ...pending,
        stage: 'delete_confirmed',
        paused: undefined,
        error: undefined,
      }
      await this.docIndexService.saveRecord(
        operationPath,
        this.recordWithPending(baseRecord, pending),
        backendId,
      )
      if (this.isOwnershipStopped(ownership, options.signal)) {
        return this.pauseOperation(
          operationPath,
          baseRecord,
          pending,
          'Backend ownership changed before replacement upload.',
        )
      }
    }

    return this.uploadAndTrack(
      file,
      operationPath,
      prepared,
      baseRecord,
      pending,
      options.signal,
      ownership,
    )
  }

  async reindexFile(file: TFile): Promise<IngestionResult> {
    return this.ingestFile(file, { intent: 'sync' })
  }

  async recoverPendingOperations(): Promise<void> {
    if (this.disposed) return
    const ownership = this.captureOwnership()
    const records = this.docIndexService.getRecords(ownership.backendId)
    for (const [path, record] of Object.entries(records)) {
      if (this.isOwnershipStopped(ownership)) break
      const pending = record.pending
      try {
        if (record.status === 'removed') continue
        if (record.removeRequested) {
          await this.deleteDocumentsByPathsWithOwnership([path], ownership)
          continue
        }
        if (!pending) continue
        if (pending.backendId !== ownership.backendId) {
          await this.pauseOperation(
            path,
            record,
            pending,
            'Pending work belongs to a different backend and was not redirected.',
          )
          continue
        }
        if (pending.stage === 'prepared') {
          await this.pauseOperation(
            path,
            record,
            pending,
            'Prepared work was not externally mutated; retry it explicitly.',
          )
          continue
        }
        if (pending.stage === 'delete_requested') {
          if (!pending.docId) {
            await this.pauseOperation(
              path,
              record,
              pending,
              'Deletion recovery is missing its exact server document ID.',
            )
            continue
          }
          const documents = await this.docIndexService.listDocuments(
            pending.backendId,
          )
          if (this.isOwnershipStopped(ownership)) continue
          if (documents.some((document) => document.id === pending.docId)) {
            await this.pauseOperation(
              path,
              record,
              pending,
              'The prior deletion is not confirmed and was not replayed.',
            )
            continue
          }
          const confirmed = {
            ...pending,
            stage: 'delete_confirmed' as const,
            paused: undefined,
            error: undefined,
          }
          await this.docIndexService.saveRecord(
            path,
            this.recordWithPending(record, confirmed),
            confirmed.backendId,
          )
          if (this.isOwnershipStopped(ownership)) continue
          await this.resumeConfirmedUpload(path, record, confirmed, ownership)
          continue
        }
        if (pending.stage === 'delete_confirmed') {
          await this.resumeConfirmedUpload(path, record, pending, ownership)
          continue
        }
        if (pending.stage === 'tracking' && pending.trackId) {
          const outcome = await this.trackSubmission(
            pending.trackId,
            pending.source,
            pending.policy,
            undefined,
            ownership,
          )
          if (this.isOwnershipStopped(ownership)) continue
          await this.finishTrackedOperation(
            path,
            record,
            pending,
            outcome,
            ownership,
          )
          continue
        }
        await this.reconcileAmbiguousUpload(
          path,
          record,
          pending,
          'The prior upload acknowledgement remains ambiguous.',
          ownership,
        )
      } catch (error) {
        if (!pending) continue
        await this.pauseOperation(
          path,
          record,
          pending,
          `Recovery paused: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  private async resumeConfirmedUpload(
    path: string,
    record: DocRecord,
    pending: PendingDocumentOperation,
    ownership: OperationOwnership,
  ): Promise<void> {
    const latest =
      this.docIndexService.getRecord(path, pending.backendId) ?? record
    if (latest.removeRequested || latest.status === 'removed') {
      if (latest.removeRequested && !this.isOwnershipStopped(ownership)) {
        await this.deleteDocumentsByPathsWithOwnership([path], ownership)
      }
      return
    }
    const abstractFile = this.app.vault.getAbstractFileByPath(path)
    if (!(abstractFile instanceof TFile)) {
      await this.pauseOperation(
        path,
        latest,
        pending,
        'The source is missing; deleted work was not resurrected.',
      )
      return
    }
    if (
      abstractFile.stat.mtime !== pending.mtime ||
      isExcludedFromGraphSync(path, {
        excludePatterns: this.settings.lightRagExcludePatterns,
        excludeHiddenFiles: this.settings.lightRagExcludeHiddenFiles,
      })
    ) {
      await this.pauseOperation(
        path,
        latest,
        pending,
        'The source changed or became excluded after reload; upload remains paused.',
      )
      return
    }
    const prepared = await this.prepareFile(abstractFile, pending.policy)
    if (this.isOwnershipStopped(ownership)) {
      await this.pauseOperation(
        path,
        latest,
        pending,
        'Backend ownership changed while reading the source.',
      )
      return
    }
    const beforeUpload =
      this.docIndexService.getRecord(path, pending.backendId) ?? latest
    if (beforeUpload.removeRequested || beforeUpload.status === 'removed') {
      if (beforeUpload.removeRequested && !this.isOwnershipStopped(ownership)) {
        await this.deleteDocumentsByPathsWithOwnership([path], ownership)
      }
      return
    }
    await this.uploadAndTrack(
      abstractFile,
      path,
      prepared,
      beforeUpload,
      pending,
      undefined,
      ownership,
    )
  }

  // --- 3. MASTER QUERY ---
  async processQuery({
    query,
    scope,
    onQueryProgressChange,
  }: {
    query: string
    scope?: {
      files: string[]
      folders: string[]
    }
    onQueryProgressChange?: (queryProgress: QueryProgressState) => void
  }): Promise<RagQueryResult> {
    // 1. LOCAL STRATEGY
    if (scope && scope.files && scope.files.length > 0) {
      const localResults: RagResult[] = []
      for (const filePath of scope.files) {
        const file = this.app.vault.getAbstractFileByPath(filePath)
        if (file instanceof TFile) {
          const content = await this.app.vault.read(file)
          localResults.push({
            id: -1,
            model: 'local-file',
            path: filePath,
            content: content,
            similarity: 1.0,
            mtime: file.stat.mtime,
            metadata: {
              startLine: 0,
              endLine: 0,
              fileName: file.name,
              content: content,
            },
          })
        }
      }
      onQueryProgressChange?.({ type: 'querying-done', queryResult: [] })
      // Safe casting to expected return type
      return localResults as unknown as RagQueryResult
    }

    // 2. GLOBAL STRATEGY
    onQueryProgressChange?.({ type: 'querying' })

    // FIX: Typed return promise to avoid implicit 'any' from response.json
    const performQuery = async (): Promise<LightRagAPIResponse> => {
      const response = await requestUrl({
        url: `${this.settings.lightRagServerUrl}/query`,
        method: 'POST',
        headers: this.getLightRagHeaders(),
        body: JSON.stringify({
          query: query,
          mode: this.settings.lightRagQueryMode || 'mix',
          stream: false,
          only_need_context: false,
          // Ask LightRAG to embed [N] citation markers so we can score references
          include_references: true,
        }),
        throw: false,
      })

      if (response.status >= 400) {
        const errorText = response.text
        if (
          errorText.toLowerCase().includes('quota') ||
          errorText.toLowerCase().includes('credit') ||
          errorText.toLowerCase().includes('429')
        ) {
          new Notice(
            'Rerank error: quota exceeded. Please check your API key.',
            0,
          )
        } else if (errorText.toLowerCase().includes('rerank')) {
          new Notice(`Reranking error: ${errorText}`, 5000)
        }
        throw new Error(`Status ${response.status}: ${errorText}`)
      }
      // FIX: Cast to interface instead of returning 'any'
      return response.json as LightRagAPIResponse
    }

    try {
      // FIX: Explicit type for data variable
      let data: LightRagAPIResponse
      try {
        data = await performQuery()
      } catch (firstError) {
        console.warn('First attempt failed...', firstError)
        if (this.settings.enableAutoStartServer) {
          onQueryProgressChange?.({ type: 'querying' })
          new Notice('Waking up the system...')
          await this.restartServerCallback()
          await new Promise((resolve) => window.setTimeout(resolve, 4000))
          data = await performQuery()
        } else {
          throw firstError
        }
      }

      const results: RagResult[] = []
      const graphAnswer = data.response || ''
      const refs = data.references ?? []

      // --- Compute real relevance scores from citation frequency ---
      // LightRAG embeds [1], [2], ... markers in the response when references
      // are included. Count how often each source is cited → normalize to 0–1.
      const citationCounts = refs.map((_, i) =>
        countCitations(graphAnswer, i + 1),
      )
      const maxCitations = Math.max(...citationCounts, 1)

      // Score formula:
      //   cited ≥1 time  → 0.40 + (citedCount / maxCited) * 0.55   [0.40 – 0.95]
      //   cited 0 times  → 0.20  (listed as reference but not explicitly cited)
      const refScore = (citations: number): number =>
        citations > 0 ? 0.4 + (citations / maxCitations) * 0.55 : 0.2

      // Build master "Graph's memory" entry (the raw LightRAG answer)
      if (graphAnswer) {
        results.push({
          id: -1,
          model: 'lightrag-master',
          path: "Graph's memory",
          content: graphAnswer,
          similarity: 1.0,
          mtime: Date.now(),
          metadata: { startLine: 0, endLine: 0, fileName: 'Graph answer' },
        })
      }

      // Build one entry per cited document with a real relevance score
      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i]
        const source = ref.file_path || ref.reference_id || `Source #${i + 1}`
        const filePath = this.docIndexService.resolveSource(source) ?? source
        results.push({
          id: -(i + 2),
          model: 'lightrag-ref',
          path: filePath, // clean path — no [N] prefix
          content: ref.content || '',
          similarity: refScore(citationCounts[i]),
          mtime: Date.now(),
          metadata: { startLine: 0, endLine: 0, fileName: filePath },
        })
      }

      onQueryProgressChange?.({ type: 'querying-done', queryResult: [] })
      return results as unknown as RagQueryResult
    } catch (error: unknown) {
      console.error('Final error:', error)
      const message = error instanceof Error ? error.message : String(error)
      const errorDoc: RagResult = {
        id: -2,
        path: 'Query error',
        content: `No response could be obtained from graph.\n\nPossible cause: ${message}\n\nIf you use reranking, check your credits.`,
        similarity: 1.0,
        metadata: { startLine: 0, endLine: 0 },
      }
      return [errorDoc] as unknown as RagQueryResult
    }
  }

  private getQueryEmbedding(query: string): Promise<number[]> {
    if (!this.embeddingModel)
      return Promise.reject(new Error('Embedding model not set'))
    return this.embeddingModel.getEmbedding(query)
  }
}
