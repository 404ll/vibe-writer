import { describe, expect, it, vi } from 'vitest'
import { fingerprintEvalDataset, runOfflineEval } from '../src/runner'

const execution = {
  modelProfile: 'scripted:model-v1',
  promptVersion: 'prompt-v1',
  graphVersion: 'graph-v1',
  toolVersions: { search: 'search-v1' },
  codeRevision: 'revision-v1',
}

describe('offline eval runner', () => {
  it('fingerprints sorted cases without exposing their contents', () => {
    const left = fingerprintEvalDataset([
      { key: 'b', input: { z: 2, a: 1 }, expected: 'private-b' },
      { key: 'a', input: { value: 'private-a' } },
    ])
    const right = fingerprintEvalDataset([
      { key: 'a', input: { value: 'private-a' } },
      { key: 'b', input: { a: 1, z: 2 }, expected: 'private-b' },
    ])
    expect(left).toBe(right)
    expect(left).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(left).not.toContain('private')
  })

  it('runs versioned deterministic evaluators and omits output by default', async () => {
    const report = await runOfflineEval(
      [{ key: 'case-1', input: 2, expected: 4 }],
      { key: 'double', version: 'v1', execute: async (input) => input * 2 },
      [{
        key: 'exact',
        version: 'v1',
        metric: 'exact_match',
        evaluate: (evaluation) => ({
          passed: evaluation.output === evaluation.case.expected,
          value: evaluation.output,
        }),
      }],
      { suite: { key: 'math', version: 'v1' }, execution },
    )

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: 'completed',
      target: { key: 'double', version: 'v1', execution },
      trials: [{
        caseKey: 'case-1',
        trialIndex: 0,
        status: 'succeeded',
        outputFingerprint: expect.stringMatching(/^sha256:/),
        scores: [{ metric: 'exact_match', value: 4, passed: true, status: 'succeeded' }],
      }],
    })
    expect(report.trials[0]).not.toHaveProperty('output')
  })

  it('records target and evaluator failures instead of silently passing', async () => {
    const target = vi.fn(async (input: string) => {
      if (input === 'target-error') throw new Error('target private detail')
      return input
    })
    const report = await runOfflineEval(
      [
        { key: 'case-target', input: 'target-error' },
        { key: 'case-evaluator', input: 'ok' },
      ],
      { key: 'target', version: 'v1', execute: target },
      [{
        key: 'grader', version: 'v1', metric: 'quality',
        evaluate: () => { throw new Error('grader private detail') },
      }],
      { suite: { key: 'failure', version: 'v1' }, execution },
    )

    expect(report.status).toBe('failed')
    expect(report.trials[0]).toMatchObject({
      status: 'error', errorCode: 'target_error', errorMessage: 'Eval target execution failed.',
    })
    expect(report.trials[1]).toMatchObject({
      status: 'succeeded',
      scores: [{
        status: 'error',
        errorCode: 'evaluator_error',
        errorMessage: 'Eval evaluator failed.',
      }],
    })
    expect(JSON.stringify(report)).not.toContain('private detail')
  })

  it('rejects ambiguous datasets and evaluator identities', async () => {
    expect(() => fingerprintEvalDataset([
      { key: 'duplicate', input: 1 },
      { key: 'duplicate', input: 2 },
    ])).toThrow('unique')

    await expect(runOfflineEval(
      [{ key: 'case', input: 1 }],
      { key: 'target', version: 'v1', execute: async (input) => input },
      [
        { key: 'same', version: 'v1', metric: 'score', evaluate: () => ({ passed: true }) },
        { key: 'same', version: 'v1', metric: 'score', evaluate: () => ({ passed: true }) },
      ],
      { suite: { key: 'suite', version: 'v1' }, execution },
    )).rejects.toThrow('unique')
  })
})
