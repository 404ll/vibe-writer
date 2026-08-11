import type { Sql } from 'postgres'
import {
  assertCurrentPostgresRole,
  postgresRoleProvisioningStatements,
  provisionPostgresRole,
  verifyCurrentPostgresRole,
  type PostgresColumnPrivilege,
  type PostgresRoleContract,
  type PostgresRoleVerification,
  type PostgresTablePrivilege,
} from './postgres-role-contract'

export const EVAL_DISPATCHER_ROLE_TABLE_PRIVILEGES = {
  outbox_events: ['SELECT', 'UPDATE'],
} as const satisfies Record<string, readonly PostgresTablePrivilege[]>

export const EVAL_DISPATCHER_ROLE_CONTRACT = {
  key: 'eval-dispatcher',
  bypassRls: false,
  tablePrivileges: EVAL_DISPATCHER_ROLE_TABLE_PRIVILEGES,
  sequencePrivileges: {},
} as const satisfies PostgresRoleContract

export const EVAL_CONSUMER_ROLE_TABLE_PRIVILEGES = {
  eval_runs: ['SELECT', 'UPDATE'],
  eval_suites: ['SELECT'],
  eval_cases: ['SELECT'],
  eval_candidates: ['SELECT'],
  eval_trials: ['INSERT'],
  eval_scores: ['INSERT'],
  memory_calibration_authorizations: ['SELECT'],
} as const satisfies Record<string, readonly PostgresTablePrivilege[]>

export const EVAL_CONSUMER_ROLE_COLUMN_PRIVILEGES = {
  eval_trials: {
    id: ['SELECT'],
  },
} as const satisfies Record<
  string,
  Record<string, readonly PostgresColumnPrivilege[]>
>

export const EVAL_CONSUMER_ROLE_CONTRACT = {
  key: 'eval-consumer',
  // The consumer processes system suites and governed suites across workspaces.
  // Exact object privileges and target/retention checks contain the bypass.
  bypassRls: true,
  tablePrivileges: EVAL_CONSUMER_ROLE_TABLE_PRIVILEGES,
  columnPrivileges: EVAL_CONSUMER_ROLE_COLUMN_PRIVILEGES,
  sequencePrivileges: {},
} as const satisfies PostgresRoleContract

export const EVAL_LIVE_SAMPLER_ROLE_TABLE_PRIVILEGES = {
  eval_sampling_policies: ['SELECT', 'UPDATE'],
  eval_candidates: ['SELECT', 'INSERT'],
  eval_candidate_events: ['INSERT'],
} as const satisfies Record<string, readonly PostgresTablePrivilege[]>

export const EVAL_LIVE_SAMPLER_ROLE_COLUMN_PRIVILEGES = {
  jobs: {
    id: ['SELECT'],
    workspace_id: ['SELECT'],
    status: ['SELECT'],
  },
  runs: {
    id: ['SELECT'],
    job_id: ['SELECT'],
    status: ['SELECT'],
    finished_at: ['SELECT'],
  },
  articles: {
    id: ['SELECT'],
    job_id: ['SELECT'],
    source_run_id: ['SELECT'],
    revision: ['SELECT'],
    content_fingerprint: ['SELECT'],
  },
} as const satisfies Record<
  string,
  Record<string, readonly PostgresColumnPrivilege[]>
>

export const EVAL_LIVE_SAMPLER_ROLE_CONTRACT = {
  key: 'eval-live-sampler',
  // The scanner is database-wide but remains unable to read article body/topic
  // or unrelated job/run columns through column-level grants.
  bypassRls: true,
  tablePrivileges: EVAL_LIVE_SAMPLER_ROLE_TABLE_PRIVILEGES,
  columnPrivileges: EVAL_LIVE_SAMPLER_ROLE_COLUMN_PRIVILEGES,
  sequencePrivileges: {},
} as const satisfies PostgresRoleContract

export type EvalRuntimeRole = 'dispatcher' | 'consumer' | 'live-sampler'

function contractFor(role: EvalRuntimeRole): PostgresRoleContract {
  if (role === 'dispatcher') return EVAL_DISPATCHER_ROLE_CONTRACT
  if (role === 'consumer') return EVAL_CONSUMER_ROLE_CONTRACT
  return EVAL_LIVE_SAMPLER_ROLE_CONTRACT
}

export function evalRuntimeRoleProvisioningStatements(
  role: EvalRuntimeRole,
  roleName: string,
): string[] {
  return postgresRoleProvisioningStatements(contractFor(role), roleName)
}

export async function provisionEvalRuntimeRole(
  client: Sql,
  role: EvalRuntimeRole,
  roleName: string,
): Promise<void> {
  await provisionPostgresRole(client, contractFor(role), roleName)
}

export async function verifyCurrentEvalRuntimeRole(
  client: Sql,
  role: EvalRuntimeRole,
  expectedRoleName: string,
): Promise<PostgresRoleVerification> {
  return verifyCurrentPostgresRole(client, contractFor(role), expectedRoleName)
}

export async function assertCurrentEvalRuntimeRole(
  client: Sql,
  role: EvalRuntimeRole,
  expectedRoleName: string,
): Promise<PostgresRoleVerification> {
  return assertCurrentPostgresRole(client, contractFor(role), expectedRoleName)
}
