import type { RunnableConfig } from '@langchain/core/runnables'
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import type {
  ActivateCheckpointAttemptResult,
  AdvanceCheckpointPointerResult,
  CheckpointAttemptRow,
  CheckpointAuthorizationResult,
  LeaseIdentity,
  PrepareCheckpointAttemptResult,
} from '@vibe-writer/db'

export type CheckpointAttemptControl = {
  prepareCheckpointAttempt(
    identity: LeaseIdentity,
  ): Promise<PrepareCheckpointAttemptResult>
  activateCheckpointAttempt(
    identity: LeaseIdentity,
    attemptId: string,
    copiedCheckpointId: string | null,
  ): Promise<ActivateCheckpointAttemptResult>
  authorizeCheckpointWrite(
    identity: LeaseIdentity,
    storageThreadId: string,
  ): Promise<CheckpointAuthorizationResult>
  advanceCheckpointPointer(
    identity: LeaseIdentity,
    storageThreadId: string,
    checkpointNamespace: string,
    checkpointId: string,
  ): Promise<AdvanceCheckpointPointerResult>
}

export type CheckpointPayloadLimits = {
  maxCheckpointBytes: number
  maxChannelBytes: number
  maxPendingWritesBytes: number
}

const DEFAULT_LIMITS: CheckpointPayloadLimits = {
  maxCheckpointBytes: 8 * 1024 * 1024,
  maxChannelBytes: 2 * 1024 * 1024,
  maxPendingWritesBytes: 2 * 1024 * 1024,
}

export class CheckpointProtocolError extends Error {
  constructor(
    public readonly code:
      | 'checkpoint_cancel_requested'
      | 'checkpoint_lease_lost'
      | 'checkpoint_not_active'
      | 'checkpoint_stale'
      | 'checkpoint_scope_violation'
      | 'checkpoint_payload_too_large'
      | 'checkpoint_incompatible_graph'
      | 'checkpoint_fork_missing'
      | 'checkpoint_activation_failed',
    message: string,
  ) {
    super(message)
    this.name = 'CheckpointProtocolError'
  }
}

