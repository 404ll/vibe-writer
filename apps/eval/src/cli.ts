import { readFileSync } from 'node:fs'
import {
  baselineFromReport,
  compareEvalBaseline,
  fingerprintEvalDataset,
  parseEvalBaseline,
  type EvalBaseline,
  type EvalJsonValue,
} from '@vibe-writer/eval-core'
import {
  COMPONENT_SUITE,
  componentEvalDefinition,
  runComponentRegressionEval,
} from './component-suite.ts'
import {
  LIVE_ARTICLE_GRADER_TARGET,
  liveArticleGraderExecution,
} from './live-article-grader-executor.ts'
import { loadLiveGraderConfig } from './queue-config.ts'

const baselinePath = new URL('../baselines/component-regression-v1.json', import.meta.url)

export function loadComponentBaseline(): EvalBaseline {
  return parseEvalBaseline(JSON.parse(readFileSync(baselinePath, 'utf8')))
}

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function main() {
  const command = process.argv[2] ?? 'check'
  if (command === 'enqueue-live') {
    const { createEvalRepository, createPostgresDatabase } = await import('@vibe-writer/db')
    const databaseUrl = process.env.EVAL_DATABASE_URL?.trim()
    const namespaceKey = process.env.EVAL_NAMESPACE_KEY?.trim()
    const suiteKey = process.env.EVAL_SUITE_KEY?.trim()
    const suiteVersion = process.env.EVAL_SUITE_VERSION?.trim()
    const datasetFingerprint = process.env.EVAL_DATASET_FINGERPRINT?.trim()
    const idempotencyKey = process.env.EVAL_IDEMPOTENCY_KEY?.trim()
    const trialsPerCase = Number(process.env.EVAL_TRIALS_PER_CASE ?? '3')
    const grader = loadLiveGraderConfig(process.env)
    if (!databaseUrl) throw new Error('EVAL_DATABASE_URL is required for live enqueue')
    if (!namespaceKey) throw new Error('EVAL_NAMESPACE_KEY is required for live enqueue')
    if (!suiteKey) throw new Error('EVAL_SUITE_KEY is required for live enqueue')
    if (!suiteVersion) throw new Error('EVAL_SUITE_VERSION is required for live enqueue')
    if (!datasetFingerprint) {
      throw new Error('EVAL_DATASET_FINGERPRINT is required for live enqueue')
    }
    if (!idempotencyKey) throw new Error('EVAL_IDEMPOTENCY_KEY is required for live enqueue')
    if (!grader) throw new Error('EVAL_GRADER_ENABLED must equal true for live enqueue')
    if (!Number.isInteger(trialsPerCase) || trialsPerCase < 1 || trialsPerCase > 20) {
      throw new Error('EVAL_TRIALS_PER_CASE must be an integer between 1 and 20')
    }
    const database = createPostgresDatabase(databaseUrl, { max: 2 })
    try {
      const queued = await createEvalRepository(database.db).enqueueRun({
        namespaceKey,
        suiteKey,
        suiteVersion,
        datasetFingerprint,
        trigger: 'manual',
        targetKey: LIVE_ARTICLE_GRADER_TARGET.key,
        targetVersion: LIVE_ARTICLE_GRADER_TARGET.version,
        execution: liveArticleGraderExecution(grader, grader.codeRevision),
        trialsPerCase,
        idempotencyKey,
      })
      output({
        status: queued.run.status,
        namespaceKey,
        evalRunId: queued.run.id,
        evalRunCreated: queued.created,
        datasetFingerprint,
        target: LIVE_ARTICLE_GRADER_TARGET,
        trialsPerCase,
      })
    } finally {
      await database.close()
    }
    return
  }
  if (command === 'enqueue') {
    const { createEvalRepository, createPostgresDatabase } = await import('@vibe-writer/db')
    const databaseUrl = process.env.EVAL_DATABASE_URL?.trim()
    const namespaceKey = process.env.EVAL_NAMESPACE_KEY?.trim()
    const idempotencyKey = process.env.EVAL_IDEMPOTENCY_KEY?.trim()
    if (!databaseUrl) throw new Error('EVAL_DATABASE_URL is required for enqueue')
    if (!namespaceKey) throw new Error('EVAL_NAMESPACE_KEY is required for enqueue')
    if (!idempotencyKey) throw new Error('EVAL_IDEMPOTENCY_KEY is required for enqueue')
    const definition = componentEvalDefinition()
    const datasetFingerprint = fingerprintEvalDataset(definition.cases)
    const database = createPostgresDatabase(databaseUrl, { max: 2 })
    try {
      const repository = createEvalRepository(database.db)
      const suite = await repository.createSuite({
        namespaceKey,
        suiteKey: COMPONENT_SUITE.key,
        version: COMPONENT_SUITE.version,
        name: 'TypeScript component regression',
        description: 'Synthetic Planner/Reviewer/Coverage/Search/Writer migration fixtures.',
        status: 'active',
        dataClassification: 'synthetic',
        cases: definition.cases.map((item) => ({
          key: item.key,
          input: item.input as unknown as EvalJsonValue,
          expected: item.expected,
          tags: item.tags,
        })),
      })
      const queued = await repository.enqueueRun({
        namespaceKey,
        suiteKey: COMPONENT_SUITE.key,
        suiteVersion: COMPONENT_SUITE.version,
        datasetFingerprint,
        trigger: 'regression',
        targetKey: definition.target.key,
        targetVersion: definition.target.version,
        execution: definition.options.execution,
        trialsPerCase: 1,
        idempotencyKey,
      })
      output({
        status: queued.run.status,
        namespaceKey,
        suiteId: suite.suite.id,
        suiteCreated: suite.created,
        evalRunId: queued.run.id,
        evalRunCreated: queued.created,
        datasetFingerprint,
      })
    } finally {
      await database.close()
    }
    return
  }

  if (!['report', 'baseline', 'check', 'register'].includes(command)) {
    throw new Error(`Unknown eval command: ${command}`)
  }
  const { cases, report } = await runComponentRegressionEval()
  if (command === 'report') {
    output(report)
    return
  }
  if (command === 'baseline') {
    output(baselineFromReport(report))
    return
  }
  if (command === 'check') {
    const comparison = compareEvalBaseline(report, loadComponentBaseline())
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
  if (command === 'register') {
    const { createEvalRepository, createPostgresDatabase } = await import('@vibe-writer/db')
    const databaseUrl = process.env.EVAL_DATABASE_URL?.trim()
    const namespaceKey = process.env.EVAL_NAMESPACE_KEY?.trim()
    if (!databaseUrl) throw new Error('EVAL_DATABASE_URL is required for registration')
    if (!namespaceKey) throw new Error('EVAL_NAMESPACE_KEY is required for registration')
    const database = createPostgresDatabase(databaseUrl, { max: 2 })
    try {
      const repository = createEvalRepository(database.db)
      const suite = await repository.createSuite({
        namespaceKey,
        suiteKey: report.suite.key,
        version: report.suite.version,
        name: 'TypeScript component regression',
        description: 'Synthetic Planner/Reviewer/Coverage/Search/Writer migration fixtures.',
        status: 'active',
        dataClassification: 'synthetic',
        cases: cases.map((item) => ({
          key: item.key,
          input: item.input as unknown as EvalJsonValue,
          expected: item.expected,
          tags: item.tags,
        })),
      })
      const evalRun = await repository.persistOfflineReport(namespaceKey, 'manual', report)
      output({
        status: evalRun.status,
        namespaceKey,
        suiteId: suite.suite.id,
        suiteCreated: suite.created,
        evalRunId: evalRun.id,
        datasetFingerprint: report.suite.datasetFingerprint,
      })
    } finally {
      await database.close()
    }
    return
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown eval CLI error'
  process.stderr.write(`${JSON.stringify({ status: 'error', message })}\n`)
  process.exitCode = 1
})
