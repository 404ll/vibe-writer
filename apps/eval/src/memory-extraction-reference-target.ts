import type { MemoryExtractionOutput } from '@vibe-writer/memory-core'

type Candidate = MemoryExtractionOutput['candidates'][number]

function candidate(
  memoryKey: string,
  kind: Candidate['kind'],
  content: string,
  subject: Candidate['subject'] = { kind: 'principal', key: 'self' },
): Candidate {
  return {
    subject,
    memoryKey,
    kind,
    content,
    confidence: 0.95,
    sensitivity: 'normal',
  }
}

const positive: Record<string, Candidate[]> = {
  'durable/zh-concise-tone': [candidate('writing.tone', 'preference', 'Prefer concise, direct technical prose.')],
  'durable/en-bullet-format': [candidate('writing.format', 'preference', 'Prefer short bullet lists over dense paragraphs.')],
  'durable/zh-no-emoji': [candidate('writing.no_emoji', 'constraint', 'Do not use emoji in formal articles.')],
  'durable/en-source-correction': [candidate(
    'research.primary_sources',
    'correction',
    'Do not use community-edited encyclopedias as primary evidence.',
  )],
  'durable/zh-language': [candidate('writing.language', 'preference', 'Default to Chinese while preserving English code identifiers.')],
  'durable/en-project-typescript': [candidate(
    'project.backend_language',
    'constraint',
    'Use TypeScript for backend implementation unless explicitly overridden.',
    { kind: 'project', key: 'default-project' },
  )],
  'durable/zh-first-person': [candidate('writing.voice', 'preference', 'Use first-person voice for retrospectives.')],
  'durable/en-citation-constraint': [candidate('research.current_claim_citations', 'constraint', 'Cite a source for claims that may have changed recently.')],
  'durable/zh-marketing-correction': [candidate('writing.marketing_language', 'correction', 'Avoid hype terms such as disruptive or revolutionary.')],
  'durable/en-date-format': [candidate('writing.date_format', 'preference', 'Use ISO date format in technical documents.')],
}

const negativeKeys = [
  'task/zh-this-article-concise',
  'task/en-one-off-poetic',
  'task/en-current-prototype-typescript',
  'assistant/generated-concise-article',
  'assistant/inferred-user-style',
  'assistant/generated-source-policy',
  'sensitive/health-treatment',
  'sensitive/political-affiliation',
  'sensitive/precise-location',
  'ambiguous/unknown-scope',
  'ambiguous/quoted-third-party',
  'ambiguous/tentative',
  'ambiguous/contradictory',
  'ambiguous/question',
] as const

export const MEMORY_EXTRACTION_REFERENCE_TARGET = {
  key: 'reference-memory-extractor',
  version: '2026-08-07-v1',
} as const

export function referenceMemoryExtractionOutput(caseKey: string): MemoryExtractionOutput {
  const candidates = positive[caseKey]
  if (candidates) return { schemaVersion: 1, candidates }
  if ((negativeKeys as readonly string[]).includes(caseKey)) {
    return { schemaVersion: 1, candidates: [] }
  }
  throw new Error(`Unknown Memory extraction reference case: ${caseKey}`)
}
