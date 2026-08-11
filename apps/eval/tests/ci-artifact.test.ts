import { runOfflineEval, baselineFromReport } from '@vibe-writer/eval-core'
import { describe, expect, it } from 'vitest'
import { contentFreeEvalResult, createEvalCiArtifact } from '../src/ci-artifact.ts'

describe('content-free CI Eval artifact', () => {
  it('keeps only identities, comparisons, and aggregate metrics', async () => {
    const report = await runOfflineEval(
      [{ key: 'safe-case-key', input: { secret: 'private-input' }, expected: 'private-expected' }],
      { key: 'target', version: 'v1', execute: async () => 'private-output' },
      [{
        key: 'exact', version: 'v1', metric: 'exact',
        evaluate: () => ({ passed: true, metadata: { secret: 'private-metadata' } }),
      }],
      {
        suite: { key: 'suite', version: 'v1' },
        execution: {
          modelProfile: 'scripted', promptVersion: 'p1', graphVersion: 'g1',
          toolVersions: { tool: 'v1' }, codeRevision: 'revision',
        },
        captureOutput: true,
      },
    )
    const artifact = createEvalCiArtifact({
      codeRevision: 'abc123', runId: '42', runAttempt: '1', generatedAt: '2026-08-07T00:00:00Z',
    }, { component: contentFreeEvalResult(report, baselineFromReport(report)) })
    const serialized = JSON.stringify(artifact)
    expect(artifact).toMatchObject({ schemaVersion: 1, status: 'passed' })
    for (const secret of ['private-input', 'private-expected', 'private-output', 'private-metadata']) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).not.toContain('"trials"')
    expect(artifact.payloadSha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
