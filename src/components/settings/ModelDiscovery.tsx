import { Notice } from 'obsidian'
import { useEffect, useId, useRef, useState } from 'react'

import NeuralComposerPlugin from '../../main'
import { ObsidianSetting } from '../common/ObsidianSetting'
import { ObsidianTextInput } from '../common/ObsidianTextInput'

const STATUS_LABELS: Record<string, string> = {
  idle: 'Not checked yet',
  loading: 'Checking available models…',
  ready: 'Catalog up to date',
  stale: 'Showing cached models; refresh needed',
  'missing-key': 'Save an API key to discover models',
  manual: 'Model discovery is unavailable; enter a model name manually',
  unsupported:
    'This endpoint does not support model listing (404). Use manual entry or reset discovery to try again.',
  'auth-error': 'Authentication failed; save a new key or refresh to retry',
  'rate-limited': 'Rate limited; retry after the provider’s waiting period',
  error: 'Discovery failed; manual entry is still available',
}

function reportDiscoveryError(error: unknown) {
  new Notice(error instanceof Error ? error.message : 'Discovery failed')
}

type ModelDiscoveryProps = {
  plugin: NeuralComposerPlugin
  providerId: string
  model?: string
  onModelChange?: (model: string) => void
}

export function ModelDiscovery({
  plugin,
  providerId,
  model,
  onModelChange,
}: ModelDiscoveryProps) {
  const catalog = plugin.modelCatalog
  const [, rerender] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const isPicker = !!onModelChange

  useEffect(() => {
    return catalog.subscribe(() => rerender((version) => version + 1))
  }, [catalog])

  useEffect(() => {
    if (!isPicker) return
    void catalog.refresh(providerId).catch(reportDiscoveryError)
    const container = containerRef.current
    if (!container) return
    const doc = container.ownerDocument
    const resume = () => {
      if (
        doc.visibilityState === 'visible' &&
        container.getClientRects().length
      ) {
        void catalog.refresh(providerId).catch(reportDiscoveryError)
      }
    }
    doc.addEventListener('visibilitychange', resume)
    doc.defaultView?.addEventListener('focus', resume)
    return () => {
      doc.removeEventListener('visibilitychange', resume)
      doc.defaultView?.removeEventListener('focus', resume)
    }
  }, [catalog, providerId, isPicker])

  const snapshot = catalog.get(providerId)
  const busy = snapshot.status === 'loading'
  const manual = snapshot.status === 'manual'

  return (
    <div ref={containerRef}>
      {onModelChange && (
        <ObsidianSetting
          name="Model name"
          desc="Search the provider catalog or enter an exact model name manually. Listing does not guarantee chat or embedding support."
          required
        >
          <ObsidianTextInput
            value={model ?? ''}
            placeholder="Search or enter a model name"
            onChange={onModelChange}
            list={listId}
            ariaLabel="Model name"
          />
          <datalist id={listId}>
            {snapshot.models.map((entry) => (
              <option
                key={entry.id}
                value={entry.id}
                label={entry.name ?? entry.id}
              />
            ))}
          </datalist>
        </ObsidianSetting>
      )}
      <div
        className="setting-item-description"
        role="status"
        aria-live="polite"
      >
        <div>{STATUS_LABELS[snapshot.status] ?? snapshot.status}</div>
        {snapshot.updatedAt !== undefined && (
          <div>
            Last updated: {new Date(snapshot.updatedAt).toLocaleString()}
          </div>
        )}
        {snapshot.error && <div>{snapshot.error}</div>}
      </div>
      <div className="nrlcmp-settings-actions">
        <button
          type="button"
          disabled={busy || manual || snapshot.status === 'unsupported'}
          onClick={() => {
            void catalog.refresh(providerId, true).catch(reportDiscoveryError)
          }}
          aria-label={`Refresh model discovery for ${providerId}`}
        >
          Refresh
        </button>
        <button
          type="button"
          disabled={busy || manual}
          onClick={() => {
            void catalog.reset(providerId).catch(reportDiscoveryError)
          }}
          aria-label={`Reset model discovery for ${providerId}`}
        >
          Reset model discovery
        </button>
      </div>
    </div>
  )
}
