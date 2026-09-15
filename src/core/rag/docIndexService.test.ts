import { TFile, requestUrl } from 'obsidian'
import type { RequestUrlResponse } from 'obsidian'

import type NeuralComposerPlugin from '../../main'

import { DocIndexService, type DocRecord } from './docIndexService'
import { type ProcessingPolicy, documentSourceName } from './documentProcessing'
import { RAGEngine } from './ragEngine'

jest.mock('obsidian', () => ({ TFile: jest.fn(), requestUrl: jest.fn() }))
const requestUrlMock = jest.mocked(requestUrl) as jest.MockedFunction<
  (...args: Parameters<typeof requestUrl>) => Promise<RequestUrlResponse>
>
jest.mock('../../main', () => ({ __esModule: true, default: class {} }))

const CONFIG_DIR = '.test-config'
const STATUS_PATH = `${CONFIG_DIR}/plugins/neural-composer/doc-status.json`
const BACKUP_PATH = `${STATUS_PATH}.backup`
const POLICY: ProcessingPolicy = {
  mode: 'paragraph',
  chunkSize: 1200,
  chunkOverlap: 100,
}
const LEGACY_POLICY: ProcessingPolicy = {
  mode: 'legacy',
  chunkSize: 900,
  chunkOverlap: 90,
}

class MemoryAdapter {
  files = new Map<string, string>()
  readError: Error | null = null
  corruptPrimaryWrite = false

  exists = jest.fn(async (path: string) => this.files.has(path))
  read = jest.fn(async (path: string) => {
    if (this.readError && path === STATUS_PATH) throw this.readError
    const value = this.files.get(path)
    if (value === undefined) throw new Error(`Missing ${path}`)
    return value
  })
  write = jest.fn(async (path: string, contents: string) => {
    this.files.set(
      path,
      this.corruptPrimaryWrite && path === STATUS_PATH ? '{corrupt' : contents,
    )
  })
}

type MockFile = Pick<TFile, 'path' | 'name' | 'extension'>

function plugin(
  adapter: MemoryAdapter,
  files: MockFile[] = [],
  backendId = 'backend-current',
): NeuralComposerPlugin {
  return {
    manifest: { id: 'neural-composer' },
    settings: {
      lightRagBackendIdentity: backendId,
      lightRagVaultNamespace: 'shared-vault',
      lightRagServerUrl: 'http://localhost:9621',
      lightRagApiKey: '',
      lightRagSyncFolder: 'Watched',
    },
    app: {
      vault: {
        configDir: CONFIG_DIR,
        adapter,
        getFiles: () => files,
      },
    },
  } as unknown as NeuralComposerPlugin
}

const file = (path: string): MockFile => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const extension = name.includes('.')
    ? name.slice(name.lastIndexOf('.') + 1)
    : ''
  return { path, name, extension }
}

const record = (overrides: Partial<DocRecord> = {}): DocRecord => ({
  status: 'processed',
  docId: 'doc-1',
  mtime: 10,
  source: `nc-${'a'.repeat(64)}.md`,
  policy: POLICY,
  ...overrides,
})

