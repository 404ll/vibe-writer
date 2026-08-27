import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url))

const forbiddenDependencies = [
  'next',
  '@langchain/anthropic',
  '@anthropic-ai/sdk',
  'drizzle-orm',
  'postgres',
  'bullmq',
  'langfuse',
  '@vibe-writer/db',
  '@langchain/langgraph-checkpoint-postgres',
]

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('workflow runtime boundaries', () => {
  it.each(sourceFiles(sourceRoot))('%s does not own infrastructure adapters', (path) => {
    const source = readFileSync(path, 'utf8')
    for (const dependency of forbiddenDependencies) {
      expect(source, `${path} imports ${dependency}`).not.toMatch(
        new RegExp(`(?:from\\s+|import\\s*\\()(["'])${dependency.replace('/', '\\/')}`),
      )
    }
  })

  it('keeps compile-time types separate from runtime graph and schemas', () => {
    const types = readFileSync(join(sourceRoot, 'types.ts'), 'utf8')
    const schemas = readFileSync(join(sourceRoot, 'schemas.ts'), 'utf8')
    const graph = readFileSync(join(sourceRoot, 'graph.ts'), 'utf8')

    expect(types).not.toContain("from 'zod'")
    expect(types).not.toContain("from '@langchain/langgraph'")
    expect(schemas).toContain('new StateSchema')
    expect(graph).not.toContain('export type WorkflowServices')
    expect(graph).not.toMatch(/type WorkflowNodeName\s*=/)
  })
})
