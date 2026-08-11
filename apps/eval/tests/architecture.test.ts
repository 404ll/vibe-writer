import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const suiteSource = readFileSync(new URL('../src/component-suite.ts', import.meta.url), 'utf8')
const workflowSuiteSource = readFileSync(
  new URL('../src/workflow-shadow-suite.ts', import.meta.url),
  'utf8',
)
const memorySuiteSource = readFileSync(
  new URL('../src/memory-governance-suite.ts', import.meta.url),
  'utf8',
)
const memoryExtractionSuiteSource = readFileSync(
  new URL('../src/memory-extraction-suite.ts', import.meta.url),
  'utf8',
)
const memoryCalibrationReadinessSource = readFileSync(
  new URL('../src/memory-calibration-readiness.ts', import.meta.url),
  'utf8',
)
const memoryCalibrationExecutionSource = readFileSync(
  new URL('../src/memory-calibration-execution.ts', import.meta.url),
  'utf8',
)
const memoryCalibrationManifest = JSON.parse(readFileSync(
  new URL('../manifests/memory-calibration-v1.json', import.meta.url),
  'utf8',
)) as { decision: { productionEligible: boolean }; runPolicy: { maxCostMicrousd: number | null } }
const pythonWorkflowSource = readFileSync(
  new URL('../python/workflow_shadow.py', import.meta.url),
  'utf8',
)
const queueProtocolSource = readFileSync(
  new URL('../src/queue-protocol.ts', import.meta.url),
  'utf8',
)
const queueRuntimeSource = readFileSync(
  new URL('../src/queue-runtime.ts', import.meta.url),
  'utf8',
)
const queueConfigSource = readFileSync(
  new URL('../src/queue-config.ts', import.meta.url),
  'utf8',
)
const liveSamplerConfigSource = readFileSync(
  new URL('../src/live-sampler-config.ts', import.meta.url),
  'utf8',
)
const liveSamplerRuntimeSource = readFileSync(
  new URL('../src/live-sampler-runtime.ts', import.meta.url),
  'utf8',
)
const graderPackage = readFileSync(
  new URL('../../../packages/eval-graders/package.json', import.meta.url),
  'utf8',
)

describe('eval CLI boundaries', () => {
  it('keeps the executable component suite independent from DB, queue, web, and vendors', () => {
    for (const dependency of [
      '@vibe-writer/db',
      'drizzle-orm',
      'bullmq',
      'next',
      'langfuse',
      '@langchain/langgraph',
    ]) {
      expect(suiteSource).not.toContain(dependency)
    }
  })

  it('runs workflow shadow adapters without inherited credentials or product persistence', () => {
    expect(workflowSuiteSource).toContain("PYTHONPATH: join(repositoryRoot, 'apps', 'api')")
    expect(workflowSuiteSource).not.toContain('...process.env')
    expect(pythonWorkflowSource).toContain('export_without_side_effects')
    expect(pythonWorkflowSource).toContain('graph_module.export_node = export_without_side_effects')
    expect(pythonWorkflowSource).not.toContain('AsyncSessionLocal(')
    expect(pythonWorkflowSource).not.toContain('open(output_path')
  })

  it('keeps Eval delivery pointer-only and composes graders only in the Eval process', () => {
    expect(queueProtocolSource).toContain("DEFAULT_EVAL_QUEUE_NAME = 'vibe-writer-eval'")
    expect(queueProtocolSource).toContain("aggregateType: 'eval_run'")
    expect(queueProtocolSource).not.toContain('caseInput')
    expect(queueProtocolSource).not.toContain('expectedOutput')
    expect(queueRuntimeSource).toContain('ComponentEvalQueueExecutor')
    expect(queueRuntimeSource).toContain('LiveArticleGraderExecutor')
    expect(queueRuntimeSource).not.toContain('@vibe-writer/worker')
    expect(queueRuntimeSource).toContain('@vibe-writer/provider-runtime')
    expect(queueProtocolSource).not.toContain('@vibe-writer/provider-runtime')
  })

  it('starts each Eval runtime only with its dedicated self-verifying database role', () => {
    expect(queueConfigSource).toContain("required(env, 'DATABASE_EVAL_DISPATCHER_URL')")
    expect(queueConfigSource).toContain("required(env, 'DATABASE_EVAL_CONSUMER_URL')")
    expect(queueConfigSource).not.toContain("required(env, 'EVAL_DATABASE_URL')")
    expect(queueRuntimeSource).toContain("'dispatcher',")
    expect(queueRuntimeSource).toContain("'consumer',")
    expect(liveSamplerConfigSource).toContain(
      "required(env, 'DATABASE_EVAL_LIVE_SAMPLER_URL')",
    )
    expect(liveSamplerRuntimeSource).toContain("'live-sampler',")
  })

  it('keeps reusable graders provider, queue, and persistence neutral', () => {
    for (const dependency of [
      '@vibe-writer/provider-runtime',
      '@vibe-writer/db',
      'bullmq',
      '@anthropic-ai/sdk',
      'langfuse',
    ]) {
      expect(graderPackage).not.toContain(dependency)
    }
  })

  it('keeps deterministic Memory governance Eval free of persistence and providers', () => {
    expect(memorySuiteSource).toContain('@vibe-writer/memory-core')
    for (const dependency of [
      '@vibe-writer/db',
      'drizzle-orm',
      'bullmq',
      '@vibe-writer/provider-runtime',
      '@langchain/langgraph',
      'next',
    ]) {
      expect(memorySuiteSource).not.toContain(dependency)
    }
  })

  it('keeps Memory extraction calibration provider, persistence, and queue neutral', () => {
    expect(memoryExtractionSuiteSource).toContain('@vibe-writer/memory-core')
    expect(memoryExtractionSuiteSource).toContain('trusted-segments-v1')
    for (const dependency of [
      '@vibe-writer/db',
      'drizzle-orm',
      'bullmq',
      '@vibe-writer/provider-runtime',
      '@langchain/langgraph',
      'next',
    ]) {
      expect(memoryExtractionSuiteSource).not.toContain(dependency)
    }
  })

  it('keeps Memory live calibration readiness offline and fail closed', () => {
    for (const dependency of [
      '@vibe-writer/provider-runtime',
      '@vibe-writer/db',
      'drizzle-orm',
      'bullmq',
      'fetch(',
      'process.env',
    ]) {
      expect(memoryCalibrationReadinessSource).not.toContain(dependency)
    }
    expect(memoryCalibrationManifest.decision.productionEligible).toBe(false)
    expect(memoryCalibrationManifest.runPolicy.maxCostMicrousd).toBeNull()
  })

  it('keeps Memory calibration execution provider-neutral, approval-bound, and output-free', () => {
    for (const dependency of [
      '@vibe-writer/db',
      'drizzle-orm',
      'bullmq',
      '@vibe-writer/provider-runtime',
      '@anthropic-ai/sdk',
      'fetch(',
      'process.env',
    ]) {
      expect(memoryCalibrationExecutionSource).not.toContain(dependency)
    }
    expect(memoryCalibrationExecutionSource).toContain('fingerprintMemoryCalibrationBinding')
    expect(memoryCalibrationExecutionSource).toContain('requires explicit bound approval')
    expect(memoryCalibrationExecutionSource).toContain('captureOutput: false')
    expect(memoryCalibrationExecutionSource).toContain("haltReason = 'provider_identity_incomplete'")
  })
})