describe('DocIndexService persistence and migration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('atomically moves ownership while retaining historical source resolution', async () => {
    const adapter = new MemoryAdapter()
    const service = new DocIndexService(plugin(adapter))
    await service.load()
    const old = record()
    await service.saveRecord('Old.md', old)
    await service.saveRecord(
      'Old.md',
      record({ docId: 'other-backend' }),
      'other',
    )

    await service.saveRecord(
      'New.md',
      record({ source: `nc-${'b'.repeat(64)}.md`, aliases: [old.source!] }),
      'backend-current',
      { previousPath: 'Old.md' },
    )

    const reloaded = new DocIndexService(plugin(adapter))
    await reloaded.load()
    expect(reloaded.getRecord('Old.md')).toBeUndefined()
    expect(reloaded.resolveSource(old.source!)).toBe('New.md')
    expect(reloaded.getRecord('Old.md', 'other')?.docId).toBe('other-backend')
  })

  it('preserves both owners when an atomic rename target is occupied', async () => {
    const adapter = new MemoryAdapter()
    const service = new DocIndexService(plugin(adapter))
    await service.load()
    await service.saveRecord('Old.md', record({ docId: 'doc-old' }))
    await service.saveRecord('New.md', record({ docId: 'doc-new' }))

    await expect(
      service.saveRecord(
        'New.md',
        record({ docId: 'replacement' }),
        'backend-current',
        { previousPath: 'Old.md' },
      ),
    ).rejects.toThrow(/rename ownership changed/i)

    const reloaded = new DocIndexService(plugin(adapter))
    await reloaded.load()
    expect(reloaded.getRecord('Old.md')?.docId).toBe('doc-old')
    expect(reloaded.getRecord('New.md')?.docId).toBe('doc-new')
  })

  it('preserves both rename owners when the destination becomes occupied during engine preparation', async () => {
    const adapter = new MemoryAdapter()
    const host = plugin(adapter)
    Object.assign(host.settings, {
      lightRagChunkingStrategy: 'legacy',
      lightRagChunkSize: LEGACY_POLICY.chunkSize,
      lightRagChunkOverlap: LEGACY_POLICY.chunkOverlap,
      lightRagExcludePatterns: [],
      lightRagExcludeHiddenFiles: true,
    })
    const service = new DocIndexService(host)
    await service.load()
    await service.saveRecord(
      'Old.md',
      record({
        docId: 'doc-old',
        source: 'Old.md',
        policy: LEGACY_POLICY,
      }),
    )
    const destination = Object.assign(new TFile(), {
      path: 'New.md',
      name: 'New.md',
      basename: 'New',
      extension: 'md',
      stat: { mtime: 20, ctime: 10, size: 12 },
    })
    Object.assign(host.app.vault, {
      read: jest.fn(async () => {
        await service.saveRecord(
          destination.path,
          record({
            docId: 'doc-new',
            source: 'New.md',
            policy: LEGACY_POLICY,
          }),
        )
        return '# Renamed'
      }),
      readBinary: jest.fn(),
    })
    const engine = Object.assign(Object.create(RAGEngine.prototype), {
      app: host.app,
      settings: host.settings,
      vectorManager: null,
      embeddingModel: null,
      docIndexService: service,
      restartServerCallback: () => Promise.resolve(),
    }) as RAGEngine

    await expect(
      engine.ingestFile(destination, {
        intent: 'sync',
        previousPath: 'Old.md',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
    })

    const reloaded = new DocIndexService(host)
    await reloaded.load()
    expect(reloaded.getRecord('Old.md')?.docId).toBe('doc-old')
    expect(reloaded.getRecord('New.md')?.docId).toBe('doc-new')
    expect(requestUrl).not.toHaveBeenCalled()
  })

  it('preserves removal intent across a stale completion queued after it', async () => {
    const service = new DocIndexService(plugin(new MemoryAdapter()))
    await service.load()
    const tracking = record({
      status: 'processing',
      pending: {
        backendId: 'backend-current',
        kind: 'ingest',
        stage: 'tracking',
        policy: POLICY,
        mtime: 20,
        source: `nc-${'8'.repeat(64)}.md`,
        docId: 'accepted-doc',
        trackId: 'track-1',
      },
    })
    await service.saveRecord('Note.md', tracking)
    const staleCompletion = record({
      docId: 'accepted-doc',
      mtime: 20,
      source: tracking.pending!.source,
    })

    await Promise.all([
      service.saveRecord('Note.md', { ...tracking, removeRequested: true }),
      service.saveRecord('Note.md', staleCompletion),
    ])

    expect(service.getRecord('Note.md')).toMatchObject({
      status: 'processed',
      docId: 'accepted-doc',
      removeRequested: true,
    })
  })

  it('clears sticky removal intent only for explicit preparation', async () => {
    const service = new DocIndexService(plugin(new MemoryAdapter()))
    await service.load()
    await service.saveRecord('Note.md', record({ removeRequested: true }))
    const preparation = record({
      status: 'processing',
      pending: {
        backendId: 'backend-current',
        kind: 'replace',
        stage: 'prepared',
        policy: POLICY,
        mtime: 20,
        source: `nc-${'9'.repeat(64)}.md`,
        docId: 'doc-1',
      },
    })

    await service.saveRecord('Note.md', preparation, 'backend-current', {
      clearRemovalIntent: true,
    })

    expect(service.getRecord('Note.md')).toEqual(preparation)
  })

  it('clears removal intent for a confirmed removed tombstone', async () => {
    const service = new DocIndexService(plugin(new MemoryAdapter()))
    await service.load()
    await service.saveRecord('Note.md', record({ removeRequested: true }))

    await service.saveRecord(
      'Note.md',
      record({
        status: 'removed',
        docId: undefined,
        removeRequested: undefined,
      }),
    )

    expect(service.getRecord('Note.md')).toEqual(
      record({
        status: 'removed',
        docId: undefined,
        removeRequested: undefined,
      }),
    )
  })

  it('rejects stale writes after a tombstone while allowing explicit re-add and a fresh removal', async () => {
    const service = new DocIndexService(plugin(new MemoryAdapter()))
    await service.load()
    const source = `nc-${'8'.repeat(64)}.md`
    const pending = {
      backendId: 'backend-current',
      kind: 'ingest' as const,
      stage: 'tracking' as const,
      policy: POLICY,
      mtime: 20,
      source,
      docId: 'accepted-doc',
      trackId: 'track-1',
    }
    const staleTracking = record({
      status: 'processing',
      docId: 'accepted-doc',
      mtime: 20,
      source,
      pending,
    })
    const staleCompletion = record({
      docId: 'accepted-doc',
      mtime: 20,
      source,
    })
    const tombstone = record({
      status: 'removed',
      docId: undefined,
      mtime: 20,
      source,
      pending: undefined,
      removeRequested: undefined,
    })
    await service.saveRecord('Note.md', staleTracking)
    await service.saveRecord('Note.md', tombstone)

    await expect(service.saveRecord('Note.md', staleTracking)).rejects.toThrow()
    await expect(
      service.saveRecord('Note.md', staleCompletion),
    ).rejects.toThrow()
    await expect(
      service.saveRecord('Note.md', staleTracking, 'backend-current', {
        clearRemovalIntent: true,
      }),
    ).rejects.toThrow()
    expect(service.getRecord('Note.md')).toEqual(tombstone)

    const preparation = record({
      status: 'removed',
      docId: undefined,
      mtime: 21,
      source,
      pending: {
        ...pending,
        stage: 'prepared',
        docId: undefined,
        trackId: undefined,
        mtime: 21,
      },
    })
    await service.saveRecord('Note.md', preparation, 'backend-current', {
      clearRemovalIntent: true,
    })
    const freshTracking = record({
      status: 'processing',
      docId: 'fresh-doc',
      mtime: 21,
      source,
      pending: {
        ...pending,
        docId: 'fresh-doc',
        trackId: 'fresh-track',
        mtime: 21,
      },
    })
    await service.saveRecord('Note.md', freshTracking)
    await service.saveRecord('Note.md', {
      ...freshTracking,
      removeRequested: true,
    })
    await service.saveRecord('Note.md', {
      ...freshTracking,
      status: 'processed',
      pending: undefined,
    })

    expect(service.getRecord('Note.md')).toMatchObject({
      status: 'processed',
      docId: 'fresh-doc',
      removeRequested: true,
    })
  })

  it('migrates old records conservatively, retains their bytes, and leaves historical policy unknown', async () => {
    const adapter = new MemoryAdapter()
    const old = JSON.stringify({
      'Outside/Legacy.md': { status: 'processed', docId: 'old-id', mtime: 4 },
      'Outside/Removed.md': { status: 'removed', mtime: 5 },
    })
    adapter.files.set(STATUS_PATH, old)
    const service = new DocIndexService(plugin(adapter))

    await service.load()

    expect(adapter.files.get(BACKUP_PATH)).toBe(old)
    expect(service.getRecord('Outside/Legacy.md')).toEqual({
      status: 'processed',
      docId: 'old-id',
      mtime: 4,
    })
    expect(service.getRecord('Outside/Legacy.md')?.policy).toBeUndefined()
    expect(service.needsIngestion('Outside/Legacy.md', 99)).toBe(false)
    expect(service.needsIngestion('Outside/Removed.md', 99)).toBe(false)
  })

  it.each([
    ['corrupt JSON', '{not-json'],
    ['unsupported schema', JSON.stringify({ version: 999, backends: {} })],
  ])('fails closed on %s and locks all later writes', async (_name, raw) => {
    const adapter = new MemoryAdapter()
    adapter.files.set(STATUS_PATH, raw)
    const service = new DocIndexService(plugin(adapter))

    await expect(service.load()).rejects.toThrow()
    await expect(service.saveRecord('Note.md', record())).rejects.toThrow(
      /locked/i,
    )
    expect(adapter.files.get(STATUS_PATH)).toBe(raw)
    expect(adapter.write).not.toHaveBeenCalled()
  })

  it('fails closed on storage read errors without replacing data', async () => {
    const adapter = new MemoryAdapter()
    adapter.files.set(STATUS_PATH, '{"valuable":true}')
    adapter.readError = new Error('disk unavailable')
    const service = new DocIndexService(plugin(adapter))

    await expect(service.load()).rejects.toThrow('disk unavailable')
    await expect(service.saveRecord('Note.md', record())).rejects.toThrow(
      /locked/i,
    )
    expect(adapter.write).not.toHaveBeenCalled()
  })

  it('serializes concurrent durable writes and verifies a reload sees every record', async () => {
    const adapter = new MemoryAdapter()
    const service = new DocIndexService(plugin(adapter))
    await service.load()

    await Promise.all([
      service.saveRecord('One.md', record({ docId: 'one' })),
      service.saveRecord('Two.md', record({ docId: 'two' })),
    ])

    const reloaded = new DocIndexService(plugin(adapter))
    await reloaded.load()
    expect(reloaded.getRecord('One.md')?.docId).toBe('one')
    expect(reloaded.getRecord('Two.md')?.docId).toBe('two')
  })

  it('rejects unverifiable writes while retaining the last readable bytes as backup', async () => {
    const adapter = new MemoryAdapter()
    const service = new DocIndexService(plugin(adapter))
    await service.load()
    await service.saveRecord('Old.md', record({ docId: 'old' }))
    const oldBytes = adapter.files.get(STATUS_PATH)
    adapter.corruptPrimaryWrite = true

    await expect(
      service.saveRecord('New.md', record({ docId: 'new' })),
    ).rejects.toThrow(/verify/i)

    expect(adapter.files.get(BACKUP_PATH)).toBe(oldBytes)
    expect(service.getRecord('Old.md')?.docId).toBe('old')
    expect(service.getRecord('New.md')).toBeUndefined()
  })

  it('keeps records and unfinished operations scoped to their captured backend', async () => {
    const adapter = new MemoryAdapter()
    const service = new DocIndexService(plugin(adapter))
    await service.load()
    const pending = {
      backendId: 'backend-old',
      kind: 'replace' as const,
      stage: 'delete_requested' as const,
      policy: POLICY,
      mtime: 20,
      source: `nc-${'b'.repeat(64)}.md`,
      docId: 'old-doc',
      paused: true,
    }

    await service.saveRecord(
      'Same.md',
      record({ docId: 'old-doc', pending }),
      'backend-old',
    )
    await service.saveRecord('Same.md', record({ docId: 'new-doc' }))

    expect(service.getRecord('Same.md')?.docId).toBe('new-doc')
    expect(service.getRecord('Same.md', 'backend-old')?.pending).toEqual(
      pending,
    )
    expect(service.getRecords('backend-old')).toHaveProperty(['Same.md'])
  })
})

