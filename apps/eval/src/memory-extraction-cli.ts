import { readFileSync } from 'node:fs'
import { baselineFromReport } from '@vibe-writer/eval-core'
import {
  compareMemoryExtractionBaseline,
  parseMemoryExtractionBaseline,
  runMemoryExtractionQualityEval,
  type MemoryExtractionBaseline,
} from './memory-extraction-suite.ts'

const baselinePath = new URL('../baselines/memory-extraction-quality-v1.json', import.meta.url)

const perfectQualityGates: MemoryExtractionBaseline['qualityGates'] = {
  minimumShouldWritePrecision: 1,
  minimumShouldWriteRecall: 1,
  minimumShouldWriteAccuracy: 1,
  minimumSlotExactRate: 1,
  maximumInvalidOutputCount: 0,
  maximumTaskLeakCount: 0,
  maximumAssistantLeakCount: 0,
  maximumSensitiveLeakCount: 0,
}

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function main() {
  const command = process.argv[2] ?? 'check'
  const { report, quality } = await runMemoryExtractionQualityEval()
  if (command === 'report') {
    output({ report, quality })
    return
  }
  if (command === 'baseline') {
    output({
      schemaVersion: 1,
      evalBaseline: baselineFromReport(report),
      qualityGates: perfectQualityGates,
    } satisfies MemoryExtractionBaseline)
    return
  }
  if (command === 'check') {
    const baseline = parseMemoryExtractionBaseline(JSON.parse(readFileSync(baselinePath, 'utf8')))
    const comparison = compareMemoryExtractionBaseline({ report, quality, baseline })
    output({
      status: comparison.passed ? 'passed' : 'failed',
      suite: report.suite,
      target: { key: report.target.key, version: report.target.version },
      promptVersion: report.target.execution.promptVersion,
      failures: comparison.failures,
      summary: {
        status: comparison.summary.status,
        caseCount: comparison.summary.caseKeys.length,
        trialCount: comparison.summary.trialCount,
        targetErrorCount: comparison.summary.targetErrorCount,
        evaluatorErrorCount: comparison.summary.evaluatorErrorCount,
        metrics: comparison.summary.metrics,
      },
      quality: comparison.quality,
    })
    if (!comparison.passed) process.exitCode = 1
    return
  }
  throw new Error(`Unknown Memory extraction command: ${command}`)
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown Memory extraction error'
  process.stderr.write(`${JSON.stringify({ status: 'error', message })}\n`)
  process.exitCode = 1
})
