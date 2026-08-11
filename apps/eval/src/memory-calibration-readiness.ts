import { readFileSync } from 'node:fs'
import { MEMORY_EXTRACTOR_PROMPT } from '@vibe-writer/memory-core'
import {
  parseMemoryExtractionBaseline,
  type MemoryExtractionBaseline,
} from './memory-extraction-suite.ts'

const MACHINE_CODE = /^[a-z0-9][a-z0-9_.:-]*$/
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/

type JsonRecord = Record<string, unknown>

export type MemoryCalibrationPlan = {
  schemaVersion: 1
  key: string
  status: 'planned'
  dataset: {
    suiteKey: string
    suiteVersion: string
    fingerprint: string
    caseCount: number
  }
  target: {
    provider: string
    transport: 'messages_sync'
    model: null
    modelProfile: null
    promptVersion: string
    extractorVersion: string
    pricingVersion: null
  }
  runPolicy: {
    trialsPerCase: number
    maxCalls: number
    maxCostMicrousd: null
    captureOutput: false
    requireUsage: true
    requireHttpRequestId: true
    requireResponseObjectId: true
  }
  providerCapabilityAudit: {
    checkedAt: string
    syncMessageTerminalLookup: 'not_documented'
    adminUsageGranularity: 'aggregate_only'
    batchResultLookup: 'batch_only'
    automaticUncertainResolutionEligible: false
    sources: string[]
  }
  qualityGates: MemoryExtractionBaseline['qualityGates']
  decision: { productionEligible: false; blockers: string[] }
}

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

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new Error(`${name} must be a bounded non-empty string`)
  }
  return value
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value as number
}

