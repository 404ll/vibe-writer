import { z } from 'zod'

const DATABASE_INTEGER_MAX = 2_147_483_647
const NonnegativeSafeIntegerSchema = z.number().int().min(0).max(DATABASE_INTEGER_MAX)
const PositiveSafeIntegerSchema = z.number().int().min(1).max(DATABASE_INTEGER_MAX)

export const MemoryModelPricingSchema = z.object({
  version: z.string().trim().min(1).max(256),
  inputMicrousdPerMillionTokens: NonnegativeSafeIntegerSchema,
  outputMicrousdPerMillionTokens: NonnegativeSafeIntegerSchema,
  cacheReadMicrousdPerMillionTokens: NonnegativeSafeIntegerSchema,
  cacheWriteMicrousdPerMillionTokens: NonnegativeSafeIntegerSchema,
}).strict()

export const MemoryExtractionBudgetPolicySchema = z.object({
  policyVersion: z.string().trim().min(1).max(256),
  maxSourceCostMicrousd: PositiveSafeIntegerSchema,
  maxWorkspaceDailyCostMicrousd: PositiveSafeIntegerSchema,
  maxOutputTokens: z.number().int().min(1).max(4_096),
  pricing: MemoryModelPricingSchema,
}).strict().superRefine((policy, context) => {
  if (policy.maxSourceCostMicrousd > policy.maxWorkspaceDailyCostMicrousd) {
    context.addIssue({
      code: 'custom',
      path: ['maxSourceCostMicrousd'],
      message: 'Source budget cannot exceed the workspace daily budget',
    })
  }
})

export const MemoryModelUsageSchema = z.object({
  inputTokens: NonnegativeSafeIntegerSchema,
  outputTokens: NonnegativeSafeIntegerSchema,
  cacheReadInputTokens: NonnegativeSafeIntegerSchema.optional(),
  cacheWriteInputTokens: NonnegativeSafeIntegerSchema.optional(),
}).strict()

export type MemoryModelPricing = z.infer<typeof MemoryModelPricingSchema>
export type MemoryExtractionBudgetPolicy = z.infer<typeof MemoryExtractionBudgetPolicySchema>
export type MemoryModelUsage = z.infer<typeof MemoryModelUsageSchema>

function tokenCost(tokens: number, rate: number): number {
  // Use the constructor instead of bigint literals so consumers whose
  // TypeScript target predates ES2020 can still type-check this package.
  const cost = (BigInt(tokens) * BigInt(rate) + BigInt(999_999)) / BigInt(1_000_000)
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Memory model cost exceeds safe integer range')
  }
  return Number(cost)
}

export function estimateMemoryExtractionMaximumCost(input: {
  inputUtf8Bytes: number
  policy: MemoryExtractionBudgetPolicy
}): number {
  const policy = MemoryExtractionBudgetPolicySchema.parse(input.policy)
  const inputUtf8Bytes = NonnegativeSafeIntegerSchema.parse(input.inputUtf8Bytes)
  // Providers differ on whether cache counters replace or accompany ordinary
  // input tokens. Reserve the sum so the hard gate remains safe for either
  // reporting convention; settlement releases the unused portion.
  const maximumCostMicrousd =
    tokenCost(inputUtf8Bytes, policy.pricing.inputMicrousdPerMillionTokens) +
    tokenCost(inputUtf8Bytes, policy.pricing.cacheReadMicrousdPerMillionTokens) +
    tokenCost(inputUtf8Bytes, policy.pricing.cacheWriteMicrousdPerMillionTokens) +
    tokenCost(policy.maxOutputTokens, policy.pricing.outputMicrousdPerMillionTokens)
  if (!Number.isSafeInteger(maximumCostMicrousd)) {
    throw new Error('Memory extraction reservation exceeds safe integer range')
  }
  return maximumCostMicrousd
}

export function memoryModelUsageCost(input: {
  usage: MemoryModelUsage
  pricing: MemoryModelPricing
}): number {
  const usage = MemoryModelUsageSchema.parse(input.usage)
  const pricing = MemoryModelPricingSchema.parse(input.pricing)
  const costMicrousd = tokenCost(usage.inputTokens, pricing.inputMicrousdPerMillionTokens) +
    tokenCost(usage.outputTokens, pricing.outputMicrousdPerMillionTokens) +
    tokenCost(
      usage.cacheReadInputTokens ?? 0,
      pricing.cacheReadMicrousdPerMillionTokens,
    ) +
    tokenCost(
      usage.cacheWriteInputTokens ?? 0,
      pricing.cacheWriteMicrousdPerMillionTokens,
    )
  if (!Number.isSafeInteger(costMicrousd)) {
    throw new Error('Memory model usage cost exceeds safe integer range')
  }
  return costMicrousd
}
