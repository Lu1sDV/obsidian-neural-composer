import { requestUrl } from 'obsidian'
import type { App, TFile } from 'obsidian'

import { RAGEngine } from './ragEngine'

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  requestUrl: jest.fn(),
}))

const mockCast = <T>(value: unknown): T => value as T

describe('RAGEngine binary ingestion', () => {
  it('uploads the vault-relative path as the multipart filename', async () => {
    const readBinary = jest
      .fn()
      .mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
    const app = mockCast<App>({ vault: { readBinary } })
    const engine = Object.assign(Object.create(RAGEngine.prototype), {
      app,
      settings: {
        lightRagApiKey: '',
        lightRagServerUrl: 'http://localhost:9621',
      },
    }) as RAGEngine
    const file = mockCast<TFile>({
      name: 'report.pdf',
      path: 'Projects/A/report.pdf',
    })
    const requestUrlMock = jest.mocked(requestUrl)
    requestUrlMock.mockResolvedValue(mockCast({ status: 200 }))

    await expect(engine.uploadDocument(file)).resolves.toBe(true)

    const request = requestUrlMock.mock.calls[0][0]
    if (typeof request === 'string') {
      throw new Error('Expected request options')
    }
    expect(request.body).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(request.body as ArrayBuffer)).toContain(
      'filename="Projects/A/report.pdf"',
    )
  })
})
