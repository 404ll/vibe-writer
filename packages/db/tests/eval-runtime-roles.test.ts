import { describe, expect, it } from 'vitest'
import {
  EVAL_CONSUMER_ROLE_COLUMN_PRIVILEGES,
  EVAL_CONSUMER_ROLE_CONTRACT,
  EVAL_CONSUMER_ROLE_TABLE_PRIVILEGES,
  EVAL_DISPATCHER_ROLE_CONTRACT,
  EVAL_DISPATCHER_ROLE_TABLE_PRIVILEGES,
  EVAL_LIVE_SAMPLER_ROLE_COLUMN_PRIVILEGES,
  EVAL_LIVE_SAMPLER_ROLE_CONTRACT,
  EVAL_LIVE_SAMPLER_ROLE_TABLE_PRIVILEGES,
  evalRuntimeRoleProvisioningStatements,
} from '../src/eval-runtime-roles'

describe('Eval runtime PostgreSQL role contracts', () => {
  it('limits dispatcher and consumer to independent queue responsibilities', () => {
    expect(EVAL_DISPATCHER_ROLE_CONTRACT.bypassRls).toBe(false)
    expect(EVAL_DISPATCHER_ROLE_TABLE_PRIVILEGES).toEqual({
      outbox_events: ['SELECT', 'UPDATE'],
    })
    expect(EVAL_CONSUMER_ROLE_CONTRACT.bypassRls).toBe(true)
    expect(EVAL_CONSUMER_ROLE_TABLE_PRIVILEGES).toEqual({
      eval_runs: ['SELECT', 'UPDATE'],
      eval_suites: ['SELECT'],
      eval_cases: ['SELECT'],
      eval_candidates: ['SELECT'],
      eval_trials: ['INSERT'],
      eval_scores: ['INSERT'],
      memory_calibration_authorizations: ['SELECT'],
    })
    expect(EVAL_CONSUMER_ROLE_COLUMN_PRIVILEGES).toEqual({
      eval_trials: { id: ['SELECT'] },
    })
  })

  it('makes sampler source reads column-level and keeps article content inaccessible', () => {
    expect(EVAL_LIVE_SAMPLER_ROLE_CONTRACT.bypassRls).toBe(true)
    expect(EVAL_LIVE_SAMPLER_ROLE_TABLE_PRIVILEGES).toEqual({
      eval_sampling_policies: ['SELECT', 'UPDATE'],
      eval_candidates: ['SELECT', 'INSERT'],
      eval_candidate_events: ['INSERT'],
    })
    expect(EVAL_LIVE_SAMPLER_ROLE_COLUMN_PRIVILEGES.articles).toEqual({
      id: ['SELECT'],
      job_id: ['SELECT'],
      source_run_id: ['SELECT'],
      revision: ['SELECT'],
      content_fingerprint: ['SELECT'],
    })
    expect(EVAL_LIVE_SAMPLER_ROLE_COLUMN_PRIVILEGES.articles)
      .not.toHaveProperty('content')
    expect(EVAL_LIVE_SAMPLER_ROLE_COLUMN_PRIVILEGES.jobs)
      .not.toHaveProperty('topic')
  })

  it('generates explicit column grants and no full source table grants', () => {
    const statements = evalRuntimeRoleProvisioningStatements(
      'live-sampler',
      'vibe_writer_eval_sampler',
    )
    expect(statements[0]).toContain('NOINHERIT BYPASSRLS NOREPLICATION')
    expect(statements).toContain(
      'GRANT SELECT (id, job_id, source_run_id, revision, content_fingerprint) ON TABLE public.articles TO "vibe_writer_eval_sampler"',
    )
    expect(statements.some((statement) =>
      statement.startsWith('GRANT SELECT ON TABLE ') &&
      statement.includes('public.articles')
    )).toBe(false)
  })

  it('keeps all Eval runtime manifests free of destructive and DDL privileges', () => {
    for (const contract of [
      EVAL_DISPATCHER_ROLE_CONTRACT,
      EVAL_CONSUMER_ROLE_CONTRACT,
      EVAL_LIVE_SAMPLER_ROLE_CONTRACT,
    ]) {
      expect(contract.sequencePrivileges).toEqual({})
      for (const privileges of Object.values(contract.tablePrivileges)) {
        expect(privileges).not.toContain('DELETE')
        expect(privileges).not.toContain('TRUNCATE')
        expect(privileges).not.toContain('REFERENCES')
        expect(privileges).not.toContain('TRIGGER')
      }
    }
  })
})