describe('DocIndexService ingestion policy and source resolution', () => {
  it('navigates exact legacy paths without guessing ambiguous root basenames', async () => {
    const service = new DocIndexService(
      plugin(new MemoryAdapter(), [
        file('A/Note.md'),
        file('B/Note.md'),
        file('Note.md'),
        file('Root.md'),
      ]),
    )
    await service.load()

    expect(service.resolveSource('A/Note.md')).toBe('A/Note.md')
    expect(service.resolveSource('B/Note.md')).toBe('B/Note.md')
    expect(service.resolveSource('Root.md')).toBe('Root.md')
    expect(service.resolveSource('Note.md')).toBeNull()
  })

  it('reconstructs same-namespace sources on a device without local records', async () => {
    const adapter = new MemoryAdapter()
    const files = [file('A/Overview.md'), file('B/Overview.md')]
    const service = new DocIndexService(plugin(adapter, files))
    await service.load()

    for (const entry of files) {
      const source = await documentSourceName('shared-vault', entry.path)
      expect(service.resolveSource(source)).toBe(entry.path)
    }
    expect(service.resolveSource('Overview.md')).toBeNull()
    expect(service.getRecords()).toEqual({})
  })

  it('blocks automatic resurrection, duplicate pending work, and unknown-policy replacement', async () => {
    const adapter = new MemoryAdapter()
    const service = new DocIndexService(plugin(adapter))
    await service.load()

    await service.saveRecord('Removed.md', record({ status: 'removed' }))
    await service.saveRecord('Failed.md', record({ status: 'failed' }))
    await service.saveRecord(
      'Pending.md',
      record({
        pending: {
          backendId: 'backend-current',
          kind: 'replace',
          stage: 'prepared',
          policy: POLICY,
          mtime: 20,
          source: `nc-${'c'.repeat(64)}.md`,
        },
      }),
    )
    await service.saveRecord(
      'Historical.md',
      record({ policy: undefined, mtime: 1 }),
    )
    await service.saveRecord('Current.md', record({ mtime: 1 }))

    expect(service.needsIngestion('Missing.md', 2)).toBe(true)
    expect(service.needsIngestion('Removed.md', 2)).toBe(false)
    expect(service.needsIngestion('Failed.md', 2)).toBe(false)
    expect(service.needsIngestion('Pending.md', 2)).toBe(false)
    expect(service.needsIngestion('Historical.md', 2)).toBe(false)
    expect(service.needsIngestion('Current.md', 2)).toBe(true)
  })

  it('resolves only exact current-backend sources, aliases, and document IDs', async () => {
    const adapter = new MemoryAdapter()
    const files = [file('A/Overview.md'), file('B/Overview.md')]
    const service = new DocIndexService(plugin(adapter, files))
    await service.load()
    await service.saveRecord(
      'A/Overview.md',
      record({
        source: `nc-${'1'.repeat(64)}.md`,
        aliases: [`nc-${'0'.repeat(64)}.md`],
        docId: 'doc-a',
      }),
    )
    await service.saveRecord(
      'B/Overview.md',
      record({ source: `nc-${'2'.repeat(64)}.md`, docId: 'doc-b' }),
    )
    await service.saveRecord(
      'A/Overview.md',
      record({ source: `nc-${'9'.repeat(64)}.md`, docId: 'doc-old-backend' }),
      'backend-old',
    )

    expect(service.resolveSource(`nc-${'1'.repeat(64)}.md`)).toBe(
      'A/Overview.md',
    )
    expect(service.resolveSource(`nc-${'0'.repeat(64)}.md`)).toBe(
      'A/Overview.md',
    )
    expect(service.resolveSource('doc-b')).toBe('B/Overview.md')
    expect(service.resolveSource('Overview.md')).toBeNull()
    expect(service.resolveSource(`nc-${'9'.repeat(64)}.md`)).toBeNull()
  })

  it('resolves accepted pending upload identities but not pre-mutation intent', async () => {
    const adapter = new MemoryAdapter()
    const service = new DocIndexService(plugin(adapter))
    await service.load()
    const pendingSource = `nc-${'3'.repeat(64)}.md`
    const prepared = {
      backendId: 'backend-current',
      kind: 'replace' as const,
      stage: 'prepared' as const,
      policy: POLICY,
      mtime: 20,
      source: pendingSource,
    }
    await service.saveRecord('Note.md', record({ pending: prepared }))
    expect(service.resolveSource(pendingSource)).toBeNull()

    await service.saveRecord(
      'Note.md',
      record({
        pending: {
          ...prepared,
          stage: 'tracking',
          docId: 'accepted-new-doc',
          trackId: 'track-new',
        },
      }),
    )
    expect(service.resolveSource(pendingSource)).toBe('Note.md')
    expect(service.resolveSource('accepted-new-doc')).toBe('Note.md')
  })

  it('reconstructs deterministic identities for surviving migrated paths', async () => {
    const adapter = new MemoryAdapter()
    adapter.files.set(
      STATUS_PATH,
      JSON.stringify({ 'Folder/Note.md': { status: 'processed', mtime: 1 } }),
    )
    const service = new DocIndexService(
      plugin(adapter, [file('Folder/Note.md'), file('Elsewhere/Note.md')]),
    )
    await service.load()

    await service.rebuildSourceMap()

    const expected = await documentSourceName('shared-vault', 'Folder/Note.md')
    expect(service.getRecord('Folder/Note.md')?.source).toBe(expected)
    expect(service.resolveSource(expected)).toBe('Folder/Note.md')
    expect(service.resolveSource('Note.md')).toBeNull()
  })
})

