import { describe, expect, it } from 'vitest'
import {
  DURABLE_API_ROLE_SEQUENCE_PRIVILEGES,
  DURABLE_API_ROLE_TABLE_PRIVILEGES,
  durableApiRoleProvisioningStatements,
} from '../src/durable-api-role'

describe('Durable API PostgreSQL role contract', () => {
  it('keeps authentication, durable HTTP writes, Memory governance, and no DDL explicit', () => {
    expect(DURABLE_API_ROLE_TABLE_PRIVILEGES).toMatchObject({
      workspace_memberships: ['SELECT'],
      jobs: ['SELECT', 'INSERT', 'UPDATE'],
      articles: ['SELECT', 'UPDATE'],
      outbox_events: ['SELECT', 'INSERT', 'UPDATE'],
      memory_source_signals: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      memory_candidates: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      memories: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    })
    expect(DURABLE_API_ROLE_SEQUENCE_PRIVILEGES).toEqual({
      article_versions_id_seq: ['SELECT', 'USAGE'],
    })
    for (const privileges of Object.values(DURABLE_API_ROLE_TABLE_PRIVILEGES)) {
      expect(privileges).not.toContain('TRUNCATE')
      expect(privileges).not.toContain('REFERENCES')
      expect(privileges).not.toContain('TRIGGER')
    }
  })

  it('generates an exact reset-before-grant contract for a constrained role', () => {
    const statements = durableApiRoleProvisioningStatements('vibe_writer_api')
    expect(statements[0]).toContain(
      'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION',
    )
    expect(statements).toContain(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "vibe_writer_api"',
    )
    expect(statements).toContain('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    expect(statements).toContain(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM "vibe_writer_api"',
    )
    expect(statements.some((statement) =>
      statement.startsWith('GRANT DELETE, INSERT, SELECT, UPDATE ON TABLE ') &&
      statement.includes('public.memory_candidates')
    )).toBe(true)
  })

  it('rejects names that cannot be safely interpolated as PostgreSQL identifiers', () => {
    expect(() => durableApiRoleProvisioningStatements('api-role')).toThrow()
    expect(() => durableApiRoleProvisioningStatements('api;drop_role')).toThrow()
    expect(() => durableApiRoleProvisioningStatements('A'.repeat(64))).toThrow()
  })
})
