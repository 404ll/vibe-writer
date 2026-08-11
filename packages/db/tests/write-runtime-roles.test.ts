import { describe, expect, it } from 'vitest'
import {
  WRITE_CONSUMER_ROLE_CONTRACT,
  WRITE_CONSUMER_ROLE_TABLE_PRIVILEGES,
  WRITE_DISPATCHER_ROLE_CONTRACT,
  WRITE_DISPATCHER_ROLE_TABLE_PRIVILEGES,
  writeRuntimeRoleProvisioningStatements,
} from '../src/write-runtime-roles'

describe('Write runtime PostgreSQL role contracts', () => {
  it('limits the dispatcher to claiming and settling outbox rows', () => {
    expect(WRITE_DISPATCHER_ROLE_CONTRACT.bypassRls).toBe(false)
    expect(WRITE_DISPATCHER_ROLE_TABLE_PRIVILEGES).toEqual({
      outbox_events: ['SELECT', 'UPDATE'],
    })
    expect(WRITE_DISPATCHER_ROLE_CONTRACT.sequencePrivileges).toEqual({})
  })

  it('limits the cross-workspace consumer to its durable and checkpoint call chain', () => {
    expect(WRITE_CONSUMER_ROLE_CONTRACT.bypassRls).toBe(true)
    expect(WRITE_CONSUMER_ROLE_CONTRACT.schemaPrivileges).toEqual({
      public: ['USAGE'],
      langgraph_checkpoint: ['USAGE'],
    })
    expect(WRITE_CONSUMER_ROLE_TABLE_PRIVILEGES).toMatchObject({
      jobs: ['SELECT', 'UPDATE'],
      job_commands: ['SELECT'],
      articles: ['SELECT', 'INSERT'],
      'langgraph_checkpoint.checkpoints': ['SELECT', 'INSERT', 'UPDATE'],
      'langgraph_checkpoint.checkpoint_blobs': ['SELECT', 'INSERT'],
      'langgraph_checkpoint.checkpoint_writes': ['SELECT', 'INSERT', 'UPDATE'],
    })
    expect(WRITE_CONSUMER_ROLE_TABLE_PRIVILEGES).not.toHaveProperty('article_versions')
    for (const privileges of Object.values(WRITE_CONSUMER_ROLE_TABLE_PRIVILEGES)) {
      expect(privileges).not.toContain('DELETE')
      expect(privileges).not.toContain('TRUNCATE')
      expect(privileges).not.toContain('REFERENCES')
      expect(privileges).not.toContain('TRIGGER')
    }
  })

  it('resets both managed schemas before granting the consumer contract', () => {
    const statements = writeRuntimeRoleProvisioningStatements(
      'consumer',
      'vibe_writer_write_consumer',
    )
    expect(statements[0]).toContain('NOINHERIT BYPASSRLS NOREPLICATION')
    expect(statements).toContain(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "vibe_writer_write_consumer"',
    )
    expect(statements).toContain(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA langgraph_checkpoint FROM "vibe_writer_write_consumer"',
    )
    expect(statements).toContain(
      'GRANT USAGE ON SCHEMA langgraph_checkpoint TO "vibe_writer_write_consumer"',
    )
    expect(statements.some((statement) =>
      statement.startsWith('GRANT INSERT, SELECT, UPDATE ON TABLE ') &&
      statement.includes('langgraph_checkpoint.checkpoints') &&
      statement.includes('langgraph_checkpoint.checkpoint_writes')
    )).toBe(true)
  })

  it('keeps dispatcher and consumer manifests independent', () => {
    const dispatcher = writeRuntimeRoleProvisioningStatements(
      'dispatcher',
      'vibe_writer_write_dispatcher',
    ).join('\n')
    expect(dispatcher).toContain('NOINHERIT NOBYPASSRLS NOREPLICATION')
    expect(dispatcher).not.toContain('langgraph_checkpoint')
    expect(dispatcher).not.toContain('public.jobs')
  })
})
