import type { Sql } from 'postgres'
import {
  assertCurrentPostgresRole,
  postgresRoleProvisioningStatements,
  provisionPostgresRole,
  verifyCurrentPostgresRole,
  type PostgresRoleContract,
  type PostgresRoleVerification,
  type PostgresTablePrivilege,
} from './postgres-role-contract'

export const MEMORY_RETENTION_ROLE_TABLE_PRIVILEGES = {
  memory_source_signals: ['SELECT', 'UPDATE', 'DELETE'],
  memory_source_signal_tombstones: ['SELECT', 'INSERT'],
  memory_extraction_tasks: ['SELECT', 'UPDATE'],
  memory_extraction_attempts: ['SELECT', 'UPDATE'],
  memory_extraction_effects: ['SELECT', 'UPDATE'],
  outbox_events: ['SELECT', 'UPDATE'],
  memories: ['SELECT', 'UPDATE', 'DELETE'],
  memory_candidates: ['SELECT', 'UPDATE', 'DELETE'],
  memory_tombstones: ['SELECT', 'INSERT'],
} as const satisfies Record<string, readonly PostgresTablePrivilege[]>

export const MEMORY_RETENTION_ROLE_SEQUENCE_PRIVILEGES = {} as const

export const MEMORY_RETENTION_ROLE_CONTRACT = {
  key: 'memory-retention',
  // Retention scans database-wide due indexes and intentionally has no end-user
  // workspace session. Exact table privileges are the containment boundary.
  bypassRls: true,
  tablePrivileges: MEMORY_RETENTION_ROLE_TABLE_PRIVILEGES,
  sequencePrivileges: MEMORY_RETENTION_ROLE_SEQUENCE_PRIVILEGES,
} as const satisfies PostgresRoleContract

export function memoryRetentionRoleProvisioningStatements(roleName: string): string[] {
  return postgresRoleProvisioningStatements(MEMORY_RETENTION_ROLE_CONTRACT, roleName)
}

export async function provisionMemoryRetentionRole(
  client: Sql,
  roleName: string,
): Promise<void> {
  await provisionPostgresRole(client, MEMORY_RETENTION_ROLE_CONTRACT, roleName)
}

export type MemoryRetentionRoleVerification = PostgresRoleVerification

export async function verifyCurrentMemoryRetentionRole(
  client: Sql,
  expectedRoleName: string,
): Promise<MemoryRetentionRoleVerification> {
  return verifyCurrentPostgresRole(
    client,
    MEMORY_RETENTION_ROLE_CONTRACT,
    expectedRoleName,
  )
}

export async function assertCurrentMemoryRetentionRole(
  client: Sql,
  expectedRoleName: string,
): Promise<MemoryRetentionRoleVerification> {
  return assertCurrentPostgresRole(
    client,
    MEMORY_RETENTION_ROLE_CONTRACT,
    expectedRoleName,
  )
}
