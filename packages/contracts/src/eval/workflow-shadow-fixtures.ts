import { z } from 'zod'

const OutlineReplySchema = z.object({
  message: z.string(),
  outline: z.array(z.string().trim().min(1)).min(1).max(6).nullable(),
})

const WorkflowShadowObservationSchema = z.object({
  phase: z.literal('completed'),
  outline: z.array(z.string().trim().min(1)).min(1).max(6),
  canonicalMarkdown: z.string().min(1),
  stageSequence: z.array(z.enum(['plan', 'write', 'review', 'export'])).min(4),
  outlineReviewCount: z.number().int().nonnegative(),
  writeCalls: z.number().int().positive(),
  fullReviewCalls: z.number().int().positive(),
})

const WorkflowShadowCaseSchema = z.object({
  id: z.string().min(1),
  topic: z.string().trim().min(1),
  initial_outline: z.array(z.string().trim().min(1)).min(1).max(6),
  intervention_on_outline: z.boolean(),
  replies: z.array(OutlineReplySchema),
  full_review_rounds: z.array(z.array(z.enum(['passed', 'failed'])).min(1)).min(1).max(2),
  expected: WorkflowShadowObservationSchema,
}).superRefine((scenario, context) => {
  if (scenario.intervention_on_outline !== (scenario.replies.length > 0)) {
    context.addIssue({
      code: 'custom',
      path: ['replies'],
      message: 'intervention scenarios require replies; non-intervention scenarios require none',
    })
  }
  if (scenario.full_review_rounds.some((round) => round.length !== scenario.initial_outline.length)) {
    context.addIssue({
      code: 'custom',
      path: ['full_review_rounds'],
      message: 'every full-review round must cover the initial outline cardinality',
    })
  }
  const finalRound = scenario.full_review_rounds.at(-1)
  if (!finalRound?.every((verdict) => verdict === 'passed')) {
    context.addIssue({
      code: 'custom',
      path: ['full_review_rounds'],
      message: 'the deterministic shadow baseline must finish with a passing review round',
    })
  }
})

export const WorkflowShadowFixtureSchema = z.object({
  schema_version: z.literal(1),
  dataset_id: z.literal('workflow-shadow-baseline-v1'),
  cases: z.array(WorkflowShadowCaseSchema).min(1),
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

export type WorkflowShadowFixture = z.infer<typeof WorkflowShadowFixtureSchema>
export type WorkflowShadowScenario = WorkflowShadowFixture['cases'][number]
export type WorkflowShadowObservation = z.infer<typeof WorkflowShadowObservationSchema>
