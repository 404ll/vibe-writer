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
})
