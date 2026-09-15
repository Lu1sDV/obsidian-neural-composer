import { requestUrl } from 'obsidian'
import type { App, RequestUrlResponse, TFile } from 'obsidian'

import { RAGEngine } from './ragEngine'

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  requestUrl: jest.fn(),
  TFile: class TFile {},
}))

const mockCast = <T>(value: unknown): T => value as T
const requestUrlMock = jest.mocked(requestUrl) as jest.MockedFunction<
  (...args: Parameters<typeof requestUrl>) => Promise<RequestUrlResponse>
>

const paragraphPolicy = {
  mode: 'paragraph' as const,
  chunkSize: 1200,
  chunkOverlap: 100,
}
const legacyPolicy = {
  mode: 'legacy' as const,
  chunkSize: 900,
  chunkOverlap: 90,
}

type TestRecord = {
  status: string
  docId?: string
  mtime?: number
  source?: string
  policy?: typeof paragraphPolicy | typeof legacyPolicy
  pending?: Record<string, unknown>
  aliases?: string[]
  removeRequested?: boolean
}

function response(
  status: number,
  json: unknown = {},
  text = '',
): RequestUrlResponse {
  return mockCast<RequestUrlResponse>({ status, json, text })
}

function file(path = 'Projects/Architecture.md', extension = 'md'): TFile {
  const name = path.split('/').pop() ?? path
  const basename = name.replace(/\.[^.]+$/, '')
  return mockCast<TFile>({
    path,
    name,
    basename,
    extension,
    stat: { mtime: 100, ctime: 50, size: 20 },
  })
}

function multipartFilename(body: ArrayBuffer): string {
  const match = new TextDecoder().decode(body).match(/filename="([^"]+)"/)
  if (!match) throw new Error('multipart filename missing')
  return match[1]
}

function canonicalUploadSource(filename: string): string {
  return filename.replace(/\.\[[^\]]+\](\.[^.]+)$/, '$1')
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function makeEngine(options?: {
  records?: Record<string, TestRecord>
  read?: string
  binary?: ArrayBuffer
  resolveSource?: (source: string) => string | null
  settings?: Record<string, unknown>
  productionCompatibility?: boolean
}) {
  const records = options?.records ?? {}
  const read = jest.fn().mockResolvedValue(options?.read ?? '# Heading\n\nBody')
  const readBinary = jest
    .fn()
    .mockResolvedValue(options?.binary ?? new Uint8Array([1, 2, 3]).buffer)
  const app = mockCast<App>({
    vault: {
      read,
      readBinary,
      getAbstractFileByPath: jest.fn(),
    },
  })
  const docIndex = {
    getRecord: jest.fn((path: string, _backendId?: string) => records[path]),
    getRecords: jest.fn((_backendId?: string) => records),
    listDocuments: jest.fn(
      async (_backendId?: string): Promise<Record<string, unknown>[]> => [],
    ),
    saveRecord: jest.fn(
      async (
        path: string,
        record: TestRecord,
        _backendId?: string,
        _options?: {
          previousPath?: string
          clearRemovalIntent?: boolean
        },
      ) => {
        records[path] = record
      },
    ),
    resolveSource: jest.fn(
      options?.resolveSource ?? ((_source: string): string | null => null),
    ),
    rebuildSourceMap: jest.fn().mockResolvedValue(undefined),
  }
  const settings = {
    lightRagApiKey: '',
    lightRagServerUrl: 'http://localhost:9621',
    lightRagBackendIdentity: 'backend-a',
    lightRagVaultNamespace: 'vault-a',
    lightRagChunkingStrategy: 'paragraph',
    lightRagChunkSize: 1200,
    lightRagChunkOverlap: 100,
    lightRagExcludePatterns: [],
    lightRagExcludeHiddenFiles: true,
    lightRagQueryMode: 'mix',
    enableAutoStartServer: false,
    ...options?.settings,
  }
  const engine = Object.assign(Object.create(RAGEngine.prototype), {
    app,
    settings,
    vectorManager: null,
    embeddingModel: null,
    docIndexService: docIndex,
    restartServerCallback: () => Promise.resolve(),
  }) as RAGEngine
  if (!options?.productionCompatibility) {
    // Exercise lifecycle behavior independently of the upstream release blocker.
    jest.spyOn(engine, 'getParagraphCompatibility').mockResolvedValue({
      status: 'supported',
      message: 'Synthetic test fixture; not release qualification.',
    })
  }
  return { engine, app, settings, docIndex, records, read, readBinary }
}

function installNativeUploadSuccess(
  docId = 'doc-native',
  metadata: Record<string, unknown> = {
    parse_engine: 'native',
    process_options: 'P',
    parse_format: 'lightrag',
    chunk_method: 'paragraph_semantic',
    chunk_opts: 'size=1200, overlap=100, drop_rf=False',
  },
) {
  let source = ''
  requestUrlMock.mockImplementation(async (input) => {
    if (typeof input === 'string') throw new Error('request options expected')
    if (input.url.endsWith('/health')) {
      return response(200, { core_version: '1.5.7' })
    }
    if (input.url.endsWith('/documents/supported_file_types')) {
      return response(200, {
        supported_extensions: ['.md', '.docx'],
        engines: { native: ['.md', '.docx'] },
      })
    }
    if (input.url.endsWith('/documents/upload')) {
      source = canonicalUploadSource(
        multipartFilename(input.body as ArrayBuffer),
      )
      return response(200, {
        status: 'success',
        track_id: 'track-native',
        message: 'accepted',
      })
    }
    if (input.url.endsWith('/documents/track_status/track-native')) {
      return response(200, {
        track_id: 'track-native',
        total_count: 1,
        status_summary: { PROCESSED: 1 },
        documents: [
          {
            id: docId,
            file_path: source,
            status: 'processed',
            metadata,
          },
        ],
      })
    }
    throw new Error(`unexpected request ${input.method} ${input.url}`)
  })
}

beforeEach(() => {
  requestUrlMock.mockReset()
})

