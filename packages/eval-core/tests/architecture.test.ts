import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { dependencies?: Record<string, string> }
const runnerSource = readFileSync(new URL('../src/runner.ts', import.meta.url), 'utf8')

describe('eval core boundaries', () => {
  it('does not depend on database, queue, graph, provider, or trace vendors', () => {
    expect(Object.keys(packageJson.dependencies ?? {})).toEqual([])
    for (const forbidden of [
      '@vibe-writer/db',
      'drizzle-orm',
      'bullmq',
      '@langchain/langgraph',
      'langfuse',
      'next',
    ]) {
      expect(runnerSource).not.toContain(forbidden)
    }
  })
})
