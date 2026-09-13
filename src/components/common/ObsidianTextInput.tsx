import { TextComponent } from 'obsidian'
import { useEffect, useRef, useState } from 'react'

import { useObsidianSetting } from './ObsidianSetting'

type ObsidianTextInputProps = {
  value: string
  placeholder?: string
  onChange: (value: string) => void
  type?: 'text' | 'number'
  list?: string
  ariaLabel?: string
}

export function ObsidianTextInput({
  value,
  placeholder,
  onChange,
  type,
  list,
  ariaLabel,
}: ObsidianTextInputProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { setting } = useObsidianSetting()
  const [textComponent, setTextComponent] = useState<TextComponent | null>(null)
  const onChangeRef = useRef(onChange)

  useEffect(() => {
    if (setting) {
      let newTextComponent: TextComponent | null = null
      setting.addText((component) => {
        newTextComponent = component
      })
      setTextComponent(newTextComponent)

      return () => {
        newTextComponent?.inputEl.remove()
      }
    } else if (containerRef.current) {
      const newTextComponent = new TextComponent(containerRef.current)
      setTextComponent(newTextComponent)

      return () => {
        newTextComponent?.inputEl.remove()
      }
    }
  }, [setting])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!textComponent) return
    textComponent.onChange((v) => onChangeRef.current(v))
  }, [textComponent])

  useEffect(() => {
    if (!textComponent) return
    textComponent.setValue(value)
    if (placeholder) textComponent.setPlaceholder(placeholder)
    if (type) textComponent.inputEl.type = type
  }, [textComponent, value, placeholder, type])

  useEffect(() => {
    if (!textComponent) return
    if (list) textComponent.inputEl.setAttribute('list', list)
    else textComponent.inputEl.removeAttribute('list')
    if (ariaLabel) textComponent.inputEl.setAttribute('aria-label', ariaLabel)
    else textComponent.inputEl.removeAttribute('aria-label')
  }, [textComponent, list, ariaLabel])

  return <div ref={containerRef} />
}
