import { migrateFrom16To17 } from './16_to_17'

describe('Migration from v16 to v17', () => {
  it('converts the legacy comma list into described entity guidance', () => {
    const data = {
      version: 16,
      lightRagEntityTypes: 'Person, Vulnerability, CustomThing',
      useCustomEntityTypes: true,
    }

    expect(migrateFrom16To17(data)).toEqual({
      version: 17,
      lightRagEntityTypeGuidance: [
        'Person: Human individuals, real or fictional',
        'Vulnerability: A weakness, exposure, defect, or condition that can cause harm or be exploited',
        'CustomThing: Domain entities classified as CustomThing',
      ].join('\n'),
      useCustomEntityTypes: true,
    })
    expect(data.lightRagEntityTypes).toBe('Person, Vulnerability, CustomThing')
  })

  it('uses the default guidance when no legacy value exists', () => {
    const migrated = migrateFrom16To17({ version: 16 })

    expect(migrated.version).toBe(17)
    expect(migrated.lightRagEntityTypeGuidance).toContain(
      'Person: Human individuals, real or fictional',
    )
  })
})
