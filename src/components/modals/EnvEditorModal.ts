import { App, ButtonComponent, Modal, Notice } from 'obsidian'

import NeuralComposerPlugin, { type EnvEditorSnapshot } from '../../main'

export class EnvEditorModal extends Modal {
  plugin: NeuralComposerPlugin
  content: string
  snapshot: EnvEditorSnapshot | null

  constructor(app: App, plugin: NeuralComposerPlugin) {
    super(app)
    this.plugin = plugin
    this.snapshot = plugin.loadEnvEditorSnapshot()
    this.content = this.snapshot?.content ?? ''
  }

  onOpen() {
    const { contentEl } = this
    contentEl.empty()
    if (!this.snapshot) {
      this.close()
      return
    }

    // El linter se queja de esta línea por el Emoji. Lo añadiremos al /skip.
    contentEl.createEl('h2', { text: 'Server configuration (.env)' })

    const desc = contentEl.createDiv({ cls: 'nrlcmp-modal-desc' })
    desc.createSpan({ text: 'Review the current configuration below. ' })
    desc.createEl('strong', { text: 'Changes here are temporary ' })
    desc.createSpan({ text: 'until you edit the settings in the plugin tab.' })

    // CSS Class instead of inline style
    const textAreaContainer = contentEl.createDiv({
      cls: 'nrlcmp-env-container',
    })

    const textArea = textAreaContainer.createEl('textarea', {
      cls: 'nrlcmp-env-textarea-full',
      text: this.content,
    })

    // Handle updates
    textArea.onchange = (e) => {
      const target = e.target as HTMLTextAreaElement
      this.content = target.value
    }

    const buttonContainer = contentEl.createDiv({ cls: 'nrlcmp-modal-actions' })

    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel')
      .onClick(() => this.close())

    new ButtonComponent(buttonContainer)
      .setButtonText('Save & restart server')
      .setCta()
      .onClick(() => {
        void this.saveAndRestart()
      })
  }

  private async saveAndRestart(): Promise<void> {
    if (!this.snapshot) return
    try {
      new Notice('Saving and restarting...')
      if (await this.plugin.saveEnvAndRestart(this.content, this.snapshot))
        this.close()
    } catch (error) {
      new Notice('Failed to restart server.')
      console.error(error)
    }
  }

  onClose() {
    this.contentEl.empty()
  }
}
