import { z } from 'zod'

const FixtureBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
  }),
])

const FixtureResponseSchema = z.object({
  stop_reason: z.enum(['end_turn', 'tool_use', 'max_tokens', 'refusal', 'pause_turn']),
  blocks: z.array(FixtureBlockSchema),
})

const HandlerBehaviorSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['return', 'error']),
  output: z.string(),
})

export const WriterComponentFixtureSchema = z
  .object({
    schema_version: z.literal(1),
    dataset_id: z.string().min(1),
    tool_loop_cases: z
      .array(
        z.object({
          id: z.string().min(1),
          classification: z.enum([
            'equivalent',
            'observable_equivalent',
            'intentional_delta',
          ]),
          delta_reason: z.string().min(1).nullable(),
          max_tool_rounds: z.number().int().nonnegative(),
          responses: z.array(FixtureResponseSchema).min(1),
          handlers: z.array(HandlerBehaviorSchema),
          compatibility: z.object({
            text: z.string(),
            model_requests: z.number().int().positive(),
          }),
          target: z.object({
            status: z.enum(['completed', 'inconclusive']),
            text: z.string(),
            reason: z
              .enum([
                'max_tool_rounds',
                'invalid_model_response',
                'empty_final_text',
                'max_tokens',
                'refusal',
                'pause_turn',
              ])
              .nullable(),
            model_requests: z.number().int().positive(),
            execution_outcomes: z.array(
              z.enum([
                'success',
                'tool_error',
                'handler_error',
                'invalid_input',
                'unknown_tool',
                'budget_exceeded',
              ]),
            ),
          }),
        }),
      )
      .min(1),
  })
  .superRefine((fixture, context) => {
    const ids = new Set<string>()
    fixture.tool_loop_cases.forEach((testCase, index) => {
      if (ids.has(testCase.id)) {
        context.addIssue({
          code: 'custom',
          path: ['tool_loop_cases', index, 'id'],
          message: `duplicate case id: ${testCase.id}`,
        })
      }
      ids.add(testCase.id)
      const handlerNames = new Set<string>()
      testCase.handlers.forEach((handler, handlerIndex) => {
        if (handlerNames.has(handler.name)) {
          context.addIssue({
            code: 'custom',
            path: ['tool_loop_cases', index, 'handlers', handlerIndex, 'name'],
            message: `duplicate handler name: ${handler.name}`,
          })
        }
        handlerNames.add(handler.name)
      })
      if (
        (testCase.classification === 'intentional_delta') !==
        (testCase.delta_reason !== null)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['tool_loop_cases', index, 'delta_reason'],
          message: 'intentional_delta requires a reason; other classifications require null',
        })
      }
      if ((testCase.target.status === 'completed') !== (testCase.target.reason === null)) {
        context.addIssue({
          code: 'custom',
          path: ['tool_loop_cases', index, 'target', 'reason'],
          message: 'completed requires null reason; inconclusive requires a reason',
        })
      }
      if (testCase.target.status === 'completed' && !testCase.target.text.trim()) {
        context.addIssue({
          code: 'custom',
          path: ['tool_loop_cases', index, 'target', 'text'],
          message: 'completed target requires non-empty text',
        })
      }
      for (const runtime of ['compatibility', 'target'] as const) {
        if (testCase[runtime].model_requests > testCase.responses.length) {
          context.addIssue({
            code: 'custom',
            path: ['tool_loop_cases', index, runtime, 'model_requests'],
            message: 'model_requests cannot exceed scripted responses',
          })
        }
      }
      const scriptedCalls = testCase.responses.reduce(
        (count, response) =>
          count + response.blocks.filter((block) => block.type === 'tool_use').length,
        0,
      )
      if (testCase.target.execution_outcomes.length > scriptedCalls) {
        context.addIssue({
          code: 'custom',
          path: ['tool_loop_cases', index, 'target', 'execution_outcomes'],
          message: 'execution outcomes cannot exceed scripted tool calls',
        })
      }
    })
  })

export type WriterComponentFixture = z.infer<typeof WriterComponentFixtureSchema>