function jsonBytes(value: unknown, label: string): number {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new CheckpointProtocolError(
      'checkpoint_payload_too_large',
      `${label} is not JSON serializable: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }
  if (serialized === undefined) {
    throw new CheckpointProtocolError(
      'checkpoint_payload_too_large',
      `${label} is not JSON serializable`,
    )
  }
  return Buffer.byteLength(serialized, 'utf8')
}

function validateCheckpointPayload(
  checkpoint: Checkpoint,
  limits: CheckpointPayloadLimits,
) {
  if (jsonBytes(checkpoint, 'checkpoint') > limits.maxCheckpointBytes) {
    throw new CheckpointProtocolError(
      'checkpoint_payload_too_large',
      `Checkpoint exceeds ${limits.maxCheckpointBytes} bytes`,
    )
  }
  for (const [channel, value] of Object.entries(checkpoint.channel_values)) {
    if (jsonBytes(value, `checkpoint channel ${channel}`) > limits.maxChannelBytes) {
      throw new CheckpointProtocolError(
        'checkpoint_payload_too_large',
        `Checkpoint channel ${channel} exceeds ${limits.maxChannelBytes} bytes`,
      )
    }
  }
}

function namespace(config: RunnableConfig): string {
  const value = config.configurable?.checkpoint_ns ?? ''
  if (typeof value !== 'string') {
    throw new CheckpointProtocolError(
      'checkpoint_scope_violation',
      'checkpoint_ns must be a string',
    )
  }
  return value
}

// PostgresSaver 负责实际序列化和存储；这一层负责业务授权与进度单调性。
// 两者分开后，即使旧 Worker 从网络阻塞中恢复，也不能继续写有效 Checkpoint。
export class FencedCheckpointSaver extends BaseCheckpointSaver {
  private readonly limits: CheckpointPayloadLimits

  constructor(
    private readonly delegate: BaseCheckpointSaver,
    private readonly control: CheckpointAttemptControl,
    private readonly identity: LeaseIdentity,
    readonly attempt: CheckpointAttemptRow,
    limits: Partial<CheckpointPayloadLimits> = {},
  ) {
    super(delegate.serde)
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`)
      }
    }
  }

  config(checkpointId?: string): RunnableConfig {
    return {
      configurable: {
        thread_id: this.attempt.checkpointThreadId,
        checkpoint_ns: this.attempt.rootCheckpointNamespace,
        ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
      },
    }
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.assertAuthorized()
    return this.delegate.getTuple(this.scoped(config))
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    await this.assertAuthorized()
    const scopedBefore = options?.before ? this.scoped(options.before) : undefined
    yield* this.delegate.list(this.scoped(config), {
      ...options,
      ...(scopedBefore ? { before: scopedBefore } : {}),
    })
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    // 写入前后都检查租约：前一次阻止无权写入，后一次覆盖“写数据库期间
    // 恰好失去租约”的窗口。随后再推进业务表中的稳定 Checkpoint 指针。
    validateCheckpointPayload(checkpoint, this.limits)
    await this.assertAuthorized()
    const scopedConfig = this.scoped(config)
    const stored = await this.delegate.put(
      scopedConfig,
      checkpoint,
      metadata,
      newVersions,
    )
    await this.assertAuthorized()

    if (namespace(scopedConfig) === this.attempt.rootCheckpointNamespace) {
      const pointer = await this.control.advanceCheckpointPointer(
        this.identity,
        this.attempt.checkpointThreadId,
        this.attempt.rootCheckpointNamespace,
        checkpoint.id,
      )
      if (pointer.status === 'stale_checkpoint') {
        throw new CheckpointProtocolError(
          'checkpoint_stale',
          `Checkpoint ${checkpoint.id} would regress the active pointer`,
        )
      }
      if (pointer.status !== 'advanced' && pointer.status !== 'replayed') {
        this.throwAuthorization(pointer.status)
      }
    }
    return stored
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    if (jsonBytes(writes, 'pending writes') > this.limits.maxPendingWritesBytes) {
      throw new CheckpointProtocolError(
        'checkpoint_payload_too_large',
        `Pending writes exceed ${this.limits.maxPendingWritesBytes} bytes`,
      )
    }
    await this.assertAuthorized()
    await this.delegate.putWrites(this.scoped(config), writes, taskId)
    await this.assertAuthorized()
  }

  async deleteThread(_threadId: string): Promise<void> {
    throw new CheckpointProtocolError(
      'checkpoint_scope_violation',
      'Active execution cannot delete checkpoint threads; use the retention service',
    )
  }

  private scoped(config: RunnableConfig): RunnableConfig {
    const requestedThread = config.configurable?.thread_id
    if (
      requestedThread !== undefined &&
      requestedThread !== this.attempt.checkpointThreadId
    ) {
      throw new CheckpointProtocolError(
        'checkpoint_scope_violation',
        `Checkpoint thread ${String(requestedThread)} is outside the active attempt`,
      )
    }
    return {
      ...config,
      configurable: {
        ...config.configurable,
        thread_id: this.attempt.checkpointThreadId,
      },
    }
  }

  private async assertAuthorized() {
    const status = await this.control.authorizeCheckpointWrite(
      this.identity,
      this.attempt.checkpointThreadId,
    )
    if (status !== 'authorized') this.throwAuthorization(status)
  }

  private throwAuthorization(status: Exclude<CheckpointAuthorizationResult, 'authorized'>) {
    if (status === 'cancel_requested') {
      throw new CheckpointProtocolError(
        'checkpoint_cancel_requested',
        'Checkpoint write rejected because cancellation was requested',
      )
    }
    if (status === 'lease_lost') {
      throw new CheckpointProtocolError(
        'checkpoint_lease_lost',
        'Checkpoint write rejected because the worker lease was lost',
      )
    }
    throw new CheckpointProtocolError(
      'checkpoint_not_active',
      'Checkpoint write rejected because the attempt is not active',
    )
  }
}

