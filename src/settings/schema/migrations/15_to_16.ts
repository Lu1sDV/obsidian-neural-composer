import type { SettingMigration } from '../setting.types'

const DEFAULT_DOCUMENT_PROCESSING_SETTINGS = {
  lightRagChunkingStrategy: 'legacy',
  lightRagVaultNamespace: '',
  lightRagBackendIdentity: '',
  lightRagImageDownloadsDisabledFor: '',
} as const

export const migrateFrom15To16: SettingMigration['migrate'] = (data) => {
  const migrated: Record<string, unknown> = { ...data, version: 16 }

  for (const [key, value] of Object.entries(
    DEFAULT_DOCUMENT_PROCESSING_SETTINGS,
  )) {
    if (migrated[key] === undefined) migrated[key] = value
  }

  return migrated
}
