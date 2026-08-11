import { z } from 'zod'

export const ProductionTakeoverObservationSchema = z.object({
  jobStatus: z.literal('completed'),
  runStatuses: z.tuple([z.literal('failed'), z.literal('completed')]),
  runErrorCodes: z.tuple([z.literal('lease_expired'), z.null()]),
  articleCount: z.literal(1),
  articleRevision: z.literal(0),
  canonicalMarkdown: z.string().min(1),
  eventTypes: z.array(z.literal('done')).length(1),
  outboxStatuses: z.array(z.literal('published')).length(1),
  effectStatusCounts: z.object({ succeeded: z.literal(5), uncertain: z.literal(1) }),
  effectErrorCodes: z.array(z.literal('lease_takeover')).length(1),
  traceStatusCounts: z.object({ succeeded: z.literal(5), uncertain: z.literal(1) }),
  traceErrorCodes: z.array(z.literal('lease_takeover')).length(1),
  traceIdCount: z.literal(2),
  providerRequestCount: z.literal(5),
  staleEffectFinishResult: z.literal('lease_lost'),
  staleTerminalResult: z.literal('lease_lost'),
})

const ProductionTakeoverCaseSchema = z.object({
  id: z.string().min(1),
  workflow_case_id: z.literal('happy-no-intervention'),
  target_words: z.number().int().positive(),
  expected: ProductionTakeoverObservationSchema,
})

export const ProductionTakeoverFixtureSchema = z.object({
  schema_version: z.literal(1),
  dataset_id: z.literal('production-takeover-baseline-v1'),
  cases: z.array(ProductionTakeoverCaseSchema).length(1),
})

export type ProductionTakeoverObservation = z.infer<
  typeof ProductionTakeoverObservationSchema
>
