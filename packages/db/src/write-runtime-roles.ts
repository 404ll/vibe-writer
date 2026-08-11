import type { Sql } from 'postgres'
import {
  assertCurrentPostgresRole,
  postgresRoleProvisioningStatements,
  provisionPostgresRole,
  verifyCurrentPostgresRole,
  type PostgresRoleContract,
  type PostgresRoleProvisioningMode,
  type PostgresRoleVerification,
  type PostgresTablePrivilege,
} from './postgres-role-contract'

export const WRITE_DISPATCHER_ROLE_TABLE_PRIVILEGES = {
  outbox_events: ['SELECT', 'UPDATE'],
} as const satisfies Record<string, readonly PostgresTablePrivilege[]>

export const WRITE_DISPATCHER_ROLE_CONTRACT = {
  key: 'write-dispatcher',
  bypassRls: false,
  tablePrivileges: WRITE_DISPATCHER_ROLE_TABLE_PRIVILEGES,
  sequencePrivileges: {},
} as const satisfies PostgresRoleContract

export const WRITE_CONSUMER_ROLE_TABLE_PRIVILEGES = {
  jobs: ['SELECT', 'UPDATE'],
  runs: ['SELECT', 'INSERT', 'UPDATE'],
  job_events: ['SELECT', 'INSERT'],
  run_effects: ['SELECT', 'INSERT', 'UPDATE'],
  trace_spans: ['SELECT', 'INSERT', 'UPDATE'],
  checkpoint_attempts: ['SELECT', 'INSERT', 'UPDATE'],
  job_interrupts: ['SELECT', 'INSERT'],
  job_commands: ['SELECT'],
  articles: ['SELECT', 'INSERT'],
  'langgraph_checkpoint.checkpoints': ['SELECT', 'INSERT', 'UPDATE'],
  'langgraph_checkpoint.checkpoint_blobs': ['SELECT', 'INSERT'],
  'langgraph_checkpoint.checkpoint_writes': ['SELECT', 'INSERT', 'UPDATE'],
} as const satisfies Record<string, readonly PostgresTablePrivilege[]>

export const WRITE_CONSUMER_ROLE_CONTRACT = {
  key: 'write-consumer',
  // Queue consumers claim jobs across workspaces without an end-user RLS session.
  // Exact schema/table privileges remain the containment boundary.
  bypassRls: true,
  schemaPrivileges: {
    public: ['USAGE'],
    langgraph_checkpoint: ['USAGE'],
  },
  tablePrivileges: WRITE_CONSUMER_ROLE_TABLE_PRIVILEGES,
  sequencePrivileges: {},
} as const satisfies PostgresRoleContract

export const WRITE_CONSUMER_SINGLE_WORKSPACE_ROLE_CONTRACT = {
  ...WRITE_CONSUMER_ROLE_CONTRACT,
  key: 'write-consumer-single-workspace',
  bypassRls: false,
} as const satisfies PostgresRoleContract

export type WriteRuntimeRole = 'dispatcher' | 'consumer'
export type WriteConsumerAccessMode = 'cross-workspace' | 'single-workspace'

export type WriteRuntimeRoleOptions = {
  consumerAccessMode?: WriteConsumerAccessMode
  provisioningMode?: PostgresRoleProvisioningMode
}

function contractFor(
  role: WriteRuntimeRole,
  consumerAccessMode: WriteConsumerAccessMode = 'cross-workspace',
): PostgresRoleContract {
  if (role === 'dispatcher') return WRITE_DISPATCHER_ROLE_CONTRACT
  return consumerAccessMode === 'single-workspace'
    ? WRITE_CONSUMER_SINGLE_WORKSPACE_ROLE_CONTRACT
    : WRITE_CONSUMER_ROLE_CONTRACT
}

export function writeRuntimeRoleProvisioningStatements(
  role: WriteRuntimeRole,
  roleName: string,
  consumerAccessMode: WriteConsumerAccessMode = 'cross-workspace',
): string[] {
  return postgresRoleProvisioningStatements(contractFor(role, consumerAccessMode), roleName)
}

export async function provisionWriteRuntimeRole(
  client: Sql,
  role: WriteRuntimeRole,
  roleName: string,
  options: WriteRuntimeRoleOptions = {},
): Promise<void> {
  await provisionPostgresRole(
    client,
    contractFor(role, options.consumerAccessMode),
    roleName,
    options.provisioningMode,
  )
}

export async function verifyCurrentWriteRuntimeRole(
  client: Sql,
  role: WriteRuntimeRole,
  expectedRoleName: string,
  consumerAccessMode: WriteConsumerAccessMode = 'cross-workspace',
): Promise<PostgresRoleVerification> {
  return verifyCurrentPostgresRole(
    client,
    contractFor(role, consumerAccessMode),
    expectedRoleName,
  )
}

export async function assertCurrentWriteRuntimeRole(
  client: Sql,
  role: WriteRuntimeRole,
  expectedRoleName: string,
  consumerAccessMode: WriteConsumerAccessMode = 'cross-workspace',
): Promise<PostgresRoleVerification> {
  return assertCurrentPostgresRole(
    client,
    contractFor(role, consumerAccessMode),
    expectedRoleName,
  )
}