describe('RAGEngine native paragraph transport', () => {
  it('uploads original Markdown through the parser-backed route and records the captured policy', async () => {
    const original = '---\ntags: [native]\n---\n# Real heading\n\nBody'
    const note = file('Folder/Architecture.md')
    const binary = new Uint8Array(new TextEncoder().encode(original)).buffer
    const { engine, records } = makeEngine({ read: original, binary })
    installNativeUploadSuccess()

    await expect(
      engine.ingestFile(note, { intent: 'new', policy: paragraphPolicy }),
    ).resolves.toEqual({
      status: 'processed',
      path: note.path,
      docId: 'doc-native',
    })

    const upload = requestUrlMock.mock.calls
      .map(([call]) => call)
      .find(
        (call) =>
          typeof call !== 'string' && call.url.endsWith('/documents/upload'),
      )
    if (!upload || typeof upload === 'string') throw new Error('upload missing')
    const wire = new TextDecoder().decode(upload.body as ArrayBuffer)
    expect(multipartFilename(upload.body as ArrayBuffer)).toMatch(
      /^nc-[a-f0-9]{64}\.\[native-P\(chunk_ts=1200,chunk_ol=100,drop_rf=false\)\]\.md$/,
    )
    expect(wire).toContain(original)
    expect(wire).not.toContain('Title: Architecture')
    expect(
      requestUrlMock.mock.calls.some(
        ([call]) =>
          typeof call !== 'string' && call.url.endsWith('/documents/texts'),
      ),
    ).toBe(false)
    expect(records[note.path]).toMatchObject({
      status: 'processed',
      docId: 'doc-native',
      mtime: 100,
      policy: paragraphPolicy,
    })
    expect(records[note.path].pending).toBeUndefined()
    expect(records[note.path].source).toMatch(/^nc-[a-f0-9]{64}\.md$/)
  })

  it('does not complete a paragraph policy when LightRAG reports raw fallback chunking', async () => {
    const note = file('Folder/Fallback.md')
    const { engine, records } = makeEngine()
    installNativeUploadSuccess('doc-fallback', {
      parse_engine: 'legacy',
      process_options: 'P',
      parse_format: 'raw',
      chunk_method: 'recursive_character',
      chunk_opts: 'size=1200, overlap=100',
    })

    await expect(
      engine.ingestFile(note, { intent: 'new', policy: paragraphPolicy }),
    ).resolves.toMatchObject({
      status: 'paused',
      path: note.path,
      docId: 'doc-fallback',
    })
    expect(records[note.path].policy).toBeUndefined()
    expect(records[note.path].pending).toMatchObject({
      stage: 'tracking',
      policy: paragraphPolicy,
      paused: true,
    })
  })

  it('opts native DOCX out of smart-heading and sends the original bytes', async () => {
    const bytes = new Uint8Array([0, 255, 64, 7]).buffer
    const docx = file('Specs/Proposal.docx', 'docx')
    const { engine } = makeEngine({ binary: bytes })
    installNativeUploadSuccess('doc-docx')

    await expect(
      engine.ingestFile(docx, { intent: 'new', policy: paragraphPolicy }),
    ).resolves.toMatchObject({ status: 'processed', docId: 'doc-docx' })

    const upload = requestUrlMock.mock.calls
      .map(([call]) => call)
      .find(
        (call) =>
          typeof call !== 'string' && call.url.endsWith('/documents/upload'),
      )
    if (!upload || typeof upload === 'string') throw new Error('upload missing')
    expect(multipartFilename(upload.body as ArrayBuffer)).toMatch(
      /^nc-[a-f0-9]{64}\.\[native\(smart_heading=false\)-P\(chunk_ts=1200,chunk_ol=100,drop_rf=false\)\]\.docx$/,
    )
    const body = new Uint8Array(upload.body as ArrayBuffer)
    expect(Array.from(body).includes(255)).toBe(true)
  })

  it('retains the legacy Markdown title preamble and text route', async () => {
    const note = file('Legacy/Note.md')
    const { engine, records } = makeEngine({
      read: '# Existing heading',
      settings: { lightRagChunkingStrategy: 'legacy' },
    })
    let source = ''
    requestUrlMock.mockImplementation(async (input) => {
      if (typeof input === 'string') throw new Error('request options expected')
      if (input.url.endsWith('/documents/texts')) {
        if (typeof input.body !== 'string')
          throw new Error('JSON body expected')
        const body = JSON.parse(input.body) as {
          texts: string[]
          file_sources: string[]
          chunking: {
            strategy: string
            params: {
              chunk_token_size: number
              chunk_overlap_token_size: number
            }
          }
        }
        expect(body.texts).toEqual(['Title: Note\n\n# Existing heading'])
        expect(body).toMatchObject({
          chunking: {
            strategy: 'fixed_token',
            params: {
              chunk_token_size: 900,
              chunk_overlap_token_size: 90,
            },
          },
        })
        expect(body.file_sources[0]).toMatch(/^nc-[a-f0-9]{64}\.md$/)
        source = body.file_sources[0]
        return response(200, {
          status: 'success',
          track_id: 'track-legacy',
          message: 'accepted',
        })
      }
      if (input.url.endsWith('/documents/track_status/track-legacy')) {
        return response(200, {
          track_id: 'track-legacy',
          total_count: 1,
          documents: [
            {
              id: 'doc-legacy',
              file_path: source,
              status: 'processed',
              metadata: {
                source_file: source,
                process_options: 'F',
                chunk_method: 'fixed_token',
                chunk_opts: 'size=900, overlap=90',
              },
            },
          ],
        })
      }
      throw new Error(`unexpected request ${input.url}`)
    })

    await expect(
      engine.ingestFile(note, { intent: 'new', policy: legacyPolicy }),
    ).resolves.toMatchObject({ status: 'processed', docId: 'doc-legacy' })
    expect(records[note.path].policy).toEqual(legacyPolicy)
  })

  it('blocks the known table-header-losing backend before ingestion', async () => {
    const { engine } = makeEngine({ productionCompatibility: true })
    installNativeUploadSuccess()
    expect((await engine.getParagraphCompatibility()).status).toBe(
      'unsupported',
    )
    await expect(engine.ingestFile(file())).resolves.toMatchObject({
      status: 'paused',
    })
    expect(
      requestUrlMock.mock.calls.some(
        ([request]) =>
          typeof request !== 'string' &&
          request.url.endsWith('/documents/upload'),
      ),
    ).toBe(false)
  })

  it('reports future LightRAG releases as unverified rather than assuming compatibility', async () => {
    const { engine } = makeEngine({ productionCompatibility: true })
    requestUrlMock
      .mockResolvedValueOnce(response(200, { core_version: '1.5.8' }))
      .mockResolvedValueOnce(
        response(200, {
          supported_extensions: ['.md', '.docx'],
          engines: { native: ['.md', '.docx'] },
        }),
      )

    await expect(engine.getParagraphCompatibility()).resolves.toMatchObject({
      status: 'unverified',
      version: '1.5.8',
    })
  })

  it('blocks every release the preservation corpus measured, not only the pinned one', async () => {
    for (const version of ['1.5.4', '1.5.5', '1.5.6', '1.5.7']) {
      const { engine } = makeEngine({ productionCompatibility: true })
      requestUrlMock
        .mockResolvedValueOnce(response(200, { core_version: version }))
        .mockResolvedValueOnce(
          response(200, {
            supported_extensions: ['.md', '.docx'],
            engines: { native: ['.md', '.docx'] },
          }),
        )

      await expect(engine.getParagraphCompatibility()).resolves.toMatchObject({
        status: 'unsupported',
        version,
      })
      await expect(engine.ingestFile(file())).resolves.toMatchObject({
        status: 'paused',
      })
    }
  })
})

