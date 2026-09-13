import { App, Notice } from 'obsidian'
import { useState } from 'react'

import { DEFAULT_EMBEDDING_MODELS, getProviderInfo } from '../../../constants'
import { getProviderClient } from '../../../core/llm/manager'
import { supportedDimensionsForIndex } from '../../../database/schema'
import NeuralComposerPlugin from '../../../main'
import {
  EmbeddingModel,
  embeddingModelSchema,
} from '../../../types/embedding-model.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ReactModal } from '../../common/ReactModal'
import { ConfirmModal } from '../../modals/ConfirmModal'
import { ModelDiscovery } from '../ModelDiscovery'

type AddEmbeddingModelModalComponentProps = {
  plugin: NeuralComposerPlugin
  onClose: () => void
}

export class AddEmbeddingModelModal extends ReactModal<AddEmbeddingModelModalComponentProps> {
  constructor(app: App, plugin: NeuralComposerPlugin) {
    super({
      app: app,
      Component: AddEmbeddingModelModalComponent,
      props: { plugin },
      options: {
        title: 'Add custom embedding model', // Sentence case
      },
    })
  }
}

function AddEmbeddingModelModalComponent({
  plugin,
  onClose,
}: AddEmbeddingModelModalComponentProps) {
  const [formData, setFormData] = useState<Omit<EmbeddingModel, 'dimension'>>({
    providerId: DEFAULT_EMBEDDING_MODELS[0].providerId,
    providerType: DEFAULT_EMBEDDING_MODELS[0].providerType,
    id: '',
    model: '',
  })

  const handleSubmit = async () => {
    try {
      if (plugin.settings.embeddingModels.some((p) => p.id === formData.id)) {
        throw new Error(
          'Model with this ID already exists. Try a different ID.',
        )
      }

      if (
        !plugin.settings.providers.some(
          (provider) => provider.id === formData.providerId,
        )
      ) {
        throw new Error('Provider with this ID does not exist')
      }

      const providerClient = getProviderClient({
        settings: plugin.settings,
        providerId: formData.providerId,
      })

      const embeddingResult = await providerClient.getEmbedding(
        formData.model,
        'test',
      )

      if (!Array.isArray(embeddingResult) || embeddingResult.length === 0) {
        throw new Error('Embedding model returned an invalid result')
      }

      const dimension = embeddingResult.length

      if (!supportedDimensionsForIndex.includes(dimension)) {
        const confirmed = await new Promise<boolean>((resolve) => {
          new ConfirmModal(plugin.app, {
            title: 'Performance warning', // Sentence case
            message: `This model outputs ${dimension} dimensions, but the optimized dimensions for database indexing are: ${supportedDimensionsForIndex.join(
              ', ',
            )}.\n\nThis may result in slower search performance.\n\nDo you want to continue anyway?`,
            onConfirm: () => resolve(true),
            onCancel: () => resolve(false),
          }).open()
        })

        if (!confirmed) {
          return
        }
      }

      const embeddingModel: EmbeddingModel = {
        ...formData,
        dimension,
      }

      const validationResult = embeddingModelSchema.safeParse(embeddingModel)

      if (!validationResult.success) {
        throw new Error(
          validationResult.error.issues.map((v) => v.message).join('\n'),
        )
      }

      await plugin.setSettings({
        ...plugin.settings,
        embeddingModels: [...plugin.settings.embeddingModels, embeddingModel],
      })

      onClose()
    } catch (error) {
      new Notice(
        error instanceof Error ? error.message : 'An unknown error occurred',
      )
    }
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
          placeholder="my-custom-embedding-model"
          onChange={(value: string) =>
            setFormData((prev) => ({ ...prev, id: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting name="Provider ID" required>
        <ObsidianDropdown
          value={formData.providerId}
          options={Object.fromEntries(
            plugin.settings.providers
              .filter((provider) => getProviderInfo(provider).supportEmbedding)
              .map((provider): [string, string] => [provider.id, provider.id]),
          )}
          onChange={(value: string) => {
            const provider = plugin.settings.providers.find(
              (p) => p.id === value,
            )
            if (!provider || provider.type === 'codex-cli') {
              new Notice('Select a provider that supports embeddings')
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

      <ModelDiscovery
        plugin={plugin}
        providerId={formData.providerId}
        model={formData.model}
        onModelChange={(model) => setFormData((prev) => ({ ...prev, model }))}
      />

      <ObsidianSetting>
        {/* Fix: Wrapped async handler to satisfy linter */}
        <ObsidianButton text="Add" onClick={() => void handleSubmit()} cta />
        <ObsidianButton text="Cancel" onClick={onClose} />
      </ObsidianSetting>
    </>
  )
}
