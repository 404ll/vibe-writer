import {
  buildMemoryExtractorPrompt,
  type MemoryExtractionOutput,
} from '@vibe-writer/memory-core'
import type { TextModel, TextModelRequest } from '@vibe-writer/model-runtime'
import type { MemoryCalibrationAuthorizationRow } from '@vibe-writer/db'
import { describe, expect, it, vi } from 'vitest'
import {
  preflightMemoryCalibrationExecution,
  memoryCalibrationBindingSnapshot,
  quoteTrackedMemoryCalibrationCost,
  runMemoryCalibrationExecution,
  type MemoryCalibrationExecutionManifest,
} from '../src/memory-calibration-execution'
import {
  MemoryCalibrationAuthorizationService,
  memoryCalibrationBaseExecution,
} from '../src/memory-calibration-authorization'
import { MemoryCalibrationQueueExecutor } from '../src/memory-calibration-queue-executor'
import { memoryExtractionEvalCases } from '../src/memory-extraction-suite'
import { memoryExtractionQualityCases } from '../src/memory-extraction-dataset'
import { referenceMemoryExtractionOutput } from '../src/memory-extraction-reference-target'

const pricing = {
  version: 'anthropic-calibration-test-pricing-v1',
  inputMicrousdPerMillionTokens: 1_000,
  outputMicrousdPerMillionTokens: 2_000,
  cacheReadMicrousdPerMillionTokens: 100,
  cacheWriteMicrousdPerMillionTokens: 1_250,
}

function unapprovedManifest(): MemoryCalibrationExecutionManifest {
  const quote = quoteTrackedMemoryCalibrationCost({ maxOutputTokens: 256, pricing })
  return {
    schemaVersion: 1,
    planKey: quote.planKey,
    datasetFingerprint: quote.datasetFingerprint,
    target: {
      provider: 'anthropic',
      model: 'claude-calibration-test',
      modelProfile: 'anthropic-memory-calibration-test-v1',
      promptVersion: '2026-08-07-v1',
      extractorVersion: 'v1',
      codeRevision: 'memory-calibration-test-revision',
    },
    generation: { maxOutputTokens: quote.maxOutputTokens },
    pricing,
    budget: {
      maxCalls: quote.callCount,
      maxCostMicrousd: quote.maximumCostMicrousd,
    },
    authorization: {
      status: 'not_authorized',
      approvalId: null,
      approvedBy: null,
      approvedAt: null,
      bindingFingerprint: null,
    },
  }
}

function approvedManifest(): MemoryCalibrationExecutionManifest {
  const manifest = unapprovedManifest()
  const bindingFingerprint = preflightMemoryCalibrationExecution(manifest).bindingFingerprint
  return {
    ...manifest,
    authorization: {
      status: 'approved',
      approvalId: 'approval-test-1',
      approvedBy: 'test-owner',
      approvedAt: '2026-08-09T00:00:00Z',
      bindingFingerprint,
    },
  }
}

function referenceModel(
  overrides: Partial<Awaited<ReturnType<TextModel['generate']>>> = {},
) {
  const outputs = new Map<string, MemoryExtractionOutput>()
  for (const qualityCase of memoryExtractionQualityCases()) {
    const prompt = buildMemoryExtractorPrompt(qualityCase.input)
    outputs.set(prompt.user, referenceMemoryExtractionOutput(qualityCase.key))
  }
  let sequence = 0
  const generate = vi.fn(async (request: TextModelRequest) => {
    const output = outputs.get(request.user)
    if (!output) throw new Error('Unknown calibration input')
    sequence += 1
    return {
      text: JSON.stringify(output),
      provider: 'anthropic',
      model: 'claude-calibration-test',
      finishReason: 'stop' as const,
      usage: { inputTokens: 10, outputTokens: 5 },
      requestId: `request-${sequence}`,
      responseId: `message-${sequence}`,
      ...overrides,
    }
  })
  return { model: { generate }, generate }
}

