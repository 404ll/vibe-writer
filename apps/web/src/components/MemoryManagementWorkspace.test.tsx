import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryManagementBootstrapResponse } from '@vibe-writer/contracts/memory-policy'
import { MemoryManagementWorkspace } from './MemoryManagementWorkspace'

const principalId = '11111111-1111-4111-8111-111111111111'
const memoryId = '22222222-2222-4222-8222-222222222222'
const signalId = '33333333-3333-4333-8333-333333333333'
const candidateId = '44444444-4444-4444-8444-444444444444'
const now = '2026-08-09T00:00:00.000Z'
const later = '2026-09-08T00:00:00.000Z'

function bootstrap(role: 'viewer' | 'editor' | 'owner'): MemoryManagementBootstrapResponse {
  const canEdit = role !== 'viewer'
  return {
    policy: {
      schema_version: 1,
      version: 'memory-consent-v1',
      title: '长期记忆使用说明',
      summary: '只保存明确提交的稳定信息。',
      statements: [{
        key: 'explicit-consent',
        title: '明确提交才保存',
        description: '普通对话不会自动进入长期记忆。',
      }],
      retention: { minimum_days: 1, default_days: 30, maximum_days: 365 },
      allowed_signal_kinds: ['explicit_remember', 'preference_setting', 'correction'],
    },
    workspace: {
      role,
      capabilities: {
        read_active_memories: true,
        review_candidates: canEdit,
        delete_active_memories: role === 'owner',
        manage_own_signals: true,
        create_shared_signals: canEdit,
      },
      signal_subjects: [
        { subject: { kind: 'principal', key: principalId }, label: '仅自己' },
        ...(canEdit
          ? [{ subject: { kind: 'workspace' as const, key: 'default' }, label: '当前工作区' }]
          : []),
      ],
    },
    active: {
      memories: [{
        id: memoryId,
        subject: { kind: 'workspace', key: 'default' },
        memory_key: 'writing.tone',
        kind: 'preference',
        content: 'Prefer concise technical explanations.',
        current_revision: 1,
        expires_at: later,
        created_at: now,
        updated_at: now,
      }],
      next_cursor: null,
    },
    signals: {
      signals: [{
        id: signalId,
        source_kind: 'preference_setting',
        subject: { kind: 'principal', key: principalId },
        text: '先解释数据结构。',
        consent: { basis: 'explicit_user', policy_version: 'memory-consent-v1' },
        retention_until: later,
        created_at: now,
        source_run_id: null,
      }],
      next_cursor: null,
    },
    candidates: {
      candidates: canEdit ? [{
        id: candidateId,
        source_kind: 'signal',
        subject: { kind: 'workspace', key: 'default' },
        memory_key: 'writing.tone',
        kind: 'preference',
        content: 'Prefer examples before abstractions.',
        proposed_by: 'model',
        confidence: 0.94,
        sensitivity: 'normal',
        consent: { basis: 'explicit_user', policy_version: 'memory-consent-v1' },
        extractor: { key: 'memory-extractor', version: 'v1' },
        policy_version: '2026-08-07-v2',
        policy_outcome: 'conflict',
        status: 'pending_review',
        expires_at: later,
        reviewed_at: null,
        decision_reason_code: null,
        materialized_memory_id: null,
        materialized_revision: null,
        created_at: now,
      }] : [],
      next_cursor: null,
    },
  }
}

describe('Memory management workspace', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows registered policy and hides editor/owner operations from viewers', () => {
    render(<MemoryManagementWorkspace initialData={bootstrap('viewer')} />)
    expect(screen.getByRole('heading', { name: '长期记忆管理' })).toBeInTheDocument()
    expect(screen.getByText('长期记忆使用说明')).toBeInTheDocument()
    expect(screen.getByText('查看者')).toBeInTheDocument()
    expect(screen.getByText('Prefer concise technical explanations.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '提交一条明确记忆' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '候选治理' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '永久删除' })).not.toBeInTheDocument()
  })

  it('sends explicit replacement identity when an editor confirms a conflict', async () => {
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const [input] = args
      const url = String(input)
      if (url.includes(`/candidates/${candidateId}/review`)) {
        return Response.json({
          status: 'materialized',
          candidate_id: candidateId,
          memory_id: memoryId,
          current_revision: 2,
          replayed: false,
        })
      }
      if (url === '/api/durable/memory?limit=50') {
        return Response.json(bootstrap('editor').active)
      }
      return Response.json({ detail: 'Unexpected request' }, { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<MemoryManagementWorkspace initialData={bootstrap('editor')} />)

    fireEvent.click(screen.getByRole('button', { name: '确认生效' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const reviewCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes(`/candidates/${candidateId}/review`))
    expect(JSON.parse(String(reviewCall?.[1]?.body))).toEqual({
      decision: 'materialize',
      reason_code: 'confirmed_change',
      replace_memory_id: memoryId,
    })
    expect(await screen.findByText('候选记忆已生效。')).toBeInTheDocument()
  })

  it('requires visible policy confirmation before creating a signal', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      return Response.json({
        created: true,
        signal: {
          id: '55555555-5555-4555-8555-555555555555',
          source_kind: request.source_kind,
          subject: request.subject,
          text: request.text,
          consent: request.consent,
          retention_until: later,
          created_at: now,
          source_run_id: null,
        },
      }, { status: 201 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<MemoryManagementWorkspace initialData={bootstrap('viewer')} />)

    const submit = screen.getByRole('button', { name: '提交记忆来源' })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: '以后先给具体例子。' } })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(submit).toBeEnabled()
    fireEvent.click(submit)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const [, init] = fetchMock.mock.calls[0]!
    expect(JSON.parse(String(init?.body))).toMatchObject({
      text: '以后先给具体例子。',
      consent: { basis: 'explicit_user', policy_version: 'memory-consent-v1' },
      retention_days: 30,
    })
    expect(await screen.findByText('记忆来源已提交。')).toBeInTheDocument()
  })

  it('does not send owner erasure until the destructive confirmation is accepted', async () => {
    const confirm = vi.spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const fetchMock = vi.fn(async () => Response.json({
      status: 'deleted',
      memory_id: memoryId,
      reason_code: 'user_requested_erasure',
      deleted_at: now,
      replayed: false,
    }))
    vi.stubGlobal('fetch', fetchMock)
    render(<MemoryManagementWorkspace initialData={bootstrap('owner')} />)

    const erase = screen.getByRole('button', { name: '永久删除' })
    fireEvent.click(erase)
    expect(confirm).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(erase)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(screen.queryByText('Prefer concise technical explanations.')).not.toBeInTheDocument()
    expect(await screen.findByText('长期记忆已永久删除。')).toBeInTheDocument()
  })
})
