'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import {
  DeleteMemoryRequestSchema,
  DeleteMemoryResponseSchema,
  ListActiveMemoriesResponseSchema,
  ListMemoryCandidateEventsResponseSchema,
  ListMemoryCandidatesResponseSchema,
  ReviewMemoryCandidateRequestSchema,
  ReviewMemoryCandidateResponseSchema,
  type MemoryCandidate,
  type MemoryCandidateEvent,
} from '@vibe-writer/contracts/memory-management'
import type { MemoryManagementBootstrapResponse } from '@vibe-writer/contracts/memory-policy'
import {
  CreateMemorySignalRequestSchema,
  CreateMemorySignalResponseSchema,
  DeleteMemorySignalRequestSchema,
  DeleteMemorySignalResponseSchema,
  ListMemorySignalsResponseSchema,
  type MemorySourceSignalKind,
} from '@vibe-writer/contracts/memory-signals'

type Props = { initialData: MemoryManagementBootstrapResponse }
type Notice = { kind: 'success' | 'error'; text: string } | null
type AuditState = { status: 'loading' | 'ready' | 'error'; events: MemoryCandidateEvent[] }

const ROLE_LABELS = { viewer: '查看者', editor: '编辑者', owner: '所有者' } as const
const SIGNAL_KIND_LABELS: Record<MemorySourceSignalKind, string> = {
  explicit_remember: '明确记住',
  preference_setting: '偏好设置',
  correction: '纠正信息',
}
const MEMORY_KIND_LABELS = {
  preference: '偏好',
  constraint: '约束',
  correction: '纠正',
} as const
const STATUS_LABELS = {
  pending_review: '待审核',
  materialized: '已生效',
  rejected: '已拒绝',
  expired: '已过期',
} as const
const DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeZone: 'UTC',
})

function appendUnique<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const ids = new Set(current.map((item) => item.id))
  return [...current, ...incoming.filter((item) => !ids.has(item.id))]
}

async function readJson(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = body && typeof body === 'object' && 'detail' in body
      ? String((body as { detail: unknown }).detail)
      : `请求失败（${response.status}）`
    throw new Error(detail)
  }
  return body
}

function sameSlot(candidate: MemoryCandidate, memory: Props['initialData']['active']['memories'][number]) {
  return candidate.subject.kind === memory.subject.kind &&
    candidate.subject.key === memory.subject.key &&
    candidate.memory_key === memory.memory_key
}

