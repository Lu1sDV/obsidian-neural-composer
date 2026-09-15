export type EntityTypeDefinition = {
  name: string
  description: string
}

const ENTITY_TYPE_DESCRIPTIONS: Record<string, string> = {
  artifact:
    'Physical or digital objects created by humans, including tools, software, and devices',
  claim:
    'An assertion, hypothesis, proposition, or conclusion that can be supported or disputed',
  concept: 'Abstract ideas, theories, principles, or beliefs',
  content:
    'Creative or informational works, including books, articles, films, and reports',
  creature: 'Non-human living beings, including animals and mythical beings',
  data: 'Quantitative or structured information, including statistics, datasets, and measurements',
  event: 'Occurrences, incidents, ceremonies, or meetings',
  formalobject:
    'A formally defined mathematical, logical, computational, or legal construct',
  location:
    'Geographic places, including cities, countries, buildings, and regions',
  method: 'Procedures, techniques, algorithms, or workflows',
  model:
    'A representation, simulation, predictive model, or domain-specific system model',
  naturalobject:
    'Natural non-living objects, including minerals, celestial bodies, and chemical compounds',
  organization: 'Companies, institutions, government bodies, or groups',
  person: 'Human individuals, real or fictional',
  phenomenon: 'An observable process, pattern, behavior, or effect',
  quantity:
    'A measurable value, amount, dimension, threshold, rate, or unit-bearing measurement',
  theory:
    'An explanatory framework or body of principles supported by reasoning or evidence',
  vulnerability:
    'A weakness, exposure, defect, or condition that can cause harm or be exploited',
}

export const DEFAULT_ENTITY_TYPE_GUIDANCE = [
  'Person',
  'Creature',
  'Organization',
  'Location',
  'Event',
  'Concept',
  'Method',
  'Content',
  'Data',
  'Artifact',
  'NaturalObject',
]
  .map((name) => `${name}: ${ENTITY_TYPE_DESCRIPTIONS[name.toLowerCase()]}`)
  .join('\n')

export function describedEntityTypesFromLegacy(value: string): string {
  const seen = new Set<string>()
  const definitions = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const words = entry.match(/[A-Za-z0-9]+/g) ?? []
      const joined = words
        .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
        .join('')
      const name = /^\d/.test(joined) ? `Entity${joined}` : joined
      return {
        description:
          ENTITY_TYPE_DESCRIPTIONS[name.toLowerCase()] ??
          `Domain entities classified as ${name}`,
        name,
      }
    })
    .filter(({ name }) => {
      const key = name.toLowerCase()
      if (!name || seen.has(key)) return false
      seen.add(key)
      return true
    })

  return definitions.length
    ? definitions
        .map(({ name, description }) => `${name}: ${description}`)
        .join('\n')
    : DEFAULT_ENTITY_TYPE_GUIDANCE
}

export function parseEntityTypeGuidance(value: string): EntityTypeDefinition[] {
  const definitions: EntityTypeDefinition[] = []
  const seen = new Set<string>()

  for (const [index, rawLine] of value.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line) continue
    const separator = line.indexOf(':')
    if (separator === -1) {
      throw new Error(`Line ${index + 1}: use Name: description`)
    }
    const name = line.slice(0, separator).trim()
    const description = line.slice(separator + 1).trim()
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
      throw new Error(
        `Line ${index + 1}: name must be singular PascalCase without spaces`,
      )
    }
    if (!description) {
      throw new Error(`Line ${index + 1}: add a description`)
    }
    const key = name.toLowerCase()
    if (seen.has(key)) {
      throw new Error(`Line ${index + 1}: ${name} is duplicated`)
    }
    seen.add(key)
    definitions.push({ description, name })
  }

  if (!definitions.length)
    throw new Error('Line 1: add at least one entity type')
  return definitions
}

export function normalizeEntityTypeGuidance(value: string): string {
  return parseEntityTypeGuidance(value)
    .map(({ name, description }) => `${name}: ${description}`)
    .join('\n')
}

export function entityTypeNames(value: string): string[] {
  return parseEntityTypeGuidance(value).map(({ name }) => name)
}

export function buildEntityTypeProfile(value: string): string {
  const guidance = parseEntityTypeGuidance(value)
    .map(({ name, description }) => `  - ${name}: ${description}`)
    .join('\n')

  return `entity_types_guidance: |
  Classify each entity using one of the following types. If no type fits, use \`Other\`.

${guidance}
entity_extraction_examples:
  - |
    entity{tuple_delimiter}<entity_name>{tuple_delimiter}<entity_type>{tuple_delimiter}<entity_description>
    relation{tuple_delimiter}<source_entity>{tuple_delimiter}<target_entity>{tuple_delimiter}<relationship_keywords>{tuple_delimiter}<relationship_description>
    {completion_delimiter}
entity_extraction_json_examples:
  - |
    {
      "entities": [
        {
          "name": "<entity_name>",
          "type": "<entity_type>",
          "description": "<entity_description>"
        },
        {
          "name": "<related_entity_name>",
          "type": "<related_entity_type>",
          "description": "<related_entity_description>"
        }
      ],
      "relationships": [
        {
          "source": "<entity_name>",
          "target": "<related_entity_name>",
          "keywords": "<relationship_keywords>",
          "description": "<relationship_description>"
        }
      ]
    }
`
}
