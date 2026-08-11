import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const agentCoreRoot = fileURLToPath(new URL('../src', import.meta.url))
const modelRuntimeRoot = fileURLToPath(new URL('../../model-runtime/src', import.meta.url))

const forbiddenDependencies = [
  'next',
  '@langchain/langgraph',
  '@langchain/anthropic',
  '@anthropic-ai/sdk',
  'drizzle-orm',
  'postgres',
  'bullmq',
  'langfuse',
]

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('core package boundaries', () => {
  it.each([...sourceFiles(agentCoreRoot), ...sourceFiles(modelRuntimeRoot)])(
    '%s does not import runtime or vendor infrastructure',
    (path) => {
      const source = readFileSync(path, 'utf8')
      for (const dependency of forbiddenDependencies) {
        expect(source, `${path} imports ${dependency}`).not.toMatch(
          new RegExp(`(?:from\\s+|import\\s*\\()(["'])${dependency.replace('/', '\\/')}`),
        )
      }
    },
  )
})