export function MemoryManagementWorkspace({ initialData }: Props) {
  const [active, setActive] = useState(initialData.active)
  const [signals, setSignals] = useState(initialData.signals)
  const [candidates, setCandidates] = useState(initialData.candidates)
  const [notice, setNotice] = useState<Notice>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [audit, setAudit] = useState<Record<string, AuditState>>({})
  const [sourceKind, setSourceKind] = useState<MemorySourceSignalKind>('preference_setting')
  const [subjectIndex, setSubjectIndex] = useState(0)
  const [signalText, setSignalText] = useState('')
  const [retentionDays, setRetentionDays] = useState(
    initialData.policy.retention.default_days,
  )
  const [consentConfirmed, setConsentConfirmed] = useState(false)

  const capabilities = initialData.workspace.capabilities
  const selectedSubject = initialData.workspace.signal_subjects[subjectIndex]

  async function createSignal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedSubject || !consentConfirmed) return
    setBusyKey('create-signal')
    setNotice(null)
    try {
      const request = CreateMemorySignalRequestSchema.parse({
        source_kind: sourceKind,
        subject: selectedSubject.subject,
        text: signalText,
        consent: {
          basis: 'explicit_user',
          policy_version: initialData.policy.version,
        },
        retention_days: retentionDays,
      })
      const response = await fetch('/api/durable/memory/signals', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `memory-ui-${crypto.randomUUID()}`,
        },
        body: JSON.stringify(request),
      })
      const created = CreateMemorySignalResponseSchema.parse(await readJson(response))
      setSignals((current) => ({
        ...current,
        signals: [
          created.signal,
          ...current.signals.filter((signal) => signal.id !== created.signal.id),
        ],
      }))
      setSignalText('')
      setConsentConfirmed(false)
      setNotice({ kind: 'success', text: created.created ? '记忆来源已提交。' : '相同请求已存在。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '提交失败。' })
    } finally {
      setBusyKey(null)
    }
  }

  async function deleteSignal(signalId: string) {
    if (!window.confirm('确认撤回这条来源并删除由它派生的长期记忆吗？')) return
    setBusyKey(`signal:${signalId}`)
    setNotice(null)
    try {
      const request = DeleteMemorySignalRequestSchema.parse({ reason_code: 'user_revoked' })
      const response = await fetch(`/api/durable/memory/signals/${signalId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      DeleteMemorySignalResponseSchema.parse(await readJson(response))
      setSignals((current) => ({
        ...current,
        signals: current.signals.filter((signal) => signal.id !== signalId),
      }))
      setNotice({ kind: 'success', text: '来源内容及其派生记忆已删除。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '删除失败。' })
    } finally {
      setBusyKey(null)
    }
  }

  async function deleteMemory(memoryId: string) {
    if (!window.confirm('确认永久删除这条长期记忆及其版本记录吗？此操作不可恢复。')) return
    setBusyKey(`memory:${memoryId}`)
    setNotice(null)
    try {
      const request = DeleteMemoryRequestSchema.parse({
        reason_code: 'user_requested_erasure',
      })
      const response = await fetch(`/api/durable/memory/${memoryId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      DeleteMemoryResponseSchema.parse(await readJson(response))
      setActive((current) => ({
        ...current,
        memories: current.memories.filter((memory) => memory.id !== memoryId),
      }))
      setNotice({ kind: 'success', text: '长期记忆已永久删除。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '删除失败。' })
    } finally {
      setBusyKey(null)
    }
  }

  async function reviewCandidate(candidate: MemoryCandidate, decision: 'materialize' | 'reject') {
    setBusyKey(`candidate:${candidate.id}`)
    setNotice(null)
    try {
      const replacement = candidate.policy_outcome === 'conflict'
        ? active.memories.find((memory) => sameSlot(candidate, memory))
        : undefined
      if (decision === 'materialize' && candidate.policy_outcome === 'conflict' && !replacement) {
        throw new Error('找不到需要显式替换的当前记忆，请刷新后重试。')
      }
      const request = ReviewMemoryCandidateRequestSchema.parse(
        decision === 'materialize'
          ? {
              decision,
              reason_code: candidate.kind === 'constraint'
                ? 'confirmed_constraint'
                : candidate.kind === 'correction'
                  ? 'confirmed_correction'
                  : candidate.policy_outcome === 'conflict'
                    ? 'confirmed_change'
                    : 'confirmed_preference',
              ...(replacement ? { replace_memory_id: replacement.id } : {}),
            }
          : { decision, reason_code: 'not_stable' },
      )
      const response = await fetch(`/api/durable/memory/candidates/${candidate.id}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      const reviewed = ReviewMemoryCandidateResponseSchema.parse(await readJson(response))
      setCandidates((current) => ({
        ...current,
        candidates: current.candidates.map((item) => item.id === candidate.id
          ? {
              ...item,
              status: reviewed.status === 'materialized' ? 'materialized' : reviewed.status,
              materialized_memory_id: reviewed.status === 'materialized'
                ? reviewed.memory_id
                : item.materialized_memory_id,
              materialized_revision: reviewed.status === 'materialized'
                ? reviewed.current_revision
                : item.materialized_revision,
            }
          : item),
      }))
      let refreshFailed = false
      if (reviewed.status === 'materialized') {
        try {
          await reloadActive()
        } catch {
          refreshFailed = true
        }
      }
      setNotice({
        kind: 'success',
        text: reviewed.status === 'materialized'
          ? refreshFailed
            ? '候选记忆已生效，但当前列表刷新失败；请重新打开页面确认。'
            : '候选记忆已生效。'
          : '候选记忆已拒绝。',
      })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '审核失败。' })
    } finally {
      setBusyKey(null)
    }
  }

  async function reloadActive() {
    const response = await fetch('/api/durable/memory?limit=50', { cache: 'no-store' })
    setActive(ListActiveMemoriesResponseSchema.parse(await readJson(response)))
  }

  async function loadMoreActive() {
    if (!active.next_cursor) return
    await loadPage(
      `/api/durable/memory?limit=50&cursor=${encodeURIComponent(active.next_cursor)}`,
      ListActiveMemoriesResponseSchema,
      (page) => setActive((current) => ({
        memories: appendUnique(current.memories, page.memories),
        next_cursor: page.next_cursor,
      })),
      'active-page',
    )
  }

  async function loadMoreSignals() {
    if (!signals.next_cursor) return
    await loadPage(
      `/api/durable/memory/signals?limit=50&cursor=${encodeURIComponent(signals.next_cursor)}`,
      ListMemorySignalsResponseSchema,
      (page) => setSignals((current) => ({
        signals: appendUnique(current.signals, page.signals),
        next_cursor: page.next_cursor,
      })),
      'signal-page',
    )
  }

  async function loadMoreCandidates() {
    if (!candidates.next_cursor) return
    await loadPage(
      `/api/durable/memory/candidates?limit=50&cursor=${encodeURIComponent(candidates.next_cursor)}`,
      ListMemoryCandidatesResponseSchema,
      (page) => setCandidates((current) => ({
        candidates: appendUnique(current.candidates, page.candidates),
        next_cursor: page.next_cursor,
      })),
      'candidate-page',
    )
  }

  async function loadPage<T>(
    url: string,
    schema: { parse(value: unknown): T },
    apply: (page: T) => void,
    key: string,
  ) {
    setBusyKey(key)
    setNotice(null)
    try {
      const response = await fetch(url, { cache: 'no-store' })
      apply(schema.parse(await readJson(response)))
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '加载失败。' })
    } finally {
      setBusyKey(null)
    }
  }

  async function toggleAudit(candidateId: string) {
    if (audit[candidateId]?.status === 'ready') {
      setAudit((current) => {
        const next = { ...current }
        delete next[candidateId]
        return next
      })
      return
    }
    setAudit((current) => ({
      ...current,
      [candidateId]: { status: 'loading', events: [] },
    }))
    try {
      const response = await fetch(
        `/api/durable/memory/candidates/${candidateId}/events`,
        { cache: 'no-store' },
      )
      const result = ListMemoryCandidateEventsResponseSchema.parse(await readJson(response))
      setAudit((current) => ({
        ...current,
        [candidateId]: { status: 'ready', events: result.events },
      }))
    } catch {
      setAudit((current) => ({
        ...current,
        [candidateId]: { status: 'error', events: [] },
      }))
    }
  }

  return (
    <div className="memory-shell">
      <header className="memory-nav">
        <Link href="/" className="ghost-button memory-back-link">返回写作</Link>
        <div>
          <span className="memory-role">{ROLE_LABELS[initialData.workspace.role]}</span>
          <code>{initialData.policy.version}</code>
        </div>
      </header>

      <main className="memory-main">
        <section className="memory-heading">
          <p className="card-label">MEMORY / GOVERNANCE</p>
          <h1>长期记忆管理</h1>
          <p>查看系统正在使用的内容，并在同一个治理平面里提交、审核或删除。</p>
        </section>

        {notice ? (
          <div className={`memory-notice memory-notice--${notice.kind}`} role="status">
            {notice.text}
          </div>
        ) : null}

        <section className="card memory-policy-card" aria-labelledby="memory-policy-title">
          <p className="card-label">CONSENT POLICY</p>
          <h2 id="memory-policy-title">{initialData.policy.title}</h2>
          <p>{initialData.policy.summary}</p>
          <div className="memory-policy-grid">
            {initialData.policy.statements.map((statement) => (
              <article key={statement.key}>
                <h3>{statement.title}</h3>
                <p>{statement.description}</p>
              </article>
            ))}
          </div>
          <p className="memory-meta">
            保留期：{initialData.policy.retention.minimum_days}–{initialData.policy.retention.maximum_days} 天，默认 {initialData.policy.retention.default_days} 天
          </p>
        </section>

        {capabilities.manage_own_signals ? (
          <section className="card memory-section" aria-labelledby="memory-create-title">
            <p className="card-label">EXPLICIT SOURCE</p>
            <h2 id="memory-create-title">提交一条明确记忆</h2>
            <form className="memory-form" onSubmit={createSignal}>
              <label>
                类型
                <select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as MemorySourceSignalKind)}>
                  {initialData.policy.allowed_signal_kinds.map((kind) => (
                    <option key={kind} value={kind}>{SIGNAL_KIND_LABELS[kind]}</option>
                  ))}
                </select>
              </label>
              <label>
                范围
                <select value={subjectIndex} onChange={(event) => setSubjectIndex(Number(event.target.value))}>
                  {initialData.workspace.signal_subjects.map((option, index) => (
                    <option key={`${option.subject.kind}:${option.subject.key}`} value={index}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                保留天数
                <input
                  type="number"
                  min={initialData.policy.retention.minimum_days}
                  max={initialData.policy.retention.maximum_days}
                  value={retentionDays}
                  onChange={(event) => setRetentionDays(Number(event.target.value))}
                />
              </label>
              <label className="memory-form-wide">
                内容
                <textarea
                  value={signalText}
                  onChange={(event) => setSignalText(event.target.value)}
                  placeholder="例如：技术说明优先给出具体数据结构，再解释执行流。"
                  maxLength={20_000}
                  required
                />
              </label>
              <label className="memory-consent memory-form-wide">
                <input
                  type="checkbox"
                  checked={consentConfirmed}
                  onChange={(event) => setConsentConfirmed(event.target.checked)}
                />
                我已阅读并同意 {initialData.policy.version}，确认将这段内容作为长期记忆来源。
              </label>
              <button
                type="submit"
                className="btn-primary memory-form-wide"
                disabled={!consentConfirmed || !signalText.trim() || busyKey !== null}
              >
                {busyKey === 'create-signal' ? '提交中…' : '提交记忆来源'}
              </button>
            </form>
          </section>
        ) : null}

        <section className="card memory-section" aria-labelledby="active-memory-title">
          <div className="memory-section-heading">
            <div>
              <p className="card-label">ACTIVE MEMORY</p>
              <h2 id="active-memory-title">当前生效</h2>
            </div>
            <span>{active.memories.length}</span>
          </div>
          <div className="memory-list">
            {active.memories.length === 0 ? <p className="memory-empty">暂无生效记忆。</p> : null}
            {active.memories.map((memory) => (
              <article key={memory.id} className="memory-item">
                <div className="memory-item-heading">
                  <div>
                    <span className="memory-chip">{MEMORY_KIND_LABELS[memory.kind]}</span>
                    <code>{memory.memory_key}</code>
                  </div>
                  <span>r{memory.current_revision}</span>
                </div>
                <p>{memory.content}</p>
                <p className="memory-meta">到期：{DATE_FORMATTER.format(new Date(memory.expires_at))}</p>
                {capabilities.delete_active_memories ? (
                  <button
                    type="button"
                    className="ghost-button danger-button"
                    disabled={busyKey !== null}
                    onClick={() => deleteMemory(memory.id)}
                  >
                    {busyKey === `memory:${memory.id}` ? '删除中…' : '永久删除'}
                  </button>
                ) : null}
              </article>
            ))}
          </div>
          {active.next_cursor ? (
            <button type="button" className="ghost-button" onClick={loadMoreActive} disabled={busyKey !== null}>
              加载更多生效记忆
            </button>
          ) : null}
        </section>

        {capabilities.manage_own_signals ? (
          <section className="card memory-section" aria-labelledby="memory-sources-title">
            <div className="memory-section-heading">
              <div>
                <p className="card-label">MY SOURCES</p>
                <h2 id="memory-sources-title">我的来源内容</h2>
              </div>
              <span>{signals.signals.length}</span>
            </div>
            <div className="memory-list">
              {signals.signals.length === 0 ? <p className="memory-empty">暂无有效来源。</p> : null}
              {signals.signals.map((signal) => (
                <article key={signal.id} className="memory-item">
                  <div className="memory-item-heading">
                    <span className="memory-chip">{SIGNAL_KIND_LABELS[signal.source_kind]}</span>
                    <span>{signal.subject.kind === 'principal' ? '仅自己' : '当前工作区'}</span>
                  </div>
                  <p>{signal.text}</p>
                  <p className="memory-meta">保留至：{DATE_FORMATTER.format(new Date(signal.retention_until))}</p>
                  <button
                    type="button"
                    className="ghost-button danger-button"
                    disabled={busyKey !== null}
                    onClick={() => deleteSignal(signal.id)}
                  >
                    {busyKey === `signal:${signal.id}` ? '撤回中…' : '撤回并删除派生内容'}
                  </button>
                </article>
              ))}
            </div>
            {signals.next_cursor ? (
              <button type="button" className="ghost-button" onClick={loadMoreSignals} disabled={busyKey !== null}>
                加载更多来源
              </button>
            ) : null}
          </section>
        ) : null}

        {capabilities.review_candidates ? (
          <section className="card memory-section memory-section-wide" aria-labelledby="candidate-title">
            <div className="memory-section-heading">
              <div>
                <p className="card-label">CANDIDATE REVIEW</p>
                <h2 id="candidate-title">候选治理</h2>
              </div>
              <span>{candidates.candidates.length}</span>
            </div>
            <div className="memory-list">
              {candidates.candidates.length === 0 ? <p className="memory-empty">暂无候选项。</p> : null}
              {candidates.candidates.map((candidate) => {
                const auditState = audit[candidate.id]
                return (
                  <article key={candidate.id} className="memory-item memory-candidate">
                    <div className="memory-item-heading">
                      <div>
                        <span className="memory-chip">{STATUS_LABELS[candidate.status]}</span>
                        <code>{candidate.memory_key}</code>
                      </div>
                      <span>{Math.round(candidate.confidence * 100)}%</span>
                    </div>
                    <p>{candidate.content}</p>
                    <p className="memory-meta">
                      {MEMORY_KIND_LABELS[candidate.kind]} · {candidate.source_kind === 'signal' ? '用户来源' : '运行来源'} · policy {candidate.policy_version}
                    </p>
                    <div className="memory-actions">
                      <button type="button" className="ghost-button" onClick={() => toggleAudit(candidate.id)}>
                        {auditState?.status === 'ready' ? '收起审计' : '查看审计'}
                      </button>
                      {candidate.status === 'pending_review' ? (
                        <>
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={busyKey !== null}
                            onClick={() => reviewCandidate(candidate, 'materialize')}
                          >确认生效</button>
                          <button
                            type="button"
                            className="ghost-button danger-button"
                            disabled={busyKey !== null}
                            onClick={() => reviewCandidate(candidate, 'reject')}
                          >拒绝</button>
                        </>
                      ) : null}
                    </div>
                    {auditState ? (
                      <div className="memory-audit" aria-live="polite">
                        {auditState.status === 'loading' ? <p>读取中…</p> : null}
                        {auditState.status === 'error' ? <p>审计记录读取失败。</p> : null}
                        {auditState.events.map((event) => (
                          <p key={event.seq}>
                            #{event.seq} {event.event_type} / {event.reason_code}
                          </p>
                        ))}
                      </div>
                    ) : null}
                  </article>
                )
              })}
            </div>
            {candidates.next_cursor ? (
              <button type="button" className="ghost-button" onClick={loadMoreCandidates} disabled={busyKey !== null}>
                加载更多候选项
              </button>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  )
}
