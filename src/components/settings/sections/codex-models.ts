import type { CodexDiscoveredModel } from '../../../core/llm/codexCliProvider'
import type { ChatModel } from '../../../types/chat-model.types'

export function mergeCodexModels(
  existing: ChatModel[],
  providerId: string,
  discovered: CodexDiscoveredModel[],
): ChatModel[] {
  const knownModels = new Set(
    existing
      .filter((model) => model.providerId === providerId)
      .map((model) => model.model),
  )
  const usedIds = new Set(existing.map((model) => model.id))
  const added: ChatModel[] = []
  for (const { model } of discovered) {
    if (knownModels.has(model)) continue
    const baseId = `${providerId}/${model}`
    let id = baseId
    for (let suffix = 2; usedIds.has(id); suffix++) {
      id = `${baseId}-${suffix}`
    }
    added.push({
      id,
      providerId,
      providerType: 'codex-cli',
      model,
      enable: true,
    })
    knownModels.add(model)
    usedIds.add(id)
  }
  return added.length ? [...existing, ...added] : existing
}
