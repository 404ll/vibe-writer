import { z } from 'zod'

const CompatibilityCoverageStatusSchema = z.enum(['ready', 'empty'])
const TargetCoverageStatusSchema = z.enum(['ready', 'inconclusive'])

const RankedDocumentSchema = z.object({
  id: z.string().min(1),
  published_at: z.string().nullable(),
})

export const ResearchComponentFixtureSchema = z.object({
  schema_version: z.literal(1),
  dataset_id: z.string().min(1),
  as_of_date: z.iso.date(),
  coverage_output_cases: z.array(
    z.object({
      id: z.string().min(1),
      raw: z.string(),
      compatibility_status: CompatibilityCoverageStatusSchema,
      compatibility_opinions_text: z.string(),
      compatibility_queries: z.array(z.string()),
      target_status: TargetCoverageStatusSchema,
      target_points: z.array(
        z.object({
          text: z.string(),
          search_query: z.string(),
        }),
      ),
    }),
  ).min(1),
  search_policy_cases: z.array(
    z.object({
      id: z.string().min(1),
      query: z.string().min(1),
      compatibility: z.object({
        news_like: z.boolean(),
        max_results: z.number().int().positive(),
        search_depth: z.string(),
        days: z.number().int().positive(),
        topic: z.string().optional(),
      }),
      target: z.object({
        topic: z.enum(['general', 'news']),
        max_results: z.number().int().positive(),
        search_depth: z.enum(['basic', 'advanced']),
        start_date: z.iso.date(),
        end_date: z.iso.date(),
      }),
    }),
  ).min(1),
  search_ranking_cases: z.array(
    z.object({
      id: z.string().min(1),
      news_like: z.boolean(),
      documents: z.array(RankedDocumentSchema),
      compatibility_order: z.array(z.string()),
      target_order: z.array(z.string()),
    }),
  ).min(1),
}).superRefine((fixture, context) => {
  const groups = [
    ['coverage_output_cases', fixture.coverage_output_cases],
    ['search_policy_cases', fixture.search_policy_cases],
    ['search_ranking_cases', fixture.search_ranking_cases],
  ] as const

  for (const [groupName, cases] of groups) {
    const seen = new Set<string>()
    cases.forEach((testCase, index) => {
      if (seen.has(testCase.id)) {
        context.addIssue({
          code: 'custom',
          path: [groupName, index, 'id'],
          message: `duplicate case id: ${testCase.id}`,
        })
      }
      seen.add(testCase.id)
    })
  }

  fixture.coverage_output_cases.forEach((testCase, index) => {
    const targetReady = testCase.target_status === 'ready'
    if (targetReady !== (testCase.target_points.length > 0)) {
      context.addIssue({
        code: 'custom',
        path: ['coverage_output_cases', index, 'target_points'],
        message: 'ready target cases must have points and non-ready cases must not',
      })
    }
    const compatibilityReady = testCase.compatibility_status === 'ready'
    if (compatibilityReady !== Boolean(testCase.compatibility_opinions_text || testCase.compatibility_queries.length)) {
      context.addIssue({
        code: 'custom',
        path: ['coverage_output_cases', index, 'compatibility_status'],
        message: 'compatibility ready status must match the exact expected legacy output',
      })
    }
  })

  fixture.search_policy_cases.forEach((testCase, index) => {
    if (testCase.target.start_date > testCase.target.end_date) {
      context.addIssue({
        code: 'custom',
        path: ['search_policy_cases', index, 'target'],
        message: 'target start_date must be on or before end_date',
      })
    }
  })

  fixture.search_ranking_cases.forEach((testCase, index) => {
    const inputIds = testCase.documents.map((document) => document.id)
    const uniqueInputIds = new Set(inputIds)
    if (uniqueInputIds.size !== inputIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['search_ranking_cases', index, 'documents'],
        message: 'ranking document ids must be unique',
      })
    }
    for (const [orderName, order] of [
      ['compatibility_order', testCase.compatibility_order],
      ['target_order', testCase.target_order],
    ] as const) {
      if (order.length !== inputIds.length || new Set(order).size !== order.length || order.some((id) => !uniqueInputIds.has(id))) {
        context.addIssue({
          code: 'custom',
          path: ['search_ranking_cases', index, orderName],
          message: 'ranking order must be an exact permutation of document ids',
        })
      }
    }
  })
})

export type ResearchComponentFixture = z.infer<typeof ResearchComponentFixtureSchema>
