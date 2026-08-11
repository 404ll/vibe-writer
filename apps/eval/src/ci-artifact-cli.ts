import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { parseEvalBaseline } from '@vibe-writer/eval-core'
import { runComponentRegressionEval } from './component-suite.ts'
import { createEvalCiArtifact, contentFreeEvalResult } from './ci-artifact.ts'
import { runWorkflowShadowEval } from './workflow-shadow-suite.ts'

const outputDirectory = process.env.EVAL_CI_ARTIFACT_DIR?.trim() || 'output/eval-ci'

async function main() {
  const componentBaseline = parseEvalBaseline(JSON.parse(readFileSync(
    new URL('../baselines/component-regression-v1.json', import.meta.url),
    'utf8',
  )))
  const workflowBaseline = parseEvalBaseline(JSON.parse(readFileSync(
    new URL('../baselines/workflow-shadow-v1.json', import.meta.url),
    'utf8',
  )))
  const component = await runComponentRegressionEval()
  const workflow = await runWorkflowShadowEval()
  const artifact = createEvalCiArtifact({
    codeRevision: process.env.EVAL_CI_CODE_REVISION ?? '',
    runId: process.env.EVAL_CI_RUN_ID ?? 'local',
    runAttempt: process.env.EVAL_CI_RUN_ATTEMPT ?? '1',
    generatedAt: new Date().toISOString(),
  }, {
    component: contentFreeEvalResult(component.report, componentBaseline),
    workflowShadow: contentFreeEvalResult(workflow.report, workflowBaseline),
  })
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(`${outputDirectory}/eval-summary.json`, `${JSON.stringify(artifact, null, 2)}\n`, {
    flag: 'wx',
  })
  process.stdout.write(`${JSON.stringify({
    status: artifact.status,
    path: `${outputDirectory}/eval-summary.json`,
    payloadSha256: artifact.payloadSha256,
  })}\n`)
  if (artifact.status !== 'passed') process.exitCode = 1
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown CI Eval artifact error'
  process.stderr.write(`${JSON.stringify({ status: 'error', message })}\n`)
  process.exitCode = 1
})
