import { API_BASE } from '@/lib/config'
import {
  CreateJobRequestSchema,
  CreateJobResponseSchema,
  type CreateJobRequestInput,
  type CreateJobResponse,
} from '@vibe-writer/contracts/jobs'
import {
  clearPendingJobIdempotencyKey,
  resolveJobIdempotencyKey,
} from '@/lib/storage/jobIdempotency'

/** 创建写作任务，并带上可重放的 Idempotency-Key */
export async function createJob(input: CreateJobRequestInput): Promise<CreateJobResponse> {
  const request = CreateJobRequestSchema.parse(input)
  const idempotencyKey = resolveJobIdempotencyKey(request)
  const res = await fetch(`${API_BASE}/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(request),
  })
  if (!res.ok) throw new Error('Failed to create job')
  const created = CreateJobResponseSchema.parse(await res.json())
  // 成功拿到 job_id 后再丢掉待重放键，下一次用户提交才会生成新意图。
  clearPendingJobIdempotencyKey()
  return created
}
