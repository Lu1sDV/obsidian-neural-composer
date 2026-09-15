import { validateDocumentProcessingValues } from './DocumentProcessingSettings'

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  Setting: jest.fn(),
}))

describe('validateDocumentProcessingValues', () => {
  it('accepts finite integer token settings at their boundaries', () => {
    expect(validateDocumentProcessingValues('1', '0')).toEqual({
      chunkSize: 1,
      chunkOverlap: 0,
    })
    expect(validateDocumentProcessingValues('2048', '128')).toEqual({
      chunkSize: 2048,
      chunkOverlap: 128,
    })
  })

  it.each(['', '0', '-1', '1.5', 'Infinity', 'not-a-number'])(
    'rejects invalid maximum chunk tokens: %s',
    (chunkSize) => {
      expect(validateDocumentProcessingValues(chunkSize, '0')).toBe(
        'Maximum chunk tokens must be a finite positive integer.',
      )
    },
  )

  it.each(['', '-1', '1.5', 'Infinity', 'not-a-number', '100'])(
    'rejects invalid overlap tokens: %s',
    (chunkOverlap) => {
      expect(validateDocumentProcessingValues('100', chunkOverlap)).toBe(
        'Overlap tokens must be a finite non-negative integer smaller than maximum chunk tokens.',
      )
    },
  )
})
