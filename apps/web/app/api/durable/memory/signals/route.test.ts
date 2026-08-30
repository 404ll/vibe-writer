import {
  MemorySourceSignalConflictError,
  MemorySourceSignalNotFoundError,
  WorkspacePermissionError,
} from '@vibe-writer/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const durable = vi.hoisted(() => ({
  apiEnabled: vi.fn(),
  memoryEnabled: vi.fn(),
  policyVersion: vi.fn(),
  authorize: vi.fn(),
  create: vi.fn(),
  listOwnPage: vi.fn(),
  delete: vi.fn(),
}))

vi.mock('@/server/database/durableDatabase', () => ({
  durableApiEnabled: durable.apiEnabled,
  durableMemorySignalApiEnabled: durable.memoryEnabled,
  getMemoryConsentPolicyVersion: durable.policyVersion,
  authorizeDurableHeaders: durable.authorize,
  getWorkspaceDurableRepositories: () => ({
    memorySourceSignals: {
      create: durable.create,
      listOwnPage: durable.listOwnPage,
      delete: durable.delete,
    },
  }),
}))

import { DELETE } from './[signalId]/route'
import { GET, POST } from './route'

const principalId = '11111111-1111-4111-8111-111111111111'
const workspaceId = '22222222-2222-4222-8222-222222222222'
const signalId = '33333333-3333-4333-8333-333333333333'
const signalRow = {
  id: signalId,
  workspaceId,
  createdByPrincipalId: principalId,
  sourceRunId: null,
  idempotencyKey: 'signal-request-1',
  requestFingerprint: `sha256:${'a'.repeat(64)}`,
  sourceKind: 'preference_setting' as const,
  subjectKind: 'principal' as const,
  subjectKey: principalId,
  sourceText: 'Prefer concise technical explanations.',
  evidenceFingerprint: `sha256:${'b'.repeat(64)}`,
  consentBasis: 'explicit_user' as const,
  consentPolicyVersion: 'memory-consent-v1',
  retentionUntil: new Date('2026-09-08T00:00:00.000Z'),
  createdAt: new Date('2026-08-09T00:00:00.000Z'),
  updatedAt: new Date('2026-08-09T00:00:00.000Z'),
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    source_kind: 'preference_setting',
    subject: { kind: 'principal', key: principalId },
    text: 'Prefer concise technical explanations.',
    consent: { basis: 'explicit_user', policy_version: 'memory-consent-v1' },
    retention_days: 30,
    ...overrides,
  }
}

