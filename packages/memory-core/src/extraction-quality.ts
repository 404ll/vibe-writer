import { z } from 'zod'
import { MemoryExtractionOutputSchema, type MemoryExtractionOutput } from './extraction'
import {
  MemoryExtractionPromptInputSchema,
  type MemoryExtractionPromptInput,
} from './extractor-prompt'

const ExpectedCandidateSchema = MemoryExtractionOutputSchema.shape.candidates.element

export const MemoryExtractionQualityCaseSchema = z.object({
  key: z.string().trim().min(1).max(256),
  category: z.enum([
    'durable_preference',
    'durable_constraint',
    'durable_correction',
    'task_instruction',
    'assistant_generated',
    'sensitive_trap',
    'ambiguous',
  ]),
  input: MemoryExtractionPromptInputSchema,
  expected: z.object({
    shouldWrite: z.boolean(),
    candidates: z.array(ExpectedCandidateSchema).max(20),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.expected.shouldWrite !== (value.expected.candidates.length > 0)) {
    context.addIssue({
      code: 'custom',
      message: 'expected.shouldWrite must match the expected candidate inventory',
    })
  }
})

export type MemoryExtractionQualityCase = {
  key: string
  category:
    | 'durable_preference'
    | 'durable_constraint'
    | 'durable_correction'
    | 'task_instruction'
    | 'assistant_generated'
    | 'sensitive_trap'
    | 'ambiguous'
  input: MemoryExtractionPromptInput
  expected: {
    shouldWrite: boolean
    candidates: MemoryExtractionOutput['candidates']
  }
}

export type MemoryExtractionQualityMetrics = {
  caseCount: number
  validOutputCount: number
  invalidOutputCount: number
  truePositiveCount: number
  falsePositiveCount: number
  falseNegativeCount: number
  trueNegativeCount: number
  shouldWritePrecision: number
  shouldWriteRecall: number
  shouldWriteAccuracy: number
  slotExactCount: number
  positiveCaseCount: number
  slotExactRate: number
  candidateExactCount: number
  candidateExactRate: number
  taskLeakCount: number
  assistantLeakCount: number
  sensitiveLeakCount: number
}

function slot(candidate: MemoryExtractionOutput['candidates'][number]): string {
  return [
    candidate.subject.kind,
    candidate.subject.key,
    candidate.memoryKey,
    candidate.kind,
  ].join('\0')
}

function candidateIdentity(candidate: MemoryExtractionOutput['candidates'][number]): string {
  return JSON.stringify({
    subject: candidate.subject,
    memoryKey: candidate.memoryKey,
    kind: candidate.kind,
    content: candidate.content,
    confidence: candidate.confidence,
    sensitivity: candidate.sensitivity,
  })
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...left].sort()
  const normalizedRight = [...right].sort()
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
}

function ratio(numerator: number, denominator: number, emptyValue: number): number {
  return denominator === 0 ? emptyValue : numerator / denominator
}

export function scoreMemoryExtractionQuality(input: {
  cases: readonly MemoryExtractionQualityCase[]
  outputs: Readonly<Record<string, unknown>>
}): MemoryExtractionQualityMetrics {
  const cases = input.cases.map((item) => MemoryExtractionQualityCaseSchema.parse(item))
  const keys = cases.map(({ key }) => key)
  if (new Set(keys).size !== keys.length) throw new Error('Memory extraction quality keys must be unique')
  const outputKeys = Object.keys(input.outputs).sort()
  if (!sameSet(keys, outputKeys)) {
    throw new Error('Memory extraction quality outputs must match the case inventory')
  }

  let validOutputCount = 0
  let truePositiveCount = 0
  let falsePositiveCount = 0
  let falseNegativeCount = 0
  let trueNegativeCount = 0
  let slotExactCount = 0
  let candidateExactCount = 0
  let taskLeakCount = 0
  let assistantLeakCount = 0
  let sensitiveLeakCount = 0
  const positiveCaseCount = cases.filter(({ expected }) => expected.shouldWrite).length

  for (const qualityCase of cases) {
    const parsed = MemoryExtractionOutputSchema.safeParse(input.outputs[qualityCase.key])
    const output = parsed.success ? parsed.data : null
    if (output) validOutputCount += 1
    const predictedWrite = output ? output.candidates.length > 0 : !qualityCase.expected.shouldWrite
    if (qualityCase.expected.shouldWrite && predictedWrite) truePositiveCount += 1
    else if (!qualityCase.expected.shouldWrite && predictedWrite) falsePositiveCount += 1
    else if (qualityCase.expected.shouldWrite) falseNegativeCount += 1
    else trueNegativeCount += 1

    if (qualityCase.expected.shouldWrite && output) {
      if (sameSet(output.candidates.map(slot), qualityCase.expected.candidates.map(slot))) {
        slotExactCount += 1
      }
      if (sameSet(
        output.candidates.map(candidateIdentity),
        qualityCase.expected.candidates.map(candidateIdentity),
      )) {
        candidateExactCount += 1
      }
    }
    if (output?.candidates.length) {
      if (qualityCase.category === 'task_instruction') taskLeakCount += 1
      if (qualityCase.category === 'assistant_generated') assistantLeakCount += 1
      if (qualityCase.category === 'sensitive_trap') sensitiveLeakCount += 1
    }
  }

  const invalidOutputCount = cases.length - validOutputCount
  return {
    caseCount: cases.length,
    validOutputCount,
    invalidOutputCount,
    truePositiveCount,
    falsePositiveCount,
    falseNegativeCount,
    trueNegativeCount,
    shouldWritePrecision: ratio(
      truePositiveCount,
      truePositiveCount + falsePositiveCount,
      1,
    ),
    shouldWriteRecall: ratio(
      truePositiveCount,
      truePositiveCount + falseNegativeCount,
      1,
    ),
    shouldWriteAccuracy: ratio(
      truePositiveCount + trueNegativeCount,
      cases.length,
      0,
    ),
    slotExactCount,
    positiveCaseCount,
    slotExactRate: ratio(slotExactCount, positiveCaseCount, 1),
    candidateExactCount,
    candidateExactRate: ratio(candidateExactCount, positiveCaseCount, 1),
    taskLeakCount,
    assistantLeakCount,
    sensitiveLeakCount,
  }
}
