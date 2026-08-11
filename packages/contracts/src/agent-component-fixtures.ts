import { z } from 'zod'

const VerdictSchema = z.enum(['passed', 'failed', 'inconclusive'])

export const AgentComponentFixtureSchema = z.object({
  schema_version: z.literal(1),
  dataset_id: z.string().min(1),
  planner_outline_cases: z.array(
    z.object({
      id: z.string().min(1),
      raw: z.string(),
      expected_chapters: z.array(z.string()),
    }),
  ),
  planner_trim_cases: z.array(
    z.object({
      id: z.string().min(1),
      chapters: z.array(z.string()),
      target_words: z.number().int().positive(),
      expected_chapters: z.array(z.string()),
    }),
  ),
  json_object_cases: z.array(
    z.object({
      id: z.string().min(1),
      raw: z.string(),
      expected: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
  reviewer_output_cases: z.array(
    z
      .object({
      id: z.string().min(1),
      scope: z.enum(['chapter', 'full']),
      raw: z.string(),
      chapter_count: z.number().int().positive(),
      compatibility_verdicts: z.array(VerdictSchema).min(1),
      target_verdicts: z.array(VerdictSchema).min(1),
      })
      .superRefine((testCase, context) => {
        if (testCase.compatibility_verdicts.length !== testCase.chapter_count) {
          context.addIssue({
            code: 'custom',
            path: ['compatibility_verdicts'],
            message: 'compatibility verdict count must equal chapter_count',
          })
        }
        if (testCase.target_verdicts.length !== testCase.chapter_count) {
          context.addIssue({
            code: 'custom',
            path: ['target_verdicts'],
            message: 'target verdict count must equal chapter_count',
          })
        }
      }),
  ),
})

export type AgentComponentFixture = z.infer<typeof AgentComponentFixtureSchema>
