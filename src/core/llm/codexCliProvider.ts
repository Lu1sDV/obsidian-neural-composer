import type * as ChildProcess from 'child_process'
import type * as FileSystem from 'fs'
import type * as OperatingSystem from 'os'
import type * as NodePath from 'path'
import type * as Readline from 'readline'

import { Platform } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'

import type { ChatModel } from '../../types/chat-model.types'
import type {
  LLMOptions,
  LLMRequest,
  LLMRequestNonStreaming,
  LLMRequestStreaming,
} from '../../types/llm/request'
import type {
  LLMResponseNonStreaming,
  LLMResponseStreaming,
  ResponseUsage,
} from '../../types/llm/response'
import type { LLMProvider } from '../../types/provider.types'

import { BaseLLMProvider } from './base'

const eventSchema = z.object({
  type: z.string(),
  thread_id: z.string().optional(),
  message: z.string().optional(),
  error: z.object({ message: z.string() }).optional(),
  item: z
    .object({
      type: z.string(),
      text: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
  usage: z
    .object({ input_tokens: z.number(), output_tokens: z.number() })
    .optional(),
})

export type CodexDiscoveredModel = {
  model: string
  displayName: string
  isDefault: boolean
}

const modelPageSchema = z.object({
  data: z.array(
    z.object({
      model: z.string().trim().min(1),
      displayName: z.string(),
      isDefault: z.boolean(),
      hidden: z.boolean(),
      inputModalities: z.array(z.string()).default(['text', 'image']),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
})

const rpcMessageSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
})

function authEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // Keep CODEX_HOME for login, but not inherited CLI execution overrides.
  for (const key of Object.keys(env)) {
    if (
      (key.startsWith('CODEX_') && key !== 'CODEX_HOME') ||
      key === 'OPENAI_API_KEY' ||
      key === 'OPENAI_BASE_URL'
    ) {
      delete env[key]
    }
  }
  return env
}

function ownProcess(
  child: ChildProcess.ChildProcess,
  spawn: typeof ChildProcess.spawn,
  lines: Readline.Interface,
) {
  let didClose = false
  let killTimer: NodeJS.Timeout | undefined
  let terminating = false
  const closed = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.once('close', (code, signal) => {
        didClose = true
        clearTimeout(killTimer)
        if (terminating && process.platform !== 'win32' && child.pid) {
          // The parent may exit before a descendant handles SIGTERM.
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            /* Already gone. */
          }
        }
        resolve({ code, signal })
      })
    },
  )
  const terminate = () => {
    if (didClose || terminating) return
    terminating = true
    lines.close()
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn(
        'taskkill',
        ['/pid', String(child.pid), '/T', '/F'],
        {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        },
      )
      killer.on('error', () => child.kill('SIGKILL'))
    } else if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
    }
    killTimer = setTimeout(() => {
      if (didClose) return
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      } else {
        child.kill('SIGKILL')
      }
    }, 1000)
  }
  return { closed, terminate }
}

const textInstructions =
  'You are a text-only conversation assistant, not a coding agent. The user input is a JSON conversation with ordered system, user, and assistant messages. Preserve their roles: follow the supplied system instructions and answer the last user turn in context. Return only the assistant response, not the transcript. Do not use tools, inspect the environment, or write files. For editing requests, return the proposed text; the application handles applying changes.'

// These switches remove default-on integrations, not just their prompt guidance.
const disabledFeatures = [
  'apps',
  'browser_use',
  'computer_use',
  'hooks',
  'plugins',
  'remote_plugin',
  'shell_tool',
  'shell_snapshot',
  'unified_exec',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'image_generation',
  'view_image',
  'tool_suggest',
  'skill_search',
  'skill_mcp_dependency_install',
  'workspace_dependencies',
  'sleep_tool',
]

function cliError(message: string): Error {
  if (
    /not logged in|login required|unauthorized|authentication|401|refresh.?token|missing.*api.?key/i.test(
      message,
    )
  ) {
    return new Error(
      `Codex CLI authentication failed. Run codex login in a terminal using the same executable and user account, then retry. ${message}`,
    )
  }
  return new Error(`Codex CLI: ${message}`)
}

class CodexConnectionError extends Error {}

export class CodexCliProvider extends BaseLLMProvider<
  Extract<LLMProvider, { type: 'codex-cli' }>
