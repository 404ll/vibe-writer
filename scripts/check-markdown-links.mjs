import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const roots = [
  'README.md',
  'AGENTS.md',
  'packages/model-runtime/README.md',
  'packages/agent-core/README.md',
  'packages/db/README.md',
  'docs/refactor',
]

function markdownFiles(path) {
  const absolutePath = resolve(repositoryRoot, path)
  if (!existsSync(absolutePath)) return []
  if (!statSync(absolutePath).isDirectory()) return absolutePath.endsWith('.md') ? [absolutePath] : []
  return readdirSync(absolutePath).flatMap((name) => markdownFiles(join(path, name)))
}

const files = roots.flatMap(markdownFiles)
const missing = []

for (const file of files) {
  const content = readFileSync(file, 'utf8')
  const links = content.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)
  for (const match of links) {
    const link = match[1]
    if (!link?.startsWith('.')) continue
    const target = resolve(dirname(file), link)
    if (!existsSync(target)) {
      missing.push(`${file.slice(repositoryRoot.length + 1)} -> ${link}`)
    }
  }
}

if (missing.length > 0) {
  console.error(`Missing relative Markdown links:\n${missing.join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`Checked ${files.length} Markdown files; all relative links resolve.`)
}
