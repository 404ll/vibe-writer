export type RubricCriterion = {
  key: string
  description: string
  weight: number
  minimumScore: number
}

export type VersionedRubric = {
  key: string
  version: string
  name: string
  passScore: number
  criteria: readonly RubricCriterion[]
}

export const ARTICLE_QUALITY_RUBRIC = {
  key: 'article-quality',
  version: '2026-08-07-v1',
  name: 'Article quality rubric',
  passScore: 75,
  criteria: [
    {
      key: 'focus_and_intent',
      description: 'The article sustains a clear purpose and does not drift into contradictory or unrelated material.',
      weight: 25,
      minimumScore: 60,
    },
    {
      key: 'coherence',
      description: 'The article has a clear structure and logically connected sections.',
      weight: 20,
      minimumScore: 60,
    },
    {
      key: 'substantive_coverage',
      description: 'The article covers the important aspects with concrete, non-repetitive detail.',
      weight: 25,
      minimumScore: 60,
    },
    {
      key: 'evidence_discipline',
      description: 'Claims are appropriately qualified and sources are not fabricated.',
      weight: 15,
      minimumScore: 60,
    },
    {
      key: 'readability',
      description: 'Language is precise, readable, and free of distracting formatting or boilerplate.',
      weight: 15,
      minimumScore: 60,
    },
  ],
} as const satisfies VersionedRubric