export async function forkPreparedCheckpoint(
  saver: BaseCheckpointSaver,
  attempt: CheckpointAttemptRow,
): Promise<string | null> {
  if (!attempt.forkedFromCheckpointId) return null
  if (
    !attempt.forkedFromCheckpointThreadId ||
    attempt.forkedFromCheckpointNamespace === null
  ) {
    throw new CheckpointProtocolError(
      'checkpoint_fork_missing',
      'Prepared checkpoint attempt has an incomplete fork source',
    )
  }

  const sourceConfig: RunnableConfig = {
    configurable: {
      thread_id: attempt.forkedFromCheckpointThreadId,
      checkpoint_ns: attempt.forkedFromCheckpointNamespace,
      checkpoint_id: attempt.forkedFromCheckpointId,
    },
  }
  const source = await saver.getTuple(sourceConfig)
  if (!source || source.checkpoint.id !== attempt.forkedFromCheckpointId) {
    throw new CheckpointProtocolError(
      'checkpoint_fork_missing',
      `Stable source checkpoint ${attempt.forkedFromCheckpointId} was not found`,
    )
  }

  const targetConfig: RunnableConfig = {
    configurable: {
      thread_id: attempt.checkpointThreadId,
      checkpoint_ns: attempt.rootCheckpointNamespace,
    },
  }
  const metadata: CheckpointMetadata = {
    ...(source.metadata ?? { step: 0, parents: {} }),
    source: 'fork',
    parents: {
      ...(source.metadata?.parents ?? {}),
      [attempt.forkedFromCheckpointNamespace]: attempt.forkedFromCheckpointId,
    },
  }
  const storedConfig = await saver.put(
    targetConfig,
    source.checkpoint,
    metadata,
    source.checkpoint.channel_versions,
  )

  const writesByTask = new Map<string, PendingWrite[]>()
  for (const [taskId, channel, value] of source.pendingWrites ?? []) {
    const writes = writesByTask.get(taskId) ?? []
    writes.push([channel, value])
    writesByTask.set(taskId, writes)
  }
  for (const [taskId, writes] of writesByTask) {
    await saver.putWrites(storedConfig, writes, taskId)
  }
  return source.checkpoint.id
}

export async function initializeCheckpointAttempt(
  saver: BaseCheckpointSaver,
  control: CheckpointAttemptControl,
  identity: LeaseIdentity,
  limits?: Partial<CheckpointPayloadLimits>,
): Promise<FencedCheckpointSaver> {
  // 新 attempt 可以从上一次已确认的稳定 Checkpoint 分叉；复制完成并激活后，
  // Executor 才会 replay。这样接管不会直接在旧 attempt 的命名空间里继续写。
  const prepared = await control.prepareCheckpointAttempt(identity)
  if (prepared.status === 'incompatible_graph') {
    throw new CheckpointProtocolError(
      'checkpoint_incompatible_graph',
      `Cannot fork ${prepared.sourceGraphVersion} into ${prepared.targetGraphVersion}`,
    )
  }
  if (!('attempt' in prepared)) {
    throw new CheckpointProtocolError(
      prepared.status === 'cancel_requested'
        ? 'checkpoint_cancel_requested'
        : 'checkpoint_lease_lost',
      `Cannot prepare checkpoint attempt: ${prepared.status}`,
    )
  }

  let attempt = prepared.attempt
  if (attempt.status === 'preparing') {
    const copiedCheckpointId = await forkPreparedCheckpoint(saver, attempt)
    const activated = await control.activateCheckpointAttempt(
      identity,
      attempt.id,
      copiedCheckpointId,
    )
    if (activated.status !== 'activated' && activated.status !== 'replayed') {
      throw new CheckpointProtocolError(
        'checkpoint_activation_failed',
        `Cannot activate checkpoint attempt: ${activated.status}`,
      )
    }
    attempt = activated.attempt
  }

  return new FencedCheckpointSaver(saver, control, identity, attempt, limits)
}

export function createPostgresSaver(
  connectionString: string,
  schema = 'langgraph_checkpoint',
) {
  return PostgresSaver.fromConnString(connectionString, { schema })
}
