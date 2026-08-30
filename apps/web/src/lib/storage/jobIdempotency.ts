import {
  CreateJobRequestSchema,
  type CreateJobRequestInput,
} from '@vibe-writer/contracts/jobs'

export const PENDING_JOB_IDEMPOTENCY_STORAGE_KEY = 'vibe-writer:pending-job-idempotency:v1'

type PendingJobIdempotency = {
  fingerprint: string //指纹哈希
  key: string
}

function browserSessionStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.sessionStorage
}

/** 用规范化后的创建请求做指纹，避免同一提交因字段缺省被当成新意图。 */
function requestFingerprint(input: CreateJobRequestInput): string {
  const request = CreateJobRequestSchema.parse(input)
  return JSON.stringify({
    topic: request.topic,
    style: request.style,
    target_words: request.target_words ?? null,
    intervention: request.intervention,
  })
}

// 读取本地存储中的幂等键
function readPending(): PendingJobIdempotency | null {
  const raw = browserSessionStorage()?.getItem(PENDING_JOB_IDEMPOTENCY_STORAGE_KEY)
  if (!raw) return null
  try {
    const pending = JSON.parse(raw) as PendingJobIdempotency
    if (typeof pending.fingerprint === 'string' && typeof pending.key === 'string' && pending.key) {
      return pending
    }
  } catch {
    // 损坏的本地指针不能继续当幂等事实用
  }
  return null
}

// 写入本地存储中的幂等键
function writePending(pending: PendingJobIdempotency) {
  browserSessionStorage()?.setItem(PENDING_JOB_IDEMPOTENCY_STORAGE_KEY, JSON.stringify(pending))
}

export function clearPendingJobIdempotencyKey() {
  browserSessionStorage()?.removeItem(PENDING_JOB_IDEMPOTENCY_STORAGE_KEY)
}

/**
 * 为同一次创建意图提供稳定 Idempotency-Key。
 * 网络重试复用同一键；换主题或上次已成功则签发新键。
 */
export function resolveJobIdempotencyKey(input: CreateJobRequestInput): string {
  const fingerprint = requestFingerprint(input)
  const pending = readPending()
  if (pending?.fingerprint === fingerprint) return pending.key

  const key = `job-ui-${crypto.randomUUID()}`
  writePending({ fingerprint, key })
  return key
}
