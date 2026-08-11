import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url))
const setupCliSource = readFileSync(join(sourceRoot, 'setup-cli.ts'), 'utf8')

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : path.endsWith('.ts')
        ? [path]
        : []
  })
}

describe('checkpoint runtime boundaries', () => {
  it.each(sourceFiles(sourceRoot))('%s does not import product UI or agent services', (path) => {
    const source = readFileSync(path, 'utf8')
    for (const dependency of [
      'next',
      '@vibe-writer/agent-core',
      '@vibe-writer/workflow-runtime',
      'bullmq',
    ]) {
      expect(source, `${path} imports ${dependency}`).not.toMatch(
        new RegExp(`(?:from\\s+|import\\s*\\()(["'])${dependency.replace('/', '\\/')}`),
      )
    }
  })

  it('exposes checkpoint DDL only through an explicit admin command', () => {
    expect(setupCliSource).toContain("requiredEnvironment('DATABASE_CHECKPOINT_ADMIN_URL')")
    expect(setupCliSource).not.toContain("requiredEnvironment('DATABASE_URL')")
    for (const path of sourceFiles(sourceRoot).filter((path) => !path.endsWith('setup-cli.ts'))) {
      expect(readFileSync(path, 'utf8'), `${path} owns checkpoint DDL`).not.toContain(
        'saver.setup()',
      )
    }
  })
})
