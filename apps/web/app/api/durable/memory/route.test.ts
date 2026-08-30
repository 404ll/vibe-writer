import {
  MemoryCandidateNotFoundError,
  MemoryNotFoundError,
  MemoryReviewConflictError,
  WorkspacePermissionError,
} from '@vibe-writer/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const durable = vi.hoisted(() => ({
  apiEnabled: vi.fn(),
  managementEnabled: vi.fn(),
  authorize: vi.fn(),
  listMemories: vi.fn(),
  listCandidates: vi.fn(),
  listCandidateEvents: vi.fn(),
  reviewCandidate: vi.fn(),
  deleteMemory: vi.fn(),
}))

vi.mock('@/server/database/durableDatabase', () => ({
  durableApiEnabled: durable.apiEnabled,
  durableMemoryManagementApiEnabled: durable.managementEnabled,
  authorizeDurableHeaders: durable.authorize,
  getWorkspaceDurableRepositories: () => ({
    memory: {
      listPage: durable.listMemories,
      listCandidatesPage: durable.listCandidates,
      listCandidateEvents: durable.listCandidateEvents,
      reviewCandidate: durable.reviewCandidate,
      delete: durable.deleteMemory,
    },
  }),
}))

import { DELETE as deleteMemory } from './[memoryId]/route'
import { GET as listCandidateEvents } from './candidates/[candidateId]/events/route'
import { POST as reviewCandidate } from './candidates/[candidateId]/review/route'
import { GET as listCandidates } from './candidates/route'
import { GET as listMemories } from './route'

const principalId = '11111111-1111-4111-8111-111111111111'
const workspaceId = '22222222-2222-4222-8222-222222222222'
const memoryId = '33333333-3333-4333-8333-333333333333'
const candidateId = '44444444-4444-4444-8444-444444444444'

const memoryRow = {
  id: memoryId,
  workspaceId,
  subjectKind: 'workspace' as const,
  subjectKey: 'default',
  memoryKey: 'writing.tone',
  kind: 'preference' as const,
  currentRevision: 2,
  currentContentFingerprint: `sha256:${'a'.repeat(64)}`,
  currentCandidateId: candidateId,
  expiresAt: new Date('2026-09-09T00:00:00.000Z'),
  createdAt: new Date('2026-08-09T00:00:00.000Z'),
  updatedAt: new Date('2026-08-09T01:00:00.000Z'),
}

const revisionRow = {
  memoryId,
  revision: 2,
  content: 'Prefer concise technical explanations.',
  contentFingerprint: `sha256:${'a'.repeat(64)}`,
  sourceCandidateId: candidateId,
  createdByPrincipalId: principalId,
  createdAt: new Date('2026-08-09T01:00:00.000Z'),
}

const candidateRow = {
  id: candidateId,
  workspaceId,
  sourceKind: 'signal' as const,
  sourceRunId: null,
  sourceSignalId: '55555555-5555-4555-8555-555555555555',
  subjectKind: 'workspace' as const,
  subjectKey: 'default',
  memoryKey: 'writing.tone',
  kind: 'preference' as const,
  content: 'Prefer concise technical explanations.',
  contentFingerprint: `sha256:${'b'.repeat(64)}`,
  proposedBy: 'model' as const,
  confidence: 0.95,
  sensitivity: 'normal' as const,
  consentBasis: 'explicit_user' as const,
  consentPolicyVersion: 'memory-consent-v1',
  evidenceFingerprint: `sha256:${'c'.repeat(64)}`,
  extractorKey: 'memory-extractor',
  extractorVersion: 'v1',
  policyVersion: '2026-08-07-v2',
  policyOutcome: 'conflict' as const,
  status: 'pending_review' as const,
  expiresAt: new Date('2026-09-09T00:00:00.000Z'),
  reviewedByPrincipalId: null,
  reviewedAt: null,
  decisionReasonCode: null,
  materializedMemoryId: null,
  materializedRevision: null,
  nextEventSeq: 1,
  createdAt: new Date('2026-08-09T00:30:00.000Z'),
  updatedAt: new Date('2026-08-09T00:30:00.000Z'),
}

const eventRow = {
  candidateId,
  seq: 0,
  eventType: 'proposed' as const,
  actorPrincipalId: principalId,
  reasonCode: 'policy_conflict_detected',
  createdAt: new Date('2026-08-09T00:30:00.000Z'),
}

function request(path: string, init?: RequestInit) {
  return new Request(`http://localhost/api/durable/memory${path}`, init)
}

