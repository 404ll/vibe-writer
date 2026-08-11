import {
  EvalEvaluatorFailure,
  type EvalEvaluator,
  type EvalJsonValue,
  type EvalModelMetering,
} from '@vibe-writer/eval-core'
import { parseJsonObject, type TextModel } from '@vibe-writer/model-runtime'
import { z } from 'zod'
import { EvalModelBudget, type ModelPricingSnapshot, usageCostMicrousd } from './budget'
import type { VersionedRubric } from './rubric'

const CriterionResultSchema = z.object({
  key: z.string().min(1).max(256),
  score: z.number().int().min(0).max(100),
  reasonCode: z.string().regex(/^[a-z0-9][a-z0-9_.:-]*$/).max(256),
}).strict()

const GraderResponseSchema = z.object({
  criteria: z.array(CriterionResultSchema).min(1).max(20),
}).strict()

export type ModelGraderProfile = {
  key: string
  version: string
  modelProfile: string
  promptVersion: string
  maxOutputTokens: number
}

export type CreateModelRubricEvaluatorOptions<TInput, TOutput, TExpected> = {
  model: TextModel
  rubric: VersionedRubric
  profile: ModelGraderProfile
  budget: EvalModelBudget
  renderSubject(input: {
    caseInput: TInput
    output: TOutput
    expected: TExpected | undefined
  }): string
}

function graderMetadata(input: {
  budget: ReturnType<EvalModelBudget['snapshot']>
  criteria?: Array<{ key: string; score: number; reasonCode: string }>
}): Record<string, EvalJsonValue> {
  return {
    budget: input.budget,
    ...(input.criteria ? { criteria: input.criteria } : {}),
  }
}

function modelMetering(input: {
  provider: string
  model: string
  requestId?: string
  responseId?: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
  costMicrousd: number
  pricing: ModelPricingSnapshot
}): EvalModelMetering {
  return {
    provider: input.provider,
    model: input.model,
    ...(input.requestId ? { providerRequestId: input.requestId } : {}),
    ...(input.responseId ? { providerResponseId: input.responseId } : {}),
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadInputTokens: input.cacheReadInputTokens,
    cacheWriteInputTokens: input.cacheWriteInputTokens,
    costMicrousd: input.costMicrousd,
    pricingVersion: input.pricing.version,
    costCurrency: 'USD',
  }
}

