import { readFileSync } from 'node:fs'
import {
  baselineFromReport,
  compareEvalBaseline,
  parseEvalBaseline,
} from '@vibe-writer/eval-core'
import { runWorkflowShadowEval } from './workflow-shadow-suite.ts'

const baselinePath = new URL('../baselines/workflow-shadow-v1.json', import.meta.url)

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function main() {
  const command = process.argv[2] ?? 'check'
  const { report } = await runWorkflowShadowEval()
  if (command === 'report') {
    output(report)
    return
  }
  if (command === 'baseline') {
    output(baselineFromReport(report))
    return
  }
  if (command === 'check') {
    const baseline = parseEvalBaseline(JSON.parse(readFileSync(baselinePath, 'utf8')))
    const comparison = compareEvalBaseline(report, baseline)
    output({
      status: comparison.passed ? 'passed' : 'failed',
      suite: report.suite,
      target: { key: report.target.key, version: report.target.version },
      failures: comparison.failures,
      summary: {
        status: comparison.summary.status,
        caseCount: comparison.summary.caseKeys.length,
        trialCount: comparison.summary.trialCount,
        targetErrorCount: comparison.summary.targetErrorCount,
        evaluatorErrorCount: comparison.summary.evaluatorErrorCount,
        metrics: comparison.summary.metrics,
      },
    })
    if (!comparison.passed) process.exitCode = 1
    return
  }
  throw new Error(`Unknown workflow shadow command: ${command}`)
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown workflow shadow error'
  process.stderr.write(`${JSON.stringify({ status: 'error', message })}\n`)
  process.exitCode = 1
})
