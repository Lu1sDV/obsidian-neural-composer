import { getProviderInfo } from '../../constants'

import { DEFAULT_SETTINGS } from './setting.types'
import { parseNeuralComposerSettings } from './settings'

describe('parseNeuralComposerSettings', () => {
  it('offers the Z.ai preset for fresh installs and migrated settings', () => {
    const preset = {
      id: 'zai',
      type: 'openai-compatible' as const,
      baseUrl: 'https://api.z.ai/api/paas/v4',
    }

    expect(DEFAULT_SETTINGS.providers).toContainEqual(preset)
    expect(parseNeuralComposerSettings({}).providers).toContainEqual(preset)
    expect(
      parseNeuralComposerSettings({ version: 14, providers: [] }).providers,
    ).toEqual([preset])
    expect(getProviderInfo(preset)).toMatchObject({
      requireApiKey: true,
      supportEmbedding: false,
    })
  })

  it('loads existing providers without discovery metadata or preset requirements', () => {
    const provider = {
      id: 'custom',
      type: 'openai-compatible' as const,
      baseUrl: 'http://localhost:8080/v1',
      apiKey: 'saved-key',
    }
    const settings = parseNeuralComposerSettings({
      version: 15,
      providers: [provider],
    })

    expect(settings.providers).toEqual([provider])
    expect(getProviderInfo(settings.providers[0])).toMatchObject({
      requireApiKey: false,
      supportEmbedding: true,
    })
  })

  it('preserves a customized zai provider, model selection and cache through migration and reload', () => {
    const provider = {
      id: 'zai',
      type: 'openai-compatible',
      baseUrl: 'https://custom.example/v1',
      apiKey: 'existing-key',
      modelDiscovery: {
        version: 1,
        endpoint: 'https://custom.example/v1',
        protocol: 'openai',
        credentialHash: 'a'.repeat(64),
        models: [{ id: 'custom-model', name: 'Custom model' }],
        status: 'unsupported',
        updatedAt: 100,
      },
    }
    const model = {
      id: 'my-model',
      providerType: 'openai-compatible',
      providerId: 'zai',
      model: 'custom-model',
    }
    const migrated = parseNeuralComposerSettings({
      version: 14,
      providers: [provider],
      chatModels: [model],
      chatModelId: model.id,
      applyModelId: model.id,
    })
    const reloaded = parseNeuralComposerSettings(
      JSON.parse(JSON.stringify(migrated)),
    )

    expect(reloaded.providers).toEqual([provider])
    expect(reloaded.chatModels).toEqual([model])
    expect(reloaded.chatModelId).toBe(model.id)
    expect(reloaded.applyModelId).toBe(model.id)
  })

  it('does not discard credentials when optional discovery metadata is invalid', () => {
    const provider = { id: 'custom', type: 'openai', apiKey: 'saved-key' }
    const settings = parseNeuralComposerSettings({
      version: 15,
      providers: [{ ...provider, modelDiscovery: { invalid: true } }],
    })

    expect(settings.providers).toEqual([provider])
  })

  it('defaults migrated installs to legacy processing with unassigned identities', () => {
    const settings = parseNeuralComposerSettings({
      version: 15,
      lightRagChunkSize: 1600,
      lightRagChunkOverlap: 80,
    })
    expect(DEFAULT_SETTINGS).toMatchObject({
      version: 17,
      lightRagChunkingStrategy: 'legacy',
      lightRagChunkSize: 1200,
      lightRagChunkOverlap: 100,
      lightRagVaultNamespace: '',
      lightRagBackendIdentity: '',
      lightRagImageDownloadsDisabledFor: '',
    })
    expect(DEFAULT_SETTINGS.lightRagEntityTypeGuidance).toContain(
      'Person: Human individuals, real or fictional',
    )

    expect(settings).toMatchObject({
      version: 17,
      lightRagChunkingStrategy: 'legacy',
      lightRagChunkSize: 1600,
      lightRagChunkOverlap: 80,
      lightRagVaultNamespace: '',
      lightRagBackendIdentity: '',
      lightRagImageDownloadsDisabledFor: '',
    })
    expect(settings.lightRagEntityTypeGuidance).toContain(
      'Person: Human individuals, real or fictional',
    )
  })

  it('retains numeric values that need explicit correction instead of replacing them', () => {
    const settings = parseNeuralComposerSettings({
      version: 15,
      lightRagChunkSize: 0.5,
      lightRagChunkOverlap: 1,
    })

    expect(settings.lightRagChunkSize).toBe(0.5)
    expect(settings.lightRagChunkOverlap).toBe(1)
  })

  it('migrates legacy custom entity names into editable descriptions', () => {
    const settings = parseNeuralComposerSettings({
      version: 16,
      lightRagEntityTypes: 'Person, Vulnerability',
      useCustomEntityTypes: true,
    })

    expect(settings).not.toHaveProperty('lightRagEntityTypes')
    expect(settings.lightRagEntityTypeGuidance).toBe(
      [
        'Person: Human individuals, real or fictional',
        'Vulnerability: A weakness, exposure, defect, or condition that can cause harm or be exploited',
      ].join('\n'),
    )
  })
})
