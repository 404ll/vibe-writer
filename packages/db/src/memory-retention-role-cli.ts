import { createPostgresDatabase } from './client'
import {
  assertCurrentMemoryRetentionRole,
  provisionMemoryRetentionRole,
} from './memory-retention-role'

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const command = process.argv[2]
const roleName = requiredEnvironment('MEMORY_RETENTION_DATABASE_ROLE')

if (command === 'provision') {
  const database = createPostgresDatabase(requiredEnvironment('DATABASE_ADMIN_URL'), { max: 1 })
  try {
    await provisionMemoryRetentionRole(database.client, roleName)
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      contractKey: 'memory-retention',
      command,
      roleName,
      status: 'provisioned',
    })}\n`)
  } finally {
    await database.close()
  }
} else if (command === 'verify') {
  const database = createPostgresDatabase(
    requiredEnvironment('DATABASE_MEMORY_RETENTION_URL'),
    { max: 1 },
  )
  try {
    const verification = await assertCurrentMemoryRetentionRole(
      database.client,
      roleName,
    )
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      contractKey: verification.contractKey,
      command,
      roleName,
      status: 'verified',
      tablePrivilegeCount: verification.tablePrivileges.length,
      sequencePrivilegeCount: verification.sequencePrivileges.length,
      bypassRls: verification.role?.bypassRls ?? null,
    })}\n`)
  } finally {
    await database.close()
  }
} else {
  throw new Error('Usage: memory-retention-role-cli.ts <provision|verify>')
}
