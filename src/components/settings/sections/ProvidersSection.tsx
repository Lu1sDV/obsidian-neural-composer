import { Settings, Trash2 } from 'lucide-react'
import { App } from 'obsidian'
import React from 'react'

import { DEFAULT_PROVIDERS, getProviderInfo } from '../../../constants'
import { useSettings } from '../../../contexts/settings-context'
import { getEmbeddingModelClient } from '../../../core/rag/embedding'
import NeuralComposerPlugin from '../../../main'
import { LLMProvider } from '../../../types/provider.types'
import { ConfirmModal } from '../../modals/ConfirmModal'
import {
  AddProviderModal,
  EditProviderModal,
} from '../modals/ProviderFormModal'
import { ModelDiscovery } from '../ModelDiscovery'

type ProvidersSectionProps = {
  app: App
  plugin: NeuralComposerPlugin
}

export function ProvidersSection({ app, plugin }: ProvidersSectionProps) {
  const { settings, setSettings } = useSettings()

  // Removed 'async' keyword as opening a modal is synchronous
  const handleDeleteProvider = (provider: LLMProvider) => {
    // Get associated models
    const associatedChatModels = settings.chatModels.filter(
      (m) => m.providerId === provider.id,
    )
    const associatedEmbeddingModels = settings.embeddingModels.filter(
      (m) => m.providerId === provider.id,
    )

    const message =
      `Are you sure you want to delete provider "${provider.id}"?\n\n` +
      `This will also delete:\n` +
      `- ${associatedChatModels.length} chat model(s)\n` +
      `- ${associatedEmbeddingModels.length} embedding model(s)\n\n` +
      `All embeddings generated using the associated embedding models will also be deleted.`

    new ConfirmModal(app, {
      title: 'Delete provider',
      message: message,
      ctaText: 'Delete',
      onConfirm: () => {
        // Wrap async logic to satisfy void return type of onConfirm
        void (async () => {
          try {
            const dbManager = await plugin.getDbManager()
            const vectorManager = dbManager.getVectorManager()
            const embeddingStats = await vectorManager.getEmbeddingStats()

            // Clear embeddings for each associated embedding model
            for (const embeddingModel of associatedEmbeddingModels) {
              const embeddingStat = embeddingStats.find(
                (v) => v.model === embeddingModel.id,
              )

              if (embeddingStat?.rowCount && embeddingStat.rowCount > 0) {
                // only clear when there's data
                const embeddingModelClient = getEmbeddingModelClient({
                  settings,
                  embeddingModelId: embeddingModel.id,
                })
                await vectorManager.clearAllVectors(embeddingModelClient)
              }
            }

            await setSettings({
              ...settings,
              providers: [...settings.providers].filter(
                (v) => v.id !== provider.id,
              ),
              chatModels: [...settings.chatModels].filter(
                (v) => v.providerId !== provider.id,
              ),
              embeddingModels: [...settings.embeddingModels].filter(
                (v) => v.providerId !== provider.id,
              ),
            })
          } catch (e) {
            console.error('Error deleting provider:', e)
          }
        })()
      },
    }).open()
  }

  return (
    <div className="nrlcmp-settings-section">
      <div className="nrlcmp-settings-header">Providers</div>

      <div className="nrlcmp-settings-desc">
        <span>Enter your API keys for the providers you want to use</span>
        <br />
        <a
          href="https://github.com/oscampo/obsidian-neural-composer/wiki/1.2-Initial-Setup#getting-your-api-key"
          target="_blank"
          rel="noopener noreferrer"
        >
          How to obtain API keys
        </a>
      </div>

      <div className="nrlcmp-settings-table-container">
        <table className="nrlcmp-settings-table">
          <colgroup>
            <col />
            <col />
            <col />
            <col />
            <col className="nrlcmp-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>ID</th>
              <th>Type</th>
              <th>API Key</th>
              <th>Model discovery</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {settings.providers.map((provider) => (
              <tr key={provider.id}>
                <td>{provider.id}</td>
                <td>{getProviderInfo(provider).label}</td>
                <td
                  className="nrlcmp-settings-table-api-key"
                  onClick={() => {
                    new EditProviderModal(app, plugin, provider).open()
                  }}
                >
                  {provider.apiKey ? '••••••••' : 'Set API key'}
                </td>
                <td>
                  <ModelDiscovery plugin={plugin} providerId={provider.id} />
                </td>
                <td>
                  <div className="nrlcmp-settings-actions">
                    <button
                      onClick={() => {
                        new EditProviderModal(app, plugin, provider).open()
                      }}
                      className="clickable-icon"
                      aria-label="Edit provider"
                    >
                      <Settings size={16} />
                    </button>
                    {!DEFAULT_PROVIDERS.some((v) => v.id === provider.id) && (
                      <button
                        onClick={() => handleDeleteProvider(provider)}
                        className="clickable-icon"
                        aria-label="Delete provider"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5}>
                <button
                  onClick={() => {
                    new AddProviderModal(app, plugin).open()
                  }}
                >
                  Add custom provider
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
