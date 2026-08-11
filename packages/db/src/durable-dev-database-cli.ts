import {
  assertCurrentDurableApiRole,
  provisionDurableApiRole,
} from './durable-api-role'
import { createPostgresDatabase } from './client'
import { migrateVibePostgresDatabase } from './migrations'
import {
  assertCurrentWriteRuntimeRole,
  provisionWriteRuntimeRole,
  type WriteConsumerAccessMode,
} from './write-runtime-roles'
import type { PostgresRoleProvisioningMode } from './postgres-role-contract'

const ROLE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function quoteIdentifier(value: string): string {
  if (!ROLE_PATTERN.test(value)) throw new Error(`Invalid local PostgreSQL role: ${value}`)
  return `"${value}"`
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function ensureLoginRole(
  database: ReturnType<typeof createPostgresDatabase>,
  role: string,
  password: string,
): Promise<void> {
  const [existing] = await database.client<{ exists: boolean }[]>`
    select exists(select 1 from pg_roles where rolname = ${role}) as exists
  `
  if (!existing?.exists) {
    await database.client.unsafe(
      `CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
    )
  } else {
    await database.client.unsafe(
      `ALTER ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
    )
  }
}

async function prepare(): Promise<void> {
  const database = createPostgresDatabase(required('DATABASE_ADMIN_URL'), { max: 1 })
  try {
    await migrateVibePostgresDatabase(database.db)
    await ensureLoginRole(
      database,
      required('DURABLE_API_ROLE'),
      required('DURABLE_API_ROLE_PASSWORD'),
    )
    await ensureLoginRole(
      database,
      required('WRITE_DISPATCHER_DATABASE_ROLE'),
      required('WRITE_DISPATCHER_DATABASE_PASSWORD'),
    )
    await ensureLoginRole(
      database,
      required('WRITE_CONSUMER_DATABASE_ROLE'),
      required('WRITE_CONSUMER_DATABASE_PASSWORD'),
    )
  } finally {
    await database.close()
  }
}

async function provision(): Promise<void> {
  const apiRole = required('DURABLE_API_ROLE')
  const dispatcherRole = required('WRITE_DISPATCHER_DATABASE_ROLE')
  const consumerRole = required('WRITE_CONSUMER_DATABASE_ROLE')
  const consumerAccessMode = (
    process.env.WRITE_CONSUMER_ACCESS_MODE?.trim() || 'cross-workspace'
  ) as WriteConsumerAccessMode
  const provisioningMode = (
    process.env.POSTGRES_ROLE_PROVISIONING_MODE?.trim() || 'full'
  ) as PostgresRoleProvisioningMode
  if (!['cross-workspace', 'single-workspace'].includes(consumerAccessMode)) {
    throw new Error('WRITE_CONSUMER_ACCESS_MODE must be cross-workspace or single-workspace')
  }
  if (!['full', 'managed-service'].includes(provisioningMode)) {
    throw new Error('POSTGRES_ROLE_PROVISIONING_MODE must be full or managed-service')
  }
  const admin = createPostgresDatabase(required('DATABASE_ADMIN_URL'), { max: 1 })
  try {
    await provisionDurableApiRole(admin.client, apiRole, provisioningMode)
    await provisionWriteRuntimeRole(admin.client, 'dispatcher', dispatcherRole, {
      provisioningMode,
    })
    await provisionWriteRuntimeRole(admin.client, 'consumer', consumerRole, {
      consumerAccessMode,
      provisioningMode,
    })
  } finally {
    await admin.close()
  }

  const api = createPostgresDatabase(required('DATABASE_API_URL'), { max: 1 })
  const dispatcher = createPostgresDatabase(
    required('DATABASE_WRITE_DISPATCHER_URL'),
    { max: 1 },
  )
  const consumer = createPostgresDatabase(
    required('DATABASE_WRITE_CONSUMER_URL'),
    { max: 1 },
  )
  try {
    await assertCurrentDurableApiRole(api.client, apiRole)
    await assertCurrentWriteRuntimeRole(dispatcher.client, 'dispatcher', dispatcherRole)
    await assertCurrentWriteRuntimeRole(
      consumer.client,
      'consumer',
      consumerRole,
      consumerAccessMode,
    )
  } finally {
    await Promise.all([api.close(), dispatcher.close(), consumer.close()])
  }
}

const action = process.argv[2]
if (action === 'prepare') {
  await prepare()
} else if (action === 'provision') {
  await provision()
} else {
  throw new Error('Usage: durable-dev-database-cli.ts prepare|provision')
}

process.stdout.write(JSON.stringify({ status: 'ready', action }) + '\n')
