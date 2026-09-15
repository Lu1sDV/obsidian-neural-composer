import type { NeuralComposerSettings } from '../../settings/schema/setting.types'

import {
  documentSourceName,
  isParagraphFile,
  paragraphUploadName,
  processingPolicy,
  sameProcessingPolicy,
} from './documentProcessing'

const settings = (overrides: Record<string, unknown> = {}) =>
  ({
    lightRagChunkingStrategy: 'paragraph',
    lightRagChunkSize: 1200,
    lightRagChunkOverlap: 100,
    ...overrides,
  }) as NeuralComposerSettings

describe('document processing identity and policy', () => {
  it('uses the exact namespace and vault path as deterministic SHA-256 identity inputs', async () => {
    await expect(documentSourceName('vault-a', 'Folder/Note.MD')).resolves.toBe(
      'nc-15d38151ec6635539899bf9568488e4d2c4abd66fa9eec630e5cd2199f568d0e.md',
    )
    await expect(documentSourceName('vault-a', 'folder/Note.MD')).resolves.toBe(
      'nc-42d01f931b477a82fec2fe3308374324a3cbd988e2d14cd71096e505ffac67ad.md',
    )
    await expect(documentSourceName('vault-a', 'Café/筆記.md')).resolves.toBe(
      'nc-d5cd76ad8e4b6dac15a0f6784e25f62cfa9a382181f0e30fea8e43e37965556e.md',
    )
  })

  it('keeps transport names bounded and never exposes raw path or parser-like filename text', async () => {
    const source = await documentSourceName(
      'shared-vault',
      'Private/Quarterly [native-P(chunk_ts=1)].' + 'x'.repeat(200),
    )

    expect(source).toMatch(/^nc-[0-9a-f]{64}\.bin$/)
    expect(source.length).toBeLessThan(80)
    expect(source).not.toContain('Private')
    expect(source).not.toContain('native')
  })

  it('generates only validated native parser hints for Markdown and DOCX', () => {
    const hash = 'a'.repeat(64)
    const policy = {
      mode: 'paragraph' as const,
      chunkSize: 1200,
      chunkOverlap: 100,
    }

    expect(paragraphUploadName(`nc-${hash}.md`, policy)).toBe(
      `nc-${hash}.[native-P(chunk_ts=1200,chunk_ol=100,drop_rf=false)].md`,
    )
    expect(paragraphUploadName(`nc-${hash}.docx`, policy)).toBe(
      `nc-${hash}.[native(smart_heading=false)-P(chunk_ts=1200,chunk_ol=100,drop_rf=false)].docx`,
    )
    expect(() => paragraphUploadName('Secret/Note.md', policy)).toThrow()
    expect(() =>
      paragraphUploadName(`nc-${hash}.[native-P].md`, policy),
    ).toThrow()
    expect(() => paragraphUploadName(`nc-${hash}.pdf`, policy)).toThrow()
  })

  it('rejects invalid inherited settings instead of silently replacing them', () => {
    expect(processingPolicy(settings())).toEqual({
      mode: 'paragraph',
      chunkSize: 1200,
      chunkOverlap: 100,
    })
    expect(() =>
      processingPolicy(settings({ lightRagChunkSize: Number.NaN })),
    ).toThrow('Maximum chunk tokens')
    expect(() =>
      processingPolicy(settings({ lightRagChunkSize: 10.5 })),
    ).toThrow('Maximum chunk tokens')
    expect(() =>
      processingPolicy(settings({ lightRagChunkOverlap: -1 })),
    ).toThrow('Overlap tokens')
    expect(() =>
      processingPolicy(
        settings({ lightRagChunkSize: 100, lightRagChunkOverlap: 100 }),
      ),
    ).toThrow('Overlap tokens')
  })

  it('compares every pinned policy field and limits paragraph processing to native-capable files', () => {
    const policy = {
      mode: 'paragraph' as const,
      chunkSize: 1200,
      chunkOverlap: 100,
    }

    expect(sameProcessingPolicy(policy, { ...policy })).toBe(true)
    expect(sameProcessingPolicy(policy, { ...policy, chunkOverlap: 99 })).toBe(
      false,
    )
    expect(isParagraphFile('md')).toBe(true)
    expect(isParagraphFile('.DOCX')).toBe(true)
    expect(isParagraphFile('pdf')).toBe(false)
  })
})
