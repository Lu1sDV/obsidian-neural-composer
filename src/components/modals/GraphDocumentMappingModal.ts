import { App, Modal, Setting } from 'obsidian'

export class GraphDocumentMappingModal extends Modal {
  constructor(
    app: App,
    private readonly vaultPath: string,
    private readonly candidates: {
      id: string
      source: string
      status: string
    }[],
    private readonly onSelect: (docId: string) => Promise<void>,
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('Map existing graph document')
    this.contentEl.createEl('p', {
      text: `Choose the exact server document belonging to ${this.vaultPath}. Mapping does not delete or reprocess it. Its historical processing policy remains unknown unless the server can establish it.`,
    })
    if (!this.candidates.length) {
      this.contentEl.createEl('p', {
        text: 'No matching server documents were found.',
      })
      return
    }
    let selected = ''
    new Setting(this.contentEl)
      .setName('Server document')
      .addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute('aria-label', 'Server document')
        dropdown.addOption('', 'Select a document')
        for (const candidate of this.candidates) {
          dropdown.addOption(
            candidate.id,
            `${candidate.source} — ${candidate.id} (${candidate.status})`,
          )
        }
        dropdown.onChange((value) => {
          selected = value
        })
      })
    const error = this.contentEl.createEl('p', { attr: { role: 'alert' } })
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText('Map document')
          .setCta()
          .onClick(() => {
            if (!selected) {
              error.setText(
                'Select the document you have verified belongs to this note.',
              )
              return
            }
            button.setDisabled(true)
            void this.onSelect(selected)
              .then(() => this.close())
              .catch((reason: unknown) => {
                error.setText(
                  reason instanceof Error ? reason.message : String(reason),
                )
                button.setDisabled(false)
              })
          }),
      )
      .addButton((button) =>
        button.setButtonText('Cancel').onClick(() => this.close()),
      )
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
