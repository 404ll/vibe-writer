import type { EvalModelPricingSnapshot } from '@vibe-writer/eval-core'
import type { ModelUsage } from '@vibe-writer/model-runtime'

export type ModelPricingSnapshot = EvalModelPricingSnapshot

export type EvalModelBudgetLimits = {
  maxCalls: number
  maxCostMicrousd: number
}

type Reservation = {
  id: number
  maximumCostMicrousd: number
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value
}

function tokenCost(tokens: number, rate: number): number {
  return Math.ceil((tokens * rate) / 1_000_000)
}

export function maximumModelCallCostMicrousd(input: {
  inputUtf8Bytes: number
  maxOutputTokens: number
  pricing: ModelPricingSnapshot
}): number {
  nonnegativeInteger(input.inputUtf8Bytes, 'inputUtf8Bytes')
  nonnegativeInteger(input.maxOutputTokens, 'maxOutputTokens')
  const conservativeInputRate = Math.max(
    input.pricing.inputMicrousdPerMillionTokens,
    input.pricing.cacheReadMicrousdPerMillionTokens,
    input.pricing.cacheWriteMicrousdPerMillionTokens,
  )
  return tokenCost(input.inputUtf8Bytes, conservativeInputRate) +
    tokenCost(input.maxOutputTokens, input.pricing.outputMicrousdPerMillionTokens)
}

export function usageCostMicrousd(
  usage: ModelUsage,
  pricing: ModelPricingSnapshot,
): number {
  return tokenCost(usage.inputTokens, pricing.inputMicrousdPerMillionTokens) +
    tokenCost(usage.outputTokens, pricing.outputMicrousdPerMillionTokens) +
    tokenCost(usage.cacheReadInputTokens ?? 0, pricing.cacheReadMicrousdPerMillionTokens) +
    tokenCost(usage.cacheWriteInputTokens ?? 0, pricing.cacheWriteMicrousdPerMillionTokens)
}

export class EvalModelBudget {
  private calls = 0
  private costMicrousd = 0
  private reservedMicrousd = 0
  private sequence = 0
  private uncertain = false

  constructor(
    readonly limits: EvalModelBudgetLimits,
    readonly pricing: ModelPricingSnapshot,
  ) {
    nonnegativeInteger(limits.maxCalls, 'maxCalls')
    nonnegativeInteger(limits.maxCostMicrousd, 'maxCostMicrousd')
    for (const [name, value] of Object.entries(pricing)) {
      if (name === 'version') {
        if (!String(value).trim()) throw new Error('pricing.version is required')
      } else {
        nonnegativeInteger(value as number, `pricing.${name}`)
      }
    }
  }

  reserve(inputUtf8Bytes: number, maxOutputTokens: number): Reservation {
    nonnegativeInteger(inputUtf8Bytes, 'inputUtf8Bytes')
    nonnegativeInteger(maxOutputTokens, 'maxOutputTokens')
    if (this.uncertain) throw new Error('Eval model budget is uncertain after an unmetered call')
    if (this.calls >= this.limits.maxCalls) throw new Error('Eval model call budget exceeded')
    const maximumCostMicrousd = maximumModelCallCostMicrousd({
      inputUtf8Bytes,
      maxOutputTokens,
      pricing: this.pricing,
    })
    if (
      this.costMicrousd + this.reservedMicrousd + maximumCostMicrousd >
      this.limits.maxCostMicrousd
    ) {
      throw new Error('Eval model cost budget exceeded before provider call')
    }
    this.calls += 1
    this.reservedMicrousd += maximumCostMicrousd
    return { id: ++this.sequence, maximumCostMicrousd }
  }

  settle(reservation: Reservation, usage: ModelUsage) {
    const actualCostMicrousd = usageCostMicrousd(usage, this.pricing)
    this.reservedMicrousd -= reservation.maximumCostMicrousd
    this.costMicrousd += actualCostMicrousd
    if (
      actualCostMicrousd > reservation.maximumCostMicrousd ||
      this.costMicrousd > this.limits.maxCostMicrousd
    ) {
      this.uncertain = true
      throw new Error('Provider usage exceeded the reserved Eval model budget')
    }
    return actualCostMicrousd
  }

  markUnmetered(reservation: Reservation) {
    this.reservedMicrousd -= reservation.maximumCostMicrousd
    this.uncertain = true
  }

  snapshot() {
    return {
      calls: this.calls,
      costMicrousd: this.costMicrousd,
      maxCalls: this.limits.maxCalls,
      maxCostMicrousd: this.limits.maxCostMicrousd,
      pricingVersion: this.pricing.version,
      uncertain: this.uncertain,
    }
  }
}
