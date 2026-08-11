import { createPostgresDatabase } from './client'
import {
  assertCurrentEvalRuntimeRole,
  provisionEvalRuntimeRole,
  type EvalRuntimeRole,
} from './eval-runtime-roles'

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const role = process.argv[2] as EvalRuntimeRole | undefined
const command = process.argv[3]
if (!role || !['dispatcher', 'consumer', 'live-sampler'].includes(role)) {
  throw new Error(
    'Usage: eval-runtime-role-cli.ts <dispatcher|consumer|live-sampler> <provision|verify>',
  )
}

const roleEnvironment = {
  dispatcher: 'EVAL_DISPATCHER_DATABASE_ROLE',
  consumer: 'EVAL_CONSUMER_DATABASE_ROLE',
  'live-sampler': 'EVAL_LIVE_SAMPLER_DATABASE_ROLE',
} as const
const urlEnvironment = {
  dispatcher: 'DATABASE_EVAL_DISPATCHER_URL',
  consumer: 'DATABASE_EVAL_CONSUMER_URL',
  'live-sampler': 'DATABASE_EVAL_LIVE_SAMPLER_URL',
} as const
const roleName = requiredEnvironment(roleEnvironment[role])

if (command === 'provision') {
  const database = createPostgresDatabase(requiredEnvironment('DATABASE_ADMIN_URL'), { max: 1 })
  try {
    await provisionEvalRuntimeRole(database.client, role, roleName)
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
  const database = createPostgresDatabase(
    requiredEnvironment(urlEnvironment[role]),
    { max: 1 },
  )
  try {
    const verification = await assertCurrentEvalRuntimeRole(
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
      columnPrivilegeCount: verification.columnPrivileges.length,
      sequencePrivilegeCount: verification.sequencePrivileges.length,
    })}\n`)
  } finally {
    await database.close()
  }
} else {
  throw new Error(
    'Usage: eval-runtime-role-cli.ts <dispatcher|consumer|live-sampler> <provision|verify>',
  )
}
