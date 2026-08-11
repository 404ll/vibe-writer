import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemorySaver, isInterrupted } from '@langchain/langgraph'
import type { CoveragePlanResult, ReviewResult, WriterResult } from '@vibe-writer/agent-core'
import {
  WorkflowShadowFixtureSchema,
  type WorkflowShadowObservation,
  type WorkflowShadowScenario,
} from '@vibe-writer/contracts/workflow-shadow-fixtures'
import {
  fingerprintEvalValue,
  runOfflineEval,
  type EvalCase,
  type EvalJsonValue,
} from '@vibe-writer/eval-core'
import {
  buildWorkflowGraph,
  createWorkflowState,
  resumeOutline,
  WORKFLOW_VERSION,
  type WorkflowServices,
} from '@vibe-writer/workflow-runtime'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = WorkflowShadowFixtureSchema.parse(JSON.parse(readFileSync(
  new URL('../../../packages/contracts/fixtures/workflow-shadow-baseline.json', import.meta.url),
  'utf8',
)))

type WorkflowShadowInput = Omit<WorkflowShadowScenario, 'expected'>
type WorkflowShadowOutput = {
  compatibility: WorkflowShadowObservation
  target: WorkflowShadowObservation
}

export const WORKFLOW_SHADOW_SUITE = {
  key: 'workflow-shadow-regression',
  version: '2026-08-07-v1',
  targetKey: 'python-typescript-workflow-shadow',
  targetVersion: 'v1',
  evaluatorKey: 'normalized-workflow-equivalence',
  evaluatorVersion: 'v1',
} as const

function json<T extends EvalJsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function canonicalMarkdown(value: string): string {
  return value.trim().replace(/\n{3,}/g, '\n\n')
}

function readyCoverage(chapterTitle: string): CoveragePlanResult {
  return {
    status: 'ready',
    points: [{ text: `覆盖 ${chapterTitle}`, searchQuery: `${chapterTitle} 查询` }],
  }
}

function readyWriter(content: string): WriterResult {
  return {
    status: 'ready',
    content,
    executions: [],
    modelCalls: [],
    budgetUsage: { totalCalls: 0, callsByTool: {} },
    modelRequests: 1,
    toolRounds: 0,
  }
}

function review(verdict: ReviewResult['verdict'], feedback = ''): ReviewResult {
  return { verdict, feedback, source: 'model' }
}

export function workflowShadowCases(): Array<
  EvalCase<WorkflowShadowInput, WorkflowShadowObservation>
> {
  return fixture.cases.map(({ expected, ...input }) => ({
    key: `${fixture.dataset_id}/${input.id}`,
    input,
    expected,
    tags: [fixture.dataset_id, 'cross-runtime', 'workflow'],
  }))
}

export async function executeTypeScriptWorkflow(
  scenario: WorkflowShadowInput,
): Promise<WorkflowShadowObservation> {
  const stages: WorkflowShadowObservation['stageSequence'] = []
  const pushStage = (stage: WorkflowShadowObservation['stageSequence'][number]) => {
    if (stages.at(-1) !== stage) stages.push(stage)
  }
  let writeCalls = 0
  let fullReviewCalls = 0
  let outlineReviewCount = 0
  const services: WorkflowServices = {
    async plan() {
      pushStage('plan')
      return [...scenario.initial_outline]
    },
    async reviseOutline() {
      throw new Error('outline revision is not scripted in this dataset')
    },
    async planCoverage({ chapterTitle }) {
      pushStage('write')
      return readyCoverage(chapterTitle)
    },
    async writeChapter({ chapterTitle }) {
      pushStage('write')
      writeCalls += 1
      return readyWriter(`${chapterTitle}正文-v${writeCalls}`)
    },
    async reviewChapter() {
      return review('passed')
    },
    async reviewFull({ chapters }) {
      pushStage('review')
      const verdicts = scenario.full_review_rounds[fullReviewCalls]
      if (!verdicts || verdicts.length !== chapters.length) {
        throw new Error('full-review round does not match chapter cardinality')
      }
      fullReviewCalls += 1
      return verdicts.map((verdict) =>
        review(verdict, verdict === 'passed' ? '' : '补充论证'))
    },
  }

  const checkpointer = scenario.intervention_on_outline ? new MemorySaver() : undefined
  const graph = buildWorkflowGraph(services, { ...(checkpointer ? { checkpointer } : {}) })
  const config = scenario.intervention_on_outline
    ? { configurable: { thread_id: `shadow-${scenario.id}` } }
    : undefined
  let result = await graph.invoke(createWorkflowState({
    jobId: `shadow-${scenario.id}`,
    topic: scenario.topic,
    interventionOnOutline: scenario.intervention_on_outline,
  }), config)

  for (const reply of scenario.replies) {
    if (!isInterrupted(result)) throw new Error('workflow did not request the scripted reply')
    outlineReviewCount += 1
    result = await graph.invoke(resumeOutline(reply), config)
  }
  if (isInterrupted(result)) throw new Error('workflow still awaits an unscripted reply')
  if (result.phase !== 'completed') throw new Error('workflow did not complete')
  pushStage('export')

  return {
    phase: 'completed',
    outline: result.outline,
    canonicalMarkdown: canonicalMarkdown(result.finalContent),
    stageSequence: stages,
    outlineReviewCount,
    writeCalls,
    fullReviewCalls,
  }
}

