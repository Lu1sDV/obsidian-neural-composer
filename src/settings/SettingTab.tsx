import { App, PluginSettingTab, Setting } from 'obsidian'
import { Root, createRoot } from 'react-dom/client'

import { SettingsTabRoot } from '../components/settings/SettingsTabRoot'
import { SettingsProvider } from '../contexts/settings-context'
import NeuralComposerPlugin from '../main'

// Obsidian 1.13+ declarative settings API (getSettingDefinitions()), not yet
// present in this repo's installed `obsidian` type definitions (1.11.4), so
// this is a minimal local type for just the "render" entry kind we use --
// see https://docs.obsidian.md/Plugins/User+interface/Settings. On Obsidian
// 1.13+, returning a non-empty array here makes display() stop being called
// entirely, and is what makes the plugin show up in Obsidian's global
// settings search (the whole point of this, see the community-plugin-review
// bot warning that prompted it) -- one single entry, not per-field, since
// our settings tab is a full custom React app (tabs, icon rail, command
// bar), not a list of individual rows.
type RenderSettingDefinition = {
  name: string
  desc?: string
  render: (setting: Setting) => (() => void) | void
}

export class NeuralComposerSettingTab extends PluginSettingTab {
  plugin: NeuralComposerPlugin
  private root: Root | null = null

  constructor(app: App, plugin: NeuralComposerPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  private mount(containerEl: HTMLElement): Root {
    containerEl.empty()
    const root = createRoot(containerEl)
    root.render(
      <SettingsProvider
        settings={this.plugin.settings}
        setSettings={(newSettings) => this.plugin.setSettings(newSettings)}
        addSettingsChangeListener={(listener) =>
          this.plugin.addSettingsChangeListener(listener)
        }
      >
        <SettingsTabRoot app={this.app} plugin={this.plugin} />
      </SettingsProvider>,
    )
    return root
  }

  // Pre-1.13 fallback (and still the code path this.mount() shares with
  // getSettingDefinitions() below).
  display(): void {
    this.root = this.mount(this.containerEl)
  }

  hide(): void {
    if (this.root) {
      this.root.unmount()
      this.root = null
    }
  }

  // Declarative API entry point (Obsidian 1.13+). A single row whose render
  // callback mounts the exact same React tree as display(), inside that
  // row's own settingEl instead of containerEl -- everything else about the
  // custom UI (tabs, absolute positioning meant to fill the whole settings
  // pane) is unchanged. NOT verified live against a real Obsidian instance
  // (no Electron/Obsidian available in this environment) -- please confirm
  // the full-bleed layout still renders correctly inside the row before
  // merging; if `position: absolute` escapes oddly because some ancestor
  // `.setting-item*` element turns out to have its own `position` set,
  // that's the first thing to check.
  getSettingDefinitions(): RenderSettingDefinition[] {
    return [
      {
        name: 'Neural Composer',
        desc: 'Providers, models, chat, graph & vault, MCP tools, advanced settings, help.',
        render: (setting: Setting) => {
          setting.settingEl.empty()
          setting.settingEl.addClass('nc-full-settings-row')
          this.root = this.mount(setting.settingEl)
          return () => {
            this.root?.unmount()
            this.root = null
          }
        },
      },
    ]
  }
}
