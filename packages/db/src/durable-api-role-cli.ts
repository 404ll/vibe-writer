import { createPostgresDatabase } from './client'
import {
  assertCurrentDurableApiRole,
  provisionDurableApiRole,
} from './durable-api-role'
import type { PostgresRoleProvisioningMode } from './postgres-role-contract'

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const command = process.argv[2]
const roleName = requiredEnvironment('DURABLE_API_ROLE')
const provisioningMode = (
  process.env.POSTGRES_ROLE_PROVISIONING_MODE?.trim() || 'full'
) as PostgresRoleProvisioningMode
if (!['full', 'managed-service'].includes(provisioningMode)) {
  throw new Error('POSTGRES_ROLE_PROVISIONING_MODE must be full or managed-service')
}

if (command === 'provision') {
  const database = createPostgresDatabase(requiredEnvironment('DATABASE_ADMIN_URL'), { max: 1 })
  try {
    await provisionDurableApiRole(database.client, roleName, provisioningMode)
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      command,
      roleName,
      status: 'provisioned',
    })}\n`)
  } finally {
    await database.close()
  }
} else if (command === 'verify') {
  const database = createPostgresDatabase(requiredEnvironment('DATABASE_API_URL'), { max: 1 })
  try {
    const verification = await assertCurrentDurableApiRole(database.client, roleName)
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      command,
      roleName,
      status: 'verified',
      tablePrivilegeCount: verification.tablePrivileges.length,
      sequencePrivilegeCount: verification.sequencePrivileges.length,
    })}\n`)
  } finally {
    await database.close()
  }
} else {
  throw new Error('Usage: durable-api-role-cli.ts <provision|verify>')
}