> {
  // Only locally authored discovery errors may cross the settings UI boundary.
  async testConnection(options?: LLMOptions): Promise<CodexDiscoveredModel[]> {
    if (!Platform.isDesktop) {
      throw new Error('Codex CLI is available only in Obsidian desktop.')
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    options?.signal?.addEventListener('abort', abort, { once: true })
    if (options?.signal?.aborted) abort()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      abort()
    }, 60000)
    let discovering = true
    try {
      const models = await this.discoverModels(controller.signal)
      discovering = false
      const selected = models.find((model) => model.isDefault) ?? models[0]
      await this.generateResponse(
        {
          id: 'codex-connection-test',
          providerId: this.provider.id,
          providerType: 'codex-cli',
          model: selected.model,
        },
        {
          model: selected.model,
          messages: [{ role: 'user', content: 'Reply with only OK.' }],
        },
        { signal: controller.signal },
      )
      if (controller.signal.aborted) throw new Error('aborted')
      return models
    } catch (error) {
      if (timedOut) throw new Error('Codex CLI connection test timed out.')
      if (controller.signal.aborted) {
        const aborted = new Error('Codex CLI connection test aborted')
        aborted.name = 'AbortError'
        throw aborted
      }
      // exec diagnostics can contain account details; never expose them here.
      const message = error instanceof Error ? error.message : ''
      if (
        /not logged in|login required|unauthorized|authentication|401|refresh.?token|missing.*api.?key/i.test(
          message,
        )
      ) {
        throw new Error(
          'Codex CLI authentication failed. Run codex login using the configured executable and user account, then retry.',
        )
      }
      if (discovering && error instanceof CodexConnectionError) {
        throw error
      }
      throw new Error(
        discovering
          ? 'Codex CLI returned an incompatible discovery protocol. Update Codex CLI and retry.'
          : 'Codex CLI could not complete a text response. Check your account access and Codex CLI setup, then retry.',
      )
    } finally {
      clearTimeout(timeout)
      options?.signal?.removeEventListener('abort', abort)
    }
  }

  private async discoverModels(
    signal: AbortSignal,
  ): Promise<CodexDiscoveredModel[]> {
    if (signal.aborted) throw new Error('aborted')
    const desktopWindow = window as unknown as {
      require: (id: string) => unknown
    }
    const nodeRequire = desktopWindow.require
    const { spawn } = nodeRequire('child_process') as typeof ChildProcess
    const nodeFs = nodeRequire('fs') as typeof FileSystem
    const fs = nodeFs.promises
    const path = nodeRequire('path') as typeof NodePath
    const { tmpdir } = nodeRequire('os') as typeof OperatingSystem
    const { createInterface } = nodeRequire('readline') as typeof Readline
    const cwd = await fs.mkdtemp(path.join(tmpdir(), 'neural-composer-codex-'))
    try {
      if (signal.aborted) throw new Error('aborted')
      const child = spawn(
        this.provider.additionalSettings?.executablePath?.trim() || 'codex',
        [
          'app-server',
          '--listen',
          'stdio://',
          '--strict-config',
          '-c',
          'model_provider="openai"',
          '-c',
          'mcp_servers={}',
          '-c',
          'analytics.enabled=false',
          ...disabledFeatures.flatMap((feature) => ['--disable', feature]),
        ],
        {
          cwd,
          env: authEnvironment(),
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      const lines = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      })
      const { closed, terminate } = ownProcess(child, spawn, lines)
      let failure: Error | undefined
      let pending:
        | {
            id: number
            resolve: (value: unknown) => void
            reject: (error: Error) => void
          }
        | undefined
      const fail = (error: Error) => {
        failure ??= error
        pending?.reject(failure)
        pending = undefined
        terminate()
      }
      const onAbort = () => fail(new Error('aborted'))
      child.once('error', (error: NodeJS.ErrnoException) => {
        fail(
          new CodexConnectionError(
            error.code === 'ENOENT'
              ? 'Codex executable not found. Install Codex CLI or set its full executable path in provider settings.'
              : 'Could not start Codex CLI. Check the executable path and permissions.',
          ),
        )
      })
      child.stdin.on('error', () =>
        fail(
          new CodexConnectionError(
            'Codex CLI discovery protocol input failed.',
          ),
        ),
      )
      // Drain diagnostics without retaining account identifiers or credentials.
      child.stderr.resume()
      child.once('close', () => {
        if (pending)
          fail(
            new CodexConnectionError(
              'Codex CLI exited before discovery completed. Check your Codex CLI setup.',
            ),
          )
      })
      lines.on('line', (line: string) => {
        if (failure || !line.trim()) return
        try {
          const message = rpcMessageSchema.parse(JSON.parse(line))
          if (message.method !== undefined) {
            if (message.id !== undefined) {
              child.stdin.write(
                JSON.stringify({
                  id: message.id,
                  error: {
                    code: -32601,
                    message:
                      'Client requests are not supported during model discovery.',
                  },
                }) + '\n',
              )
              fail(
                new CodexConnectionError(
                  'Codex CLI requested unsupported client interaction during discovery. Run codex login in a terminal and retry.',
                ),
              )
            }
            return
          }
          if (
            !pending ||
            message.id !== pending.id ||
            (message.error === undefined) ===
              !Object.prototype.hasOwnProperty.call(message, 'result')
          ) {
            throw new Error('Invalid response')
          }
          if (message.error) {
            fail(
              new CodexConnectionError(
                /unauthorized|authentication|401|refresh.?token|login|api.?key/i.test(
                  message.error.message,
                )
                  ? 'Codex CLI authentication failed.'
                  : 'Codex CLI discovery request failed. Update Codex CLI and check your account access.',
              ),
            )
            return
          }
          const request = pending
          pending = undefined
          request.resolve(message.result)
        } catch {
          fail(
            new CodexConnectionError(
              'Codex CLI returned an incompatible discovery protocol. Update Codex CLI and retry.',
            ),
          )
        }
      })
      let id = 0
      const rpc = (method: string, params: unknown): Promise<unknown> => {
        if (failure) return Promise.reject(failure)
        return new Promise((resolve, reject) => {
          pending = { id: ++id, resolve, reject }
          child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
        })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        if (signal.aborted) onAbort()
        z.object({ userAgent: z.string() }).parse(
          await rpc('initialize', {
            clientInfo: {
              name: 'neural_composer',
              title: 'Neural Composer',
              version: '1.0.0',
            },
            capabilities: { experimentalApi: false },
          }),
        )
        child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
        const account = z
          .object({
            account: z
              .object({ type: z.enum(['chatgpt', 'apiKey', 'amazonBedrock']) })
              .nullish(),
            requiresOpenaiAuth: z.boolean(),
          })
          .parse(await rpc('account/read', { refreshToken: true }))
        if (!account.account || account.account.type === 'amazonBedrock') {
          throw new Error('Codex CLI authentication failed.')
        }
        const models = new Map<string, CodexDiscoveredModel>()
        const cursors = new Set<string>()
        let cursor: string | null = null
        do {
          const page = modelPageSchema.parse(
            await rpc('model/list', {
              cursor,
              limit: 100,
              includeHidden: false,
            }),
          )
          for (const model of page.data) {
            if (model.hidden || !model.inputModalities.includes('text'))
              continue
            const previous = models.get(model.model)
            models.set(model.model, {
              model: model.model,
              displayName:
                previous?.displayName || model.displayName || model.model,
              isDefault: model.isDefault || previous?.isDefault === true,
            })
          }
          cursor = page.nextCursor ?? null
          if (cursor !== null) {
            if (cursors.has(cursor))
              throw new CodexConnectionError(
                'Codex CLI returned a repeated discovery cursor.',
              )
            cursors.add(cursor)
          }
        } while (cursor !== null)
        if (!models.size)
          throw new CodexConnectionError(
            'Codex CLI returned no visible text-capable models.',
          )
        child.stdin.end()
        const result = await closed
        if (failure) throw failure
        if (result.code !== 0)
          throw new CodexConnectionError(
            'Codex CLI discovery exited unsuccessfully. Check your Codex CLI setup.',
          )
        return [...models.values()]
      } finally {
        signal.removeEventListener('abort', onAbort)
        terminate()
        await closed
        lines.close()
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  }

  async generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming> {
    let content = ''
    let id = ''
    let usage: ResponseUsage | undefined
    for await (const chunk of this.run(model, request, options)) {
      id = chunk.id
      content += chunk.choices[0]?.delta.content ?? ''
      usage = chunk.usage ?? usage
    }
    return {
      id,
      model: model.model,
      object: 'chat.completion',
      usage,
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content } },
      ],
    }
  }

  async streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>> {
    return this.run(model, request, options)
  }

  getEmbedding(_model: string, _text: string): Promise<number[]> {
    return Promise.reject(
      new Error(
        'Codex CLI does not support embeddings. Select an embedding provider.',
      ),
    )
  }

  private async *run(
    model: ChatModel,
    request: LLMRequest,
    options?: LLMOptions,
  ): AsyncGenerator<LLMResponseStreaming> {
    if (!Platform.isDesktop) {
      throw new Error('Codex CLI is available only in Obsidian desktop.')
    }
    if (model.providerType !== 'codex-cli' || request.model !== model.model) {
      throw new Error('Codex CLI requires a matching Codex CLI chat model.')
    }
    if (!model.model.trim())
      throw new Error('Codex CLI model name is required.')
    if (
      request.tools?.length ||
      (request.tool_choice !== undefined && request.tool_choice !== 'none') ||
      request.messages.some(
        (message) =>
          message.role === 'tool' ||
          (message.role === 'assistant' && message.tool_calls?.length),
      )
    ) {
      throw new Error(
        'Codex CLI does not support tool calls or tool-result history. Start a text-only conversation or select another provider.',
      )
    }
    const unsupportedParameter = [
      'max_tokens',
      'temperature',
      'top_p',
      'frequency_penalty',
      'presence_penalty',
      'logit_bias',
      'prediction',
      'reasoning_effort',
      'web_search_options',
    ].find((key) => request[key as keyof LLMRequest] !== undefined)
    if (unsupportedParameter) {
      throw new Error(
        `Codex CLI does not support the ${unsupportedParameter} request option.`,
      )
    }
    const messages = request.messages.map((message) => {
      if (typeof message.content === 'string') return message
      if (message.content.some((part) => part.type !== 'text')) {
        throw new Error(
          'Codex CLI supports text only. Remove image attachments or select another provider.',
        )
      }
      return {
        role: message.role,
        content: message.content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('\n'),
      }
    })
    const abortError = new Error('Codex CLI request aborted')
    abortError.name = 'AbortError'
    if (options?.signal?.aborted) throw abortError

    // Obsidian exposes Node's loader on desktop; imports above are type-only.
    const desktopWindow = window as unknown as {
      require: (id: string) => unknown
    }
    const nodeRequire = desktopWindow.require
    const { spawn } = nodeRequire('child_process') as typeof ChildProcess
    const nodeFs = nodeRequire('fs') as typeof FileSystem
    const fs = nodeFs.promises
    const path = nodeRequire('path') as typeof NodePath
    const { tmpdir } = nodeRequire('os') as typeof OperatingSystem
    const { createInterface } = nodeRequire('readline') as typeof Readline
    const cwd = await fs.mkdtemp(path.join(tmpdir(), 'neural-composer-codex-'))
    try {
      const catalogPath = path.join(cwd, 'models.json')
      // shell_tool=false does not disable apply_patch. An authoritative catalog
      // removes model-provided tools too; no server refresh can add them back.
      await fs.writeFile(
        catalogPath,
        JSON.stringify({
          models: [
            {
              slug: model.model,
              display_name: model.model,
              description: 'Text-only Neural Composer session',
              supported_reasoning_levels: [],
              shell_type: 'disabled',
              visibility: 'list',
              supported_in_api: true,
              priority: 0,
              base_instructions: textInstructions,
              support_verbosity: false,
              apply_patch_tool_type: null,
              truncation_policy: { mode: 'bytes', limit: 10000 },
              experimental_supported_tools: [],
              input_modalities: ['text'],
              include_apps_usage_instructions: false,
              supports_reasoning_summary_parameter: false,
              node_repl_disabled: true,
            },
          ],
        }),
        { mode: 0o600 },
      )
      if (options?.signal?.aborted) throw abortError

      const args = [
        'exec',
        '--json',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--strict-config',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--color',
        'never',
        '--model',
        model.model,
        '-c',
        `model_catalog_json=${JSON.stringify(catalogPath)}`,
        '-c',
        'model_provider="openai"',
        '-c',
        'approval_policy="never"',
        '-c',
        'project_doc_max_bytes=0',
        '-c',
        'mcp_servers={}',
        '-c',
        'web_search="disabled"',
        '-c',
        'tools.update_plan.enabled=false',
        '-c',
        'tools.experimental_request_user_input.enabled=false',
        '-c',
        'skills.include_instructions=false',
        '-c',
        'features.skip_host_skill_discovery=true',
        '-c',
        'agents.enabled=false',
        ...disabledFeatures.flatMap((feature) => ['--disable', feature]),
        '-',
      ]
      const executable =
        this.provider.additionalSettings?.executablePath?.trim() || 'codex'
      const env = authEnvironment()
      const child = spawn(executable, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const lines = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      })
      let stderr = ''
      let spawnError: NodeJS.ErrnoException | undefined
      let inputError: Error | undefined
      const { closed, terminate } = ownProcess(child, spawn, lines)
      child.once('error', (error: NodeJS.ErrnoException) => {
        spawnError = error
        lines.close()
      })
      child.stdin.on('error', (error: Error) => {
        inputError = error
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (text: string) => {
        stderr = (stderr + text).slice(-16384)
      })
      options?.signal?.addEventListener('abort', terminate, { once: true })
      let id = uuidv4()
      let contentReceived = false
      let completed = false
      let usage: ResponseUsage | undefined
      let diagnostic: string | undefined
      try {
        if (options?.signal?.aborted) {
          terminate()
          throw abortError
        }
        child.stdin.end(JSON.stringify({ messages }))
        for await (const line of lines) {
          if (options?.signal?.aborted) throw abortError
          if (!line.trim()) continue
          let event: z.infer<typeof eventSchema>
          try {
            event = eventSchema.parse(JSON.parse(line))
          } catch {
            throw cliError(
              'Invalid JSON event from the executable. Use a compatible Codex CLI version supporting exec --json and the isolation flags.',
            )
          }
          if (event.type === 'thread.started' && event.thread_id)
            id = event.thread_id
          // exec reports warnings and recoverable stream errors as error items.
          // Only turn.failed or an unsuccessful process exit ends the request.
          if (event.type === 'error' || event.item?.type === 'error') {
            diagnostic = event.message ?? event.item?.message
            continue
          }
          if (event.type === 'turn.failed') {
            throw cliError(
              event.error?.message ?? diagnostic ?? 'Generation failed.',
            )
          }
          if (
            event.item &&
            !['agent_message', 'reasoning'].includes(event.item.type)
          ) {
            throw cliError(
              `Unexpected ${event.item.type} activity in a text-only session. The request was stopped; update Codex CLI before retrying.`,
            )
          }
          if (
            event.type === 'item.completed' &&
            event.item?.type === 'agent_message' &&
            event.item.text
          ) {
            const content = (contentReceived ? '\n\n' : '') + event.item.text
            contentReceived = true
            yield {
              id,
              model: model.model,
              object: 'chat.completion.chunk',
              choices: [
                { finish_reason: null, delta: { role: 'assistant', content } },
              ],
            }
          }
          if (event.type === 'turn.completed') {
            completed = true
            if (event.usage) {
              usage = {
                prompt_tokens: event.usage.input_tokens,
                completion_tokens: event.usage.output_tokens,
                total_tokens:
                  event.usage.input_tokens + event.usage.output_tokens,
              }
            }
          }
        }
        const result = await closed
        if (options?.signal?.aborted) throw abortError
        if (spawnError) {
          if (spawnError.code === 'ENOENT') {
            throw new Error(
              `Codex executable not found: ${executable}. Install Codex CLI or set its full executable path in provider settings.`,
            )
          }
          throw cliError(
            `Could not start ${executable}: ${spawnError.message}. Check the executable path and permissions (on Windows, use the native codex.exe).`,
          )
        }
        if (result.code !== 0) {
          throw cliError(
            `Exited with ${result.signal ? `signal ${result.signal}` : `code ${result.code}`}.${stderr.trim() || diagnostic ? ` ${stderr.trim() || diagnostic}` : ' Run codex login if you have not authenticated.'}`,
          )
        }
        if (inputError)
          throw cliError(`Could not send the prompt: ${inputError.message}`)
        if (!completed || !contentReceived) {
          throw cliError(
            `Exited without a completed text response.${diagnostic || stderr.trim() ? ` ${diagnostic || stderr.trim()}` : ''}`,
          )
        }
        yield {
          id,
          model: model.model,
          object: 'chat.completion.chunk',
          usage,
          choices: [{ finish_reason: 'stop', delta: {} }],
        }
      } finally {
        options?.signal?.removeEventListener('abort', terminate)
        terminate()
        await closed
        lines.close()
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  }
}
