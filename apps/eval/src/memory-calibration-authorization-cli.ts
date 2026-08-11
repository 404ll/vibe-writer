import { readFileSync } from 'node:fs'
import {
  createMemoryCalibrationAuthorizationRepository,
  createPostgresDatabase,
  createWorkspaceRepository,
} from '@vibe-writer/db'
import { MemoryCalibrationAuthorizationService } from './memory-calibration-authorization.ts'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function main() {
  const [command, manifestPath, ...rest] = process.argv.slice(2)
  if (!command || rest.length > 0 || !['register', 'approve', 'enqueue'].includes(command)) {
    throw new Error('Usage: memory-calibration:authorize <register manifest-path|approve|enqueue>')
  }
  if ((command === 'register') !== Boolean(manifestPath)) {
    throw new Error('register requires exactly one manifest path; approve and enqueue require none')
  }
  const database = createPostgresDatabase(required('EVAL_DATABASE_URL'), { max: 2 })
  try {
    const scope = await createWorkspaceRepository(database.db).authorize({
      workspaceId: required('EVAL_WORKSPACE_ID'),
      principalId: required('EVAL_PRINCIPAL_ID'),
    })
    if (!scope) throw new Error('Active workspace membership is required')
    const service = new MemoryCalibrationAuthorizationService(
      createMemoryCalibrationAuthorizationRepository(database.db),
    )
    if (command === 'register') {
      const result = await service.register(scope, {
        idempotencyKey: required('EVAL_IDEMPOTENCY_KEY'),
        execution: JSON.parse(readFileSync(manifestPath!, 'utf8')),
      })
      output({
        status: result.authorization.status,
        authorizationId: result.authorization.id,
        created: result.created,
        bindingFingerprint: result.authorization.bindingFingerprint,
      })
      return
    }
    const input = {
      authorizationId: required('EVAL_MEMORY_CALIBRATION_AUTHORIZATION_ID'),
      expectedBindingFingerprint: required('EVAL_MEMORY_CALIBRATION_BINDING_FINGERPRINT'),
    }
    if (command === 'approve') {
      const result = await service.approve(scope, {
        ...input,
        reasonCode: required('EVAL_MEMORY_CALIBRATION_APPROVAL_REASON'),
      })
      output({
        status: result.authorization.status,
        authorizationId: result.authorization.id,
        approvalId: result.authorization.approvalId,
        approved: result.approved,
      })
      return
    }
    const result = await service.enqueue(scope, input)
    output({
      status: result.authorization.status,
      authorizationId: result.authorization.id,
      evalRunId: result.run.id,
      enqueued: result.enqueued,
    })
  } finally {
    await database.close()
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown calibration authorization error'
  process.stderr.write(`${JSON.stringify({ status: 'error', message })}\n`)
  process.exitCode = 1
})