export function executePythonWorkflow(
  scenario: WorkflowShadowInput,
): WorkflowShadowObservation {
  const interpreter = process.env.API_PYTHON?.trim()
    || join(repositoryRoot, '.venv', 'bin', 'python')
  const script = join(repositoryRoot, 'apps', 'eval', 'python', 'workflow_shadow.py')
  const result = spawnSync(interpreter, [script], {
    cwd: join(repositoryRoot, 'apps', 'api'),
    encoding: 'utf8',
    input: JSON.stringify(scenario),
    env: {
      PATH: process.env.PATH ?? '',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: join(repositoryRoot, 'apps', 'api'),
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1',
    },
    maxBuffer: 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.trim().split('\n').slice(-12).join('\n')
    throw new Error(
      `Python workflow shadow failed with exit ${result.status ?? 'unknown'}`
      + (detail ? `\n${detail}` : ''),
    )
  }
  return json(JSON.parse(result.stdout) as WorkflowShadowObservation)
}

async function executeWorkflowShadow(
  scenario: WorkflowShadowInput,
): Promise<WorkflowShadowOutput> {
  const [target, compatibility] = await Promise.all([
    executeTypeScriptWorkflow(scenario),
    Promise.resolve().then(() => executePythonWorkflow(scenario)),
  ])
  return { compatibility, target }
}

function hashDirectory(hash: ReturnType<typeof createHash>, relativeRoot: string): void {
  const root = join(repositoryRoot, relativeRoot)
  const files = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ['.ts', '.py'].includes(extname(entry.name)))
    .map((entry) => join(root, entry.name))
    .sort()
  for (const file of files) {
    hash.update(relative(repositoryRoot, file))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
}

function sourceRevision(): string {
  const hash = createHash('sha256')
  for (const root of [
    'packages/workflow-runtime/src',
    'packages/contracts/src',
    'packages/eval-core/src',
    'apps/api/backend/agent',
  ]) hashDirectory(hash, root)
  for (const file of [
    'packages/contracts/fixtures/workflow-shadow-baseline.json',
    'apps/eval/python/workflow_shadow.py',
    'apps/eval/src/workflow-shadow-suite.ts',
  ]) {
    hash.update(file)
    hash.update('\0')
    hash.update(readFileSync(join(repositoryRoot, file)))
    hash.update('\0')
  }
  return `workflow-shadow-source@sha256:${hash.digest('hex')}`
}

export async function runWorkflowShadowEval() {
  const cases = workflowShadowCases()
  const report = await runOfflineEval(
    cases,
    {
      key: WORKFLOW_SHADOW_SUITE.targetKey,
      version: WORKFLOW_SHADOW_SUITE.targetVersion,
      execute: executeWorkflowShadow,
    },
    [{
      key: WORKFLOW_SHADOW_SUITE.evaluatorKey,
      version: WORKFLOW_SHADOW_SUITE.evaluatorVersion,
      metric: 'cross_runtime_exact_match',
      evaluate: (evaluation) => {
        const expected = fingerprintEvalValue(evaluation.case.expected)
        const compatibilityMatchesExpected =
          fingerprintEvalValue(evaluation.output.compatibility) === expected
        const targetMatchesExpected = fingerprintEvalValue(evaluation.output.target) === expected
        const shadowMatches =
          fingerprintEvalValue(evaluation.output.compatibility) ===
          fingerprintEvalValue(evaluation.output.target)
        return {
          passed: compatibilityMatchesExpected && targetMatchesExpected && shadowMatches,
          metadata: { compatibilityMatchesExpected, targetMatchesExpected, shadowMatches },
        }
      },
    }],
    {
      suite: { key: WORKFLOW_SHADOW_SUITE.key, version: WORKFLOW_SHADOW_SUITE.version },
      execution: {
        modelProfile: 'scripted:cross-runtime-workflow-v1',
        promptVersion: 'scripted-workflow-prompts-v1',
        graphVersion: `python-c47cbfd0ab1f+${WORKFLOW_VERSION}`,
        toolVersions: { providerAdapters: 'scripted-workflow-adapters-v1' },
        codeRevision: sourceRevision(),
      },
    },
  )
  return { cases, report }
}