function machineCodes(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be non-empty`)
  const codes = value.map((item) => text(item, name))
  if (codes.some((item) => !MACHINE_CODE.test(item)) || new Set(codes).size !== codes.length) {
    throw new Error(`${name} must contain unique machine-readable codes`)
  }
  return codes
}

function qualityGates(value: unknown): MemoryExtractionBaseline['qualityGates'] {
  return parseMemoryExtractionBaseline({
    schemaVersion: 1,
    evalBaseline: {
      schemaVersion: 1,
      suite: { key: 'placeholder', version: 'placeholder', datasetFingerprint: `sha256:${'0'.repeat(64)}` },
      target: { key: 'placeholder', version: 'placeholder' },
      trialsPerCase: 1,
      expectedCaseKeys: ['placeholder'],
      maximumTargetErrors: 0,
      maximumEvaluatorErrors: 0,
      metrics: { placeholder: { scoreCount: 1, maximumErrorCount: 0, minimumPassRate: 1 } },
    },
    qualityGates: value,
  }).qualityGates
}

export function parseMemoryCalibrationPlan(value: unknown): MemoryCalibrationPlan {
  const root = record(value, 'Memory calibration plan')
  exactKeys(root, [
    'schemaVersion', 'key', 'status', 'dataset', 'target', 'runPolicy',
    'providerCapabilityAudit', 'qualityGates', 'decision',
  ], 'Memory calibration plan')
  if (root.schemaVersion !== 1 || root.status !== 'planned') {
    throw new Error('Memory calibration plan version or status is unsupported')
  }
  const dataset = record(root.dataset, 'dataset')
  exactKeys(dataset, ['suiteKey', 'suiteVersion', 'fingerprint', 'caseCount'], 'dataset')
  const target = record(root.target, 'target')
  exactKeys(target, [
    'provider', 'transport', 'model', 'modelProfile', 'promptVersion',
    'extractorVersion', 'pricingVersion',
  ], 'target')
  const runPolicy = record(root.runPolicy, 'runPolicy')
  exactKeys(runPolicy, [
    'trialsPerCase', 'maxCalls', 'maxCostMicrousd', 'captureOutput', 'requireUsage',
    'requireHttpRequestId', 'requireResponseObjectId',
  ], 'runPolicy')
  const audit = record(root.providerCapabilityAudit, 'providerCapabilityAudit')
  exactKeys(audit, [
    'checkedAt', 'syncMessageTerminalLookup', 'adminUsageGranularity',
    'batchResultLookup', 'automaticUncertainResolutionEligible', 'sources',
  ], 'providerCapabilityAudit')
  const decision = record(root.decision, 'decision')
  exactKeys(decision, ['productionEligible', 'blockers'], 'decision')
  const fingerprint = text(dataset.fingerprint, 'dataset.fingerprint')
  if (!FINGERPRINT.test(fingerprint)) throw new Error('dataset.fingerprint is invalid')
  const sources = Array.isArray(audit.sources)
    ? audit.sources.map((source) => text(source, 'providerCapabilityAudit.sources'))
    : []
  if (
    sources.length < 3 || new Set(sources).size !== sources.length ||
    sources.some((source) => !source.startsWith('https://platform.claude.com/docs/'))
  ) {
    throw new Error('provider capability audit requires unique official sources')
  }
  if (
    target.transport !== 'messages_sync' || target.model !== null ||
    target.modelProfile !== null || target.pricingVersion !== null ||
    runPolicy.maxCostMicrousd !== null || runPolicy.captureOutput !== false ||
    runPolicy.requireUsage !== true || runPolicy.requireHttpRequestId !== true ||
    runPolicy.requireResponseObjectId !== true ||
    audit.syncMessageTerminalLookup !== 'not_documented' ||
    audit.adminUsageGranularity !== 'aggregate_only' ||
    audit.batchResultLookup !== 'batch_only' ||
    audit.automaticUncertainResolutionEligible !== false ||
    decision.productionEligible !== false
  ) {
    throw new Error('Uncalibrated Memory target must remain fail closed')
  }
  const blockers = machineCodes(decision.blockers, 'decision.blockers')
  for (const required of [
    'model_unselected',
    'pricing_snapshot_unbound',
    'live_trials_missing',
    'request_level_terminal_lookup_unavailable',
  ]) {
    if (!blockers.includes(required)) throw new Error(`Memory calibration blocker is missing: ${required}`)
  }
  const trialsPerCase = positiveInteger(runPolicy.trialsPerCase, 'runPolicy.trialsPerCase')
  const caseCount = positiveInteger(dataset.caseCount, 'dataset.caseCount')
  const maxCalls = positiveInteger(runPolicy.maxCalls, 'runPolicy.maxCalls')
  if (trialsPerCase < 3 || maxCalls !== trialsPerCase * caseCount) {
    throw new Error('Memory calibration call budget must cover the exact trial inventory')
  }
  const checkedAt = text(audit.checkedAt, 'providerCapabilityAudit.checkedAt')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedAt)) throw new Error('Provider audit date is invalid')
  return {
    schemaVersion: 1,
    key: text(root.key, 'key'),
    status: 'planned',
    dataset: {
      suiteKey: text(dataset.suiteKey, 'dataset.suiteKey'),
      suiteVersion: text(dataset.suiteVersion, 'dataset.suiteVersion'),
      fingerprint,
      caseCount,
    },
    target: {
      provider: text(target.provider, 'target.provider'),
      transport: 'messages_sync',
      model: null,
      modelProfile: null,
      promptVersion: text(target.promptVersion, 'target.promptVersion'),
      extractorVersion: text(target.extractorVersion, 'target.extractorVersion'),
      pricingVersion: null,
    },
    runPolicy: {
      trialsPerCase,
      maxCalls,
      maxCostMicrousd: null,
      captureOutput: false,
      requireUsage: true,
      requireHttpRequestId: true,
      requireResponseObjectId: true,
    },
    providerCapabilityAudit: {
      checkedAt,
      syncMessageTerminalLookup: 'not_documented',
      adminUsageGranularity: 'aggregate_only',
      batchResultLookup: 'batch_only',
      automaticUncertainResolutionEligible: false,
      sources,
    },
    qualityGates: qualityGates(root.qualityGates),
    decision: { productionEligible: false, blockers },
  }
}

export function evaluateMemoryCalibrationReadiness(input: {
  plan: unknown
  baseline: unknown
}) {
  const plan = parseMemoryCalibrationPlan(input.plan)
  const baseline = parseMemoryExtractionBaseline(input.baseline)
  const suite = baseline.evalBaseline.suite
  if (
    plan.dataset.suiteKey !== suite.key ||
    plan.dataset.suiteVersion !== suite.version ||
    plan.dataset.fingerprint !== suite.datasetFingerprint ||
    plan.dataset.caseCount !== baseline.evalBaseline.expectedCaseKeys.length
  ) {
    throw new Error('Memory calibration dataset does not match the tracked baseline')
  }
  if (plan.target.promptVersion !== MEMORY_EXTRACTOR_PROMPT.version) {
    throw new Error('Memory calibration prompt version is stale')
  }
  if (JSON.stringify(plan.qualityGates) !== JSON.stringify(baseline.qualityGates)) {
    throw new Error('Memory calibration quality gates drifted from the tracked baseline')
  }
  return {
    status: 'no_go' as const,
    productionEligible: false as const,
    automaticUncertainResolutionEligible: false as const,
    dataset: plan.dataset,
    target: plan.target,
    runPolicy: plan.runPolicy,
    qualityGates: plan.qualityGates,
    blockers: plan.decision.blockers,
    providerCapabilityAudit: plan.providerCapabilityAudit,
  }
}

export function readTrackedMemoryCalibrationReadiness() {
  const plan = JSON.parse(readFileSync(
    new URL('../manifests/memory-calibration-v1.json', import.meta.url),
    'utf8',
  ))
  const baseline = JSON.parse(readFileSync(
    new URL('../baselines/memory-extraction-quality-v1.json', import.meta.url),
    'utf8',
  ))
  return evaluateMemoryCalibrationReadiness({ plan, baseline })
}
