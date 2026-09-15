import { App } from 'obsidian'

import { ReactModal } from '../common/ReactModal'

export type ConfirmModalOptions = {
  title: string
  message: string
  ctaText?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel?: () => void
}

type ConfirmModalComponentProps = {
  message: string
  ctaText?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel?: () => void
  onClose: () => void
}

export class ConfirmModal extends ReactModal<ConfirmModalComponentProps> {
  constructor(app: App, options: ConfirmModalOptions) {
    super({
      app: app,
      Component: ConfirmModalComponent,
      props: {
        message: options.message,
        ctaText: options.ctaText,
        destructive: options.destructive,
        onConfirm: options.onConfirm,
        onCancel: options.onCancel,
      },
      options: {
        title: options.title,
      },
    })
  }
}

function ConfirmModalComponent({
  message,
  ctaText,
  onConfirm,
  destructive = false,
  onCancel,
  onClose,
}: ConfirmModalComponentProps) {
  return (
    <div>
      <div style={{ whiteSpace: 'pre-wrap' }}>{message}</div>
      <div className="modal-button-container">
        <button
          className={destructive ? 'mod-destructive' : 'mod-warning'}
          onClick={() => {
            onClose()
            onConfirm()
          }}
        >
          {ctaText ?? 'Confirm'}
        </button>
        <button
          className="mod-cancel"
          onClick={() => {
            onClose()
            onCancel?.()
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
