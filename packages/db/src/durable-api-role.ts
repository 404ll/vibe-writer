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

export {
  POSTGRES_TABLE_PRIVILEGES,
  type PostgresTablePrivilege,
} from './postgres-role-contract'

export const DURABLE_API_ROLE_TABLE_PRIVILEGES = {
  principals: ['SELECT'],
  workspaces: ['SELECT'],
  workspace_memberships: ['SELECT'],
  jobs: ['SELECT', 'INSERT', 'UPDATE'],
  runs: ['SELECT'],
  job_events: ['SELECT', 'INSERT'],
  job_interrupts: ['SELECT', 'UPDATE'],
  job_commands: ['SELECT', 'INSERT'],
  outbox_events: ['SELECT', 'INSERT', 'UPDATE'],
  articles: ['SELECT', 'UPDATE'],
  article_versions: ['SELECT', 'INSERT'],
  memory_source_signals: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  memory_source_signal_tombstones: ['SELECT', 'INSERT'],
  memory_extraction_tasks: ['SELECT', 'UPDATE'],
  memory_extraction_attempts: ['SELECT', 'UPDATE'],
  memory_extraction_effects: ['SELECT', 'UPDATE'],
  memory_candidates: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  memory_candidate_events: ['SELECT', 'INSERT'],
  memories: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  memory_revisions: ['SELECT', 'INSERT'],
  memory_tombstones: ['SELECT', 'INSERT'],
} as const satisfies Record<string, readonly PostgresTablePrivilege[]>

export const DURABLE_API_ROLE_SEQUENCE_PRIVILEGES = {
  article_versions_id_seq: ['SELECT', 'USAGE'],
} as const

export const DURABLE_API_ROLE_CONTRACT = {
  key: 'durable-api',
  bypassRls: false,
  tablePrivileges: DURABLE_API_ROLE_TABLE_PRIVILEGES,
  sequencePrivileges: DURABLE_API_ROLE_SEQUENCE_PRIVILEGES,
} as const satisfies PostgresRoleContract

export function durableApiRoleProvisioningStatements(roleName: string): string[] {
  return postgresRoleProvisioningStatements(DURABLE_API_ROLE_CONTRACT, roleName)
}

export async function provisionDurableApiRole(
  client: Sql,
  roleName: string,
  mode: PostgresRoleProvisioningMode = 'full',
): Promise<void> {
  await provisionPostgresRole(client, DURABLE_API_ROLE_CONTRACT, roleName, mode)
}

export type DurableApiRoleVerification = PostgresRoleVerification

export async function verifyCurrentDurableApiRole(
  client: Sql,
  expectedRoleName: string,
): Promise<DurableApiRoleVerification> {
  return verifyCurrentPostgresRole(client, DURABLE_API_ROLE_CONTRACT, expectedRoleName)
}

export async function assertCurrentDurableApiRole(
  client: Sql,
  expectedRoleName: string,
): Promise<DurableApiRoleVerification> {
  return assertCurrentPostgresRole(client, DURABLE_API_ROLE_CONTRACT, expectedRoleName)
}