describe('DocIndexService authoritative listing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('accepts the full nullable LightRAG paginated DTO and preserves metadata and errors', async () => {
    const service = new DocIndexService(plugin(new MemoryAdapter()))
    await service.load()
    const documents = [
      {
        id: 'doc-a',
        content_summary: 'Processed note',
        content_length: 42,
        status: 'PROCESSED',
        created_at: '2026-09-14T10:00:00+00:00',
        updated_at: '2026-09-14T10:01:00+00:00',
        track_id: null,
        chunks_count: 2,
        error_msg: null,
        metadata: { source: 'vault' },
        file_path: 'a.md',
      },
      {
        id: 'doc-b',
        content_summary: 'Failed note',
        content_length: 17,
        status: 'FAILED',
        created_at: '2026-09-14T11:00:00+00:00',
        updated_at: '2026-09-14T11:01:00+00:00',
        track_id: 'track-b',
        chunks_count: null,
        error_msg: 'parse failed',
        metadata: null,
        file_path: 'b.md',
      },
    ]
    jest.mocked(requestUrl).mockResolvedValue({
      status: 200,
      json: {
        documents,
        pagination: {
          page: 1,
          page_size: 200,
          total_count: 2,
          total_pages: 1,
          has_next: false,
          has_prev: false,
        },
        status_counts: { PROCESSED: 1, FAILED: 1 },
      },
    } as never)

    await expect(service.listDocuments()).resolves.toEqual(documents)
  })

  it('accepts LightRAG empty pagination with zero total pages', async () => {
    const service = new DocIndexService(plugin(new MemoryAdapter()))
    await service.load()
    jest.mocked(requestUrl).mockResolvedValue({
      status: 200,
      json: {
        documents: [],
        pagination: {
          page: 1,
          page_size: 200,
          total_count: 0,
          total_pages: 0,
          has_next: false,
          has_prev: false,
        },
        status_counts: {},
      },
    } as never)

    await expect(service.listDocuments()).resolves.toEqual([])
  })

  it.each([
    [
      'missing fields',
      [],
      {
        page: 1,
        total_count: 0,
        total_pages: 0,
        has_next: false,
        has_prev: false,
      },
    ],
    [
      'contradictory terminal fields',
      [{ id: 'doc-a', file_path: 'a.md', status: 'PROCESSED' }],
      {
        page: 1,
        page_size: 200,
        total_count: 1,
        total_pages: 2,
        has_next: false,
        has_prev: false,
      },
    ],
    [
      'a page size different from the request',
      [{ id: 'doc-a', file_path: 'a.md', status: 'PROCESSED' }],
      {
        page: 1,
        page_size: 1,
        total_count: 1,
        total_pages: 1,
        has_next: false,
        has_prev: false,
      },
    ],
  ])(
    'rejects %s in pagination metadata',
    async (_case, documents, pagination) => {
      const service = new DocIndexService(plugin(new MemoryAdapter()))
      await service.load()
      jest.mocked(requestUrl).mockResolvedValue({
        status: 200,
        json: { documents, pagination },
      } as never)

      await expect(service.listDocuments()).rejects.toThrow()
    },
  )

  it('rejects totals that change between pages', async () => {
    const service = new DocIndexService(plugin(new MemoryAdapter()))
    await service.load()
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      id: `doc-${index}`,
      file_path: `${index}.md`,
      status: 'PROCESSED',
    }))
    jest
      .mocked(requestUrl)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          documents: firstPage,
          pagination: {
            page: 1,
            page_size: 200,
            total_count: 201,
            total_pages: 2,
            has_next: true,
            has_prev: false,
          },
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          documents: [
            { id: 'doc-200', file_path: '200.md', status: 'PROCESSED' },
          ],
          pagination: {
            page: 2,
            page_size: 200,
            total_count: 202,
            total_pages: 2,
            has_next: false,
            has_prev: true,
          },
        },
      } as never)

    await expect(service.listDocuments()).rejects.toThrow()
  })

  it('rejects duplicate document IDs across pages', async () => {
    const service = new DocIndexService(plugin(new MemoryAdapter()))
    await service.load()
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      id: `doc-${index}`,
      file_path: `${index}.md`,
      status: 'PROCESSED',
    }))
    jest
      .mocked(requestUrl)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          documents: firstPage,
          pagination: {
            page: 1,
            page_size: 200,
            total_count: 201,
            total_pages: 2,
            has_next: true,
            has_prev: false,
          },
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          documents: [
            { id: 'doc-0', file_path: 'duplicate.md', status: 'PROCESSED' },
          ],
          pagination: {
            page: 2,
            page_size: 200,
            total_count: 201,
            total_pages: 2,
            has_next: false,
            has_prev: true,
          },
        },
      } as never)

    await expect(service.listDocuments()).rejects.toThrow()
  })

  it('rejects a terminal page whose documents do not match the total', async () => {
    const service = new DocIndexService(plugin(new MemoryAdapter()))
    await service.load()
    jest.mocked(requestUrl).mockResolvedValue({
      status: 200,
      json: {
        documents: [{ id: 'doc-a', file_path: 'a.md', status: 'PROCESSED' }],
        pagination: {
          page: 1,
          page_size: 200,
          total_count: 2,
          total_pages: 1,
          has_next: false,
          has_prev: false,
        },
      },
    } as never)

    await expect(service.listDocuments()).rejects.toThrow()
  })

  it('does not expose unsupported grouped fallback as authoritative', async () => {
    const service = new DocIndexService(plugin(new MemoryAdapter()))
    await service.load()
    jest
      .mocked(requestUrl)
      .mockResolvedValueOnce({ status: 404, json: {} } as never)

    await expect(service.listDocuments()).rejects.toThrow()
    expect(requestUrl).toHaveBeenCalledTimes(1)
  })

  it('rejects a backend configuration change before requesting another page', async () => {
    const mutablePlugin = plugin(new MemoryAdapter())
    mutablePlugin.settings.lightRagApiKey = 'key-a'
    const service = new DocIndexService(mutablePlugin)
    await service.load()
    requestUrlMock.mockImplementationOnce(async () => {
      mutablePlugin.settings.lightRagBackendIdentity = 'backend-next'
      mutablePlugin.settings.lightRagServerUrl = 'http://next:9621'
      mutablePlugin.settings.lightRagApiKey = 'key-next'
      return {
        status: 200,
        json: {
          documents: [{ id: 'doc-a', file_path: 'a.md', status: 'PROCESSED' }],
          pagination: {
            page: 1,
            page_size: 200,
            total_count: 2,
            total_pages: 2,
            has_next: true,
            has_prev: false,
          },
        },
      } as unknown as RequestUrlResponse
    })

    await expect(service.listDocuments('backend-current')).rejects.toThrow(
      /changed/i,
    )
    expect(requestUrl).toHaveBeenCalledTimes(1)
    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://localhost:9621/documents/paginated',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'key-a',
        },
      }),
    )
  })
})

