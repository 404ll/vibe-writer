import { createPostgresDatabase } from './client'
import {
  assertCurrentWriteRuntimeRole,
  provisionWriteRuntimeRole,
  type WriteRuntimeRole,
} from './write-runtime-roles'

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const role = process.argv[2] as WriteRuntimeRole | undefined
const command = process.argv[3]
if (!role || !['dispatcher', 'consumer'].includes(role)) {
  throw new Error('Usage: write-runtime-role-cli.ts <dispatcher|consumer> <provision|verify>')
}

const roleName = requiredEnvironment(
  role === 'dispatcher'
    ? 'WRITE_DISPATCHER_DATABASE_ROLE'
    : 'WRITE_CONSUMER_DATABASE_ROLE',
)

if (command === 'provision') {
  const database = createPostgresDatabase(requiredEnvironment('DATABASE_ADMIN_URL'), { max: 1 })
  try {
    await provisionWriteRuntimeRole(database.client, role, roleName)
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      command,
      runtimeRole: role,
      roleName,
      status: 'provisioned',
    })}\n`)
  } finally {
    await database.close()
  }
} else if (command === 'verify') {
  const database = createPostgresDatabase(requiredEnvironment(
    role === 'dispatcher'
      ? 'DATABASE_WRITE_DISPATCHER_URL'
      : 'DATABASE_WRITE_CONSUMER_URL',
  ), { max: 1 })
  try {
    const verification = await assertCurrentWriteRuntimeRole(
      database.client,
      role,
      roleName,
    )
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      command,
      runtimeRole: role,
      roleName,
      status: 'verified',
      schemaPrivilegeCount: verification.schemaPrivileges.length,
      tablePrivilegeCount: verification.tablePrivileges.length,
      sequencePrivilegeCount: verification.sequencePrivileges.length,
    })}\n`)
  } finally {
    await database.close()
  }
} else {
  throw new Error('Usage: write-runtime-role-cli.ts <dispatcher|consumer> <provision|verify>')
}