describe('RAGEngine replacement and failure semantics', () => {
  it('does not implicitly migrate an existing document through new ingestion', async () => {
    const note = file()
    const oldPolicy = { ...paragraphPolicy, chunkSize: 900 }
    const { engine, records } = makeEngine({
      records: {
        [note.path]: {
          status: 'processed',
          docId: 'existing',
          policy: oldPolicy,
          mtime: 1,
        },
      },
    })

    await expect(
      engine.ingestFile(note, { intent: 'new' }),
    ).resolves.toMatchObject({
      status: 'skipped',
    })
    expect(records[note.path].policy).toEqual(oldPolicy)
    expect(requestUrlMock).not.toHaveBeenCalled()
  })

  it.each(['delete_requested', 'upload_requested'])(
    'does not redirect mutations when the backend changes during %s persistence',
    async (stage) => {
      const note = file()
      const { engine, settings, records, docIndex } = makeEngine({
        records:
          stage === 'delete_requested'
            ? {
                [note.path]: {
                  status: 'processed',
                  docId: 'old-document',
                  policy: paragraphPolicy,
                  mtime: 1,
                },
              }
            : {},
      })
      installNativeUploadSuccess()
      docIndex.saveRecord.mockImplementation(async (path, record) => {
        records[path] = record
        if (record.pending?.stage === stage) {
          settings.lightRagBackendIdentity = 'backend-b'
          settings.lightRagServerUrl = 'http://localhost:9639'
        }
      })

      await engine.ingestFile(note, { intent: 'reprocess' })

      expect(
        requestUrlMock.mock.calls.filter(
          ([request]) =>
            typeof request !== 'string' &&
            (request.method === 'DELETE' ||
              request.url.endsWith('/documents/upload') ||
              request.url.endsWith('/documents/texts')),
        ),
      ).toEqual([])
    },
  )

  it('reconciles a completed document after its tracking ID expires', async () => {
    const note = file()
    const source = `nc-${'e'.repeat(64)}.md`
    const { engine, docIndex, records } = makeEngine({
      records: {
        [note.path]: {
          status: 'processing',
          pending: {
            backendId: 'backend-a',
            kind: 'ingest',
            stage: 'tracking',
            trackId: 'expired',
            source,
            policy: paragraphPolicy,
            mtime: 100,
          },
        },
      },
    })
    requestUrlMock.mockResolvedValueOnce(response(404))
    docIndex.listDocuments.mockResolvedValue([
      {
        id: 'completed',
        file_path: source,
        status: 'processed',
        metadata: {
          source_file: `nc-${'e'.repeat(64)}.[native-P(chunk_ts=1200,chunk_ol=100,drop_rf=false)].md`,
          parse_engine: 'native',
          parse_format: 'lightrag',
          process_options: 'P',
          chunk_method: 'paragraph_semantic',
          chunk_opts: 'size=1200, overlap=100, drop_rf=False',
        },
      },
    ])

    await engine.recoverPendingOperations()

    expect(records[note.path].status).toBe('processed')
    expect(records[note.path].pending).toBeUndefined()
  })

  it('reconciles an expired legacy text track without a metadata source_file hint', async () => {
    const note = file('Legacy/Recovered.md')
    const source = `nc-${'5'.repeat(64)}.md`
    const recoveredPolicy = {
      mode: 'legacy' as const,
      chunkSize: 800,
      chunkOverlap: 80,
    }
    const { engine, docIndex, records } = makeEngine({
      records: {
        [note.path]: {
          status: 'processing',
          source,
          policy: recoveredPolicy,
          pending: {
            backendId: 'backend-a',
            kind: 'ingest',
            stage: 'tracking',
            trackId: 'expired-legacy',
            source,
            policy: recoveredPolicy,
            mtime: 100,
          },
        },
      },
      settings: { lightRagChunkingStrategy: 'legacy' },
    })
    requestUrlMock.mockResolvedValueOnce(response(404))
    docIndex.listDocuments.mockResolvedValue([
      {
        id: 'legacy-completed',
        file_path: source,
        status: 'PROCESSED',
        track_id: null,
        metadata: {
          parse_engine: 'legacy',
          parse_format: 'raw',
          process_options: 'F',
          chunk_method: 'fixed_token',
          chunk_opts: 'size=800, split_only=False, overlap=80',
        },
      },
    ])

    await engine.recoverPendingOperations()

    expect(records[note.path]).toMatchObject({
      status: 'processed',
      docId: 'legacy-completed',
      source,
      policy: recoveredPolicy,
      mtime: 100,
    })
    expect(records[note.path].pending).toBeUndefined()
    expect(
      requestUrlMock.mock.calls.some(
        ([input]) =>
          typeof input !== 'string' &&
          (input.url.endsWith('/documents/upload') ||
            input.url.endsWith('/documents/texts')),
      ),
    ).toBe(false)
  })

  it('pins a known completed policy for sync and treats HTTP 200 busy as no deletion', async () => {
    const note = file()
    const source = `nc-${'a'.repeat(64)}.md`
    const { engine, records } = makeEngine({
      records: {
        [note.path]: {
          status: 'processed',
          docId: 'doc-old',
          source,
          policy: paragraphPolicy,
          mtime: 50,
        },
      },
      settings: { lightRagChunkingStrategy: 'legacy' },
    })
    requestUrlMock.mockImplementation(async (input) => {
      if (typeof input === 'string') throw new Error('request options expected')
      if (input.url.endsWith('/health')) {
        return response(200, { core_version: '1.5.7' })
      }
      if (input.url.endsWith('/documents/supported_file_types')) {
        return response(200, {
          supported_extensions: ['.md', '.docx'],
          engines: { native: ['.md', '.docx'] },
        })
      }
      if (input.url.endsWith('/documents/delete_document')) {
        return response(200, {
          status: 'busy',
          doc_id: 'doc-old',
          message: 'pipeline busy',
        })
      }
      throw new Error(`unexpected request ${input.url}`)
    })

    await expect(
      engine.ingestFile(note, { intent: 'sync' }),
    ).resolves.toMatchObject({ status: 'paused', path: note.path })
    expect(records[note.path].pending).toMatchObject({
      kind: 'replace',
      stage: 'prepared',
      policy: paragraphPolicy,
      source,
      docId: 'doc-old',
      paused: true,
    })
    expect(
      requestUrlMock.mock.calls.some(
        ([call]) =>
          typeof call !== 'string' && call.url.endsWith('/documents/upload'),
      ),
    ).toBe(false)
  })

  it('keeps an unknown legacy policy paused until explicit policy adoption', async () => {
    const note = file('Legacy/Unknown.md')
    const { engine, records } = makeEngine({
      records: {
        [note.path]: {
          status: 'processed',
          docId: 'legacy-doc',
          source: 'Unknown.md',
          mtime: 40,
        },
      },
    })

    await expect(
      engine.ingestFile(note, { intent: 'sync' }),
    ).resolves.toMatchObject({
      status: 'paused',
    })
    expect(requestUrlMock).not.toHaveBeenCalled()
    expect(records[note.path].policy).toBeUndefined()
  })

  it('captures an explicitly adopted policy for reprocessing an unknown legacy record', async () => {
    const note = file('Legacy/Unknown.md')
    const { engine, records } = makeEngine({
      records: {
        [note.path]: {
          status: 'processed',
          docId: 'legacy-doc',
          source: 'Unknown.md',
          mtime: 40,
        },
      },
    })
    requestUrlMock.mockResolvedValue(
      response(200, {
        status: 'busy',
        doc_id: 'legacy-doc',
        message: 'pipeline busy',
      }),
    )

    await engine.ingestFile(note, {
      intent: 'reprocess',
      policy: legacyPolicy,
    })

    expect(records[note.path].policy).toBeUndefined()
    expect(records[note.path].pending).toMatchObject({ policy: legacyPolicy })
  })

  it('confirms deletion only after a complete authoritative document read', async () => {
    const { engine, docIndex, records } = makeEngine({
      records: {
        'Folder/Target.md': {
          status: 'processed',
          docId: 'target',
          source: 'Target.md',
          policy: legacyPolicy,
        },
      },
    })
    docIndex.listDocuments
      .mockResolvedValueOnce([
        { id: 'target', file_path: 'Target.md', status: 'PROCESSED' },
      ])
      .mockResolvedValueOnce([])
    requestUrlMock.mockResolvedValueOnce(
      response(200, {
        status: 'deletion_started',
        doc_id: 'target',
        message: 'started',
      }),
    )

    await expect(engine.deleteDocumentsByIds(['target'])).resolves.toBe(true)
    expect(requestUrlMock).toHaveBeenCalledTimes(1)
    expect(records['Folder/Target.md']).toMatchObject({
      status: 'removed',
      source: 'Target.md',
      policy: legacyPolicy,
    })
    expect(records['Folder/Target.md'].docId).toBeUndefined()
    expect(records['Folder/Target.md'].removeRequested).toBeUndefined()
  })

  it('persists explicit removal intent when HTTP 200 reports busy', async () => {
    const { engine, docIndex, records } = makeEngine({
      records: {
        'Folder/Target.md': {
          status: 'processed',
          docId: 'target',
          source: 'Target.md',
        },
      },
    })
    docIndex.listDocuments.mockResolvedValue([
      { id: 'target', file_path: 'Target.md', status: 'PROCESSED' },
    ])
    requestUrlMock.mockResolvedValue(
      response(200, {
        status: 'busy',
        doc_id: 'target',
        message: 'pipeline busy',
      }),
    )

    await expect(engine.deleteDocumentsByIds(['target'])).resolves.toBe(false)
    expect(records['Folder/Target.md']).toMatchObject({
      status: 'processed',
      docId: 'target',
      removeRequested: true,
    })
  })

  it('fails closed instead of returning a partial document list', async () => {
    const { engine, docIndex } = makeEngine()
    docIndex.listDocuments.mockRejectedValue(
      new Error('Document listing failed with HTTP 503'),
    )

    await expect(engine.listAllDocumentPaths()).rejects.toThrow('503')
  })

  it('does not blindly retry after an upload acknowledgement is lost', async () => {
    const note = file()
    const { engine, records } = makeEngine()
    requestUrlMock.mockImplementation(async (input) => {
      if (typeof input === 'string') throw new Error('request options expected')
      if (input.url.endsWith('/health')) {
        return response(200, { core_version: '1.5.7' })
      }
      if (input.url.endsWith('/documents/supported_file_types')) {
        return response(200, {
          supported_extensions: ['.md', '.docx'],
          engines: { native: ['.md', '.docx'] },
        })
      }
      if (input.url.endsWith('/documents/upload')) {
        throw new Error('connection reset after send')
      }
      throw new Error(`unexpected request ${input.url}`)
    })

    await expect(
      engine.ingestFile(note, { intent: 'new', policy: paragraphPolicy }),
    ).resolves.toMatchObject({ status: 'paused', path: note.path })
    const uploads = requestUrlMock.mock.calls.filter(
      ([call]) =>
        typeof call !== 'string' && call.url.endsWith('/documents/upload'),
    )
    expect(uploads).toHaveLength(1)
    expect(records[note.path].pending).toMatchObject({
      stage: 'upload_requested',
      paused: true,
    })
  })

  it('stops scheduling after cancellation of an accepted upload and preserves tracking intent', async () => {
    const controller = new AbortController()
    const note = file()
    const { engine, records } = makeEngine()
    requestUrlMock.mockImplementation(async (input) => {
      if (typeof input === 'string') throw new Error('request options expected')
      if (input.url.endsWith('/health')) {
        return response(200, { core_version: '1.5.7' })
      }
      if (input.url.endsWith('/documents/supported_file_types')) {
        return response(200, {
          supported_extensions: ['.md', '.docx'],
          engines: { native: ['.md', '.docx'] },
        })
      }
      if (input.url.endsWith('/documents/upload')) {
        controller.abort()
        return response(200, {
          status: 'success',
          track_id: 'track-accepted',
          message: 'accepted',
        })
      }
      throw new Error(`unexpected request ${input.url}`)
    })

    await expect(
      engine.ingestFile(note, {
        intent: 'new',
        policy: paragraphPolicy,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ status: 'paused', path: note.path })
    expect(records[note.path].pending).toMatchObject({
      stage: 'tracking',
      trackId: 'track-accepted',
      paused: true,
    })
    expect(
      requestUrlMock.mock.calls.some(
        ([request]) =>
          typeof request !== 'string' &&
          request.url.includes('/documents/track_status/'),
      ),
    ).toBe(false)
  })

  it('does not replay a pending delete when reload reconciliation still finds the document', async () => {
    const note = file()
    const source = `nc-${'b'.repeat(64)}.md`
    const { engine, docIndex, records } = makeEngine({
      records: {
        [note.path]: {
          status: 'processing',
          docId: 'old-doc',
          source,
          policy: paragraphPolicy,
          pending: {
            backendId: 'backend-a',
            kind: 'replace',
            stage: 'delete_requested',
            policy: paragraphPolicy,
            mtime: 100,
            source,
            docId: 'old-doc',
          },
        },
      },
    })
    docIndex.listDocuments.mockResolvedValue([
      { id: 'old-doc', file_path: source, status: 'PROCESSED' },
    ])

    await engine.recoverPendingOperations()

    expect(docIndex.listDocuments).toHaveBeenCalledTimes(1)
    expect(records[note.path].pending).toMatchObject({
      stage: 'delete_requested',
      paused: true,
    })
    expect(
      requestUrlMock.mock.calls.some(
        ([call]) => typeof call !== 'string' && call.method === 'DELETE',
      ),
    ).toBe(false)
  })
})

describe('RAGEngine lifecycle ownership regressions', () => {
  it('can finish durable removal after an accepted tracked upload is retried after reload', async () => {
    const note = file()
    const source = `nc-${'d'.repeat(64)}.md`
    const records: Record<string, TestRecord> = {
      [note.path]: {
        status: 'processing',
        docId: 'accepted-doc',
        source,
        policy: paragraphPolicy,
        pending: {
          backendId: 'backend-a',
          kind: 'ingest',
          stage: 'tracking',
          trackId: 'accepted-track',
          policy: paragraphPolicy,
          mtime: 100,
          source,
          docId: 'accepted-doc',
        },
      },
    }
    const first = makeEngine({ records })
    first.docIndex.listDocuments.mockRejectedValueOnce(
      new Error('authoritative listing unavailable'),
    )
    let deletionStarted = false
    requestUrlMock.mockImplementation(async (input) => {
      if (typeof input === 'string') throw new Error('request options expected')
      if (input.url.endsWith('/documents/delete_document')) {
        deletionStarted = true
        return response(200, {
          status: 'deletion_started',
          message: 'started',
        })
      }
      throw new Error(`unexpected request ${input.url}`)
    })

    await expect(
      first.engine.deleteDocumentsByPaths([note.path]),
    ).resolves.toBe(false)
    expect(records[note.path].removeRequested).toBe(true)

    const reloaded = makeEngine({ records })
    reloaded.docIndex.listDocuments.mockImplementation(async () =>
      deletionStarted
        ? []
        : [{ id: 'accepted-doc', file_path: source, status: 'PROCESSED' }],
    )

    await expect(
      reloaded.engine.deleteDocumentsByPaths([note.path]),
    ).resolves.toBe(true)
    expect(records[note.path]).toMatchObject({
      status: 'removed',
      source,
      policy: paragraphPolicy,
    })
    expect(records[note.path].docId).toBeUndefined()
    expect(records[note.path].pending).toBeUndefined()
    expect(records[note.path].removeRequested).toBeUndefined()
    expect(
      requestUrlMock.mock.calls.some(
        ([call]) =>
          typeof call !== 'string' &&
          (call.url.endsWith('/documents/upload') ||
            call.url.endsWith('/documents/texts')),
      ),
    ).toBe(false)
  })

  it('does not let deferred tracking completion clear newer durable removal intent', async () => {
    const note = file()
    let source = ''
    let uploadName = ''
    const trackingStarted = deferred<void>()
    const trackingResponse = deferred<RequestUrlResponse>()
    const removalPersisted = deferred<void>()
    const { engine, docIndex, records } = makeEngine()
    docIndex.saveRecord.mockImplementation(async (path, record) => {
      records[path] = record
      if (record.removeRequested) removalPersisted.resolve()
    })
    docIndex.listDocuments.mockImplementation(async () => [
      { id: 'accepted-doc', file_path: source, status: 'PROCESSING' },
    ])
    requestUrlMock.mockImplementation(async (input) => {
      if (typeof input === 'string') throw new Error('request options expected')
      if (input.url.endsWith('/documents/upload')) {
        uploadName = multipartFilename(input.body as ArrayBuffer)
        source = canonicalUploadSource(uploadName)
        return response(200, {
          status: 'success',
          track_id: 'accepted-track',
          message: 'accepted',
        })
      }
      if (input.url.endsWith('/documents/track_status/accepted-track')) {
        trackingStarted.resolve()
        return trackingResponse.promise
      }
      if (input.url.endsWith('/documents/delete_document')) {
        return response(200, { status: 'busy', message: 'pipeline busy' })
      }
      throw new Error(`unexpected request ${input.url}`)
    })

    const ingestion = engine.ingestFile(note, {
      intent: 'new',
      policy: paragraphPolicy,
    })
    await trackingStarted.promise
    const removal = engine.deleteDocumentsByPaths([note.path])
    await removalPersisted.promise
    trackingResponse.resolve(
      response(200, {
        track_id: 'accepted-track',
        total_count: 1,
        status_summary: { PROCESSED: 1 },
        documents: [
          {
            id: 'accepted-doc',
            file_path: source,
            status: 'PROCESSED',
            metadata: {
              source_file: uploadName,
              parse_engine: 'native',
              parse_format: 'lightrag',
              process_options: 'P',
              chunk_method: 'paragraph_semantic',
              chunk_opts: 'size=1200, overlap=100, drop_rf=False',
            },
          },
        ],
      }),
    )

    await ingestion
    await expect(removal).resolves.toBe(false)
    expect(records[note.path]).toMatchObject({
      status: 'processed',
      docId: 'accepted-doc',
      removeRequested: true,
    })
  })

  it('does not confirm deletion from an incomplete authoritative listing', async () => {
    const path = 'Folder/Target.md'
    const { engine, docIndex, records } = makeEngine({
      records: {
        [path]: {
          status: 'processed',
          docId: 'target',
          source: 'Target.md',
          policy: legacyPolicy,
        },
      },
    })
    docIndex.listDocuments.mockRejectedValue(
      new Error('Incomplete paginated document response'),
    )

    await expect(engine.deleteDocumentsByIds(['target'])).resolves.toBe(false)
    expect(records[path]).toMatchObject({
      status: 'processed',
      docId: 'target',
      removeRequested: true,
    })
    expect(requestUrlMock).not.toHaveBeenCalled()
  })

  it('does not resume a replacement upload from an incomplete authoritative listing', async () => {
    const note = file()
    const source = `nc-${'f'.repeat(64)}.md`
    const { engine, docIndex, records } = makeEngine({
      records: {
        [note.path]: {
          status: 'processing',
          docId: 'old-doc',
          source,
          policy: paragraphPolicy,
          pending: {
            backendId: 'backend-a',
            kind: 'replace',
            stage: 'delete_requested',
            policy: paragraphPolicy,
            mtime: 100,
            source,
            docId: 'old-doc',
          },
        },
      },
    })
    docIndex.listDocuments.mockRejectedValue(
      new Error('Incomplete paginated document response'),
    )

    await engine.recoverPendingOperations()

    expect(records[note.path].pending).toMatchObject({
      stage: 'delete_requested',
      paused: true,
    })
    expect(requestUrlMock).not.toHaveBeenCalled()
  })

  it.each(['new', 'sync'] as const)(
    'does not assign a new policy to a source-bearing historical record during %s',
    async (intent) => {
      const note = file('Legacy/Historical.md')
      const historical = {
        status: 'processed',
        source: 'Historical.md',
        mtime: 1,
      } as const
      const { engine, docIndex, records } = makeEngine({
        records: { [note.path]: { ...historical } },
        settings: { lightRagChunkingStrategy: 'legacy' },
      })

      const result = await engine.ingestFile(note, { intent })

      expect(['paused', 'skipped']).toContain(result.status)
      expect(docIndex.saveRecord).not.toHaveBeenCalled()
      expect(records[note.path]).toEqual(historical)
      expect(requestUrlMock).not.toHaveBeenCalled()
    },
  )

  it('does not turn retry without pending work into reprocessing', async () => {
    const note = file()
    const source = `nc-${'1'.repeat(64)}.md`
    const completed = {
      status: 'processed',
      docId: 'completed-doc',
      source,
      policy: legacyPolicy,
      mtime: 1,
    } as const
    const { engine, docIndex, records } = makeEngine({
      records: { [note.path]: { ...completed } },
      settings: {
        lightRagChunkingStrategy: 'paragraph',
        lightRagChunkSize: 1200,
        lightRagChunkOverlap: 100,
      },
    })

    const result = await engine.ingestFile(note, { intent: 'retry' })

    expect(['paused', 'skipped']).toContain(result.status)
    expect(docIndex.saveRecord).not.toHaveBeenCalled()
    expect(records[note.path]).toEqual(completed)
    expect(requestUrlMock).not.toHaveBeenCalled()
  })

  it('does not mutate either record when a rename destination is already owned', async () => {
    const destination = file('New.md')
    const oldRecord = {
      status: 'processed',
      docId: 'doc-old',
      source: 'Old.md',
      policy: legacyPolicy,
      mtime: 1,
    } as const
    const destinationRecord = {
      status: 'processed',
      docId: 'doc-new',
      source: 'New.md',
      policy: legacyPolicy,
      mtime: 1,
    } as const
    const { engine, docIndex, records } = makeEngine({
      records: {
        'Old.md': { ...oldRecord },
        [destination.path]: { ...destinationRecord },
      },
      settings: { lightRagChunkingStrategy: 'legacy' },
    })
    requestUrlMock.mockResolvedValue(
      response(200, { status: 'busy', message: 'pipeline busy' }),
    )

    await expect(
      engine.ingestFile(destination, {
        intent: 'sync',
        previousPath: 'Old.md',
      }),
    ).resolves.toMatchObject({ status: 'paused' })

    expect(docIndex.saveRecord).not.toHaveBeenCalled()
    expect(records).toEqual({
      'Old.md': oldRecord,
      [destination.path]: destinationRecord,
    })
    expect(
      requestUrlMock.mock.calls.some(
        ([call]) =>
          typeof call !== 'string' &&
          (call.method === 'DELETE' ||
            call.url.endsWith('/documents/upload') ||
            call.url.endsWith('/documents/texts')),
      ),
    ).toBe(false)
  })
})

describe('RAGEngine backend ownership across awaited preparation', () => {
  it('stops when backend ownership changes during compatibility discovery', async () => {
    const compatibilityStarted = deferred<void>()
    const compatibility = deferred<{
      status: 'supported'
      message: string
    }>()
    const { engine, settings, docIndex } = makeEngine()
    jest
      .spyOn(engine, 'getParagraphCompatibility')
      .mockImplementation(async () => {
        compatibilityStarted.resolve()
        return compatibility.promise
      })

    const ingestion = engine.ingestFile(file(), {
      intent: 'new',
      policy: paragraphPolicy,
    })
    await compatibilityStarted.promise
    settings.lightRagBackendIdentity = 'backend-b'
    settings.lightRagServerUrl = 'http://localhost:9639'
    settings.lightRagVaultNamespace = 'vault-b'
    compatibility.resolve({ status: 'supported', message: 'supported' })

    await expect(ingestion).resolves.toMatchObject({ status: 'paused' })
    expect(docIndex.saveRecord).not.toHaveBeenCalled()
    expect(requestUrlMock).not.toHaveBeenCalled()
  })

  it('stops when the namespace changes during a vault read', async () => {
    const readStarted = deferred<void>()
    const readResult = deferred<string>()
    const { engine, settings, docIndex, read } = makeEngine({
      settings: { lightRagChunkingStrategy: 'legacy' },
    })
    read.mockImplementation(async () => {
      readStarted.resolve()
      return readResult.promise
    })

    const ingestion = engine.ingestFile(file(), {
      intent: 'new',
      policy: legacyPolicy,
    })
    await readStarted.promise
    settings.lightRagVaultNamespace = 'vault-b'
    readResult.resolve('# Heading\n\nBody')

    await expect(ingestion).resolves.toMatchObject({ status: 'paused' })
    expect(docIndex.saveRecord).not.toHaveBeenCalled()
    expect(requestUrlMock).not.toHaveBeenCalled()
  })

  it('stops when the namespace changes while hashing the transport source', async () => {
    const digestStarted = deferred<void>()
    const continueDigest = deferred<void>()
    const originalDigest = globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle,
    )
    const digestSpy = jest
      .spyOn(globalThis.crypto.subtle, 'digest')
      .mockImplementation(
        async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
          digestStarted.resolve()
          await continueDigest.promise
          return originalDigest(algorithm, data)
        },
      )
    const { engine, settings, docIndex } = makeEngine({
      settings: { lightRagChunkingStrategy: 'legacy' },
    })

    try {
      const ingestion = engine.ingestFile(file(), {
        intent: 'new',
        policy: legacyPolicy,
      })
      await digestStarted.promise
      settings.lightRagVaultNamespace = 'vault-b'
      continueDigest.resolve()

      await expect(ingestion).resolves.toMatchObject({ status: 'paused' })
      expect(docIndex.saveRecord).not.toHaveBeenCalled()
      expect(requestUrlMock).not.toHaveBeenCalled()
    } finally {
      digestSpy.mockRestore()
    }
  })

  it('stops when backend ownership changes during existing-source discovery', async () => {
    const listingStarted = deferred<void>()
    const continueListing = deferred<void>()
    const { engine, settings, docIndex } = makeEngine({
      settings: { lightRagChunkingStrategy: 'legacy' },
    })
    docIndex.listDocuments.mockImplementation(async () => {
      listingStarted.resolve()
      await continueListing.promise
      return []
    })

    const ingestion = engine.ingestFile(file(), {
      intent: 'new',
      policy: legacyPolicy,
    })
    await listingStarted.promise
    settings.lightRagBackendIdentity = 'backend-b'
    settings.lightRagServerUrl = 'http://localhost:9639'
    continueListing.resolve()

    await expect(ingestion).resolves.toMatchObject({ status: 'paused' })
    expect(docIndex.saveRecord).not.toHaveBeenCalled()
    expect(requestUrlMock).not.toHaveBeenCalled()
  })
})

