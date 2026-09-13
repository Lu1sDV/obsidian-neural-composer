import { migrateFrom14To15 } from './14_to_15'

const zaiPreset = {
  id: 'zai',
  type: 'openai-compatible',
  baseUrl: 'https://api.z.ai/api/paas/v4',
}

describe('Migration from v14 to v15', () => {
  it('adds Z.ai without changing configured providers, credentials or models', () => {
    const providers = [
      { id: 'openai', type: 'openai', apiKey: 'saved-key' },
      {
        id: 'custom',
        type: 'openai-compatible',
        baseUrl: 'https://custom.example/v1',
        apiKey: 'custom-key',
        additionalSettings: { noStainless: true },
      },
    ]
    const data = {
      version: 14,
      providers,
      chatModels: [{ id: 'chosen', providerId: 'custom', model: 'my-model' }],
      embeddingModels: [{ id: 'embedding', providerId: 'openai' }],
      chatModelId: 'chosen',
      applyModelId: 'chosen',
      embeddingModelId: 'embedding',
      systemPrompt: 'Keep this prompt',
    }

    expect(migrateFrom14To15(data)).toEqual({
      ...data,
      version: 15,
      providers: [...providers, zaiPreset],
    })
    expect(data.version).toBe(14)
    expect(data.providers).toEqual(providers)
    expect(providers.some((provider) => provider.id === 'zai')).toBe(false)
  })

  it('preserves every colliding zai entry instead of overwriting or deduplicating', () => {
    const data = {
      version: 14,
      providers: [
        {
          id: 'zai',
          type: 'openai-compatible',
          baseUrl: 'https://custom.example/v1',
          apiKey: 'existing-key',
        },
        { id: 'zai', type: 'anthropic', apiKey: 'other-key' },
      ],
      chatModelId: 'my-zai-model',
    }

    expect(migrateFrom14To15(data)).toEqual({ ...data, version: 15 })
  })

  it('leaves missing provider data for the settings defaults and is idempotent', () => {
    expect(migrateFrom14To15({ version: 14 })).toEqual({ version: 15 })
    const once = migrateFrom14To15({ version: 14, providers: [] })
    expect(once).toEqual({ version: 15, providers: [zaiPreset] })
    expect(migrateFrom14To15(once)).toEqual(once)
  })
})
