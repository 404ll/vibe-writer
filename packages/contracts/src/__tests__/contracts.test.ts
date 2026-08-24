import { describe, expect, it } from 'vitest'
import { CreateJobRequestSchema, ReplyRequestSchema } from '../jobs/commands'
import {
  DeleteMemoryRequestSchema,
  MemoryManagementPageQuerySchema,
  ReviewMemoryCandidateRequestSchema,
} from '../memory/management'
import {
  MemoryConsentPolicyDocumentSchema,
  MemoryPolicyAccessResponseSchema,
} from '../memory/policy'
import {
  CreateMemorySignalRequestSchema,
  DeleteMemorySignalRequestSchema,
  MemorySignalIdempotencyKeySchema,
  MemorySignalPageQuerySchema,
} from '../memory/signals'
import { SearchDocumentSchema, SearchRequestSchema } from '../research'
import {
  JobEventSchema,
  SSE_EVENT_GROUPS,
  SSE_EVENT_TYPES,
  TERMINAL_EVENTS,
} from '../jobs/sse'

describe('job contracts', () => {
  it('applies defaults compatible with the current FastAPI request model', () => {
    expect(CreateJobRequestSchema.parse({ topic: 'Agent 工程化' })).toEqual({
      topic: 'Agent 工程化',
      intervention: { on_outline: true },
      style: '',
    })
  })

  it('accepts outline replies used by the current review panel', () => {
    expect(
      ReplyRequestSchema.parse({ message: '确认', outline: ['第一章', '第二章'] }),
    ).toEqual({ message: '确认', outline: ['第一章', '第二章'] })
  })
})

describe('SSE contracts', () => {
  it('keeps a single ordered inventory for producers and consumers', () => {
    expect(SSE_EVENT_TYPES).toEqual([
      ...SSE_EVENT_GROUPS.lifecycle,
      ...SSE_EVENT_GROUPS.planning,
      ...SSE_EVENT_GROUPS.chapter,
      ...SSE_EVENT_GROUPS.review,
    ])
    expect([...TERMINAL_EVENTS]).toEqual(['done', 'cancelled', 'error'])
  })

  it('validates representative sequenced events', () => {
    expect(
      JobEventSchema.parse({
        event: 'writing_chapter',
        data: { title: '第一章', token: '正文', _seq: 7 },
      }),
    ).toEqual({
      event: 'writing_chapter',
      data: { title: '第一章', token: '正文', _seq: 7 },
    })
  })

  it('accepts Python file paths and a durable TS article without a local file', () => {
    const pythonDone = JobEventSchema.parse({
      event: 'done',
      data: { output_path: 'output/article.md', article_id: 'article-python' },
    })
    const typescriptDone = JobEventSchema.parse({
      event: 'done',
      data: { output_path: null, article_id: 'article-typescript' },
    })
    if (pythonDone.event !== 'done' || typescriptDone.event !== 'done') {
      throw new Error('Expected done events')
    }
    expect(pythonDone.data.output_path).toBe('output/article.md')
    expect(typescriptDone.data.output_path).toBeNull()
  })

  it('rejects unknown event names', () => {
    expect(() => JobEventSchema.parse({ event: 'unknown', data: {} })).toThrow()
  })
})

describe('research contracts', () => {
  it('accepts a provider-independent search request and source document', () => {
    expect(
      SearchRequestSchema.parse({
        query: '最新 Agent 评测',
        topic: 'news',
        searchDepth: 'advanced',
        maxResults: 5,
        startDate: '2026-05-09',
      }),
    ).toMatchObject({ topic: 'news', maxResults: 5 })
    expect(
      SearchDocumentSchema.parse({
        title: '来源',
        url: 'https://example.com/source',
        content: '摘要',
        publishedAt: '2026-08-01',
        score: 0.8,
      }),
    ).toMatchObject({ title: '来源', score: 0.8 })
  })

  it('rejects invalid source URLs and provider result limits', () => {
    expect(() =>
      SearchDocumentSchema.parse({ title: '来源', url: 'not-a-url', content: '摘要' }),
    ).toThrow()
    expect(() =>
      SearchRequestSchema.parse({
        query: '查询',
        topic: 'general',
        searchDepth: 'basic',
        maxResults: 21,
      }),
    ).toThrow()
    expect(() =>
      SearchDocumentSchema.parse({
        title: '来源',
        url: 'https://example.com/source',
        content: '摘要',
        publishedAt: '2026-08-01T00:30:00',
      }),
    ).toThrow()
  })
})

