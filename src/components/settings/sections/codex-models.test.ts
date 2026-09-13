import type { ChatModel } from '../../../types/chat-model.types'
import { PromptLevel } from '../../../types/prompt-level.types'

import { mergeCodexModels } from './codex-models'

describe('mergeCodexModels', () => {
  it('preserves customized models and unrelated providers across duplicate discoveries and retests', () => {
    const customized: ChatModel = {
      id: 'my-alias',
      providerId: 'codex-cli',
      providerType: 'codex-cli',
      model: 'existing-model',
      enable: false,
      promptLevel: PromptLevel.Simple,
    }
    const other: ChatModel = {
      id: 'codex-cli/new-model',
      providerId: 'other',
      providerType: 'openai',
      model: 'new-model',
      enable: true,
    }
    const collision: ChatModel = { ...other, id: 'codex-cli/new-model-2' }
    const existing = [customized, other, collision]
    const before = existing.map((model) => ({ ...model }))
    const discovered = [
      { model: 'existing-model', displayName: 'Existing', isDefault: true },
      { model: 'new-model', displayName: 'New', isDefault: false },
      { model: 'new-model', displayName: 'New duplicate', isDefault: false },
    ]

    const merged = mergeCodexModels(existing, 'codex-cli', discovered)

    expect(merged).toEqual([
      ...before,
      {
        id: 'codex-cli/new-model-3',
        providerId: 'codex-cli',
        providerType: 'codex-cli',
        model: 'new-model',
        enable: true,
      },
    ])
    expect(mergeCodexModels(merged, 'codex-cli', discovered)).toEqual(merged)
    expect(existing).toEqual(before)
  })
})
