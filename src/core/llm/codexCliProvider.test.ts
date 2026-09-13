import type { ChildProcess } from 'child_process'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { access } from 'fs/promises'
import { PassThrough } from 'stream'

import { Platform } from 'obsidian'

import type { ChatModel } from '../../types/chat-model.types'
import type { LLMRequestNonStreaming } from '../../types/llm/request'

import { CodexCliProvider } from './codexCliProvider'

jest.mock('obsidian', () => ({ Platform: { isDesktop: true } }))
jest.mock('child_process', () => ({ spawn: jest.fn() }))

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { require },
  })
})
afterAll(() => Reflect.deleteProperty(globalThis, 'window'))

const mockedSpawn = jest.mocked(spawn)
const model: ChatModel = {
  providerType: 'codex-cli',
  providerId: 'codex',
  id: 'codex-chat',
  model: 'gpt-5.4',
}
const request: LLMRequestNonStreaming = {
  model: model.model,
  messages: [
    { role: 'system', content: 'Answer in Spanish.' },
    { role: 'user', content: 'Remember the word: café.' },
    { role: 'assistant', content: 'Entendido.' },
    { role: 'user', content: 'Repeat it. $(not-a-command)\n"quoted"' },
  ],
}
const provider = new CodexCliProvider({ type: 'codex-cli', id: 'codex' })

class FakeCli extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 43210
  input = ''
  closed = false
  kill = jest.fn(() => {
    this.finish(null, 'SIGKILL')
    return true
  })

  constructor(onInput: (child: FakeCli) => void) {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (text: string) => {
      this.input += text
    })
    this.stdin.on('finish', () => {
      setImmediate(() => onInput(this))
    })
  }

  finish(code: number | null = 0, signal: string | null = null) {
    if (this.closed) return
    this.closed = true
    this.stdout.end()
    this.stderr.end()
    setImmediate(() => this.emit('close', code, signal))
  }
}

type RpcRequest = {
  id: number
  method: string
  params: Record<string, unknown>
}

const listedModel = {
  model: 'codex-first',
  displayName: 'Codex First',
  isDefault: false,
  hidden: false,
  inputModalities: ['text', 'image'],
}

function useAppServer(
  respond: (request: RpcRequest, child: FakeCli) => unknown,
  account: unknown = {
    type: 'chatgpt',
    email: 'private@example.test',
    planType: 'plus',
  },
) {
  const child = useCli((cli) => cli.finish())
  let buffer = ''
  child.stdin.on('data', (text: string) => {
    buffer += text
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)) as RpcRequest
      buffer = buffer.slice(newline + 1)
      setImmediate(() => {
        if (child.closed) return
        if (message.method === 'initialized' || !message.method) return
        const result =
          message.method === 'initialize'
            ? { userAgent: 'fake-codex' }
            : message.method === 'account/read'
              ? { account, requiresOpenaiAuth: true }
              : respond(message, child)
        if (result !== undefined) {
          child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n')
        }
      })
    }
  })
  return child
}

function useCli(onInput: (child: FakeCli) => void) {
  const child = new FakeCli(onInput)
  mockedSpawn.mockReturnValueOnce(child as unknown as ChildProcess)
  jest.spyOn(process, 'kill').mockImplementation(() => {
    child.finish(null, 'SIGTERM')
    return true
  })
  return child
}

