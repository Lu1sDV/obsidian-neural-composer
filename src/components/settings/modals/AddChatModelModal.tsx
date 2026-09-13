import { App, Notice } from 'obsidian'
import { useState } from 'react'

import { DEFAULT_PROVIDERS } from '../../../constants'
import NeuralComposerPlugin from '../../../main'
import { ChatModel, chatModelSchema } from '../../../types/chat-model.types'
import { PromptLevel } from '../../../types/prompt-level.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ReactModal } from '../../common/ReactModal'
import { ModelDiscovery } from '../ModelDiscovery'

type AddChatModelModalComponentProps = {
  plugin: NeuralComposerPlugin
  onClose: () => void
}

export class AddChatModelModal extends ReactModal<AddChatModelModalComponentProps> {
  constructor(app: App, plugin: NeuralComposerPlugin) {
    super({
      app: app,
      Component: AddChatModelModalComponent,
      props: { plugin },
      options: {
        title: 'Add custom chat model', // Sentence case
      },
    })
  }
}

function AddChatModelModalComponent({
  plugin,
  onClose,
}: AddChatModelModalComponentProps) {
  const [formData, setFormData] = useState<ChatModel>({
    providerId: DEFAULT_PROVIDERS[0].id,
    providerType: DEFAULT_PROVIDERS[0].type,
    id: '',
    model: '',
    promptLevel: PromptLevel.Default,
  })

  const handleSubmit = async () => {
    if (plugin.settings.chatModels.some((p) => p.id === formData.id)) {
      new Notice('Model with this ID already exists. Try a different ID.')
      return
    }

    if (
      !plugin.settings.providers.some(
        (provider) => provider.id === formData.providerId,
      )
    ) {
      new Notice('Provider with this ID does not exist')
      return
    }

    const validationResult = chatModelSchema.safeParse(formData)
    if (!validationResult.success) {
      new Notice(validationResult.error.issues.map((v) => v.message).join('\n'))
      return
    }

    await plugin.setSettings({
      ...plugin.settings,
      chatModels: [...plugin.settings.chatModels, formData],
    })

    onClose()
  }

  return (
    <>
      <ObsidianSetting
        name="ID"
        desc="Choose an ID to identify this model in your settings. This is just for your reference."
        required
      >
        <ObsidianTextInput
          value={formData.id}
          placeholder="my-custom-model"
          onChange={(value: string) =>
            setFormData((prev) => ({ ...prev, id: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting name="Provider ID" required>
        <ObsidianDropdown
          value={formData.providerId}
          options={Object.fromEntries(
            plugin.settings.providers.map((provider): [string, string] => [
              provider.id,
              provider.id,
            ]),
          )}
          onChange={(value: string) => {
            const provider = plugin.settings.providers.find(
              (p) => p.id === value,
            )
            if (!provider) {
              new Notice(`Provider with ID ${value} not found`)
              return
            }
            setFormData((prev) => ({
              ...prev,
              providerId: value,
              providerType: provider.type,
            }))
          }}
        />
      </ObsidianSetting>

      {formData.providerType === 'codex-cli' && (
        <ObsidianSetting
          name="Text-only Codex model"
          desc="Enter a model available to your Codex login. Supports desktop chat and apply only; images, MCP tools, embeddings, and LightRAG are unavailable."
        />
      )}

      <ModelDiscovery
        plugin={plugin}
        providerId={formData.providerId}
        model={formData.model}
        onModelChange={(model) => setFormData((prev) => ({ ...prev, model }))}
      />

      <ObsidianSetting
        name="Prompt level" // Sentence case
        desc={`Choose how complex the system prompt should be. Select "simple" for small models that ignore user questions and just repeat back instructions.`}
        required
      >
        <ObsidianDropdown
          value={(formData.promptLevel ?? PromptLevel.Default).toString()}
          options={{
            [PromptLevel.Default]: 'default',
            [PromptLevel.Simple]: 'simple',
          }}
          onChange={(value: string) =>
            setFormData((prev) => ({
              ...prev,
              promptLevel: Number(value),
            }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting>
        {/* Fix: Wrapped async handler to satisfy linter */}
        <ObsidianButton text="Add" onClick={() => void handleSubmit()} cta />
        <ObsidianButton text="Cancel" onClick={onClose} />
      </ObsidianSetting>
    </>
  )
}
