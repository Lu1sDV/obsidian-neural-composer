import { Notice, Setting } from 'obsidian'

import type NeuralComposerPlugin from '../../../main'

const CHUNK_SIZE_ERROR =
  'Maximum chunk tokens must be a finite positive integer.'
const CHUNK_OVERLAP_ERROR =
  'Overlap tokens must be a finite non-negative integer smaller than maximum chunk tokens.'

type DocumentProcessingValues = {
  chunkSize: number
  chunkOverlap: number
}

export function validateDocumentProcessingValues(
  chunkSizeValue: string,
  chunkOverlapValue: string,
): DocumentProcessingValues | string {
  const chunkSize = Number(chunkSizeValue)
  if (
    chunkSizeValue.trim() === '' ||
    !Number.isFinite(chunkSize) ||
    !Number.isInteger(chunkSize) ||
    chunkSize < 1
  ) {
    return CHUNK_SIZE_ERROR
  }

  const chunkOverlap = Number(chunkOverlapValue)
  if (
    chunkOverlapValue.trim() === '' ||
    !Number.isFinite(chunkOverlap) ||
    !Number.isInteger(chunkOverlap) ||
    chunkOverlap < 0 ||
    chunkOverlap >= chunkSize
  ) {
    return CHUNK_OVERLAP_ERROR
  }

  return { chunkSize, chunkOverlap }
}

type DocumentProcessingSettingsOptions = {
  isDesktop: boolean
  isRemote: boolean
}

