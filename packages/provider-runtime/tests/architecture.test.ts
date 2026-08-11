import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageSource = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
const lookupSource = readFileSync(new URL('../src/request-lookup.ts', import.meta.url), 'utf8')

describe('provider lookup architecture', () => {
  it('does not depend on persistence, Worker, or Memory policy packages', () => {
    for (const dependency of ['@vibe-writer/db', '@vibe-writer/worker', '@vibe-writer/memory-core']) {
      expect(packageSource).not.toContain(dependency)
      expect(lookupSource).not.toContain(dependency)
    }
  })

  it('uses strict content-free terminal evidence', () => {
    expect(lookupSource).toContain("status: z.literal('succeeded')")
    expect(lookupSource).toContain("status: z.literal('failed')")
    expect(lookupSource).toContain("status: z.literal('pending')")
    expect(lookupSource).toContain("status: z.literal('not_found')")
    expect(lookupSource).not.toContain('responseBody')
    expect(lookupSource).not.toContain('modelOutput')
  })
})