describe('DocIndexService server reconciliation', () => {
  beforeEach(() => {
    requestUrlMock.mockReset()
  })

  it('does not overwrite a durable update queued during status reconciliation', async () => {
    const service = new DocIndexService(plugin(new MemoryAdapter()))
    await service.load()
    await service.saveRecord('Keep.md', record())
    let update: Promise<void> | undefined
    jest.mocked(requestUrl).mockResolvedValue({
      status: 200,
      get json() {
        update = service.saveRecord(
          'Keep.md',
          record({ docId: 'replacement', mtime: 20 }),
        )
        return {
          documents: [],
          pagination: {
            page: 1,
            page_size: 200,
            total_count: 0,
            total_pages: 0,
            has_next: false,
            has_prev: false,
          },
        }
      },
    } as never)

    await service.syncFromServer()
    await update

    expect(service.getRecord('Keep.md')).toMatchObject({
      status: 'processed',
      docId: 'replacement',
      mtime: 20,
    })
  })

  it('reconciles every managed record with strict pagination, outside the watched folder', async () => {
    const adapter = new MemoryAdapter()
    const service = new DocIndexService(
      plugin(adapter, [file('Watched/In.md')]),
    )
    await service.load()
    await service.saveRecord(
      'Manual/Outside.md',
      record({ source: `nc-${'d'.repeat(64)}.md`, docId: undefined }),
    )
    jest.mocked(requestUrl).mockResolvedValue({
      status: 200,
      json: {
        documents: [
          {
            id: 'server-id',
            file_path: `nc-${'d'.repeat(64)}.md`,
            status: 'PROCESSED',
          },
        ],
        pagination: {
          page: 1,
          page_size: 200,
          total_count: 1,
          total_pages: 1,
          has_next: false,
          has_prev: false,
        },
      },
    } as never)

    await service.syncFromServer()

    expect(service.getRecord('Manual/Outside.md')).toMatchObject({
      status: 'processed',
      docId: 'server-id',
      policy: POLICY,
    })
  })

  it('never promotes a desired pending policy from server status alone', async () => {
    const adapter = new MemoryAdapter()
    const service = new DocIndexService(plugin(adapter))
    await service.load()
    const pending = {
      backendId: 'backend-current',
      kind: 'replace' as const,
      stage: 'tracking' as const,
      policy: POLICY,
      mtime: 20,
      source: `nc-${'e'.repeat(64)}.md`,
      trackId: 'track-2',
    }
    await service.saveRecord(
      'Historical.md',
      record({
        source: pending.source,
        policy: undefined,
        pending,
      }),
    )
    jest.mocked(requestUrl).mockResolvedValue({
      status: 200,
      json: {
        documents: [
          { id: 'new-id', file_path: pending.source, status: 'PROCESSED' },
        ],
        pagination: {
          page: 1,
          page_size: 200,
          total_count: 1,
          total_pages: 1,
          has_next: false,
          has_prev: false,
        },
      },
    } as never)

    await service.syncFromServer()

    expect(service.getRecord('Historical.md')).toMatchObject({
      status: 'processed',
      docId: 'new-id',
      pending,
    })
    expect(service.getRecord('Historical.md')?.policy).toBeUndefined()
  })

  it.each(['upload_requested', 'tracking'] as const)(
    'preserves accepted removal through an early empty %s snapshot and later visibility',
    async (stage) => {
      const adapter = new MemoryAdapter()
      const service = new DocIndexService(plugin(adapter))
      await service.load()
      const source = `nc-${'4'.repeat(64)}.md`
      const pending = {
        backendId: 'backend-current',
        kind: 'ingest' as const,
        stage,
        policy: POLICY,
        mtime: 20,
        source,
        ...(stage === 'tracking'
          ? { docId: 'accepted-doc', trackId: 'track-accepted' }
          : {}),
      }
      const removal = record({
        status: 'processing',
        docId: undefined,
        mtime: 20,
        source,
        pending,
        removeRequested: true,
      })
      await service.saveRecord('Remove.md', removal)
      jest
        .mocked(requestUrl)
        .mockResolvedValueOnce({
          status: 200,
          json: {
            documents: [],
            pagination: {
              page: 1,
              page_size: 200,
              total_count: 0,
              total_pages: 0,
              has_next: false,
              has_prev: false,
            },
            status_counts: {},
          },
        } as never)
        .mockResolvedValueOnce({
          status: 200,
          json: {
            documents: [
              {
                id: 'accepted-doc',
                file_path: source,
                status: 'PROCESSED',
              },
            ],
            pagination: {
              page: 1,
              page_size: 200,
              total_count: 1,
              total_pages: 1,
              has_next: false,
              has_prev: false,
            },
            status_counts: { PROCESSED: 1 },
          },
        } as never)

      await service.syncFromServer()
      const reloaded = new DocIndexService(plugin(adapter))
      await reloaded.load()
      expect(reloaded.getRecord('Remove.md')).toEqual(removal)

      await reloaded.syncFromServer()
      expect(reloaded.getRecord('Remove.md')).toEqual({
        ...removal,
        status: 'processed',
        docId: 'accepted-doc',
      })
      expect(
        jest.mocked(requestUrl).mock.calls.every(([input]) => {
          return (
            typeof input !== 'string' &&
            input.url.endsWith('/documents/paginated')
          )
        }),
      ).toBe(true)
    },
  )

  it('keeps intentional removal pending until authoritative absence is confirmed', async () => {
    const adapter = new MemoryAdapter()
    const service = new DocIndexService(plugin(adapter))
    await service.load()
    const source = `nc-${'f'.repeat(64)}.md`
    await service.saveRecord(
      'Remove.md',
      record({ source, docId: 'remove-id', removeRequested: true }),
    )
    jest
      .mocked(requestUrl)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          documents: [
            { id: 'remove-id', file_path: source, status: 'PROCESSED' },
          ],
          pagination: {
            page: 1,
            page_size: 200,
            total_count: 1,
            total_pages: 1,
            has_next: false,
            has_prev: false,
          },
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          documents: [],
          pagination: {
            page: 1,
            page_size: 200,
            total_count: 0,
            total_pages: 0,
            has_next: false,
            has_prev: false,
          },
        },
      } as never)

    expect(service.needsIngestion('Remove.md', 99)).toBe(false)
    await service.syncFromServer()
    expect(service.getRecord('Remove.md')).toMatchObject({
      status: 'processed',
      docId: 'remove-id',
      removeRequested: true,
    })

    await service.syncFromServer()
    expect(service.getRecord('Remove.md')).toMatchObject({
      status: 'removed',
      source,
      policy: POLICY,
    })
    expect(service.getRecord('Remove.md')?.docId).toBeUndefined()
    expect(service.getRecord('Remove.md')?.removeRequested).toBeUndefined()
  })

  it('uses incomplete grouped fallback for positive observations only', async () => {
    const service = new DocIndexService(plugin(new MemoryAdapter()))
    await service.load()
    const pending = {
      backendId: 'backend-current',
      kind: 'replace' as const,
      stage: 'tracking' as const,
      policy: POLICY,
      mtime: 20,
      source: `nc-${'6'.repeat(64)}.md`,
      docId: 'remove-id',
      trackId: 'remove-track',
    }
    const removal = record({
      status: 'processing',
      docId: 'remove-id',
      source: pending.source,
      pending,
      removeRequested: true,
    })
    const missing = record({
      docId: 'missing-id',
      source: `nc-${'7'.repeat(64)}.md`,
    })
    await service.saveRecord('Remove.md', removal)
    await service.saveRecord('Missing.md', missing)
    await service.saveRecord(
      'Present.md',
      record({ status: 'processing', docId: 'present-id' }),
    )
    jest
      .mocked(requestUrl)
      .mockResolvedValueOnce({ status: 404, json: {} } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          processed: [
            {
              id: 'present-id',
              file_path: record().source,
              status: 'PROCESSED',
            },
          ],
        },
      } as never)

    await service.syncFromServer()

    expect(service.getRecord('Present.md')?.status).toBe('processed')
    expect(service.getRecord('Remove.md')).toEqual(removal)
    expect(service.getRecord('Missing.md')).toEqual(missing)
  })

  it('treats authorization and incomplete pagination as unknown outcomes', async () => {
    const adapter = new MemoryAdapter()
    const service = new DocIndexService(plugin(adapter))
    await service.load()
    await service.saveRecord('Keep.md', record())
    jest
      .mocked(requestUrl)
      .mockResolvedValue({ status: 401, json: {} } as never)

    await service.syncFromServer()

    expect(service.getRecord('Keep.md')).toEqual(record())
  })
})
