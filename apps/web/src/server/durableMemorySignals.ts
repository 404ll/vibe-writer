import 'server-only'

import type { MemorySignal } from '@vibe-writer/contracts/memory-signals'
import {
  MemorySourceSignalConflictError,
  MemorySourceSignalNotFoundError,
  WorkspacePermissionError,
  type MemorySourceSignalRow,
} from '@vibe-writer/db'
import {
  conflict,
  forbidden,
  notFound,
  serverFailure,
} from './durableHttp'

export function toMemorySignal(row: MemorySourceSignalRow): MemorySignal {
  return {
    id: row.id,
    source_kind: row.sourceKind,
    subject: { kind: row.subjectKind, key: row.subjectKey },
    text: row.sourceText,
    consent: {
      basis: 'explicit_user',
      policy_version: row.consentPolicyVersion,
    },
    retention_until: row.retentionUntil.toISOString(),
    created_at: row.createdAt.toISOString(),
    source_run_id: row.sourceRunId,
  }
}

export function memorySignalRepositoryFailure(error: unknown): Response {
  if (error instanceof WorkspacePermissionError) return forbidden()
  if (error instanceof MemorySourceSignalConflictError) {
    return conflict('Memory signal idempotency conflict.')
  }
  if (error instanceof MemorySourceSignalNotFoundError) {
    return notFound('Memory signal or source run not found.')
  }
  return serverFailure()
}
