import { z } from 'zod'

export const ProductionFailureObservationSchema = z.object({
  jobStatus: z.literal('failed'),
  jobErrorCode: z.literal('workflow_service_exception'),
  runStatuses: z.array(z.literal('failed')).length(1),
  runErrorCodes: z.array(z.literal('workflow_service_exception')).length(1),
  articleCount: z.literal(0),
  eventTypes: z.array(z.literal('error')).length(1),
  outboxStatuses: z.array(z.literal('published')).length(1),
  effectStatuses: z.array(z.literal('failed')).length(2),
  effectErrorCodes: z.array(z.literal('provider_unavailable')).length(2),
  traceStatuses: z.array(z.literal('failed')).length(2),
  traceErrorCodes: z.array(z.literal('provider_unavailable')).length(2),
  providerRequestCount: z.literal(2),
})

const ProductionFailureCaseSchema = z.object({
  id: z.string().min(1),
  topic: z.string().trim().min(1),
  target_words: z.number().int().positive(),
  provider_status: z.literal(503),
  expected: ProductionFailureObservationSchema,
})

export const ProductionFailureFixtureSchema = z.object({
  schema_version: z.literal(1),
  dataset_id: z.literal('production-failure-baseline-v1'),
  cases: z.array(ProductionFailureCaseSchema).length(1),
})

export type ProductionFailureObservation = z.infer<
  typeof ProductionFailureObservationSchema
>
