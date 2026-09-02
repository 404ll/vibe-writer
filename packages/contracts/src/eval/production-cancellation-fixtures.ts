import { z } from 'zod'

export const ProductionCancellationObservationSchema = z.object({
  jobStatus: z.literal('cancelled'),
  runStatuses: z.array(z.literal('cancelled')).min(1),
  articleCount: z.literal(0),
  eventTypes: z.array(z.string().min(1)).min(1),
  outboxStatuses: z.array(z.string().min(1)).min(1),
  effectStatuses: z.array(z.enum(['failed', 'uncertain'])).min(1),
  traceStatuses: z.array(z.enum(['failed', 'cancelled', 'uncertain'])).min(1),
  providerRequestCount: z.number().int().positive(),
  cancellationResult: z.literal('cancel_requested'),
})

const ProductionCancellationCaseSchema = z.object({
  id: z.string().min(1),
  topic: z.string().trim().min(1),
  target_words: z.number().int().positive(),
  expected: ProductionCancellationObservationSchema,
})

export const ProductionCancellationFixtureSchema = z.object({
  schema_version: z.literal(1),
  dataset_id: z.literal('production-cancellation-baseline-v2'),
  cases: z.array(ProductionCancellationCaseSchema).length(1),
})

export type ProductionCancellationObservation = z.infer<
  typeof ProductionCancellationObservationSchema
>
