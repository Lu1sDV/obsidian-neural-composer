import { SettingMigration } from '../setting.types'

import { migrateFrom12To13 } from './12_to_13'
import { migrateFrom13To14 } from './13_to_14'
import { migrateFrom14To15 } from './14_to_15'
import { migrateFrom15To16 } from './15_to_16'
import { migrateFrom16To17 } from './16_to_17'

export const SETTINGS_SCHEMA_VERSION = 17

export const SETTING_MIGRATIONS: SettingMigration[] = [
  {
    fromVersion: 12,
    toVersion: 13,
    migrate: migrateFrom12To13,
  },
  {
    fromVersion: 13,
    toVersion: 14,
    migrate: migrateFrom13To14,
  },
  {
    fromVersion: 14,
    toVersion: 15,
    migrate: migrateFrom14To15,
  },
  {
    fromVersion: 15,
    toVersion: 16,
    migrate: migrateFrom15To16,
  },
  {
    fromVersion: 16,
    toVersion: 17,
    migrate: migrateFrom16To17,
  },
]
