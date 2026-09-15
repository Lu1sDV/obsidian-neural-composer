import {
  DEFAULT_ENTITY_TYPE_GUIDANCE,
  describedEntityTypesFromLegacy,
} from '../../../core/rag/entityTypeGuidance'
import type { SettingMigration } from '../setting.types'

export const migrateFrom16To17: SettingMigration['migrate'] = (data) => {
  const migrated: Record<string, unknown> = { ...data, version: 17 }
  const legacy = data.lightRagEntityTypes
  migrated.lightRagEntityTypeGuidance =
    typeof legacy === 'string' && legacy.trim()
      ? describedEntityTypesFromLegacy(legacy)
      : DEFAULT_ENTITY_TYPE_GUIDANCE
  delete migrated.lightRagEntityTypes
  return migrated
}
