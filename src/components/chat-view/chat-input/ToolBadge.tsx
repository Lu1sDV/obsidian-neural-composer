import clsx from 'clsx'
import { Eye, EyeOff, Wrench } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { useApp } from '../../../contexts/app-context'
import { useMcp } from '../../../contexts/mcp-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import { McpManager } from '../../../core/mcp/mcpManager'
import { McpSectionModal } from '../../modals/McpSectionModal'

export default function ToolBadge() {
  const plugin = usePlugin()
  const app = useApp()
  const { settings, setSettings } = useSettings()
  const { getMcpManager } = useMcp()

  const [mcpManager, setMcpManager] = useState<McpManager | null>(null)
  const [toolCount, setToolCount] = useState(0)
  const supportsTools =
    settings.chatModels.find((model) => model.id === settings.chatModelId)
      ?.providerType !== 'codex-cli'

  const handleBadgeClick = useCallback(() => {
    new McpSectionModal(app, plugin).open()
  }, [plugin, app])

  const handleToolToggle = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.stopPropagation()
      // Fix: Handle floating promise from setSettings explicitly
      void setSettings({
        ...settings,
        chatOptions: {
          ...settings.chatOptions,
          enableTools: !settings.chatOptions.enableTools,
        },
      })
    },
    [settings, setSettings],
  )

  useEffect(() => {
    if (!supportsTools) return
    const initMCPManager = async () => {
      const mcpManager = await getMcpManager()
      setMcpManager(mcpManager)

      const tools = await mcpManager.listAvailableTools()
      setToolCount(tools.length)
    }
    // Fix: Handle floating promise in useEffect
    void initMCPManager()
  }, [getMcpManager, supportsTools])

  useEffect(() => {
    if (mcpManager) {
      // Fix: Refactored to explicit sync function calling void async to satisfy linter
      const unsubscribe = mcpManager.subscribeServersChange((_servers) => {
        const updateTools = async () => {
          const tools = await mcpManager.listAvailableTools()
          setToolCount(tools.length)
        }
        void updateTools()
      })

      return () => {
        unsubscribe()
      }
    }
  }, [mcpManager])

  if (!supportsTools) {
    return (
      <div className="nrlcmp-chat-user-input-file-badge">
        <span>Tools unavailable (Codex CLI)</span>
      </div>
    )
  }

  return (
    <div
      className="nrlcmp-chat-user-input-file-badge"
      onClick={handleBadgeClick}
    >
      <div className="nrlcmp-chat-user-input-file-badge-name">
        <Wrench
          size={12}
          className="nrlcmp-chat-user-input-file-badge-name-icon"
        />
        <span
          className={clsx(
            !settings.chatOptions.enableTools && 'nrlcmp-excluded-content',
          )}
        >
          Tools ({toolCount})
        </span>
      </div>
      <div
        className="nrlcmp-chat-user-input-file-badge-eye"
        onClick={handleToolToggle}
      >
        {settings.chatOptions.enableTools ? (
          <Eye size={12} />
        ) : (
          <EyeOff size={12} />
        )}
      </div>
    </div>
  )
}
