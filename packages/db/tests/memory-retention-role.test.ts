import { describe, expect, it } from 'vitest'
import {
  MEMORY_RETENTION_ROLE_CONTRACT,
  MEMORY_RETENTION_ROLE_SEQUENCE_PRIVILEGES,
  MEMORY_RETENTION_ROLE_TABLE_PRIVILEGES,
  memoryRetentionRoleProvisioningStatements,
} from '../src/memory-retention-role'

describe('Memory retention PostgreSQL role contract', () => {
  it('limits the cross-workspace maintenance role to expiry operations', () => {
    expect(MEMORY_RETENTION_ROLE_CONTRACT.bypassRls).toBe(true)
    expect(MEMORY_RETENTION_ROLE_TABLE_PRIVILEGES).toEqual({
      memory_source_signals: ['SELECT', 'UPDATE', 'DELETE'],
      memory_source_signal_tombstones: ['SELECT', 'INSERT'],
      memory_extraction_tasks: ['SELECT', 'UPDATE'],
      memory_extraction_attempts: ['SELECT', 'UPDATE'],
      memory_extraction_effects: ['SELECT', 'UPDATE'],
      outbox_events: ['SELECT', 'UPDATE'],
      memories: ['SELECT', 'UPDATE', 'DELETE'],
      memory_candidates: ['SELECT', 'UPDATE', 'DELETE'],
      memory_tombstones: ['SELECT', 'INSERT'],
    })
    expect(MEMORY_RETENTION_ROLE_SEQUENCE_PRIVILEGES).toEqual({})
    for (const privileges of Object.values(MEMORY_RETENTION_ROLE_TABLE_PRIVILEGES)) {
      expect(privileges).not.toContain('TRUNCATE')
      expect(privileges).not.toContain('REFERENCES')
      expect(privileges).not.toContain('TRIGGER')
    }
  })

  it('resets privileges and makes the exceptional RLS bypass explicit', () => {
    const statements = memoryRetentionRoleProvisioningStatements(
      'vibe_writer_memory_retention',
    )
    expect(statements[0]).toContain(
      'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS NOREPLICATION',
    )
    expect(statements).toContain(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "vibe_writer_memory_retention"',
    )
    expect(statements).toContain(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM "vibe_writer_memory_retention"',
    )
    expect(statements.some((statement) =>
      statement.startsWith('GRANT DELETE, SELECT, UPDATE ON TABLE ') &&
      statement.includes('public.memory_source_signals') &&
      statement.includes('public.memories') &&
      statement.includes('public.memory_candidates')
    )).toBe(true)
    expect(statements.some((statement) =>
      statement.startsWith('GRANT INSERT, SELECT ON TABLE ') &&
      statement.includes('public.memory_source_signal_tombstones') &&
      statement.includes('public.memory_tombstones')
    )).toBe(true)
  })

  it('rejects unsafe role identifiers through the shared role engine', () => {
    expect(() => memoryRetentionRoleProvisioningStatements('retention-role')).toThrow()
    expect(() => memoryRetentionRoleProvisioningStatements('role;drop')).toThrow()
    expect(() => memoryRetentionRoleProvisioningStatements('a'.repeat(64))).toThrow()
  })
})
