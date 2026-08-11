import { runOfflineEval } from '@vibe-writer/eval-core'
import type { TextModel, TextModelResponse } from '@vibe-writer/model-runtime'
import { describe, expect, it, vi } from 'vitest'
import {
  EvalModelBudget,
  maximumModelCallCostMicrousd,
  usageCostMicrousd,
} from '../src/budget'
import { createModelRubricEvaluator } from '../src/model-grader'
import { ARTICLE_QUALITY_RUBRIC } from '../src/rubric'

const pricing = {
  version: 'anthropic-test-pricing-v1',
  inputMicrousdPerMillionTokens: 3_000_000,
  outputMicrousdPerMillionTokens: 15_000_000,
  cacheReadMicrousdPerMillionTokens: 300_000,
  cacheWriteMicrousdPerMillionTokens: 3_750_000,
}

const profile = {
  key: 'anthropic-article-quality',
  version: 'v1',
  modelProfile: 'anthropic-grader-test',
  promptVersion: 'article-quality-grader-v1',
  maxOutputTokens: 512,
}

function response(overrides: Partial<TextModelResponse> = {}): TextModelResponse {
  return {
    text: JSON.stringify({
      criteria: ARTICLE_QUALITY_RUBRIC.criteria.map((criterion) => ({
        key: criterion.key,
        score: 80,
        reasonCode: 'meets_expectations',
      })),
    }),
    provider: 'anthropic',
    model: 'claude-test',
    finishReason: 'stop',
    requestId: 'request-1',
    responseId: 'response-1',
    usage: { inputTokens: 100, outputTokens: 50 },
    ...overrides,
  }
}

function evaluator(model: TextModel, budget: EvalModelBudget) {
  return createModelRubricEvaluator<{ markdown: string }, string>({
    model,
    budget,
    rubric: ARTICLE_QUALITY_RUBRIC,
    profile,
    renderSubject: ({ output }) => output,
  })
}

describe('versioned model rubric grader', () => {
  it('exposes the same conservative call reservation used by the hard budget', () => {
    const maximum = maximumModelCallCostMicrousd({
      inputUtf8Bytes: 100,
      maxOutputTokens: 50,
      pricing,
    })
    const budget = new EvalModelBudget({ maxCalls: 1, maxCostMicrousd: maximum }, pricing)
    expect(budget.reserve(100, 50)).toMatchObject({ maximumCostMicrousd: maximum })
  })

  it('computes scores itself and records structured metering plus budget metadata', async () => {
    const generate = vi.fn(async (_request: Parameters<TextModel['generate']>[0]) => response())
    const budget = new EvalModelBudget({ maxCalls: 2, maxCostMicrousd: 50_000 }, pricing)
    const report = await runOfflineEval(
      [{ key: 'article-a', input: { markdown: '# Article' } }],
      { key: 'identity', version: 'v1', execute: async (input) => input.markdown },
      [evaluator({ generate }, budget)],
      {
        suite: { key: 'live-articles', version: 'v1' },
        execution: {
          modelProfile: profile.modelProfile,
          promptVersion: profile.promptVersion,
          graphVersion: 'live-article-eval-v1',
          toolVersions: {
            rubric: ARTICLE_QUALITY_RUBRIC.version,
            pricing: pricing.version,
          },
          codeRevision: 'test',
        },
        trialsPerCase: 2,
      },
    )

    expect(generate).toHaveBeenCalledTimes(2)
    expect(report.status).toBe('completed')
    expect(report.trials).toHaveLength(2)
    expect(report.trials.every((trial) => trial.scores[0]?.passed === true)).toBe(true)
    expect(report.trials[0]?.scores[0]).toMatchObject({
      value: 80,
      modelMetering: {
        provider: 'anthropic',
        model: 'claude-test',
        providerRequestId: 'request-1',
        providerResponseId: 'response-1',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        costCurrency: 'USD',
        costMicrousd: 1_050,
        pricingVersion: pricing.version,
      },
      metadata: {
        budget: {
          calls: 1,
          costMicrousd: 1_050,
          maxCalls: 2,
          maxCostMicrousd: 50_000,
          uncertain: false,
        },
      },
    })
    expect(budget.snapshot()).toMatchObject({ calls: 2, costMicrousd: 2_100 })
    const request = generate.mock.calls[0]?.[0]
    expect(request?.metadata).toEqual({
      graderProfile: profile.modelProfile,
      graderVersion: profile.version,
      rubricVersion: ARTICLE_QUALITY_RUBRIC.version,
    })
    expect(request?.user).toContain('focus_and_intent')
  })

  it('rejects a call before the provider when the conservative hard budget is insufficient', async () => {
    const generate = vi.fn(async (_request: Parameters<TextModel['generate']>[0]) => response())
    const budget = new EvalModelBudget({ maxCalls: 1, maxCostMicrousd: 1 }, pricing)
    const report = await runOfflineEval(
      [{ key: 'article-a', input: { markdown: '# Article' } }],
      { key: 'identity', version: 'v1', execute: async (input) => input.markdown },
      [evaluator({ generate }, budget)],
      {
        suite: { key: 'live-articles', version: 'v1' },
        execution: {
          modelProfile: profile.modelProfile,
          promptVersion: profile.promptVersion,
          graphVersion: 'live-article-eval-v1',
          toolVersions: { rubric: ARTICLE_QUALITY_RUBRIC.version },
          codeRevision: 'test',
        },
      },
    )
    expect(generate).not.toHaveBeenCalled()
    expect(report.status).toBe('failed')
    expect(report.trials[0]?.scores[0]).toMatchObject({
      status: 'error',
      metadata: { failureReason: 'budget_rejected' },
    })
  })

  it('fails closed on criterion drift without persisting grader prose', async () => {
    const generate = vi.fn(async (_request: Parameters<TextModel['generate']>[0]) => response({
      text: JSON.stringify({
        criteria: [{ key: 'unknown', score: 100, reasonCode: 'looks_good' }],
        explanation: 'Do not persist this prose.',
      }),
    }))
    const budget = new EvalModelBudget({ maxCalls: 1, maxCostMicrousd: 50_000 }, pricing)
    const report = await runOfflineEval(
      [{ key: 'article-a', input: { markdown: '# Article' } }],
      { key: 'identity', version: 'v1', execute: async (input) => input.markdown },
      [evaluator({ generate }, budget)],
      {
        suite: { key: 'live-articles', version: 'v1' },
        execution: {
          modelProfile: profile.modelProfile,
          promptVersion: profile.promptVersion,
          graphVersion: 'live-article-eval-v1',
          toolVersions: { rubric: ARTICLE_QUALITY_RUBRIC.version },
          codeRevision: 'test',
        },
      },
    )
    expect(report.status).toBe('failed')
    expect(report.trials[0]?.scores[0]).toMatchObject({
      status: 'error',
      modelMetering: {
        provider: 'anthropic',
        costMicrousd: 1_050,
        pricingVersion: pricing.version,
      },
      metadata: { failureReason: 'response_invalid' },
    })
    expect(JSON.stringify(report)).not.toContain('Do not persist this prose')
  })

  it('prices cache token classes explicitly', () => {
    expect(usageCostMicrousd({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: 10,
    }, pricing)).toBe(1_094)
  })
})
