import { z } from 'zod'

const RewriteRouteCaseSchema = z.object({
  id: z.string().min(1),
  review_count: z.number().int().nonnegative(),
  chapter_passed: z.array(z.boolean()).min(1),
  compatibility_route: z.enum(['write', 'export']),
  target_route: z.enum(['rewrite', 'export', 'export_with_warnings']),
  classification: z.enum(['equivalent', 'observable_equivalent', 'intentional_delta']),
  delta_reason: z.string().min(1).nullable(),
})

const WriterPolicyCaseSchema = z.object({
  id: z.string().min(1),
  reason: z.enum([
    'max_tool_rounds',
    'invalid_model_response',
    'empty_final_text',
    'max_tokens',
    'refusal',
    'pause_turn',
  ]),
  attempts: z.number().int().positive(),
  target: z.enum(['retry', 'terminal']),
})

export const WorkflowComponentFixtureSchema = z
  .object({
    schema_version: z.literal(1),
    dataset_id: z.literal('workflow-control-baseline-v1'),
    rewrite_route_cases: z.array(RewriteRouteCaseSchema).min(1),
    writer_policy_cases: z.array(WriterPolicyCaseSchema).min(1),
  })
  .superRefine((fixture, context) => {
    const ids = new Set<string>()
    const cases = [...fixture.rewrite_route_cases, ...fixture.writer_policy_cases]
    cases.forEach((testCase, index) => {
      if (ids.has(testCase.id)) {
        context.addIssue({
          code: 'custom',
          path: ['cases', index, 'id'],
          message: `duplicate case id: ${testCase.id}`,
        })
      }
      ids.add(testCase.id)
    })
    fixture.rewrite_route_cases.forEach((testCase, index) => {
      if (
        (testCase.classification === 'intentional_delta') !==
        (testCase.delta_reason !== null)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['rewrite_route_cases', index, 'delta_reason'],
          message: 'intentional_delta requires a reason; other classifications require null',
        })
      }
      if (
        testCase.classification === 'equivalent' &&
        testCase.compatibility_route !== testCase.target_route
      ) {
        context.addIssue({
          code: 'custom',
          path: ['rewrite_route_cases', index, 'target_route'],
          message: 'equivalent routes must match exactly',
        })
      }
      const failedCount = testCase.chapter_passed.filter((passed) => !passed).length
      if (failedCount === 0 && testCase.target_route !== 'export') {
        context.addIssue({
          code: 'custom',
          path: ['rewrite_route_cases', index, 'target_route'],
          message: 'all-passed cases must export',
        })
      }
      if (
        failedCount > 0 &&
        testCase.review_count >= 2 &&
        testCase.target_route !== 'export_with_warnings'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['rewrite_route_cases', index, 'target_route'],
          message: 'second-round failures must export with warnings',
        })
      }
    })
    fixture.writer_policy_cases.forEach((testCase, index) => {
      const retryable = [
        'invalid_model_response',
        'empty_final_text',
        'max_tokens',
        'pause_turn',
      ].includes(testCase.reason)
      const expected = retryable && testCase.attempts === 1 ? 'retry' : 'terminal'
      if (testCase.target !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['writer_policy_cases', index, 'target'],
          message: 'Writer target contradicts the retry policy boundary',
        })
      }
    })
  })

export type WorkflowComponentFixture = z.infer<typeof WorkflowComponentFixtureSchema>