describe('RAGEngine exact source discovery and resolution', () => {
  it('lists legacy mapping candidates from the authoritative index', async () => {
    const note = file('Folder/Report.md')
    const { engine, docIndex } = makeEngine()
    docIndex.listDocuments.mockResolvedValue([
      { id: 'unrelated', file_path: 'Other.md', status: 'PROCESSED' },
      { id: 'legacy-a', file_path: 'Report.md', status: 'PROCESSED' },
      {
        id: 'legacy-b',
        file_path: 'Archive/Report.md',
        status: 'FAILED',
      },
    ])

    await expect(engine.listDocumentCandidates(note)).resolves.toEqual([
      { id: 'legacy-a', source: 'Report.md', status: 'PROCESSED' },
      {
        id: 'legacy-b',
        source: 'Archive/Report.md',
        status: 'FAILED',
      },
    ])
  })

  it('binds only a re-fetched exact server ID and keeps historical policy unknown', async () => {
    const note = file('Folder/Report.md')
    const { engine, docIndex, records } = makeEngine()
    docIndex.listDocuments.mockResolvedValue([
      { id: 'legacy-a', file_path: 'Report.md', status: 'PROCESSED' },
    ])

    await engine.bindDocument(note, 'legacy-a')

    expect(records[note.path]).toMatchObject({
      status: 'processed',
      docId: 'legacy-a',
      source: 'Report.md',
    })
    expect(records[note.path].policy).toBeUndefined()
  })

  it('refuses to bind a server document already owned by another vault path', async () => {
    const note = file('Folder/Report.md')
    const { engine, docIndex } = makeEngine({
      records: {
        'Other/Report.md': {
          status: 'processed',
          docId: 'legacy-a',
          source: 'Report.md',
        },
      },
    })
    docIndex.listDocuments.mockResolvedValue([
      { id: 'legacy-a', file_path: 'Report.md', status: 'PROCESSED' },
    ])

    await expect(engine.bindDocument(note, 'legacy-a')).rejects.toThrow(
      'Other/Report.md',
    )
    expect(docIndex.saveRecord).not.toHaveBeenCalled()
  })

  it('resolves LightRAG transport sources in query references without changing retrieval', async () => {
    const transport = `nc-${'c'.repeat(64)}.md`
    const { engine, docIndex } = makeEngine({
      resolveSource: (source) =>
        source === transport ? 'Folder/Resolved.md' : null,
    })
    requestUrlMock.mockResolvedValue(
      response(200, {
        response: 'Answer [1]',
        references: [{ file_path: transport, content: 'quoted chunk' }],
      }),
    )

    const results = (await engine.processQuery({
      query: 'question',
    })) as unknown as {
      path: string
      model?: string
      metadata?: { fileName?: string }
    }[]

    expect(results[1]).toMatchObject({
      model: 'lightrag-ref',
      path: 'Folder/Resolved.md',
      metadata: { fileName: 'Folder/Resolved.md' },
    })
    expect(docIndex.resolveSource).toHaveBeenCalledWith(transport)
    const queryCall = requestUrlMock.mock.calls[0][0]
    if (typeof queryCall === 'string')
      throw new Error('request options expected')
    expect(queryCall.url).toBe('http://localhost:9621/query')
    if (typeof queryCall.body !== 'string')
      throw new Error('JSON body expected')
    expect(JSON.parse(queryCall.body)).toMatchObject({
      query: 'question',
      mode: 'mix',
      include_references: true,
    })
  })
})