describe('Memory calibration execution', () => {
  it('quotes the exact tracked call inventory and a conservative micro-USD ceiling', () => {
    expect(quoteTrackedMemoryCalibrationCost({ maxOutputTokens: 256, pricing })).toMatchObject({
      planKey: 'memory-extraction-live-calibration',
      callCount: 72,
      trialsPerCase: 3,
      maxOutputTokens: 256,
      pricing: { version: pricing.version },
      currency: 'USD',
    })
    expect(quoteTrackedMemoryCalibrationCost({
      maxOutputTokens: 256,
      pricing,
    }).maximumCostMicrousd).toBeGreaterThan(0)
  })

  it('preflights a bound execution but keeps it non-executable without approval', () => {
    expect(preflightMemoryCalibrationExecution(unapprovedManifest())).toMatchObject({
      status: 'ready_for_authorization',
      executable: false,
      productionEligible: false,
      automaticUncertainResolutionEligible: false,
      callCount: 72,
      pricingVersion: pricing.version,
      remainingProductionBlockers: [
        'live_trials_missing',
        'request_level_terminal_lookup_unavailable',
      ],
    })
  })

  it('rejects cost, dataset, and immutable approval drift', () => {
    const manifest = unapprovedManifest()
    expect(() => preflightMemoryCalibrationExecution({
      ...manifest,
      budget: { ...manifest.budget, maxCostMicrousd: manifest.budget.maxCostMicrousd + 1 },
    })).toThrow('cost cap must equal')
    expect(() => preflightMemoryCalibrationExecution({
      ...manifest,
      datasetFingerprint: `sha256:${'f'.repeat(64)}`,
    })).toThrow('dataset does not match')
    const approved = approvedManifest()
    expect(() => preflightMemoryCalibrationExecution({
      ...approved,
      target: { ...approved.target, model: 'changed-after-approval' },
    })).toThrow('approval does not match')
  })

  it('refuses execution before touching the model when approval is absent', async () => {
    const { model, generate } = referenceModel()
    await expect(runMemoryCalibrationExecution({
      execution: unapprovedManifest(),
      model,
    })).rejects.toThrow('requires explicit bound approval')
    expect(generate).not.toHaveBeenCalled()
  })

  it('runs 24 cases times 3 trials through a provider-neutral model without output capture', async () => {
    const { model, generate } = referenceModel()
    const result = await runMemoryCalibrationExecution({
      execution: approvedManifest(),
      model,
    })
    expect(generate).toHaveBeenCalledTimes(72)
    expect(result.report).toMatchObject({
      status: 'completed',
      trialsPerCase: 3,
      target: {
        key: 'memory-extraction-live-calibration',
        execution: { toolVersions: { approval: 'approval-test-1' } },
      },
    })
    expect(result.report.trials).toHaveLength(72)
    expect(result.report.trials.every((trial) => trial.output === undefined)).toBe(true)
    expect(result.report.trials.every((trial) => trial.scores[0]?.modelMetering?.providerRequestId)).toBe(true)
    expect(result.report.trials.every((trial) => trial.scores[0]?.modelMetering?.providerResponseId)).toBe(true)
    expect(result.quality).toMatchObject({
      caseCount: 72,
      shouldWritePrecision: 1,
      shouldWriteRecall: 1,
      shouldWriteAccuracy: 1,
      slotExactRate: 1,
      taskLeakCount: 0,
      assistantLeakCount: 0,
      sensitiveLeakCount: 0,
    })
    expect(result).toMatchObject({
      gate: { passed: true, failures: [] },
      budget: { calls: 72, uncertain: false },
      decision: {
        calibrationStatus: 'quality_gate_passed',
        productionEligible: false,
        automaticUncertainResolutionEligible: false,
      },
    })
  })

  it('registers an unapproved binding and executes only the matching durable queued approval', async () => {
    const unapproved = unapprovedManifest()
    const preflight = preflightMemoryCalibrationExecution(unapproved)
    const registered = {
      id: 'authorization-test-1',
      workspaceId: 'workspace-test-1',
      suiteId: 'suite-test-1',
      evalRunId: 'run-test-1',
      idempotencyKey: 'calibration-test-1',
      status: 'enqueued',
      bindingSnapshot: memoryCalibrationBindingSnapshot(unapproved),
      bindingFingerprint: preflight.bindingFingerprint,
      baseExecutionSnapshot: memoryCalibrationBaseExecution(
        unapproved,
        preflight.bindingFingerprint,
      ),
      targetKey: 'memory-extraction-live-calibration',
      targetVersion: 'v1',
      trialsPerCase: 3,
      createdByPrincipalId: 'principal-test-1',
      approvalId: 'approval-test-1',
      approvedByPrincipalId: 'principal-test-1',
      approvalReasonCode: 'operator-reviewed-cost-v1',
      approvedAt: new Date('2026-08-09T00:00:00Z'),
      nextEventSeq: 4,
      createdAt: new Date('2026-08-09T00:00:00Z'),
      updatedAt: new Date('2026-08-09T00:00:00Z'),
    } satisfies MemoryCalibrationAuthorizationRow
    const register = vi.fn(async () => ({
      authorization: { ...registered, status: 'draft' as const, evalRunId: null },
      created: true,
    }))
    const service = new MemoryCalibrationAuthorizationService({
      register,
      approve: vi.fn(),
      enqueue: vi.fn(),
    } as never)
    await service.register({
      workspaceId: registered.workspaceId,
      principalId: registered.createdByPrincipalId,
      role: 'owner',
      authorization: 'verified-membership',
    }, {
      idempotencyKey: registered.idempotencyKey,
      execution: unapproved,
    })
    expect(register).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      binding: registered.bindingSnapshot,
      trialsPerCase: 3,
      targetKey: 'memory-extraction-live-calibration',
    }))

    const { model, generate } = referenceModel()
    const executor = new MemoryCalibrationQueueExecutor({
      getEnqueuedByRunId: vi.fn(async () => registered),
    }, model)
    const executionSnapshot = {
      ...registered.baseExecutionSnapshot,
      toolVersions: {
        ...registered.baseExecutionSnapshot.toolVersions,
        approval: registered.approvalId!,
      },
    }
    const report = await executor.execute({
      run: {
        id: registered.evalRunId,
        targetKey: registered.targetKey,
        targetVersion: registered.targetVersion,
        datasetFingerprint: registered.bindingSnapshot.datasetFingerprint,
        executionSnapshot,
      },
      suite: {
        id: registered.suiteId,
        workspaceId: registered.workspaceId,
        suiteKey: 'memory-extraction-live-calibration',
        version: '2026-08-07-v1',
        datasetFingerprint: registered.bindingSnapshot.datasetFingerprint,
      },
      cases: memoryExtractionEvalCases(),
    } as never, new AbortController().signal)
    expect(report).toMatchObject({
      status: 'completed',
      trialsPerCase: 3,
      target: { execution: executionSnapshot },
    })
    expect(generate).toHaveBeenCalledTimes(72)
  })

  it('halts after the first metered response with incomplete provider identity', async () => {
    const { model, generate } = referenceModel({ requestId: undefined })
    const result = await runMemoryCalibrationExecution({
      execution: approvedManifest(),
      model,
    })
    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.report.status).toBe('failed')
    expect(result.report.trials[0]?.scores[0]).toMatchObject({
      status: 'error',
      metadata: { failureReason: 'provider_identity_incomplete' },
      modelMetering: { providerResponseId: 'message-1' },
    })
    expect(result.quality).toBeNull()
    expect(result.gate).toEqual({ passed: false, failures: ['calibration_report_incomplete'] })
  })

  it('scores invalid model JSON as a quality No-Go while preserving the full metered trial inventory', async () => {
    const { model, generate } = referenceModel({ text: 'not-json' })
    const result = await runMemoryCalibrationExecution({
      execution: approvedManifest(),
      model,
    })
    expect(generate).toHaveBeenCalledTimes(72)
    expect(result.report.status).toBe('completed')
    expect(result.quality).toMatchObject({ caseCount: 72, invalidOutputCount: 72 })
    expect(result.gate.passed).toBe(false)
    expect(result.gate.failures).toContain('invalid_output_above_gate')
    expect(result.decision.calibrationStatus).toBe('no_go')
  })

  it('makes an unmetered provider failure uncertain and prevents every later provider call', async () => {
    const generate = vi.fn(async () => {
      throw new Error('transport failed after request dispatch')
    })
    const result = await runMemoryCalibrationExecution({
      execution: approvedManifest(),
      model: { generate },
    })
    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.report.status).toBe('failed')
    expect(result.budget).toMatchObject({ calls: 1, uncertain: true })
    expect(result.quality).toBeNull()
    expect(result.decision).toMatchObject({
      calibrationStatus: 'no_go',
      productionEligible: false,
    })
  })
})