function createRequest(
  body: unknown = createBody(),
  idempotencyKey: string | null = 'signal-request-1',
) {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (idempotencyKey !== null) headers.set('idempotency-key', idempotencyKey)
  return new Request('http://localhost/api/durable/memory/signals', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('durable Memory signal staging routes', () => {
  beforeEach(() => {
    for (const mock of Object.values(durable)) mock.mockReset()
    durable.apiEnabled.mockReturnValue(true)
    durable.memoryEnabled.mockReturnValue(true)
    durable.policyVersion.mockReturnValue('memory-consent-v1')
    durable.authorize.mockResolvedValue({
      status: 'authorized',
      scope: {
        principalId,
        workspaceId,
        role: 'viewer',
        authorization: 'verified-membership',
      },
    })
  })

  it('stays fail-closed behind an independent feature flag and policy configuration', async () => {
    durable.memoryEnabled.mockReturnValue(false)
    const disabled = await POST(createRequest())
    expect(disabled.status).toBe(503)
    expect(durable.authorize).not.toHaveBeenCalled()

    durable.memoryEnabled.mockReturnValue(true)
    durable.policyVersion.mockReturnValue(null)
    const unconfigured = await POST(createRequest())
    expect(unconfigured.status).toBe(503)
    await expect(unconfigured.json()).resolves.toEqual({
      detail: 'Durable Memory signal API configuration is incomplete.',
    })
    expect(durable.create).not.toHaveBeenCalled()
  })

  it('requires a stable idempotency key and the currently configured consent policy', async () => {
    const missingKey = await POST(createRequest(createBody(), null))
    expect(missingKey.status).toBe(428)
    const stalePolicy = await POST(createRequest(createBody({
      consent: { basis: 'explicit_user', policy_version: 'memory-consent-v0' },
    })))
    expect(stalePolicy.status).toBe(409)
    await expect(stalePolicy.json()).resolves.toEqual({
      detail: 'Memory consent policy version conflict.',
      current_policy_version: 'memory-consent-v1',
    })
    expect(durable.create).not.toHaveBeenCalled()
  })

  it('creates a personal signal for a viewer and exposes no internal fingerprints', async () => {
    durable.create.mockResolvedValue({ signal: signalRow, created: true })
    const response = await POST(createRequest())
    expect(response.status).toBe(201)
    expect(response.headers.get('location')).toBe(
      `/api/durable/memory/signals/${signalId}`,
    )
    await expect(response.json()).resolves.toEqual({
      created: true,
      signal: {
        id: signalId,
        source_kind: 'preference_setting',
        subject: { kind: 'principal', key: principalId },
        text: 'Prefer concise technical explanations.',
        consent: { basis: 'explicit_user', policy_version: 'memory-consent-v1' },
        retention_until: '2026-09-08T00:00:00.000Z',
        created_at: '2026-08-09T00:00:00.000Z',
        source_run_id: null,
      },
    })
    expect(durable.create).toHaveBeenCalledWith({
      idempotencyKey: 'signal-request-1',
      sourceKind: 'preference_setting',
      subject: { kind: 'principal', key: principalId },
      text: 'Prefer concise technical explanations.',
      consentPolicyVersion: 'memory-consent-v1',
      retentionDays: 30,
      sourceRunId: undefined,
    })
  })

  it('returns 200 for exact replay and 409 for key reuse with drift', async () => {
    durable.create.mockResolvedValueOnce({ signal: signalRow, created: false })
      .mockRejectedValueOnce(new MemorySourceSignalConflictError())
    const replay = await POST(createRequest())
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ created: false })
    const collision = await POST(createRequest())
    expect(collision.status).toBe(409)
  })

  it('lists only the authorized principal own active signals without caching', async () => {
    durable.listOwnPage.mockResolvedValue({ items: [signalRow], nextCursor: null })
    const response = await GET(
      new Request('http://localhost/api/durable/memory/signals'),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({
      signals: [{ id: signalId, text: signalRow.sourceText }],
      next_cursor: null,
    })
    expect(durable.listOwnPage).toHaveBeenCalledWith({ limit: 50 })
  })

  it('rejects malformed signal cursors and enforces the page maximum', async () => {
    const invalid = await GET(new Request(
      'http://localhost/api/durable/memory/signals?cursor=not-a-cursor',
    ))
    expect(invalid.status).toBe(400)
    expect(durable.listOwnPage).not.toHaveBeenCalled()

    durable.listOwnPage.mockResolvedValue({ items: [], nextCursor: null })
    const bounded = await GET(new Request(
      'http://localhost/api/durable/memory/signals?limit=100',
    ))
    expect(bounded.status).toBe(200)
    expect(durable.listOwnPage).toHaveBeenCalledWith({ limit: 100 })

    const tooLarge = await GET(new Request(
      'http://localhost/api/durable/memory/signals?limit=101',
    ))
    expect(tooLarge.status).toBe(400)
  })

  it('preserves repository subject and deletion authorization decisions', async () => {
    durable.create.mockRejectedValueOnce(new WorkspacePermissionError())
    const shared = await POST(createRequest(createBody({
      subject: { kind: 'workspace', key: 'default' },
    })))
    expect(shared.status).toBe(403)

    durable.delete.mockResolvedValue({
      status: 'deleted',
      tombstone: {
        sourceSignalId: signalId,
        workspaceId,
        deletedByPrincipalId: principalId,
        reasonCode: 'user_revoked',
        deletedAt: new Date('2026-08-09T01:00:00.000Z'),
      },
      replayed: false,
    })
    const deleted = await DELETE(new Request(
      `http://localhost/api/durable/memory/signals/${signalId}`,
      { method: 'DELETE', body: JSON.stringify({ reason_code: 'user_revoked' }) },
    ), { params: Promise.resolve({ signalId }) })
    expect(deleted.status).toBe(200)
    await expect(deleted.json()).resolves.toEqual({
      status: 'deleted',
      source_signal_id: signalId,
      reason_code: 'user_revoked',
      deleted_at: '2026-08-09T01:00:00.000Z',
      replayed: false,
    })
  })

  it('rejects malformed deletion and hides missing signal/source-run distinctions', async () => {
    const malformed = await DELETE(new Request(
      `http://localhost/api/durable/memory/signals/${signalId}`,
      { method: 'DELETE', body: JSON.stringify({ reason_code: 'free-form' }) },
    ), { params: Promise.resolve({ signalId }) })
    expect(malformed.status).toBe(400)
    expect(durable.delete).not.toHaveBeenCalled()

    durable.delete.mockRejectedValue(new MemorySourceSignalNotFoundError())
    const missing = await DELETE(new Request(
      `http://localhost/api/durable/memory/signals/${signalId}`,
      { method: 'DELETE', body: JSON.stringify({ reason_code: 'incorrect' }) },
    ), { params: Promise.resolve({ signalId }) })
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({
      detail: 'Memory signal or source run not found.',
    })
  })
})
