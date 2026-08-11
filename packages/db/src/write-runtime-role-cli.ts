import { createPostgresDatabase } from './client'
import {
  assertCurrentWriteRuntimeRole,
  provisionWriteRuntimeRole,
  type WriteConsumerAccessMode,
  type WriteRuntimeRole,
} from './write-runtime-roles'
import type { PostgresRoleProvisioningMode } from './postgres-role-contract'

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
const consumerAccessMode = (
  process.env.WRITE_CONSUMER_ACCESS_MODE?.trim() || 'cross-workspace'
) as WriteConsumerAccessMode
if (!['cross-workspace', 'single-workspace'].includes(consumerAccessMode)) {
  throw new Error('WRITE_CONSUMER_ACCESS_MODE must be cross-workspace or single-workspace')
}
const provisioningMode = (
  process.env.POSTGRES_ROLE_PROVISIONING_MODE?.trim() || 'full'
) as PostgresRoleProvisioningMode
if (!['full', 'managed-service'].includes(provisioningMode)) {
  throw new Error('POSTGRES_ROLE_PROVISIONING_MODE must be full or managed-service')
}

if (command === 'provision') {
  const database = createPostgresDatabase(requiredEnvironment('DATABASE_ADMIN_URL'), { max: 1 })
  try {
    await provisionWriteRuntimeRole(database.client, role, roleName, {
      consumerAccessMode,
      provisioningMode,
    })
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      command,
      runtimeRole: role,
      consumerAccessMode,
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
      consumerAccessMode,
    )
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      command,
      runtimeRole: role,
      consumerAccessMode,
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
