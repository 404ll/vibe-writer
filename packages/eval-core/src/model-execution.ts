import { fingerprintEvalValue } from './runner'

type JsonRecord = Record<string, unknown>

export type EvalModelPricingSnapshot = {
  version: string
  inputMicrousdPerMillionTokens: number
  outputMicrousdPerMillionTokens: number
  cacheReadMicrousdPerMillionTokens: number
  cacheWriteMicrousdPerMillionTokens: number
}

export type EvalModelExecutionBinding = {
  schemaVersion: 1
  planKey: string
  datasetFingerprint: string
  target: {
    provider: string
    model: string
    modelProfile: string
    promptVersion: string
    extractorVersion: string
    codeRevision: string
  }
  generation: { maxOutputTokens: number }
  pricing: EvalModelPricingSnapshot
  budget: { maxCalls: number; maxCostMicrousd: number }
}

const FINGERPRINT = /^sha256:[0-9a-f]{64}$/

function record(value: unknown, name: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as JsonRecord
}

function exactKeys(value: JsonRecord, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has an invalid field inventory`)
  }
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new Error(`${name} must be a bounded non-empty string`)
  }
  return value
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value as number
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = nonnegativeInteger(value, name)
  if (parsed < 1) throw new Error(`${name} must be positive`)
  return parsed
}

export function parseEvalModelPricingSnapshot(value: unknown): EvalModelPricingSnapshot {
  const pricing = record(value, 'pricing')
  exactKeys(pricing, [
    'version',
    'inputMicrousdPerMillionTokens',
    'outputMicrousdPerMillionTokens',
    'cacheReadMicrousdPerMillionTokens',
    'cacheWriteMicrousdPerMillionTokens',
  ], 'pricing')
  return {
    version: identifier(pricing.version, 'pricing.version'),
    inputMicrousdPerMillionTokens: nonnegativeInteger(
      pricing.inputMicrousdPerMillionTokens,
      'pricing.inputMicrousdPerMillionTokens',
    ),
    outputMicrousdPerMillionTokens: nonnegativeInteger(
      pricing.outputMicrousdPerMillionTokens,
      'pricing.outputMicrousdPerMillionTokens',
    ),
    cacheReadMicrousdPerMillionTokens: nonnegativeInteger(
      pricing.cacheReadMicrousdPerMillionTokens,
      'pricing.cacheReadMicrousdPerMillionTokens',
    ),
    cacheWriteMicrousdPerMillionTokens: nonnegativeInteger(
      pricing.cacheWriteMicrousdPerMillionTokens,
      'pricing.cacheWriteMicrousdPerMillionTokens',
    ),
  }
}

export function parseEvalModelExecutionBinding(value: unknown): EvalModelExecutionBinding {
  const root = record(value, 'Eval model execution binding')
  exactKeys(root, [
    'schemaVersion', 'planKey', 'datasetFingerprint', 'target', 'generation',
    'pricing', 'budget',
  ], 'Eval model execution binding')
  if (root.schemaVersion !== 1) throw new Error('Eval model execution binding version is unsupported')
  const datasetFingerprint = identifier(root.datasetFingerprint, 'datasetFingerprint')
  if (!FINGERPRINT.test(datasetFingerprint)) throw new Error('datasetFingerprint is invalid')
  const target = record(root.target, 'target')
  exactKeys(target, [
    'provider', 'model', 'modelProfile', 'promptVersion', 'extractorVersion', 'codeRevision',
  ], 'target')
  const generation = record(root.generation, 'generation')
  exactKeys(generation, ['maxOutputTokens'], 'generation')
  const budget = record(root.budget, 'budget')
  exactKeys(budget, ['maxCalls', 'maxCostMicrousd'], 'budget')
  return {
    schemaVersion: 1,
    planKey: identifier(root.planKey, 'planKey'),
    datasetFingerprint,
    target: {
      provider: identifier(target.provider, 'target.provider'),
      model: identifier(target.model, 'target.model'),
      modelProfile: identifier(target.modelProfile, 'target.modelProfile'),
      promptVersion: identifier(target.promptVersion, 'target.promptVersion'),
      extractorVersion: identifier(target.extractorVersion, 'target.extractorVersion'),
      codeRevision: identifier(target.codeRevision, 'target.codeRevision'),
    },
    generation: {
      maxOutputTokens: positiveInteger(generation.maxOutputTokens, 'generation.maxOutputTokens'),
    },
    pricing: parseEvalModelPricingSnapshot(root.pricing),
    budget: {
      maxCalls: positiveInteger(budget.maxCalls, 'budget.maxCalls'),
      maxCostMicrousd: positiveInteger(budget.maxCostMicrousd, 'budget.maxCostMicrousd'),
    },
  }
}

export function fingerprintEvalModelExecutionBinding(value: unknown): string {
  return fingerprintEvalValue(parseEvalModelExecutionBinding(value))
}
