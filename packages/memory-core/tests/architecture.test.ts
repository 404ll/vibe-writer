import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageSource = readFileSync(new URL('../package.json', import.meta.url), 'utf8')

describe('Memory core boundaries', () => {
  it('does not depend on persistence, graph, queue, model, or vector vendors', () => {
    for (const dependency of [
      '@vibe-writer/db',
      '@vibe-writer/model-runtime',
      '@langchain/langgraph',
      'bullmq',
      'drizzle-orm',
      'pgvector',
    ]) {
      expect(packageSource).not.toContain(dependency)
    }
  })
})
