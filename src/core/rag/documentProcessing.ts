import type { NeuralComposerSettings } from '../../settings/schema/setting.types'

export type ProcessingPolicy = {
  mode: 'legacy' | 'paragraph'
  chunkSize: number
  chunkOverlap: number
}

export type PendingDocumentOperation = {
  backendId: string
  kind: 'ingest' | 'replace' | 'rename'
  stage:
    | 'prepared'
    | 'delete_requested'
    | 'delete_confirmed'
    | 'upload_requested'
    | 'tracking'
  policy: ProcessingPolicy
  mtime: number
  source: string
  docId?: string
  trackId?: string
  previousPath?: string
  previousDocId?: string
  paused?: boolean
  error?: string
}

export type IngestionResult = {
  status: 'processed' | 'skipped' | 'paused' | 'failed'
  path: string
  docId?: string
  message?: string
}

export type ParagraphCompatibility = {
  status: 'supported' | 'unsupported' | 'unverified'
  message: string
  version?: string
}

function validatePolicy(policy: ProcessingPolicy): ProcessingPolicy {
  if (policy.mode !== 'legacy' && policy.mode !== 'paragraph') {
    throw new Error('Processing mode must be legacy or paragraph')
  }
  if (
    !Number.isFinite(policy.chunkSize) ||
    !Number.isInteger(policy.chunkSize) ||
    policy.chunkSize < 1
  ) {
    throw new Error('Maximum chunk tokens must be a finite positive integer')
  }
  if (
    !Number.isFinite(policy.chunkOverlap) ||
    !Number.isInteger(policy.chunkOverlap) ||
    policy.chunkOverlap < 0 ||
    policy.chunkOverlap >= policy.chunkSize
  ) {
    throw new Error(
      'Overlap tokens must be a finite non-negative integer smaller than maximum chunk tokens',
    )
  }
  return policy
}

export function processingPolicy(
  settings: NeuralComposerSettings,
): ProcessingPolicy {
  return validatePolicy({
    mode: settings.lightRagChunkingStrategy,
    chunkSize: settings.lightRagChunkSize,
    chunkOverlap: settings.lightRagChunkOverlap,
  })
}

export function sameProcessingPolicy(
  a: ProcessingPolicy,
  b: ProcessingPolicy,
): boolean {
  return (
    a.mode === b.mode &&
    a.chunkSize === b.chunkSize &&
    a.chunkOverlap === b.chunkOverlap
  )
}

export async function documentSourceName(
  namespace: string,
  vaultPath: string,
): Promise<string> {
  if (!namespace) throw new Error('Vault namespace is required')
  if (!vaultPath) throw new Error('Vault path is required')
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is unavailable')

  const input = new TextEncoder().encode(JSON.stringify([namespace, vaultPath]))
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', input),
  )
  let sourceKey = ''
  for (const byte of digest) sourceKey += byte.toString(16).padStart(2, '0')

  const name = vaultPath.slice(vaultPath.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const candidate = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const extension = /^[a-z0-9]{1,16}$/.test(candidate) ? candidate : 'bin'
  return `nc-${sourceKey}.${extension}`
}

export function paragraphUploadName(
  source: string,
  policy: ProcessingPolicy,
): string {
  validatePolicy(policy)
  if (policy.mode !== 'paragraph') {
    throw new Error('Native paragraph upload requires paragraph mode')
  }

  const match = /^nc-([0-9a-f]{64})\.(md|docx)$/.exec(source)
  if (!match) {
    throw new Error(
      'Paragraph source must be a generated Markdown or DOCX name',
    )
  }

  const [, sourceKey, extension] = match
  const engine = extension === 'docx' ? 'native(smart_heading=false)' : 'native'
  return `nc-${sourceKey}.[${engine}-P(chunk_ts=${policy.chunkSize},chunk_ol=${policy.chunkOverlap},drop_rf=false)].${extension}`
}

export function isParagraphFile(extension: string): boolean {
  const normalized = extension.replace(/^\./, '').toLowerCase()
  return normalized === 'md' || normalized === 'docx'
}
