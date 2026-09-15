import { migrateFrom15To16 } from './15_to_16'

describe('Migration from v15 to v16', () => {
  it('adds the legacy processing contract without manufacturing identities', () => {
    const data = {
      version: 15,
      providers: [{ id: 'custom', type: 'openai', apiKey: 'saved-key' }],
      lightRagExcludePatterns: ['Archive/**'],
    }

    expect(migrateFrom15To16(data)).toEqual({
      ...data,
      version: 16,
      lightRagChunkingStrategy: 'legacy',
      lightRagVaultNamespace: '',
      lightRagBackendIdentity: '',
      lightRagImageDownloadsDisabledFor: '',
    })
    expect(data.version).toBe(15)
  })

  it('preserves customized values, including values requiring UI correction', () => {
    const data = {
      version: 15,
      providers: [{ id: 'custom', type: 'openai', apiKey: 'saved-key' }],
      chatModelId: 'chosen-model',
      lightRagChunkSize: 1200.5,
      lightRagChunkOverlap: 1200.5,
      lightRagExcludePatterns: ['Private/**'],
      lightRagExcludeHiddenFiles: false,
      lightRagChunkingStrategy: 'paragraph',
      lightRagVaultNamespace: 'shared-vault-id',
      lightRagBackendIdentity: 'backend-id',
      lightRagImageDownloadsDisabledFor: 'backend-id',
    }

    expect(migrateFrom15To16(data)).toEqual({ ...data, version: 16 })
  })
})