export function createModelRubricEvaluator<TInput, TOutput, TExpected = unknown>(
  options: CreateModelRubricEvaluatorOptions<TInput, TOutput, TExpected>,
): EvalEvaluator<TInput, TOutput, TExpected> {
  const totalWeight = options.rubric.criteria.reduce(
    (sum, criterion) => sum + criterion.weight,
    0,
  )
  if (totalWeight <= 0) throw new Error('Rubric criterion weights must sum above zero')
  if (new Set(options.rubric.criteria.map((criterion) => criterion.key)).size !==
    options.rubric.criteria.length) {
    throw new Error('Rubric criterion keys must be unique')
  }
  return {
    key: options.profile.key,
    version: options.profile.version,
    metric: options.rubric.key,
    async evaluate(evaluation) {
      const subject = options.renderSubject({
        caseInput: evaluation.case.input,
        output: evaluation.output,
        expected: evaluation.case.expected,
      })
      const system = [
        'You are a strict evaluation grader.',
        'Return one JSON object only. Do not quote or reproduce the evaluated content.',
        'For every rubric criterion return: key, integer score from 0 to 100, and a machine-readable reasonCode.',
        'Do not add explanations or additional fields.',
      ].join('\n')
      const user = JSON.stringify({
        rubric: {
          key: options.rubric.key,
          version: options.rubric.version,
          criteria: options.rubric.criteria.map((criterion) => ({
            key: criterion.key,
            description: criterion.description,
          })),
        },
        subject,
      })
      let reservation
      try {
        reservation = options.budget.reserve(
          Buffer.byteLength(system, 'utf8') + Buffer.byteLength(user, 'utf8'),
          options.profile.maxOutputTokens,
        )
      } catch (error) {
        throw new EvalEvaluatorFailure('Eval grader budget rejected the model call', {
          failureReason: 'budget_rejected',
          budget: options.budget.snapshot(),
        })
      }
      let response
      try {
        response = await options.model.generate({
          operation: `eval.grader.${options.rubric.key}`,
          promptVersion: options.profile.promptVersion,
          system,
          user,
          maxTokens: options.profile.maxOutputTokens,
          ...(evaluation.signal ? { signal: evaluation.signal } : {}),
          metadata: {
            graderProfile: options.profile.modelProfile,
            graderVersion: options.profile.version,
            rubricVersion: options.rubric.version,
          },
        })
      } catch (error) {
        options.budget.markUnmetered(reservation)
        throw new EvalEvaluatorFailure('Eval grader provider call failed', {
          failureReason: 'provider_call_failed',
          budget: options.budget.snapshot(),
        })
      }
      if (!response.usage) {
        options.budget.markUnmetered(reservation)
        throw new EvalEvaluatorFailure('Eval grader response omitted usage', {
          failureReason: 'usage_missing',
          provider: response.provider,
          model: response.model,
          budget: options.budget.snapshot(),
        })
      }
      const costMicrousd = usageCostMicrousd(response.usage, options.budget.pricing)
      try {
        options.budget.settle(reservation, response.usage)
      } catch {
        throw new EvalEvaluatorFailure('Eval grader exceeded its reserved budget', {
          failureReason: 'budget_settle_failed',
          budget: options.budget.snapshot(),
        }, modelMetering({
          provider: response.provider,
          model: response.model,
          ...(response.requestId ? { requestId: response.requestId } : {}),
          ...(response.responseId ? { responseId: response.responseId } : {}),
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cacheReadInputTokens: response.usage.cacheReadInputTokens ?? 0,
          cacheWriteInputTokens: response.usage.cacheWriteInputTokens ?? 0,
          costMicrousd,
          pricing: options.budget.pricing,
        }))
      }
      const metering = modelMetering({
        provider: response.provider,
        model: response.model,
        ...(response.requestId ? { requestId: response.requestId } : {}),
        ...(response.responseId ? { responseId: response.responseId } : {}),
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheReadInputTokens: response.usage.cacheReadInputTokens ?? 0,
        cacheWriteInputTokens: response.usage.cacheWriteInputTokens ?? 0,
        costMicrousd,
        pricing: options.budget.pricing,
      })
      if (response.finishReason !== 'stop') {
        throw new EvalEvaluatorFailure('Eval grader did not finish normally', {
          failureReason: 'finish_reason_invalid',
          finishReason: response.finishReason,
          budget: options.budget.snapshot(),
        }, metering)
      }
      const parsed = GraderResponseSchema.safeParse(parseJsonObject(response.text))
      if (!parsed.success) {
        throw new EvalEvaluatorFailure('Eval grader returned invalid JSON', {
          failureReason: 'response_invalid',
          budget: options.budget.snapshot(),
        }, metering)
      }
      const byKey = new Map(parsed.data.criteria.map((criterion) => [criterion.key, criterion]))
      if (
        byKey.size !== options.rubric.criteria.length ||
        options.rubric.criteria.some((criterion) => !byKey.has(criterion.key))
      ) {
        throw new EvalEvaluatorFailure('Eval grader criterion identity mismatch', {
          failureReason: 'criteria_mismatch',
          budget: options.budget.snapshot(),
        }, metering)
      }
      const criteria = options.rubric.criteria.map((definition) => ({
        ...byKey.get(definition.key)!,
        weight: definition.weight,
        minimumScore: definition.minimumScore,
      }))
      const value = criteria.reduce(
        (sum, criterion) => sum + criterion.score * criterion.weight,
        0,
      ) / totalWeight
      const passed = value >= options.rubric.passScore &&
        criteria.every((criterion) => criterion.score >= criterion.minimumScore)
      return {
        value,
        passed,
        modelMetering: metering,
        metadata: graderMetadata({
          budget: options.budget.snapshot(),
          criteria: criteria.map(({ key, score, reasonCode }) => ({ key, score, reasonCode })),
        }),
      }
    },
  }
}
