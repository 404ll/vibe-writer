import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MEMORY_EXTRACTOR_PROMPT,
  MemoryExtractionOutputSchema,
  scoreMemoryExtractionQuality,
  type MemoryExtractionPromptInput,
  type MemoryExtractionQualityCase,
  type MemoryExtractionQualityMetrics,
} from '@vibe-writer/memory-core'
import {
  compareEvalBaseline,
  parseEvalBaseline,
  runOfflineEval,
  type EvalBaseline,
  type EvalCase,
  type EvalJsonValue,
  type EvalTarget,
} from '@vibe-writer/eval-core'
import {
  MEMORY_EXTRACTION_DATASET_VERSION,
  memoryExtractionQualityCases,
} from './memory-extraction-dataset.ts'
import {
  MEMORY_EXTRACTION_REFERENCE_TARGET,
  referenceMemoryExtractionOutput,
} from './memory-extraction-reference-target.ts'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))

export const MEMORY_EXTRACTION_SUITE = {
  key: 'memory-extraction-quality',
  version: MEMORY_EXTRACTION_DATASET_VERSION,
  evaluatorKey: 'memory-extraction-case-exact',
  evaluatorVersion: 'v1',
} as const

type MemoryExtractionExpected = MemoryExtractionQualityCase['expected'] & {
  category: MemoryExtractionQualityCase['category']
}

export type MemoryExtractionQualityGates = {
  minimumShouldWritePrecision: number
  minimumShouldWriteRecall: number
  minimumShouldWriteAccuracy: number
  minimumSlotExactRate: number
  maximumInvalidOutputCount: number
  maximumTaskLeakCount: number
  maximumAssistantLeakCount: number
  maximumSensitiveLeakCount: number
}

export type MemoryExtractionBaseline = {
  schemaVersion: 1
  evalBaseline: EvalBaseline
  qualityGates: MemoryExtractionQualityGates
}

export type MemoryExtractionBaselineComparison = {
  passed: boolean
  failures: string[]
  summary: ReturnType<typeof compareEvalBaseline>['summary']
  quality: MemoryExtractionQualityMetrics
}

export type MemoryExtractionTarget = EvalTarget<MemoryExtractionPromptInput, unknown>

function json<T>(value: T): EvalJsonValue {
  return JSON.parse(JSON.stringify(value)) as EvalJsonValue
}

function finiteRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function parseMemoryExtractionBaseline(value: unknown): MemoryExtractionBaseline {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Memory extraction baseline')
  }
  const root = value as Record<string, unknown>
  const rawGates = root.qualityGates
  if (root.schemaVersion !== 1 || rawGates === null || typeof rawGates !== 'object' || Array.isArray(rawGates)) {
    throw new Error('Invalid Memory extraction baseline')
  }
  const gates = rawGates as Record<string, unknown>
  if (
    !finiteRatio(gates.minimumShouldWritePrecision) ||
    !finiteRatio(gates.minimumShouldWriteRecall) ||
    !finiteRatio(gates.minimumShouldWriteAccuracy) ||
    !finiteRatio(gates.minimumSlotExactRate) ||
    !nonnegativeInteger(gates.maximumInvalidOutputCount) ||
    !nonnegativeInteger(gates.maximumTaskLeakCount) ||
    !nonnegativeInteger(gates.maximumAssistantLeakCount) ||
    !nonnegativeInteger(gates.maximumSensitiveLeakCount)
  ) {
    throw new Error('Invalid Memory extraction quality gates')
  }
  return {
    schemaVersion: 1,
    evalBaseline: parseEvalBaseline(root.evalBaseline),
    qualityGates: gates as MemoryExtractionQualityGates,
  }
}

export function memoryExtractionEvalCases(): Array<
  EvalCase<MemoryExtractionPromptInput, MemoryExtractionExpected>
> {
  return memoryExtractionQualityCases().map((qualityCase) => ({
    key: qualityCase.key,
    input: qualityCase.input,
    expected: {
      category: qualityCase.category,
      ...qualityCase.expected,
    },
    tags: ['memory-extraction', qualityCase.category],
  }))
}

function sourceRevision(): string {
  const hash = createHash('sha256')
  for (const relativePath of [
    'packages/memory-core/src/extraction.ts',
    'packages/memory-core/src/extraction-quality.ts',
    'packages/memory-core/src/extractor-prompt.ts',
    'apps/eval/src/memory-extraction-dataset.ts',
    'apps/eval/src/memory-extraction-reference-target.ts',
    'apps/eval/src/memory-extraction-suite.ts',
  ]) {
    hash.update(relativePath)
    hash.update('\0')
    hash.update(readFileSync(join(repositoryRoot, relativePath)))
    hash.update('\0')
  }
  return `memory-extraction-source@sha256:${hash.digest('hex')}`
}

function referenceTarget(): MemoryExtractionTarget {
  return {
    ...MEMORY_EXTRACTION_REFERENCE_TARGET,
    async execute(_input, context) {
      return json(referenceMemoryExtractionOutput(context.caseKey))
    },
  }
}