describe('RAGEngine bounded lifecycle recovery and deletion', () => {
  it('does not redirect a later recovery removal after backend ownership drifts', async () => {
    const trackingStarted = deferred<void>()
    const trackingResponse = deferred<RequestUrlResponse>()
    const firstPath = 'Folder/First.md'
    const removalPath = 'Folder/Remove.md'
    const firstSource = `nc-${'2'.repeat(64)}.md`
    const firstRecord: TestRecord = {
      status: 'processing',
      source: firstSource,
      policy: paragraphPolicy,
      pending: {
        backendId: 'backend-a',
        kind: 'ingest',
        stage: 'tracking',
        trackId: 'first-track',
        policy: paragraphPolicy,
        mtime: 100,
        source: firstSource,
      },
    }
    const removalRecord: TestRecord = {
      status: 'processed',
      docId: 'remove-doc',
      source: 'Remove.md',
      policy: legacyPolicy,
      removeRequested: true,
      pending: {
        backendId: 'backend-a',
        kind: 'ingest',
        stage: 'prepared',
        policy: legacyPolicy,
        mtime: 100,
        source: 'Remove.md',
        docId: 'remove-doc',
      },
    }
    const buckets: Record<string, Record<string, TestRecord>> = {
      'backend-a': {
        [firstPath]: firstRecord,
        [removalPath]: removalRecord,
      },
      'backend-b': {},
    }
    const { engine, settings, docIndex } = makeEngine({
      records: buckets['backend-a'],
      settings: { lightRagApiKey: 'key-a' },
    })
    docIndex.getRecord.mockImplementation(
      (path, backendId = 'backend-a') => buckets[backendId]?.[path],
    )
    docIndex.getRecords.mockImplementation(
      (backendId = 'backend-a') => buckets[backendId] ?? {},
    )
    docIndex.saveRecord.mockImplementation(
      async (path, record, backendId = 'backend-a') => {
        const bucket = (buckets[backendId] ??= {})
        bucket[path] = record
      },
    )
    requestUrlMock.mockImplementation(async (input) => {
      if (typeof input === 'string') throw new Error('request options expected')
      if (
        input.url === 'http://localhost:9621/documents/track_status/first-track'
      ) {
        trackingStarted.resolve()
        return trackingResponse.promise
      }
      throw new Error(`unexpected request ${input.method} ${input.url}`)
    })

    const recovery = engine.recoverPendingOperations()
    await trackingStarted.promise
    settings.lightRagBackendIdentity = 'backend-b'
    settings.lightRagVaultNamespace = 'vault-b'
    settings.lightRagServerUrl = 'http://localhost:9639'
    settings.lightRagApiKey = 'key-b'
    trackingResponse.resolve(response(200, { documents: [] }))
    await recovery

    expect(buckets).toEqual({
      'backend-a': {
        [firstPath]: firstRecord,
        [removalPath]: removalRecord,
      },
      'backend-b': {},
    })
    expect(docIndex.listDocuments).not.toHaveBeenCalled()
    expect(
      docIndex.saveRecord.mock.calls.some(
        ([, , backendId]) => backendId === 'backend-b',
      ),
    ).toBe(false)
    expect(
      requestUrlMock.mock.calls.map(([input]) => {
        if (typeof input === 'string') return input
        return input.url
      }),
    ).toEqual(['http://localhost:9621/documents/track_status/first-track'])
  })

  it('recovers a busy removal after tracking completion cleared its pending journal', async () => {
    const note = file('Folder/Pending.md')
    const source = `nc-${'3'.repeat(64)}.md`
    const trackingStarted = deferred<void>()
    const trackingResponse = deferred<RequestUrlResponse>()
    const records: Record<string, TestRecord> = {
      [note.path]: {
        status: 'processing',
        source,
        policy: paragraphPolicy,
        pending: {
          backendId: 'backend-a',
          kind: 'ingest',
          stage: 'tracking',
          trackId: 'pending-track',
          policy: paragraphPolicy,
          mtime: 100,
          source,
        },
      },
    }
    let deletionAllowed = false
    let deletionStarted = false
    const listedDocument = {
      id: 'pending-doc',
      file_path: source,
      status: 'PROCESSED',
    }
    const first = makeEngine({ records })
    first.docIndex.listDocuments.mockImplementation(async () =>
      deletionStarted ? [] : [listedDocument],
    )
    requestUrlMock.mockImplementation(async (input) => {
      if (typeof input === 'string') throw new Error('request options expected')
      if (input.url.endsWith('/documents/track_status/pending-track')) {
        trackingStarted.resolve()
        return trackingResponse.promise
      }
      if (input.url.endsWith('/documents/delete_document')) {
        if (!deletionAllowed) {
          return response(200, { status: 'busy', message: 'pipeline busy' })
        }
        deletionStarted = true
        return response(200, {
          status: 'deletion_started',
          message: 'started',
        })
      }
      throw new Error(`unexpected request ${input.method} ${input.url}`)
    })

    const firstRecovery = first.engine.recoverPendingOperations()
    await trackingStarted.promise
    await expect(
      first.engine.deleteDocumentsByPaths([note.path]),
    ).resolves.toBe(false)
    trackingResponse.resolve(
      response(200, {
        documents: [
          {
            ...listedDocument,
            metadata: {
              parse_engine: 'native',
              process_options: 'P',
              parse_format: 'lightrag',
              chunk_method: 'paragraph_semantic',
              chunk_opts: 'size=1200, overlap=100, drop_rf=False',
            },
          },
        ],
      }),
    )
    await firstRecovery
    expect(records[note.path]).toMatchObject({
      status: 'processed',
      docId: 'pending-doc',
      removeRequested: true,
    })
    expect(records[note.path].pending).toBeUndefined()

    deletionAllowed = true
    const reloaded = makeEngine({ records })
    reloaded.docIndex.listDocuments.mockImplementation(async () =>
      deletionStarted ? [] : [listedDocument],
    )
    await reloaded.engine.recoverPendingOperations()

    expect(records[note.path]).toMatchObject({
      status: 'removed',
      source,
      policy: paragraphPolicy,
    })
    expect(records[note.path].docId).toBeUndefined()
    expect(records[note.path].pending).toBeUndefined()
    expect(records[note.path].removeRequested).toBeUndefined()
    expect(
      requestUrlMock.mock.calls.some(
        ([input]) =>
          typeof input !== 'string' &&
          (input.url.endsWith('/documents/upload') ||
            input.url.endsWith('/documents/texts')),
      ),
    ).toBe(false)
  })

  it('deletes only the exact bound document when a bare source is shared', async () => {
    const path = 'Folder/Note.md'
    const { engine, app, docIndex, records } = makeEngine({
      records: {
        [path]: {
          status: 'processed',
          docId: 'bound-doc',
          source: 'Note.md',
          policy: legacyPolicy,
        },
      },
    })
    let documents = [
      { id: 'bound-doc', file_path: 'Note.md', status: 'PROCESSED' },
      { id: 'other-doc', file_path: 'Note.md', status: 'PROCESSED' },
    ]
    Object.assign(app.vault, {
      getFiles: jest.fn(() => [file(path)]),
    })
    const submittedIds: string[][] = []
    docIndex.listDocuments.mockImplementation(async () => documents)
    requestUrlMock.mockImplementation(async (input) => {
      if (typeof input === 'string') throw new Error('request options expected')
      if (!input.url.endsWith('/documents/delete_document')) {
        throw new Error(`unexpected request ${input.method} ${input.url}`)
      }
      if (typeof input.body !== 'string') throw new Error('JSON body expected')
      const body = JSON.parse(input.body) as { doc_ids: string[] }
      submittedIds.push(body.doc_ids)
      const removed = new Set(body.doc_ids)
      documents = documents.filter((document) => !removed.has(document.id))
      return response(200, {
        status: 'deletion_started',
        message: 'started',
      })
    })

    await expect(engine.deleteDocumentsByPaths([path])).resolves.toBe(true)

    expect(submittedIds).toEqual([['bound-doc']])
    expect(documents.map((document) => document.id)).toEqual(['other-doc'])
    expect(records[path]).toMatchObject({
      status: 'removed',
      source: 'Note.md',
      policy: legacyPolicy,
    })
  })

  it('fails closed when an unbound bare source is ambiguous', async () => {
    const path = 'Folder/Note.md'
    const { engine, docIndex, records } = makeEngine({
      records: {
        [path]: {
          status: 'processed',
          source: 'Note.md',
          policy: legacyPolicy,
        },
      },
    })
    docIndex.listDocuments.mockResolvedValue([
      { id: 'legacy-a', file_path: 'Note.md', status: 'PROCESSED' },
      { id: 'legacy-b', file_path: 'Note.md', status: 'PROCESSED' },
    ])
    requestUrlMock.mockResolvedValue(
      response(200, { status: 'busy', message: 'pipeline busy' }),
    )

    await expect(engine.deleteDocumentsByPaths([path])).resolves.toBe(false)

    expect(requestUrlMock).not.toHaveBeenCalled()
    expect(records[path]).toMatchObject({
      status: 'processed',
      source: 'Note.md',
      removeRequested: true,
    })
  })

  it('honors removal renewed after explicit reprocess preparation', async () => {
    const note = file('Folder/Readd.md')
    const source = `nc-${'4'.repeat(64)}.md`
    const { engine, docIndex, records } = makeEngine({
      records: {
        [note.path]: {
          status: 'removed',
          source,
          policy: legacyPolicy,
        },
      },
      settings: { lightRagChunkingStrategy: 'legacy' },
    })
    let renewalInjected = false
    docIndex.saveRecord.mockImplementation(
      async (path, next, _backendId, saveOptions) => {
        const current = records[path]
        if (current?.status === 'removed' && !saveOptions?.clearRemovalIntent) {
          return
        }
        records[path] =
          current?.removeRequested && !saveOptions?.clearRemovalIntent
            ? { ...next, removeRequested: true }
            : next
        if (!renewalInjected && next.pending?.stage === 'upload_requested') {
          renewalInjected = true
          records[path] = { ...records[path], removeRequested: true }
        }
      },
    )

    await expect(
      engine.ingestFile(note, {
        intent: 'reprocess',
        policy: legacyPolicy,
      }),
    ).resolves.toMatchObject({
      status: 'paused',
      path: note.path,
    })

    expect(renewalInjected).toBe(true)
    expect(records[note.path]).toMatchObject({
      status: 'processing',
      removeRequested: true,
      pending: {
        stage: 'prepared',
        paused: true,
      },
    })
    expect(requestUrlMock).not.toHaveBeenCalled()
  })
  it('keeps accepted tracking on its original path when Obsidian mutates the same TFile during rename', async () => {
    const oldPath = 'Projects/accepted-original.md'
    const newPath = 'Projects/accepted-renamed.md'
    const note = file(oldPath)
    const trackingStarted = deferred<void>()
    const trackingResponse = deferred<RequestUrlResponse>()
    let source = ''
    const { engine, docIndex, records } = makeEngine({
      settings: { lightRagChunkingStrategy: 'legacy' },
    })
    docIndex.listDocuments.mockImplementation(async () =>
      source
        ? [{ id: 'accepted-doc', file_path: source, status: 'PROCESSING' }]
        : [],
    )
    requestUrlMock.mockImplementation(async (input) => {
      if (typeof input === 'string') throw new Error('request options expected')
      if (input.url.endsWith('/documents/texts')) {
        if (typeof input.body !== 'string') {
          throw new Error('JSON body expected')
        }
        const body = JSON.parse(input.body) as { file_sources?: unknown }
        if (
          !Array.isArray(body.file_sources) ||
          typeof body.file_sources[0] !== 'string'
        ) {
          throw new Error('captured source expected')
        }
        source = body.file_sources[0]
        return response(200, {
          status: 'success',
          track_id: 'accepted-track',
          message: 'accepted',
        })
      }
      if (input.url.endsWith('/documents/track_status/accepted-track')) {
        trackingStarted.resolve()
        return trackingResponse.promise
      }
      if (input.url.endsWith('/documents/delete_document')) {
        return response(200, { status: 'busy', message: 'pipeline busy' })
      }
      throw new Error(`unexpected request ${input.method} ${input.url}`)
    })

    const ingestion = engine.ingestFile(note, {
      intent: 'new',
      policy: legacyPolicy,
    })
    await trackingStarted.promise
    expect(records[oldPath].pending).toMatchObject({
      stage: 'tracking',
      trackId: 'accepted-track',
      mtime: 100,
      source,
    })
    await expect(engine.deleteDocumentsByPaths([oldPath])).resolves.toBe(false)

    Object.assign(note, {
      path: newPath,
      name: 'accepted-renamed.md',
      basename: 'accepted-renamed',
    })
    Object.assign(note.stat, { mtime: 200 })
    trackingResponse.resolve(
      response(200, {
        documents: [
          {
            id: 'accepted-doc',
            file_path: source,
            status: 'PROCESSED',
            metadata: {
              process_options: 'F',
              chunk_method: 'fixed_token',
              chunk_opts: 'size=900, overlap=90',
            },
          },
        ],
      }),
    )

    await expect(ingestion).resolves.toMatchObject({
      status: 'paused',
      path: oldPath,
    })
    expect(records[oldPath]).toMatchObject({
      status: 'processed',
      docId: 'accepted-doc',
      mtime: 100,
      source,
      removeRequested: true,
    })
    expect(records[oldPath].pending).toBeUndefined()
    expect(records[newPath]).toBeUndefined()
    expect(Object.keys(records)).toEqual([oldPath])
    expect(
      requestUrlMock.mock.calls.filter(
        ([input]) =>
          typeof input !== 'string' && input.url.endsWith('/documents/texts'),
      ),
    ).toHaveLength(1)
  })
})
