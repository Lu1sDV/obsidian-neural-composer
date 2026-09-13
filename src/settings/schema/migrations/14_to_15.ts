import { DEFAULT_PROVIDERS } from '../../../constants'
import type { SettingMigration } from '../setting.types'

export const migrateFrom14To15: SettingMigration['migrate'] = (data) => {
  const newData = { ...data, version: 15 }
  if (!Array.isArray(data.providers)) return newData

  const providers: unknown[] = data.providers
  if (
    !providers.some(
      (provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'id' in provider &&
        provider.id === 'zai',
    )
  ) {
    return {
      ...newData,
      providers: [
        ...providers,
        ...DEFAULT_PROVIDERS.filter((provider) => provider.id === 'zai'),
      ],
    }
  }
  return newData
}