function qualityCaseFromEval(
  evalCase: EvalCase<MemoryExtractionPromptInput, MemoryExtractionExpected>,
): MemoryExtractionQualityCase {
  if (!evalCase.expected) throw new Error('Memory extraction case has no expected result')
  const { category, ...expected } = evalCase.expected
  return {
    key: evalCase.key,
    category,
    input: evalCase.input,
    expected,
  }
}

export function memoryExtractionEvalDefinition(
  target: MemoryExtractionTarget = referenceTarget(),
) {
  return {
    cases: memoryExtractionEvalCases(),
    target,
    evaluators: [{
      key: MEMORY_EXTRACTION_SUITE.evaluatorKey,
      version: MEMORY_EXTRACTION_SUITE.evaluatorVersion,
      metric: 'memory_extraction_case_exact',
      evaluate(evaluation: {
        output: unknown
        case: EvalCase<MemoryExtractionPromptInput, MemoryExtractionExpected>
      }) {
        const qualityCase = qualityCaseFromEval(evaluation.case)
        const quality = scoreMemoryExtractionQuality({
          cases: [qualityCase],
          outputs: { [qualityCase.key]: evaluation.output },
        })
        const expected = evaluation.case.expected
        const parsed = MemoryExtractionOutputSchema.safeParse(evaluation.output)
        const classificationMatches = parsed.success &&
          (parsed.data.candidates.length > 0) === expected?.shouldWrite
        const slotMatches = !expected?.shouldWrite || quality.slotExactRate === 1
        return {
          passed: classificationMatches && slotMatches,
          metadata: {
            category: expected?.category ?? 'unknown',
            validOutput: parsed.success,
            slotExact: quality.slotExactRate === 1,
          },
        }
      },
    }],
    options: {
      suite: {
        key: MEMORY_EXTRACTION_SUITE.key,
        version: MEMORY_EXTRACTION_SUITE.version,
      },
      execution: {
        modelProfile: `none:${target.key}`,
        promptVersion: MEMORY_EXTRACTOR_PROMPT.version,
        graphVersion: 'memory-extraction-no-graph-v1',
        toolVersions: {
          memoryExtractionContract: 'v1',
          sourceContract: 'trusted-segments-v1',
        },
        codeRevision: sourceRevision(),
      },
      captureOutput: true,
    },
  }
}

export async function runMemoryExtractionQualityEval(
  target?: MemoryExtractionTarget,
) {
  const definition = memoryExtractionEvalDefinition(target)
  const report = await runOfflineEval(
    definition.cases,
    definition.target,
    definition.evaluators,
    definition.options,
  )
  const outputs: Record<string, unknown> = {}
  for (const trial of report.trials) outputs[trial.caseKey] = trial.output
  const quality = scoreMemoryExtractionQuality({
    cases: memoryExtractionQualityCases(),
    outputs,
  })
  return { cases: definition.cases, report, quality }
}

export function compareMemoryExtractionBaseline(input: {
  report: Awaited<ReturnType<typeof runMemoryExtractionQualityEval>>['report']
  quality: MemoryExtractionQualityMetrics
  baseline: MemoryExtractionBaseline
}): MemoryExtractionBaselineComparison {
  const baseline = parseMemoryExtractionBaseline(input.baseline)
  const standard = compareEvalBaseline(input.report, baseline.evalBaseline)
  const failures = [...standard.failures]
  const { quality, } = input
  const gates = baseline.qualityGates
  if (quality.shouldWritePrecision < gates.minimumShouldWritePrecision) {
    failures.push(`Should-write precision regressed to ${quality.shouldWritePrecision}`)
  }
  if (quality.shouldWriteRecall < gates.minimumShouldWriteRecall) {
    failures.push(`Should-write recall regressed to ${quality.shouldWriteRecall}`)
  }
  if (quality.shouldWriteAccuracy < gates.minimumShouldWriteAccuracy) {
    failures.push(`Should-write accuracy regressed to ${quality.shouldWriteAccuracy}`)
  }
  if (quality.slotExactRate < gates.minimumSlotExactRate) {
    failures.push(`Memory slot exact rate regressed to ${quality.slotExactRate}`)
  }
  if (quality.invalidOutputCount > gates.maximumInvalidOutputCount) {
    failures.push(`Invalid outputs increased to ${quality.invalidOutputCount}`)
  }
  if (quality.taskLeakCount > gates.maximumTaskLeakCount) {
    failures.push(`Task instruction leaks increased to ${quality.taskLeakCount}`)
  }
  if (quality.assistantLeakCount > gates.maximumAssistantLeakCount) {
    failures.push(`Assistant-generated leaks increased to ${quality.assistantLeakCount}`)
  }
  if (quality.sensitiveLeakCount > gates.maximumSensitiveLeakCount) {
    failures.push(`Sensitive memory leaks increased to ${quality.sensitiveLeakCount}`)
  }
  return {
    passed: failures.length === 0,
    failures,
    summary: standard.summary,
    quality,
  }
}