describe('Memory signal contracts', () => {
  it('requires explicit versioned consent and bounded retention', () => {
    expect(MemorySignalPageQuerySchema.parse({})).toEqual({ limit: 50 })
    expect(CreateMemorySignalRequestSchema.parse({
      source_kind: 'preference_setting',
      subject: { kind: 'principal', key: '11111111-1111-4111-8111-111111111111' },
      text: 'Prefer concise technical explanations.',
      consent: { basis: 'explicit_user', policy_version: 'memory-consent-v1' },
      retention_days: 30,
    })).toMatchObject({
      consent: { basis: 'explicit_user', policy_version: 'memory-consent-v1' },
      retention_days: 30,
    })
    expect(MemorySignalIdempotencyKeySchema.parse(' signal-request-1 '))
      .toBe('signal-request-1')
  })

  it('rejects implicit consent, unknown fields, invalid retention and free-form deletion reasons', () => {
    const valid = {
      source_kind: 'explicit_remember',
      subject: { kind: 'workspace', key: 'default' },
      text: 'Remember the shared writing rule.',
      consent: { basis: 'explicit_user', policy_version: 'memory-consent-v1' },
      retention_days: 30,
    }
    expect(() => CreateMemorySignalRequestSchema.parse({
      ...valid,
      consent: { basis: 'workspace_policy', policy_version: 'memory-consent-v1' },
    })).toThrow()
    expect(() => CreateMemorySignalRequestSchema.parse({
      ...valid,
      retention_days: 366,
    })).toThrow()
    expect(() => CreateMemorySignalRequestSchema.parse({
      ...valid,
      silently_enable_extraction: true,
    })).toThrow()
    expect(() => DeleteMemorySignalRequestSchema.parse({
      reason_code: 'arbitrary_unversioned_reason',
    })).toThrow()
  })
})

describe('Memory consent policy contracts', () => {
  const policy = {
    schema_version: 1 as const,
    version: 'memory-consent-v1',
    title: '长期记忆使用说明',
    summary: '只保存用户明确提交的稳定偏好。',
    statements: [{
      key: 'explicit-consent',
      title: '显式确认',
      description: '提交前必须展示并确认当前版本。',
    }],
    retention: { minimum_days: 1, default_days: 30, maximum_days: 365 },
    allowed_signal_kinds: ['explicit_remember', 'preference_setting', 'correction'],
  }

  it('keeps policy copy, retention and role capabilities versioned and strict', () => {
    expect(MemoryConsentPolicyDocumentSchema.parse(policy)).toEqual(policy)
    expect(MemoryPolicyAccessResponseSchema.parse({
      policy,
      workspace: {
        role: 'editor',
        capabilities: {
          read_active_memories: true,
          review_candidates: true,
          delete_active_memories: false,
          manage_own_signals: true,
          create_shared_signals: true,
        },
        signal_subjects: [{
          subject: { kind: 'principal', key: '11111111-1111-4111-8111-111111111111' },
          label: '仅自己',
        }],
      },
    })).toMatchObject({ workspace: { role: 'editor' } })
  })

  it('rejects inconsistent retention and unversioned capability fields', () => {
    expect(() => MemoryConsentPolicyDocumentSchema.parse({
      ...policy,
      retention: { minimum_days: 30, default_days: 7, maximum_days: 365 },
    })).toThrow()
    expect(() => MemoryPolicyAccessResponseSchema.parse({
      policy,
      workspace: {
        role: 'owner',
        capabilities: {
          read_active_memories: true,
          review_candidates: true,
          delete_active_memories: true,
          manage_own_signals: true,
          create_shared_signals: true,
          bypass_review: true,
        },
        signal_subjects: [],
      },
    })).toThrow()
  })
})

describe('Memory management contracts', () => {
  it('separates materialize, reject and owner erasure reasons', () => {
    expect(MemoryManagementPageQuerySchema.parse({})).toEqual({ limit: 50 })
    expect(MemoryManagementPageQuerySchema.parse({ limit: '100' })).toEqual({ limit: 100 })
    expect(ReviewMemoryCandidateRequestSchema.parse({
      decision: 'materialize',
      reason_code: 'confirmed_change',
      replace_memory_id: '11111111-1111-4111-8111-111111111111',
    })).toMatchObject({ decision: 'materialize', reason_code: 'confirmed_change' })
    expect(ReviewMemoryCandidateRequestSchema.parse({
      decision: 'reject',
      reason_code: 'not_stable',
    })).toEqual({ decision: 'reject', reason_code: 'not_stable' })
    expect(DeleteMemoryRequestSchema.parse({
      reason_code: 'user_requested_erasure',
    })).toEqual({ reason_code: 'user_requested_erasure' })
  })

  it('rejects replacement on rejection and arbitrary audit reasons', () => {
    expect(() => ReviewMemoryCandidateRequestSchema.parse({
      decision: 'reject',
      reason_code: 'not_stable',
      replace_memory_id: '11111111-1111-4111-8111-111111111111',
    })).toThrow()
    expect(() => ReviewMemoryCandidateRequestSchema.parse({
      decision: 'materialize',
      reason_code: 'free_form_reason',
    })).toThrow()
    expect(() => DeleteMemoryRequestSchema.parse({
      reason_code: 'hide_without_audit_contract',
    })).toThrow()
  })
})
