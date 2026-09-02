import { z } from 'zod'

export const ProductionCompositionObservationSchema = z.object({
  jobStatus: z.literal('completed'),
  runStatuses: z.array(z.literal('completed')).min(1),
  articleCount: z.literal(1),
  articleRevision: z.literal(0),
  canonicalMarkdown: z.string().min(1),
  eventTypes: z.array(z.string().min(1)).min(1),
  outboxStatuses: z.array(z.string().min(1)).min(1),
  effectKeys: z.array(z.string().min(1)).min(1),
  traceOperations: z.array(z.string().min(1)).min(1),
  traceIdCount: z.number().int().positive(),
  providerRequestCount: z.number().int().positive(),
})

const ProductionCompositionCaseSchema = z.object({
  id: z.string().min(1),
  workflow_case_id: z.string().min(1),
  target_words: z.number().int().positive(),
  expected: ProductionCompositionObservationSchema,
})

export const ProductionCompositionFixtureSchema = z.object({
  schema_version: z.literal(1),
  dataset_id: z.literal('production-composition-baseline-v3'),
  cases: z.array(ProductionCompositionCaseSchema).min(1),
}).superRefine((fixture, context) => {
  const ids = new Set<string>()
  fixture.cases.forEach((scenario, index) => {
    if (ids.has(scenario.id)) {
      context.addIssue({
        code: 'custom',
        path: ['cases', index, 'id'],
        message: `duplicate case id: ${scenario.id}`,
      })
    }
    ids.add(scenario.id)
  })
})

export type ProductionCompositionFixture = z.infer<
  typeof ProductionCompositionFixtureSchema
>
export type ProductionCompositionObservation = z.infer<
  typeof ProductionCompositionObservationSchema
>
