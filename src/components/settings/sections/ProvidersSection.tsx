import { Settings, Trash2 } from 'lucide-react'
import { App, Notice, Platform } from 'obsidian'
import React, { useEffect, useRef, useState } from 'react'

import { DEFAULT_PROVIDERS, PROVIDER_TYPES_INFO } from '../../../constants'
import { useSettings } from '../../../contexts/settings-context'
import { CodexCliProvider } from '../../../core/llm/codexCliProvider'
import { getEmbeddingModelClient } from '../../../core/rag/embedding'
import NeuralComposerPlugin from '../../../main'
import { LLMProvider } from '../../../types/provider.types'
import { ConfirmModal } from '../../modals/ConfirmModal'
import {
  AddProviderModal,
  EditProviderModal,
} from '../modals/ProviderFormModal'

import { mergeCodexModels } from './codex-models'

type ProvidersSectionProps = {
  app: App
  plugin: NeuralComposerPlugin
}

function CodexConnection({
  provider,
  plugin,
}: {
  provider: Extract<LLMProvider, { type: 'codex-cli' }>
  plugin: NeuralComposerPlugin
}) {
  const { setSettings } = useSettings()
  const [status, setStatus] = useState({
    kind: 'untested',
    message: 'Not tested. Install Codex CLI and run codex login first.',
  })
  const activeRequest = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const providerKey = JSON.stringify(provider)

  useEffect(() => {
    mounted.current = true
    const removeListener = plugin.addSettingsChangeListener((latest) => {
      const current = latest.providers.find((entry) => entry.id === provider.id)
      if (JSON.stringify(current) !== providerKey) {
        activeRequest.current?.abort()
        activeRequest.current = null
        if (mounted.current) {
          setStatus({
            kind: 'untested',
            message: 'Provider changed. Test the connection again.',
          })
        }
      }
    })
    return () => {
      mounted.current = false
      removeListener()
      activeRequest.current?.abort()
      activeRequest.current = null
    }
  }, [plugin, provider.id, providerKey])

  const testConnection = async () => {
    if (!Platform.isDesktop || activeRequest.current) return
    const controller = new AbortController()
    activeRequest.current = controller
    const isCurrent = () =>
      mounted.current &&
      activeRequest.current === controller &&
      !controller.signal.aborted &&
      JSON.stringify(
        plugin.settings.providers.find((entry) => entry.id === provider.id),
      ) === providerKey

    setStatus({
      kind: 'testing',
      message: 'Testing login, models, and a short response…',
    })
    try {
      const discovered = await new CodexCliProvider(provider).testConnection({
        signal: controller.signal,
      })
      if (!isCurrent()) return
      const latest = plugin.settings
      await setSettings({
        ...latest,
        chatModels: mergeCodexModels(
          latest.chatModels,
          provider.id,
          discovered,
        ),
      })
      if (!isCurrent()) return
      setStatus({
        kind: 'success',
        message: `Connected. ${discovered.length} model(s) available. Select a model in Models or Chat settings; existing selections and disabled models are unchanged.`,
      })
    } catch (error) {
      if (!isCurrent()) return
      setStatus({
        kind: 'error',
        message:
          error instanceof Error ? error.message : 'Connection test failed.',
      })
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null
    }
  }

  if (!Platform.isDesktop) {
    return (
      <span className="setting-item-description">
        Codex CLI requires Obsidian desktop. Test and use this provider there.
      </span>
    )
  }

  return (
    <div className="nrlcmp-codex-connection">
      <div className="setting-item-description">
        Uses your local Codex login. Testing sends a short request. Use the gear
        to set the executable path.
      </div>
      <button
        disabled={status.kind === 'testing'}
        onClick={() => void testConnection()}
      >
        {status.kind === 'testing' ? 'Testing…' : 'Test connection'}
      </button>
      {status.kind === 'testing' && (
        <button
          onClick={() => {
            activeRequest.current?.abort()
            activeRequest.current = null
            setStatus({ kind: 'untested', message: 'Test cancelled.' })
          }}
        >
          Cancel
        </button>
      )}
      <div
        className="setting-item-description"
        role="status"
        aria-live="polite"
        data-connection-status={status.kind}
      >
        {status.message}
      </div>
    </div>
  )
}

export function ProvidersSection({ app, plugin }: ProvidersSectionProps) {
  const { settings, setSettings } = useSettings()

  const enableCodex = async () => {
    if (!Platform.isDesktop) return
    const latest = plugin.settings
    if (latest.providers.some((provider) => provider.type === 'codex-cli'))
      return
    const ids = new Set(latest.providers.map((provider) => provider.id))
    let id = 'codex-cli'
    for (let suffix = 2; ids.has(id); suffix++) id = `codex-cli-${suffix}`
    try {
      await setSettings({
        ...latest,
        providers: [...latest.providers, { id, type: 'codex-cli' }],
      })
    } catch (error) {
      new Notice(
        error instanceof Error ? error.message : 'Could not enable Codex.',
      )
    }
  }

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

            const latest = plugin.settings
            await setSettings({
              ...latest,
              providers: latest.providers.filter((v) => v.id !== provider.id),
              chatModels: latest.chatModels.filter(
                (v) => v.providerId !== provider.id,
              ),
              embeddingModels: latest.embeddingModels.filter(
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
        <span>
          Configure API providers or enable Codex CLI with your local Codex
          login.
        </span>
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
            <col className="nrlcmp-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>ID</th>
              <th>Type</th>
              <th>API key / connection</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {settings.providers.map((provider) => (
              <tr key={provider.id} data-provider-id={provider.id}>
                <td>{provider.id}</td>
                <td>{PROVIDER_TYPES_INFO[provider.type].label}</td>
                {provider.type === 'codex-cli' ? (
                  <td>
                    <CodexConnection
                      key={JSON.stringify(provider)}
                      provider={provider}
                      plugin={plugin}
                    />
                  </td>
                ) : (
                  <td
                    className="nrlcmp-settings-table-api-key"
                    onClick={() => {
                      new EditProviderModal(app, plugin, provider).open()
                    }}
                  >
                    {provider.apiKey ? '••••••••' : 'Set API key'}
                  </td>
                )}
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
            {!settings.providers.some(
              (provider) => provider.type === 'codex-cli',
            ) && (
              <tr data-provider-type="codex-cli" data-configured="false">
                <td>Codex CLI</td>
                <td>{PROVIDER_TYPES_INFO['codex-cli'].label}</td>
                <td className="setting-item-description">
                  {Platform.isDesktop
                    ? 'Use your local Codex login, without an API key. Install Codex CLI and run codex login, then enable and test the connection.'
                    : 'Codex CLI requires Obsidian desktop. Enable and use it there.'}
                </td>
                <td>
                  <button
                    disabled={!Platform.isDesktop}
                    onClick={() => void enableCodex()}
                  >
                    Enable Codex
                  </button>
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>
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