async function expectWorkspaceRemoved() {
  for (const call of mockedSpawn.mock.calls) {
    if (!call[2]?.cwd) continue
    await expect(access(String(call[2].cwd))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  }
}

afterEach(() => {
  jest.restoreAllMocks()
  mockedSpawn.mockReset()
  Object.assign(Platform, { isDesktop: true })
})

describe('Codex CLI text provider', () => {
  it('frames split UTF-8 JSONL, preserves role history, and avoids duplicate completed text', async () => {
    const child = useCli((cli) => {
      const events = [
        { type: 'thread.started', thread_id: 'thread-test' },
        {
          type: 'item.completed',
          item: {
            type: 'error',
            message: 'Under-development features enabled.',
          },
        },
        { type: 'item.updated', item: { type: 'agent_message', text: 'caf' } },
        {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'café 😀' },
        },
        {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Second paragraph.' },
        },
        {
          type: 'turn.completed',
          usage: { input_tokens: 11, output_tokens: 7 },
        },
      ]
      // Deliberately split inside a multibyte character and omit the last newline.
      const bytes = Buffer.from(
        events.map((event) => JSON.stringify(event)).join('\r\n'),
      )
      const split = bytes.indexOf(Buffer.from('😀')) + 1
      cli.stdout.write(bytes.subarray(0, split))
      cli.stdout.write(bytes.subarray(split, split + 1))
      cli.stdout.write(bytes.subarray(split + 1))
      cli.finish()
    })
    const stream = await provider.streamResponse(model, {
      ...request,
      stream: true,
    })
    let text = ''
    let finishReason: string | null = null
    let totalTokens: number | undefined
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? ''
      finishReason = chunk.choices[0]?.finish_reason
      totalTokens = chunk.usage?.total_tokens ?? totalTokens
    }
    expect(text).toBe('café 😀\n\nSecond paragraph.')
    expect(finishReason).toBe('stop')
    expect(totalTokens).toBe(18)
    expect(JSON.parse(child.input)).toEqual({ messages: request.messages })
    const [, args, options] = mockedSpawn.mock.calls[0]
    expect(args?.join(' ')).not.toContain('not-a-command')
    expect(options?.shell).toBe(false)
    await expectWorkspaceRemoved()
  })

  it('returns normal chat completions and rejects failed exits even after text', async () => {
    useCli((cli) => {
      cli.stdout.write(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Hello' },
        }) + '\n',
      )
      cli.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n')
      cli.finish()
    })
    const response = await provider.generateResponse(model, request)
    expect(response.choices[0]).toEqual({
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'Hello' },
    })

    useCli((cli) => {
      cli.stdout.write(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Partial' },
        }) + '\n',
      )
      cli.stderr.write('service unavailable')
      cli.finish(17)
    })
    await expect(provider.generateResponse(model, request)).rejects.toThrow(
      'Exited with code 17. service unavailable',
    )
  })

  it.each([
    ['malformed JSON', '{broken\n', /Invalid JSON event/],
    [
      'authentication failure',
      '{"type":"turn.failed","error":{"message":"401 unauthorized"}}\n',
      /codex login/,
    ],
    [
      'unexpected tool execution',
      '{"type":"item.started","item":{"type":"command_execution"}}\n',
      /Unexpected command_execution/,
    ],
    [
      'missing completion',
      '{"type":"turn.started"}\n',
      /without a completed text response/,
    ],
  ])(
    'rejects %s without returning a successful completion',
    async (_name, output, error) => {
      useCli((cli) => {
        cli.stdout.write(output)
        cli.finish()
      })
      await expect(provider.generateResponse(model, request)).rejects.toThrow(
        error,
      )
      await expectWorkspaceRemoved()
    },
  )

  it('reports a missing executable rather than hanging on stdout', async () => {
    useCli((cli) => {
      cli.emit(
        'error',
        Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
      )
      cli.finish(-2)
    })
    await expect(provider.generateResponse(model, request)).rejects.toThrow(
      'Codex executable not found',
    )
    await expectWorkspaceRemoved()
  })

  it('aborts a waiting request, kills its process group, and cleans the workspace', async () => {
    const controller = new AbortController()
    let ready: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    const child = useCli(() => ready())
    const kill = jest
      .spyOn(process, 'kill')
      .mockImplementation((_pid, signal) => {
        if (signal === 'SIGKILL') child.finish(null, 'SIGKILL')
        return true
      })
    const response = provider.generateResponse(model, request, {
      signal: controller.signal,
    })
    const rejected = expect(response).rejects.toMatchObject({
      name: 'AbortError',
    })
    await started
    controller.abort()
    await rejected
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL')
    expect(child.closed).toBe(true)
    await expectWorkspaceRemoved()
  })

  it('rejects mobile, images, and tool history before starting an executable', async () => {
    Object.assign(Platform, { isDesktop: false })
    await expect(provider.generateResponse(model, request)).rejects.toThrow(
      'only in Obsidian desktop',
    )
    Object.assign(Platform, { isDesktop: true })
    await expect(
      provider.generateResponse(model, {
        ...request,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,AAAA' },
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow('supports text only')
    await expect(
      provider.generateResponse(model, {
        ...request,
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'tool-1', name: 'read_file', arguments: '{}' }],
          },
        ],
      }),
    ).rejects.toThrow('does not support tool calls')
    await expect(provider.getEmbedding('anything', 'text')).rejects.toThrow(
      'does not support embeddings',
    )
    const controller = new AbortController()
    controller.abort()
    await expect(
      provider.generateResponse(model, request, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mockedSpawn).not.toHaveBeenCalled()
  })
})

