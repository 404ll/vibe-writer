import {
  createPostgresDatabase,
  importLegacySqliteArticles,
} from '@vibe-writer/db'
import { readLegacySqliteManifest } from '@vibe-writer/db/legacy-sqlite'

type Arguments = {
  source: string
  apply: boolean
  expectedSourceSha256?: string
}

function parseArguments(argv: string[]): Arguments {
  let source = ''
  let apply = false
  let expectedSourceSha256: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--source') {
      source = argv[++index]?.trim() ?? ''
    } else if (argument === '--apply') {
      apply = true
    } else if (argument === '--expected-source-sha256') {
      expectedSourceSha256 = argv[++index]?.trim()
    } else {
      throw new Error(`Unknown migration argument: ${argument}`)
    }
  }
  if (!source) throw new Error('--source is required')
  if (apply && !expectedSourceSha256) {
    throw new Error('--expected-source-sha256 is required with --apply')
  }
  return { source, apply, ...(expectedSourceSha256 ? { expectedSourceSha256 } : {}) }
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (args.apply && process.env.ALLOW_LEGACY_SQLITE_IMPORT !== 'true') {
    throw new Error('ALLOW_LEGACY_SQLITE_IMPORT must equal true for --apply')
  }
  const databaseUrl = process.env.LEGACY_MIGRATION_DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error('LEGACY_MIGRATION_DATABASE_URL is required')
  const manifest = await readLegacySqliteManifest(args.source)
  if (
    args.expectedSourceSha256 &&
    args.expectedSourceSha256 !== manifest.sourceSha256
  ) {
    throw new Error('Legacy SQLite source fingerprint does not match the approved value')
  }
  const database = createPostgresDatabase(databaseUrl, { max: 2 })
  try {
    const report = await importLegacySqliteArticles(database.db, manifest, {
      apply: args.apply,
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await database.close()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Legacy article migration failed'
  process.stderr.write(`${JSON.stringify({ level: 'fatal', scope: 'legacy-article-migration', message })}\n`)
  process.exitCode = 1
})
