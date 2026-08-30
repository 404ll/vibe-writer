import 'server-only'

import type {
  MemoryCandidate,
  MemoryCandidateEvent,
} from '@vibe-writer/contracts/memory/management/candidates'
import type { ActiveMemory } from '@vibe-writer/contracts/memory/management/records'
import {
  MemoryCandidateNotFoundError,
  MemoryNotFoundError,
  MemoryReviewConflictError,
  WorkspacePermissionError,
  type MemoryCandidateEventRow,
  type MemoryCandidateRow,
  type MemoryRevisionRow,
  type MemoryRow,
} from '@vibe-writer/db'
import { conflict, forbidden, notFound, serverFailure } from '@/server/http/durableHttp'

export function toActiveMemory(input: {
  memory: MemoryRow
  revision: MemoryRevisionRow
}): ActiveMemory {
  return {
    id: input.memory.id,
    subject: {
      kind: input.memory.subjectKind,
      key: input.memory.subjectKey,
    },
    memory_key: input.memory.memoryKey,
    kind: input.memory.kind,
    content: input.revision.content,
    current_revision: input.memory.currentRevision,
    expires_at: input.memory.expiresAt.toISOString(),
    created_at: input.memory.createdAt.toISOString(),
    updated_at: input.memory.updatedAt.toISOString(),
  }
}

export function toMemoryCandidate(row: MemoryCandidateRow): MemoryCandidate {
  return {
    id: row.id,
    source_kind: row.sourceKind,
    subject: { kind: row.subjectKind, key: row.subjectKey },
    memory_key: row.memoryKey,
    kind: row.kind,
    content: row.content,
    proposed_by: row.proposedBy,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    consent: {
      basis: row.consentBasis,
      policy_version: row.consentPolicyVersion,
    },
    extractor: { key: row.extractorKey, version: row.extractorVersion },
    policy_version: row.policyVersion,
    policy_outcome: row.policyOutcome,
    status: row.status,
    expires_at: row.expiresAt.toISOString(),
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    decision_reason_code: row.decisionReasonCode,
    materialized_memory_id: row.materializedMemoryId,
    materialized_revision: row.materializedRevision,
    created_at: row.createdAt.toISOString(),
  }
}

export function toMemoryCandidateEvent(row: MemoryCandidateEventRow): MemoryCandidateEvent {
  return {
    seq: row.seq,
    event_type: row.eventType,
    reason_code: row.reasonCode,
    created_at: row.createdAt.toISOString(),
  }
}

export function memoryManagementRepositoryFailure(error: unknown): Response {
  if (error instanceof WorkspacePermissionError) return forbidden()
  if (error instanceof MemoryCandidateNotFoundError) {
    return notFound('Memory candidate not found.')
  }
  if (error instanceof MemoryNotFoundError) return notFound('Memory not found.')
  if (error instanceof MemoryReviewConflictError) {
    return conflict('Memory candidate review conflict.')
  }
  return serverFailure()
}