describe('Codex CLI connection discovery', () => {
  it('collects paged visible text models and waits for a real default-model completion', async () => {
    const server = useAppServer((rpc, cli) => {
      cli.stdout.write(
        JSON.stringify({
          method: 'remoteControl/status/changed',
          params: { status: 'disabled' },
        }) + '\n',
      )
      if (rpc.params.cursor === null) {
        return {
          data: [
            listedModel,
            { ...listedModel, model: 'hidden', hidden: true },
            { ...listedModel, model: 'audio', inputModalities: ['audio'] },
          ],
          nextCursor: 'page-two',
        }
      }
      expect(rpc.params.cursor).toBe('page-two')
      return {
        data: [
          listedModel,
          {
            ...listedModel,
            model: 'codex-default',
            displayName: 'Codex Default',
            isDefault: true,
          },
        ],
        nextCursor: null,
      }
    })
    let finishInference: () => void = () => undefined
    let inferenceReady: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      inferenceReady = resolve
    })
    useCli((cli) => {
      finishInference = () => {
        cli.stdout.write(
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'OK' },
          }) + '\n',
        )
        cli.stdout.write('{"type":"turn.completed"}\n')
        cli.finish()
      }
      inferenceReady()
    })
    let resolved = false
    const result = provider.testConnection().then((models) => {
      resolved = true
      return models
    })
    await started
    expect(resolved).toBe(false)
    expect(server.closed).toBe(true)
    expect(mockedSpawn.mock.calls[1][1]).toEqual(
      expect.arrayContaining(['--model', 'codex-default']),
    )
    finishInference()
    await expect(result).resolves.toEqual([
      { model: 'codex-first', displayName: 'Codex First', isDefault: false },
      { model: 'codex-default', displayName: 'Codex Default', isDefault: true },
    ])
    await expectWorkspaceRemoved()
  })

  it('rejects missing login without attempting inference', async () => {
    const server = useAppServer(() => {
      throw new Error('Unexpected model request')
    }, null)
    await expect(provider.testConnection()).rejects.toThrow('codex login')
    expect(mockedSpawn).toHaveBeenCalledTimes(1)
    expect(server.closed).toBe(true)
    await expectWorkspaceRemoved()
  })

  it('does not expose authentication diagnostics from a failed inference', async () => {
    useAppServer(() => ({ data: [listedModel], nextCursor: null }))
    useCli((cli) => {
      cli.stdout.write(
        JSON.stringify({
          type: 'turn.failed',
          error: {
            message: '401 unauthorized private@example.test token=secret',
          },
        }) + '\n',
      )
      cli.finish(1)
    })
    const result = provider.testConnection()
    await expect(result).rejects.toThrow(/authentication failed/)
    await expect(result).rejects.not.toThrow(/private@example\.test|secret/)
    await expectWorkspaceRemoved()
  })

  it('cancels inference after discovery without returning the collected models', async () => {
    useAppServer(() => ({ data: [listedModel], nextCursor: null }))
    const controller = new AbortController()
    const inference = useCli(() => controller.abort())
    await expect(
      provider.testConnection({ signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(inference.closed).toBe(true)
    await expectWorkspaceRemoved()
  })

  it.each([
    [
      'no text models',
      {
        data: [{ ...listedModel, inputModalities: ['audio'] }],
        nextCursor: null,
      },
      /no visible text-capable models/,
    ],
    [
      'invalid model fields',
      { data: [{ ...listedModel, isDefault: 'yes' }], nextCursor: null },
      /incompatible discovery protocol/,
    ],
    [
      'repeated cursor',
      { data: [listedModel], nextCursor: 'again' },
      /repeated discovery cursor/,
    ],
  ])('rejects %s before inference', async (_name, page, error) => {
    useAppServer(() => page)
    await expect(provider.testConnection()).rejects.toThrow(error)
    expect(mockedSpawn).toHaveBeenCalledTimes(1)
    await expectWorkspaceRemoved()
  })

  it('rejects server-initiated requests instead of waiting for interactive authentication', async () => {
    const server = useAppServer((_rpc, cli) => {
      cli.stdout.write(
        JSON.stringify({
          id: 'server-request',
          method: 'account/chatgptAuthTokens/refresh',
          params: { reason: 'unauthorized' },
        }) + '\n',
      )
    })
    await expect(provider.testConnection()).rejects.toThrow(
      'unsupported client interaction',
    )
    expect(server.input).toContain('"code":-32601')
    expect(server.closed).toBe(true)
    await expectWorkspaceRemoved()
  })

  it('rejects a nonzero discovery exit even after receiving models', async () => {
    const server = useAppServer(() => ({
      data: [listedModel],
      nextCursor: null,
    }))
    server.stdin.on('finish', () => server.finish(17))
    await expect(provider.testConnection()).rejects.toThrow(
      'discovery exited unsuccessfully',
    )
    expect(mockedSpawn).toHaveBeenCalledTimes(1)
    await expectWorkspaceRemoved()
  })

  it('reports a missing discovery executable and removes its workspace', async () => {
    const server = useAppServer(() => undefined)
    server.stdin.once('data', () => {
      server.emit(
        'error',
        Object.assign(new Error('private executable path'), { code: 'ENOENT' }),
      )
      server.finish(-2)
    })
    await expect(provider.testConnection()).rejects.toThrow(
      'Codex executable not found',
    )
    await expectWorkspaceRemoved()
  })

  it.each(['cancel', 'timeout'])(
    'cleans a hung protocol on %s',
    async (reason) => {
      let ready: () => void = () => undefined
      const started = new Promise<void>((resolve) => {
        ready = resolve
      })
      const server = useAppServer(() => {
        ready()
      })
      const controller = new AbortController()
      let timeoutCallback: (() => void) | undefined
      const originalSetTimeout = global.setTimeout
      jest.spyOn(global, 'setTimeout').mockImplementation(((
        callback: () => void,
        delay: number,
      ) => {
        if (delay === 60000) {
          timeoutCallback = callback
          return originalSetTimeout(() => undefined, 60000)
        }
        return originalSetTimeout(callback, delay)
      }) as typeof setTimeout)
      const result = provider.testConnection({ signal: controller.signal })
      const rejected =
        reason === 'cancel'
          ? expect(result).rejects.toMatchObject({ name: 'AbortError' })
          : expect(result).rejects.toThrow('timed out')
      await started
      if (reason === 'cancel') controller.abort()
      else timeoutCallback?.()
      await rejected
      expect(server.closed).toBe(true)
      expect(mockedSpawn).toHaveBeenCalledTimes(1)
      await expectWorkspaceRemoved()
    },
  )
})
