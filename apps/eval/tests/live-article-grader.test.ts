import { randomUUID } from 'node:crypto'
import { fingerprintEvalDataset } from '@vibe-writer/eval-core'
import { AnthropicModel } from '@vibe-writer/provider-runtime'
import { describe, expect, it, vi } from 'vitest'
import { EvalQueueExecutorRegistry } from '../src/executor-registry.ts'
import {
  LIVE_ARTICLE_GRADER_TARGET,
  LiveArticleGraderExecutor,
  liveArticleGraderExecution,
} from '../src/live-article-grader-executor.ts'
import type { LiveGraderConfig } from '../src/queue-config.ts'
import type { ClaimedEvalContext } from '../src/queue-runner.ts'

const config: LiveGraderConfig = {
  codeRevision: 'grader-test-revision',
  anthropic: {
    apiKey: 'test-key',
    model: 'claude-test',
    timeoutMs: 5_000,
  },
  profile: {
    key: 'anthropic-article-quality',
    version: 'v1',
    modelProfile: 'anthropic-grader-test',
    promptVersion: 'article-quality-grader-v1',
    maxOutputTokens: 512,
  },
  pricing: {
    version: 'anthropic-test-pricing-v1',
    inputMicrousdPerMillionTokens: 3_000_000,
    outputMicrousdPerMillionTokens: 15_000_000,
    cacheReadMicrousdPerMillionTokens: 300_000,
    cacheWriteMicrousdPerMillionTokens: 3_750_000,
  },
  budget: { maxCalls: 2, maxCostMicrousd: 50_000 },
}

const criteria = [
  'focus_and_intent',
  'coherence',
  'substantive_coverage',
  'evidence_discipline',
  'readability',
].map((key) => ({ key, score: 82, reasonCode: 'meets_expectations' }))

function context(): ClaimedEvalContext {
  const candidateId = randomUUID()
  const cases = [{
    key: `article-${candidateId}`,
    input: {
      schemaVersion: 1,
      source: {
        candidateId,
        articleRevision: 0,
        contentFingerprint: `sha256:${'a'.repeat(64)}`,
      },
      article: { markdown: '# Approved article\n\nA clear body.' },
    },
    tags: ['live-eval', 'user-content'],
  }]
  const datasetFingerprint = fingerprintEvalDataset(cases)
  const now = new Date()
  return {
    suite: {
      id: randomUUID(),
      workspaceId: randomUUID(),
      namespaceKey: `workspace:${randomUUID()}`,
      suiteKey: 'approved-live-articles',
      version: 'v1',
      name: 'Approved live articles',
      description: '',
      status: 'active',
      datasetFingerprint,
      createdAt: now,
      updatedAt: now,
    },
    run: {
      id: randomUUID(),
      suiteId: randomUUID(),
      status: 'running',
      mode: 'queued',
      idempotencyKey: 'live-grader-test',
      trigger: 'manual',
      targetKey: LIVE_ARTICLE_GRADER_TARGET.key,
      targetVersion: LIVE_ARTICLE_GRADER_TARGET.version,
      executionSnapshot: liveArticleGraderExecution(config, config.codeRevision),
      datasetFingerprint,
      trialsPerCase: 2,
      attempt: 1,
      leaseOwner: 'eval-worker',
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 30_000),
      heartbeatAt: now,
      errorCode: null,
      errorMessage: null,
      startedAt: now,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    cases,
  }
}

describe('live article queue grader', () => {
  it('uses the Anthropic wire adapter and emits metered multi-trial scores without output capture', async () => {
    const providerFetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      id: 'grader-message-1',
      model: 'claude-test',
      content: [{ type: 'text', text: JSON.stringify({ criteria }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'request-id': 'grader-request-1' },
    }))
    const executor = new LiveArticleGraderExecutor(
      new AnthropicModel({ ...config.anthropic, fetch: providerFetch }),
      config,
      config.codeRevision,
    )

    const report = await executor.execute(context(), new AbortController().signal)
    expect(providerFetch).toHaveBeenCalledTimes(2)
    expect(report.status).toBe('completed')
    expect(report.trials).toHaveLength(2)
    expect(report.trials.every((trial) => trial.output === undefined)).toBe(true)
    expect(report.trials.every((trial) => trial.scores[0]?.passed === true)).toBe(true)
    expect(report.trials[0]?.scores[0]).toMatchObject({
      metric: 'article-quality',
      value: 82,
      modelMetering: {
        provider: 'anthropic',
        providerRequestId: 'grader-request-1',
        providerResponseId: 'grader-message-1',
        inputTokens: 100,
        outputTokens: 50,
        costMicrousd: 1_050,
        pricingVersion: config.pricing.version,
      },
    })
    const request = JSON.parse(String(providerFetch.mock.calls[0]?.[1]?.body)) as {
      system: string
      messages: Array<{ content: string }>
    }
    expect(request.system).toContain('Do not quote or reproduce')
    expect(request.messages[0]?.content).toContain('Approved article')
  })

  it('fails identity drift and disabled registry routes before a provider call', async () => {
    const providerFetch = vi.fn()
    const executor = new LiveArticleGraderExecutor(
      new AnthropicModel({ ...config.anthropic, fetch: providerFetch }),
      config,
      config.codeRevision,
    )
    const drifted = context()
    drifted.run.executionSnapshot = {
      ...drifted.run.executionSnapshot,
      promptVersion: 'unavailable-prompt',
    }
    await expect(executor.execute(drifted, new AbortController().signal))
      .rejects.toThrow('identity is unavailable')
    expect(providerFetch).not.toHaveBeenCalled()

    const registry = new EvalQueueExecutorRegistry({ execute: vi.fn() } as never, null)
    expect(() => registry.execute(context(), new AbortController().signal))
      .toThrow('disabled')
  })
})
