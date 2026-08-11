import { readFileSync } from 'node:fs'
import { WorkflowShadowFixtureSchema } from '@vibe-writer/contracts/workflow-shadow-fixtures'
import { describe, expect, it } from 'vitest'
import {
  executePythonWorkflow,
  executeTypeScriptWorkflow,
  runWorkflowShadowEval,
} from '../src/workflow-shadow-suite'

const fixture = WorkflowShadowFixtureSchema.parse(JSON.parse(readFileSync(
  new URL('../../../packages/contracts/fixtures/workflow-shadow-baseline.json', import.meta.url),
  'utf8',
)))

describe('TypeScript workflow shadow target', () => {
  it.each(fixture.cases)('matches the explicit $id observation', async ({ expected, ...scenario }) => {
    await expect(executeTypeScriptWorkflow(scenario)).resolves.toEqual(expected)
  })
})

describe.runIf(Boolean(process.env.API_PYTHON))('cross-runtime workflow shadow target', () => {
  it.each(fixture.cases)('matches Python $id to the explicit observation', ({ expected, ...scenario }) => {
    expect(executePythonWorkflow(scenario)).toEqual(expected)
  })

  it('produces a completed self-owned Eval report', async () => {
    const { report } = await runWorkflowShadowEval()
    expect(report.status).toBe('completed')
    expect(report.trials).toHaveLength(fixture.cases.length)
    expect(report.trials.every((trial) => trial.scores[0]?.passed === true)).toBe(true)
  })
})