describe('durable Memory management staging routes', () => {
  beforeEach(() => {
    for (const mock of Object.values(durable)) mock.mockReset()
    durable.apiEnabled.mockReturnValue(true)
    durable.managementEnabled.mockReturnValue(true)
    durable.authorize.mockResolvedValue({
      status: 'authorized',
      scope: {
        principalId,
        workspaceId,
        role: 'owner',
        authorization: 'verified-membership',
      },
    })
  })

  it('stays fail-closed behind its own feature flag and trusted identity', async () => {
    durable.managementEnabled.mockReturnValue(false)
    const disabled = await listMemories(request(''))
    expect(disabled.status).toBe(503)
    expect(durable.authorize).not.toHaveBeenCalled()

    durable.managementEnabled.mockReturnValue(true)
    durable.authorize.mockResolvedValue({ status: 'unauthenticated' })
    const unauthenticated = await listMemories(request(''))
    expect(unauthenticated.status).toBe(401)
    expect(durable.listMemories).not.toHaveBeenCalled()
  })

  it('projects active Memory content without internal fingerprints or candidate identity', async () => {
    durable.listMemories.mockResolvedValue({
      items: [{ memory: memoryRow, revision: revisionRow }],
      nextCursor: null,
    })
    const response = await listMemories(request(''))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body).toEqual({
      memories: [{
        id: memoryId,
        subject: { kind: 'workspace', key: 'default' },
        memory_key: 'writing.tone',
        kind: 'preference',
        content: 'Prefer concise technical explanations.',
        current_revision: 2,
        expires_at: '2026-09-09T00:00:00.000Z',
        created_at: '2026-08-09T00:00:00.000Z',
        updated_at: '2026-08-09T01:00:00.000Z',
      }],
      next_cursor: null,
    })
    expect(durable.listMemories).toHaveBeenCalledWith({ limit: 50 })
    expect(JSON.stringify(body)).not.toContain('fingerprint')
    expect(JSON.stringify(body)).not.toContain(candidateId)
  })

  it('keeps candidate content editor-only and omits source/evidence/actor identities', async () => {
    durable.listCandidates.mockRejectedValueOnce(new WorkspacePermissionError())
    const forbidden = await listCandidates(request('/candidates'))
    expect(forbidden.status).toBe(403)

    durable.listCandidates.mockResolvedValueOnce({ items: [candidateRow], nextCursor: null })
    const response = await listCandidates(request('/candidates'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      candidates: [{
        id: candidateId,
        source_kind: 'signal',
        content: candidateRow.content,
        policy_outcome: 'conflict',
        status: 'pending_review',
      }],
      next_cursor: null,
    })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(candidateRow.sourceSignalId)
    expect(serialized).not.toContain(candidateRow.evidenceFingerprint)
    expect(serialized).not.toContain('content_fingerprint')
    expect(serialized).not.toContain('reviewed_by')
  })

  it('rejects malformed cursors and forwards bounded page size', async () => {
    const invalid = await listMemories(request('?cursor=not-a-cursor'))
    expect(invalid.status).toBe(400)
    expect(durable.listMemories).not.toHaveBeenCalled()

    durable.listMemories.mockResolvedValue({ items: [], nextCursor: null })
    const bounded = await listMemories(request('?limit=100'))
    expect(bounded.status).toBe(200)
    expect(durable.listMemories).toHaveBeenCalledWith({ limit: 100 })

    const tooLarge = await listCandidates(request('/candidates?limit=101'))
    expect(tooLarge.status).toBe(400)
    expect(durable.listCandidates).not.toHaveBeenCalled()
  })

  it('returns a bounded candidate audit trail without actor identity', async () => {
    durable.listCandidateEvents.mockResolvedValue([eventRow])
    const response = await listCandidateEvents(
      request(`/candidates/${candidateId}/events`),
      { params: Promise.resolve({ candidateId }) },
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      candidate_id: candidateId,
      events: [{
        seq: 0,
        event_type: 'proposed',
        reason_code: 'policy_conflict_detected',
        created_at: '2026-08-09T00:30:00.000Z',
      }],
    })
    expect(JSON.stringify(body)).not.toContain(principalId)
  })

  it('materializes explicit conflicts, preserves replay and maps review collisions', async () => {
    durable.reviewCandidate.mockResolvedValueOnce({
      status: 'materialized',
      candidate: { ...candidateRow, status: 'materialized' },
      memory: memoryRow,
      replayed: false,
    })
    const materialized = await reviewCandidate(request(
      `/candidates/${candidateId}/review`,
      {
        method: 'POST',
        body: JSON.stringify({
          decision: 'materialize',
          reason_code: 'confirmed_change',
          replace_memory_id: memoryId,
        }),
      },
    ), { params: Promise.resolve({ candidateId }) })
    expect(materialized.status).toBe(200)
    await expect(materialized.json()).resolves.toEqual({
      status: 'materialized',
      candidate_id: candidateId,
      memory_id: memoryId,
      current_revision: 2,
      replayed: false,
    })
    expect(durable.reviewCandidate).toHaveBeenCalledWith({
      candidateId,
      decision: 'materialize',
      reasonCode: 'confirmed_change',
      replaceMemoryId: memoryId,
    })

    durable.reviewCandidate.mockRejectedValueOnce(new MemoryReviewConflictError())
    const collision = await reviewCandidate(request(
      `/candidates/${candidateId}/review`,
      {
        method: 'POST',
        body: JSON.stringify({
          decision: 'materialize',
          reason_code: 'confirmed_change',
          replace_memory_id: memoryId,
        }),
      },
    ), { params: Promise.resolve({ candidateId }) })
    expect(collision.status).toBe(409)
  })

  it('returns rejected replay, expired gone and candidate not-found distinctly', async () => {
    durable.reviewCandidate.mockResolvedValueOnce({
      status: 'rejected',
      candidate: { ...candidateRow, status: 'rejected' },
      replayed: true,
    }).mockResolvedValueOnce({ status: 'expired', candidateId })
      .mockRejectedValueOnce(new MemoryCandidateNotFoundError())

    const body = { decision: 'reject', reason_code: 'not_stable' }
    const rejected = await reviewCandidate(request(
      `/candidates/${candidateId}/review`,
      { method: 'POST', body: JSON.stringify(body) },
    ), { params: Promise.resolve({ candidateId }) })
    expect(rejected.status).toBe(200)
    await expect(rejected.json()).resolves.toMatchObject({
      status: 'rejected', replayed: true,
    })

    const expired = await reviewCandidate(request(
      `/candidates/${candidateId}/review`,
      { method: 'POST', body: JSON.stringify(body) },
    ), { params: Promise.resolve({ candidateId }) })
    expect(expired.status).toBe(410)
    await expect(expired.json()).resolves.toEqual({ status: 'expired', candidate_id: candidateId })

    const missing = await reviewCandidate(request(
      `/candidates/${candidateId}/review`,
      { method: 'POST', body: JSON.stringify(body) },
    ), { params: Promise.resolve({ candidateId }) })
    expect(missing.status).toBe(404)
  })

  it('validates review shape before the repository', async () => {
    const invalid = await reviewCandidate(request(
      `/candidates/${candidateId}/review`,
      {
        method: 'POST',
        body: JSON.stringify({
          decision: 'reject',
          reason_code: 'not_stable',
          replace_memory_id: memoryId,
        }),
      },
    ), { params: Promise.resolve({ candidateId }) })
    expect(invalid.status).toBe(400)
    expect(durable.reviewCandidate).not.toHaveBeenCalled()
  })

  it('returns a content-free owner deletion receipt and preserves repository authorization', async () => {
    durable.deleteMemory.mockRejectedValueOnce(new WorkspacePermissionError())
    const denied = await deleteMemory(request(`/${memoryId}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason_code: 'user_requested_erasure' }),
    }), { params: Promise.resolve({ memoryId }) })
    expect(denied.status).toBe(403)

    durable.deleteMemory.mockResolvedValueOnce({
      status: 'deleted',
      tombstone: {
        memoryId,
        workspaceId,
        slotFingerprint: `sha256:${'d'.repeat(64)}`,
        deletedByPrincipalId: principalId,
        reasonCode: 'user_requested_erasure',
        deletedAt: new Date('2026-08-09T02:00:00.000Z'),
      },
      replayed: false,
    })
    const deleted = await deleteMemory(request(`/${memoryId}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason_code: 'user_requested_erasure' }),
    }), { params: Promise.resolve({ memoryId }) })
    expect(deleted.status).toBe(200)
    const body = await deleted.json()
    expect(body).toEqual({
      status: 'deleted',
      memory_id: memoryId,
      reason_code: 'user_requested_erasure',
      deleted_at: '2026-08-09T02:00:00.000Z',
      replayed: false,
    })
    expect(JSON.stringify(body)).not.toContain('fingerprint')

    durable.deleteMemory.mockRejectedValueOnce(new MemoryNotFoundError())
    const missing = await deleteMemory(request(`/${memoryId}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason_code: 'incorrect' }),
    }), { params: Promise.resolve({ memoryId }) })
    expect(missing.status).toBe(404)
  })
})