export function renderDocumentProcessingSettings(
  container: HTMLElement,
  plugin: NeuralComposerPlugin,
  { isDesktop, isRemote }: DocumentProcessingSettingsOptions,
): () => void {
  let disposed = false
  const stackOnMobile = (setting: Setting) => {
    if (!isDesktop) setting.settingEl.addClass('nrlcmp-setting-stacked')
    return setting
  }

  container.createEl('h4', { text: 'Document processing' })

  new Setting(container)
    .setName('Processing mode')
    .setDesc(
      'Applies to newly ingested documents. Existing documents keep their recorded settings until you explicitly reprocess them. Changing this does not reprocess documents or restart the server.',
    )
    .addDropdown((dropdown) => {
      dropdown.selectEl.setAttribute('aria-label', 'Processing mode')
      dropdown
        .addOption('legacy', 'Existing behavior')
        .addOption('paragraph', 'Native paragraph')
        .setValue(plugin.settings.lightRagChunkingStrategy)
        .onChange((value) => {
          void plugin.setSettings({
            ...plugin.settings,
            lightRagChunkingStrategy: value as 'legacy' | 'paragraph',
          })
        })
    })

  let chunkSizeInput: HTMLInputElement
  let chunkOverlapInput: HTMLInputElement

  const saveChunkSettings = () => {
    const validation = validateDocumentProcessingValues(
      chunkSizeInput.value,
      chunkOverlapInput.value,
    )
    const invalidSize = validation === CHUNK_SIZE_ERROR
    const invalidOverlap = validation === CHUNK_OVERLAP_ERROR
    for (const [input, invalid] of [
      [chunkSizeInput, invalidSize],
      [chunkOverlapInput, invalidOverlap],
    ] as const) {
      if (invalid) input.setAttribute('aria-invalid', 'true')
      else input.removeAttribute('aria-invalid')
    }
    if (typeof validation === 'string') {
      new Notice(validation)
      return
    }
    if (
      validation.chunkSize === plugin.settings.lightRagChunkSize &&
      validation.chunkOverlap === plugin.settings.lightRagChunkOverlap
    ) {
      return
    }
    void plugin.setSettings({
      ...plugin.settings,
      lightRagChunkSize: validation.chunkSize,
      lightRagChunkOverlap: validation.chunkOverlap,
    })
  }

  stackOnMobile(
    new Setting(container)
      .setName('Maximum chunk tokens')
      .setDesc('Finite positive integer used for new processing requests.')
      .addText((text) => {
        chunkSizeInput = text.inputEl
        text.inputEl.setAttribute('aria-label', 'Maximum chunk tokens')
        text.setValue(String(plugin.settings.lightRagChunkSize))
        text.inputEl.type = 'number'
        text.inputEl.min = '1'
        text.inputEl.step = '1'
        text.inputEl.addEventListener('blur', saveChunkSettings)
      }),
  )

  stackOnMobile(
    new Setting(container)
      .setName('Overlap tokens')
      .setDesc('Finite non-negative integer smaller than maximum chunk tokens.')
      .addText((text) => {
        chunkOverlapInput = text.inputEl
        text.inputEl.setAttribute('aria-label', 'Overlap tokens')
        text.setValue(String(plugin.settings.lightRagChunkOverlap))
        text.inputEl.type = 'number'
        text.inputEl.min = '0'
        text.inputEl.step = '1'
        text.inputEl.addEventListener('blur', saveChunkSettings)
      }),
  )

  const compatibilitySetting = new Setting(container)
    .setName('Paragraph compatibility')
    .setDesc(
      'Not verified — checking the current backend. Native paragraph ingestion remains blocked.',
    )
  compatibilitySetting.descEl.setAttribute('aria-live', 'polite')
  const backendId = plugin.settings.lightRagBackendIdentity
  void (async () => {
    try {
      const compatibility = await (
        await plugin.getRAGEngine()
      ).getParagraphCompatibility()
      if (disposed || backendId !== plugin.settings.lightRagBackendIdentity) {
        return
      }
      const label =
        compatibility.status === 'supported'
          ? 'Supported'
          : compatibility.status === 'unsupported'
            ? 'Unsupported'
            : 'Not verified'
      compatibilitySetting.setDesc(
        `${label} — ${compatibility.message}${
          compatibility.status === 'supported'
            ? ' Privacy confirmation is also required.'
            : ' Native paragraph ingestion is blocked.'
        }`,
      )
    } catch {
      if (!disposed && backendId === plugin.settings.lightRagBackendIdentity) {
        compatibilitySetting.setDesc(
          'Not verified — the current backend could not be checked. Native paragraph ingestion is blocked.',
        )
      }
    }
  })()

  stackOnMobile(
    new Setting(container)
      .setName('Vault namespace')
      .setDesc(
        'Generated once for document source identity. Devices sharing this vault and graph must sync the same plugin settings; different namespaces produce different future source identities.',
      )
      .addText((text) => {
        text.setValue(
          plugin.settings.lightRagVaultNamespace || 'Not initialized',
        )
        text.inputEl.readOnly = true
        text.inputEl.setAttribute('aria-label', 'Vault namespace')
      }),
  )

  container.createEl('p', {
    cls: 'setting-item-description',
    text: 'Retries keep their captured processing settings. Existing documents with unknown historical settings remain paused during automatic replacement until you explicitly reprocess them with current settings.',
  })

  const privacyDescription = isRemote
    ? 'On the server host, set NATIVE_MD_IMAGE_DOWNLOAD_ENABLED=false and restart LightRAG. The plugin cannot read or modify a remote filesystem, so this remains operator-confirmed rather than verified.'
    : 'Native Markdown can download external images. Configure the managed local .env explicitly and restart, then confirm the effective running setting below. A generated file is not runtime verification.'
  const privacySetting = new Setting(container)
    .setName('External image download prerequisite')
    .setDesc(privacyDescription)

  if (isDesktop && !isRemote) {
    privacySetting.addButton((button) =>
      button.setButtonText('Configure & restart').onClick(() => {
        button.setDisabled(true)
        void plugin
          .configureParagraphPrivacy()
          .catch((error: unknown) => {
            new Notice(
              error instanceof Error
                ? error.message
                : 'Could not configure the local privacy prerequisite.',
            )
          })
          .finally(() => {
            if (!disposed) button.setDisabled(false)
          })
      }),
    )
  }

  const privacyConfirmed =
    backendId.length > 0 &&
    plugin.settings.lightRagImageDownloadsDisabledFor === backendId
  new Setting(container)
    .setName('Operator confirmation')
    .setDesc(
      privacyConfirmed
        ? 'Operator-confirmed for this backend identity; the plugin does not claim runtime verification.'
        : 'Required for native paragraph ingestion and scoped only to the current backend identity.',
    )
    .addToggle((toggle) => {
      toggle.toggleEl.setAttribute('role', 'switch')
      toggle.toggleEl.setAttribute('aria-label', 'Operator confirmation')
      toggle.toggleEl.setAttribute('aria-checked', String(privacyConfirmed))
      toggle.toggleEl
        .querySelector('input')
        ?.setAttribute('aria-hidden', 'true')
      toggle
        .setValue(privacyConfirmed)
        .setDisabled(backendId.length === 0)
        .onChange((confirmed) => {
          if (
            !backendId ||
            backendId !== plugin.settings.lightRagBackendIdentity
          ) {
            new Notice('Backend identity changed. Review the setting again.')
            return
          }
          toggle.toggleEl.setAttribute('aria-checked', String(confirmed))
          void plugin
            .setSettings({
              ...plugin.settings,
              lightRagImageDownloadsDisabledFor: confirmed ? backendId : '',
            })
            .catch(() => {
              if (!disposed) {
                toggle.setValue(privacyConfirmed)
                toggle.toggleEl.setAttribute(
                  'aria-checked',
                  String(privacyConfirmed),
                )
              }
              new Notice('Could not save privacy confirmation.')
            })
        })
    })

  new Setting(container)
    .setName('Backend replaced or reconfigured')
    .setDesc(
      'Use only when the operator knows the deployment or graph changed behind the same connection. This resets plugin ownership and privacy confirmation; it does not modify backend files or graph data.',
    )
    .addButton((button) =>
      button.setButtonText('Reset & revalidate').onClick(() => {
        button.setDisabled(true)
        void plugin
          .invalidateParagraphBackend()
          .then(() => {
            new Notice(
              'Backend identity reset. Recheck compatibility and confirm privacy before paragraph ingestion.',
            )
          })
          .catch(() => {
            new Notice('Could not reset the backend identity.')
          })
          .finally(() => {
            if (!disposed) button.setDisabled(false)
          })
      }),
    )

  return () => {
    disposed = true
  }
}
