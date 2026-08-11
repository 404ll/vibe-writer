import { randomUUID } from 'node:crypto'
import {
  MemorySaver,
  emptyCheckpoint,
  type Checkpoint,
  type CheckpointMetadata,
} from '@langchain/langgraph-checkpoint'
import type { CheckpointAttemptRow, LeaseIdentity } from '@vibe-writer/db'
import { describe, expect, it, vi } from 'vitest'
import {
  CheckpointProtocolError,
  FencedCheckpointSaver,
  forkPreparedCheckpoint,
  initializeCheckpointAttempt,
  type CheckpointAttemptControl,
} from '../src/runtime'

const identity: LeaseIdentity = {
  jobId: '3bf9e781-5e1e-4e15-9dda-48bc45cc0346',
  runId: '970b685e-e044-4453-97ac-2ef576e59366',
  leaseToken: 'lease-token',
}

function attempt(
  overrides: Partial<CheckpointAttemptRow> = {},
): CheckpointAttemptRow {
  const now = new Date('2026-08-07T00:00:00.000Z')
  return {
    id: 'f023851c-ddf5-4fcf-a687-da825120c3a0',
    jobId: identity.jobId,
    runId: identity.runId,
    checkpointThreadId: `job:${identity.jobId}:run:${identity.runId}`,
    rootCheckpointNamespace: '',
    graphVersion: 'writer-graph-v1-target-2026-08-07',
    status: 'active',
    forkedFromRunId: null,
    forkedFromCheckpointThreadId: null,
    forkedFromCheckpointNamespace: null,
    forkedFromCheckpointId: null,
    latestCheckpointId: null,
    activatedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function checkpoint(id: string, values: Record<string, unknown> = {}): Checkpoint {
  return {
    ...emptyCheckpoint(),
    id,
    ts: new Date('2026-08-07T00:00:00.000Z').toISOString(),
    channel_values: values,
    channel_versions: Object.fromEntries(
      Object.keys(values).map((key) => [key, 1]),
    ),
  }
}

const metadata: CheckpointMetadata = {
  source: 'loop',
  step: 1,
  parents: {},
}

function control(overrides: Partial<CheckpointAttemptControl> = {}) {
  const active = attempt()
  return {
    prepareCheckpointAttempt: vi.fn(async () => ({
      status: 'existing' as const,
      attempt: active,
    })),
    activateCheckpointAttempt: vi.fn(async () => ({
      status: 'replayed' as const,
      attempt: active,
    })),
    authorizeCheckpointWrite: vi.fn(async () => 'authorized' as const),
    advanceCheckpointPointer: vi.fn(async () => ({
      status: 'advanced' as const,
      attempt: active,
    })),
    ...overrides,
  } satisfies CheckpointAttemptControl
}

describe('FencedCheckpointSaver', () => {
  it('forces the physical attempt thread and advances only the root pointer', async () => {
    const delegate = new MemorySaver()
    const checkpointControl = control()
    const active = attempt()
    const saver = new FencedCheckpointSaver(
      delegate,
      checkpointControl,
      identity,
      active,
    )

    await saver.put(
      saver.config(),
      checkpoint('00000000-0000-6000-8000-000000000001', { phase: 'plan' }),
      metadata,
      { phase: 1 },
    )
    expect(checkpointControl.advanceCheckpointPointer).toHaveBeenCalledWith(
      identity,
      active.checkpointThreadId,
      '',
      '00000000-0000-6000-8000-000000000001',
    )
    expect(await delegate.getTuple(saver.config())).toMatchObject({
      checkpoint: { channel_values: { phase: 'plan' } },
    })

    await saver.put(
      {
        configurable: {
          thread_id: active.checkpointThreadId,
          checkpoint_ns: 'child|node',
        },
      },
      checkpoint('00000000-0000-6000-8000-000000000002', { child: true }),
      metadata,
      { child: 1 },
    )
    expect(checkpointControl.advanceCheckpointPointer).toHaveBeenCalledTimes(1)
  })

  it('rejects cross-attempt scope, oversized payloads, and active deletion', async () => {
    const saver = new FencedCheckpointSaver(
      new MemorySaver(),
      control(),
      identity,
      attempt(),
      { maxCheckpointBytes: 256, maxChannelBytes: 32 },
    )

    await expect(
      saver.getTuple({ configurable: { thread_id: 'another-attempt' } }),
    ).rejects.toMatchObject({ code: 'checkpoint_scope_violation' })
    await expect(
      saver.put(
        saver.config(),
        checkpoint('00000000-0000-6000-8000-000000000003', {
          article: 'x'.repeat(64),
        }),
        metadata,
        { article: 1 },
      ),
    ).rejects.toMatchObject({ code: 'checkpoint_payload_too_large' })
    await expect(saver.deleteThread('ignored')).rejects.toMatchObject({
      code: 'checkpoint_scope_violation',
    })
  })

  it('cannot advance the pointer when the lease is lost after saver write', async () => {
    const delegate = new MemorySaver()
    const authorize = vi
      .fn<CheckpointAttemptControl['authorizeCheckpointWrite']>()
      .mockResolvedValueOnce('authorized')
      .mockResolvedValueOnce('lease_lost')
    const checkpointControl = control({ authorizeCheckpointWrite: authorize })
    const active = attempt()
    const saver = new FencedCheckpointSaver(
      delegate,
      checkpointControl,
      identity,
      active,
    )
    const value = checkpoint('00000000-0000-6000-8000-000000000004', {
      phase: 'write',
    })

    await expect(
      saver.put(saver.config(), value, metadata, { phase: 1 }),
    ).rejects.toMatchObject({ code: 'checkpoint_lease_lost' })
    expect(await delegate.getTuple(saver.config())).toMatchObject({
      checkpoint: { id: value.id },
    })
    expect(checkpointControl.advanceCheckpointPointer).not.toHaveBeenCalled()
  })
})

describe('checkpoint attempt initialization and fork', () => {
  it('copies checkpoint metadata and pending writes to a prepared physical thread', async () => {
    const saver = new MemorySaver()
    const sourceThread = 'job:source:run:source'
    const sourceCheckpoint = checkpoint(
      '00000000-0000-6000-8000-000000000010',
      { chapter: 1 },
    )
    const sourceConfig = await saver.put(
      { configurable: { thread_id: sourceThread, checkpoint_ns: '' } },
      sourceCheckpoint,
      metadata,
    )
    await saver.putWrites(sourceConfig, [['chapter_result', 'draft']], 'task-write')

    const prepared = attempt({
      status: 'preparing',
      activatedAt: null,
      forkedFromRunId: randomUUID(),
      forkedFromCheckpointThreadId: sourceThread,
      forkedFromCheckpointNamespace: '',
      forkedFromCheckpointId: sourceCheckpoint.id,
    })
    await expect(forkPreparedCheckpoint(saver, prepared)).resolves.toBe(
      sourceCheckpoint.id,
    )
    const copied = await saver.getTuple({
      configurable: {
        thread_id: prepared.checkpointThreadId,
        checkpoint_ns: '',
        checkpoint_id: sourceCheckpoint.id,
      },
    })
    expect(copied).toMatchObject({
      checkpoint: { channel_values: { chapter: 1 } },
      metadata: { source: 'fork' },
      pendingWrites: [['task-write', 'chapter_result', 'draft']],
    })
  })

  it('prepares, forks, activates, and returns a fenced saver', async () => {
    const saver = new MemorySaver()
    const prepared = attempt({ status: 'preparing', activatedAt: null })
    const active = { ...prepared, status: 'active' as const, activatedAt: new Date() }
    const checkpointControl = control({
      prepareCheckpointAttempt: vi.fn(async () => ({
        status: 'prepared' as const,
        attempt: prepared,
      })),
      activateCheckpointAttempt: vi.fn(async () => ({
        status: 'activated' as const,
        attempt: active,
      })),
    })

    const fenced = await initializeCheckpointAttempt(
      saver,
      checkpointControl,
      identity,
    )
    expect(fenced.attempt.status).toBe('active')
    expect(checkpointControl.activateCheckpointAttempt).toHaveBeenCalledWith(
      identity,
      prepared.id,
      null,
    )
  })

  it('rejects graph-version incompatibility before returning a saver', async () => {
    const checkpointControl = control({
      prepareCheckpointAttempt: vi.fn(async () => ({
        status: 'incompatible_graph' as const,
        sourceGraphVersion: 'graph-v1',
        targetGraphVersion: 'graph-v2',
      })),
    })
    await expect(
      initializeCheckpointAttempt(new MemorySaver(), checkpointControl, identity),
    ).rejects.toEqual(
      new CheckpointProtocolError(
        'checkpoint_incompatible_graph',
        'Cannot fork graph-v1 into graph-v2',
      ),
    )
  })
})
