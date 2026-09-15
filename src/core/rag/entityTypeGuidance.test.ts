import {
  buildEntityTypeProfile,
  entityTypeNames,
  normalizeEntityTypeGuidance,
} from './entityTypeGuidance'

describe('entity type guidance', () => {
  it('accepts one described PascalCase entity type per line', () => {
    const guidance = [
      'Person: Human individuals, real or fictional',
      'FormalObject: A formally defined mathematical or logical construct',
      'Vulnerability: A weakness or condition that can be exploited',
    ].join('\n')

    expect(normalizeEntityTypeGuidance(guidance)).toBe(guidance)
    expect(entityTypeNames(guidance)).toEqual([
      'Person',
      'FormalObject',
      'Vulnerability',
    ])
  })

  it.each([
    ['missing description', 'Person'],
    ['non-PascalCase name', 'formal_object: A formal construct'],
    ['duplicate name', 'Person: A human\nperson: Another human'],
  ])('rejects %s', (_case, guidance) => {
    expect(() => normalizeEntityTypeGuidance(guidance)).toThrow(/Line \d+:/)
  })

  it('builds a YAML profile usable by text and JSON extraction modes', () => {
    const profile = buildEntityTypeProfile(
      'Person: Human individuals\nVulnerability: A weakness: exploitable or harmful',
    )

    expect(profile).toContain('entity_types_guidance: |')
    expect(profile).toContain('  - Person: Human individuals')
    expect(profile).toContain(
      '  - Vulnerability: A weakness: exploitable or harmful',
    )
    expect(profile).toContain('entity_extraction_examples:')
    expect(profile).toContain('entity_extraction_json_examples:')
  })
})
