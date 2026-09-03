import type { SSEEventType } from '@vibe-writer/contracts/jobs/event-types'
import type { EvalModelExecutionBinding } from '@vibe-writer/eval-core'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type {
  JobIntervention,
  JobStatus,
  ModelProfileSnapshot,
  OutboxStatus,
  RunEffectStatus,
  RunEffectType,
  RunStatus,
  CheckpointAttemptStatus,
  JobCommandType,
  JobInterruptStatus,
  JobInterruptType,
  ToolVersions,
  WorkflowStage,
  EvalDataClassification,
  EvalCandidateEventType,
  EvalCandidateStatus,
  EvalConsentBasis,
  EvalSamplingPolicyStatus,
  EvalExecutionSnapshot,
  EvalRunMode,
  EvalRunStatus,
  EvalRunTrigger,
  EvalScoreStatus,
  EvalSuiteStatus,
  EvalTrialStatus,
  PrincipalStatus,
  TraceSpanKind,
  TraceSpanStatus,
  WorkspaceRole,
  WorkspaceStatus,
  MemorySubjectKind,
  MemoryKind,
  MemoryProposer,
  MemorySensitivity,
  MemoryPolicyOutcome,
  MemoryCandidateStatus,
  MemoryCandidateEventType,
  MemorySourceSignalKind,
  MemoryEvidenceSourceKind,
  MemoryExtractionTaskStatus,
  MemoryExtractionAttemptStatus,
  MemoryExtractionEffectStatus,
  MemoryExtractionExecutionSnapshot,
  MemoryReconciliationDecision,
  MemoryReconciliationEvidenceKind,
  MemoryReconciliationRetryDisposition,
  MemoryCalibrationAuthorizationStatus,
  MemoryCalibrationAuthorizationEventType,
} from './domain'
import type { ReplyRequest } from '@vibe-writer/contracts/jobs'

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()

export const principals = pgTable(
  'principals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    displayName: text('display_name'),
    status: text('status').$type<PrincipalStatus>().default('active').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('principals_status_check', sql`${table.status} in ('active', 'disabled')`),
  ],
)

export const principalIdentities = pgTable(
  'principal_identities',
  {
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    principalId: uuid('principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.issuer, table.subject] }),
    index('principal_identities_principal_idx').on(table.principalId),
    check(
      'principal_identities_key_check',
      sql`length(trim(${table.issuer})) between 1 and 512
        and length(trim(${table.subject})) between 1 and 512`,
    ),
  ],
)

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    status: text('status').$type<WorkspaceStatus>().default('active').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('workspaces_slug_uidx').on(table.slug),
    check(
      'workspaces_identity_check',
      sql`length(trim(${table.slug})) between 1 and 128
        and ${table.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
        and length(trim(${table.name})) between 1 and 256`,
    ),
    check('workspaces_status_check', sql`${table.status} in ('active', 'suspended')`),
  ],
)

export const workspaceMemberships = pgTable(
  'workspace_memberships',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    principalId: uuid('principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    role: text('role').$type<WorkspaceRole>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.principalId] }),
    index('workspace_memberships_principal_idx').on(table.principalId, table.workspaceId),
    check(
      'workspace_memberships_role_check',
      sql`${table.role} in ('owner', 'editor', 'viewer')`,
    ),
  ],
)

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    createdByPrincipalId: uuid('created_by_principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key').notNull(),
    topic: text('topic').notNull(),
    style: text('style').default('').notNull(),
    targetWords: integer('target_words'),
    intervention: jsonb('intervention')
      .$type<JobIntervention>()
      .default(sql`'{"on_outline":true}'::jsonb`)
      .notNull(),
    status: text('status').$type<JobStatus>().default('queued').notNull(),
    stage: text('stage').$type<WorkflowStage>().default('plan').notNull(),
    nextEventSeq: integer('next_event_seq').default(0).notNull(),
    version: integer('version').default(0).notNull(),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    leaseOwner: text('lease_owner'),
    leaseToken: text('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('jobs_workspace_idempotency_key_uidx').on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    index('jobs_workspace_created_at_idx').on(table.workspaceId, table.createdAt),
    index('jobs_status_created_at_idx').on(table.status, table.createdAt),
    index('jobs_lease_expiry_idx').on(table.status, table.leaseExpiresAt),
    check(
      'jobs_status_check',
      sql`${table.status} in ('queued', 'running', 'awaiting_input', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      'jobs_stage_check',
      sql`${table.stage} in ('plan', 'write', 'review', 'export')`,
    ),
    check('jobs_target_words_check', sql`${table.targetWords} is null or ${table.targetWords} > 0`),
    check('jobs_next_event_seq_check', sql`${table.nextEventSeq} >= 0`),
    check('jobs_version_check', sql`${table.version} >= 0`),
    check(
      'jobs_terminal_finished_at_check',
      sql`(
        ${table.status} in ('completed', 'failed', 'cancelled') and ${table.finishedAt} is not null
      ) or (
        ${table.status} not in ('completed', 'failed', 'cancelled') and ${table.finishedAt} is null
      )`,
    ),
    check(
      'jobs_lease_shape_check',
      sql`(
        ${table.leaseOwner} is null and ${table.leaseToken} is null
        and ${table.leaseExpiresAt} is null and ${table.heartbeatAt} is null
      ) or (
        ${table.leaseOwner} is not null and ${table.leaseToken} is not null
        and ${table.leaseExpiresAt} is not null and ${table.heartbeatAt} is not null
      )`,
    ),
    check(
      'jobs_running_lease_check',
      sql`(
        ${table.status} = 'running' and ${table.leaseToken} is not null
      ) or (
        ${table.status} <> 'running' and ${table.leaseToken} is null
      )`,
    ),
  ],
)

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    status: text('status').$type<RunStatus>().default('queued').notNull(),
    workerId: text('worker_id'),
    leaseToken: text('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    modelProfile: jsonb('model_profile').$type<ModelProfileSnapshot>().notNull(),
    promptVersion: text('prompt_version').notNull(),
    graphVersion: text('graph_version').notNull(),
    toolVersions: jsonb('tool_versions').$type<ToolVersions>().notNull(),
    codeRevision: text('code_revision').notNull(),
    traceId: text('trace_id').default(sql`gen_random_uuid()::text`).notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('runs_job_attempt_uidx').on(table.jobId, table.attempt),
    index('runs_job_created_at_idx').on(table.jobId, table.createdAt),
    check('runs_attempt_check', sql`${table.attempt} > 0`),
    check(
      'runs_status_check',
      sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      'runs_terminal_finished_at_check',
      sql`(
        ${table.status} in ('completed', 'failed', 'cancelled') and ${table.finishedAt} is not null
      ) or (
        ${table.status} not in ('completed', 'failed', 'cancelled') and ${table.finishedAt} is null
      )`,
    ),
    check(
      'runs_lease_shape_check',
      sql`(
        ${table.workerId} is null and ${table.leaseToken} is null
        and ${table.leaseExpiresAt} is null and ${table.heartbeatAt} is null
      ) or (
        ${table.workerId} is not null and ${table.leaseToken} is not null
        and ${table.leaseExpiresAt} is not null and ${table.heartbeatAt} is not null
      )`,
    ),
    check(
      'runs_running_lease_check',
      sql`${table.status} <> 'running' or ${table.leaseToken} is not null`,
    ),
    check(
      'runs_version_fields_check',
      sql`length(trim(${table.promptVersion})) > 0
        and length(trim(${table.graphVersion})) > 0
        and length(trim(${table.codeRevision})) > 0`,
    ),
  ],
)

export const checkpointAttempts = pgTable(
  'checkpoint_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    checkpointThreadId: text('checkpoint_thread_id').notNull(),
    rootCheckpointNamespace: text('root_checkpoint_namespace').default('').notNull(),
    graphVersion: text('graph_version').notNull(),
    status: text('status').$type<CheckpointAttemptStatus>().default('preparing').notNull(),
    forkedFromRunId: uuid('forked_from_run_id').references(() => runs.id),
    forkedFromCheckpointThreadId: text('forked_from_checkpoint_thread_id'),
    forkedFromCheckpointNamespace: text('forked_from_checkpoint_namespace'),
    forkedFromCheckpointId: text('forked_from_checkpoint_id'),
    latestCheckpointId: text('latest_checkpoint_id'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('checkpoint_attempts_run_uidx').on(table.runId),
    uniqueIndex('checkpoint_attempts_storage_uidx').on(table.checkpointThreadId),
    uniqueIndex('checkpoint_attempts_job_active_uidx')
      .on(table.jobId)
      .where(sql`${table.status} = 'active'`),
    index('checkpoint_attempts_job_created_idx').on(table.jobId, table.createdAt),
    check(
      'checkpoint_attempts_status_check',
      sql`${table.status} in ('preparing', 'active', 'superseded')`,
    ),
    check(
      'checkpoint_attempts_identity_check',
      sql`length(trim(${table.checkpointThreadId})) > 0
        and length(trim(${table.graphVersion})) > 0
        and ${table.rootCheckpointNamespace} = ''`,
    ),
    check(
      'checkpoint_attempts_activation_check',
      sql`(${table.status} = 'preparing' and ${table.activatedAt} is null)
        or (${table.status} in ('active', 'superseded') and ${table.activatedAt} is not null)`,
    ),
    check(
      'checkpoint_attempts_fork_shape_check',
      sql`(
        ${table.forkedFromRunId} is null
        and ${table.forkedFromCheckpointThreadId} is null
        and ${table.forkedFromCheckpointNamespace} is null
        and ${table.forkedFromCheckpointId} is null
      ) or (
        ${table.forkedFromRunId} is not null
        and ${table.forkedFromCheckpointThreadId} is not null
        and ${table.forkedFromCheckpointNamespace} is not null
        and ${table.forkedFromCheckpointId} is not null
        and length(trim(${table.forkedFromCheckpointThreadId})) > 0
        and length(trim(${table.forkedFromCheckpointId})) > 0
      )`,
    ),
    check(
      'checkpoint_attempts_latest_check',
      sql`${table.latestCheckpointId} is null
        or length(trim(${table.latestCheckpointId})) > 0`,
    ),
  ],
)

export const jobInterrupts = pgTable(
  'job_interrupts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    externalId: text('external_id').notNull(),
    interruptType: text('interrupt_type')
      .$type<JobInterruptType>()
      .default('outline_review')
      .notNull(),
    payload: jsonb('payload').$type<{ outline: string[] }>().notNull(),
    status: text('status').$type<JobInterruptStatus>().default('pending').notNull(),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('job_interrupts_job_external_uidx').on(table.jobId, table.externalId),
    uniqueIndex('job_interrupts_job_pending_uidx')
      .on(table.jobId)
      .where(sql`${table.status} = 'pending'`),
    index('job_interrupts_job_created_idx').on(table.jobId, table.createdAt),
    check(
      'job_interrupts_type_check',
      sql`${table.interruptType} in ('outline_review')`,
    ),
    check(
      'job_interrupts_status_check',
      sql`${table.status} in ('pending', 'replied', 'cancelled')`,
    ),
    check(
      'job_interrupts_external_check',
      sql`length(trim(${table.externalId})) between 1 and 512`,
    ),
    check(
      'job_interrupts_reply_shape_check',
      sql`(${table.status} = 'replied' and ${table.repliedAt} is not null)
        or (${table.status} <> 'replied' and ${table.repliedAt} is null)`,
    ),
  ],
)

export const jobCommands = pgTable(
  'job_commands',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    interruptId: uuid('interrupt_id')
      .notNull()
      .references(() => jobInterrupts.id, { onDelete: 'cascade' }),
    commandType: text('command_type')
      .$type<JobCommandType>()
      .default('outline_reply')
      .notNull(),
    payload: jsonb('payload').$type<ReplyRequest>().notNull(),
    payloadFingerprint: text('payload_fingerprint').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('job_commands_interrupt_uidx').on(table.interruptId),
    index('job_commands_job_created_idx').on(table.jobId, table.createdAt),
    check('job_commands_type_check', sql`${table.commandType} in ('outline_reply')`),
    check(
      'job_commands_fingerprint_check',
      sql`${table.payloadFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  ],
)

export const articles = pgTable(
  'articles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    sourceRunId: uuid('source_run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'restrict' }),
    exportIdempotencyKey: text('export_idempotency_key').notNull(),
    topic: text('topic').notNull(),
    content: text('content').notNull(),
    contentFingerprint: text('content_fingerprint').notNull(),
    wordCount: integer('word_count').notNull(),
    revision: integer('revision').default(0).notNull(),
    graphVersion: text('graph_version').notNull(),
    promptVersion: text('prompt_version').notNull(),
    codeRevision: text('code_revision').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('articles_job_id_uidx').on(table.jobId),
    uniqueIndex('articles_export_idempotency_uidx').on(table.exportIdempotencyKey),
    index('articles_created_at_idx').on(table.createdAt),
    check('articles_topic_check', sql`length(trim(${table.topic})) > 0`),
    check('articles_content_check', sql`length(${table.content}) > 0`),
    check(
      'articles_fingerprint_check',
      sql`${table.contentFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check('articles_word_count_check', sql`${table.wordCount} >= 0`),
    check('articles_revision_check', sql`${table.revision} >= 0`),
    check(
      'articles_version_fields_check',
      sql`length(trim(${table.graphVersion})) > 0
        and length(trim(${table.promptVersion})) > 0
        and length(trim(${table.codeRevision})) > 0`,
    ),
  ],
)

export const articleVersions = pgTable(
  'article_versions',
  {
    id: serial('id').primaryKey(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    sourceRevision: integer('source_revision').notNull(),
    content: text('content').notNull(),
    contentFingerprint: text('content_fingerprint').notNull(),
    wordCount: integer('word_count').notNull(),
    savedAt: timestamp('saved_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('article_versions_article_revision_uidx').on(
      table.articleId,
      table.sourceRevision,
    ),
    index('article_versions_article_saved_at_idx').on(table.articleId, table.savedAt),
    check('article_versions_revision_check', sql`${table.sourceRevision} >= 0`),
    check('article_versions_content_check', sql`length(${table.content}) > 0`),
    check(
      'article_versions_fingerprint_check',
      sql`${table.contentFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check('article_versions_word_count_check', sql`${table.wordCount} >= 0`),
  ],
)

export const jobEvents = pgTable(
  'job_events',
  {
    id: uuid('id').defaultRandom().notNull(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadFingerprint: text('payload_fingerprint').notNull(),
    eventType: text('event_type').$type<SSEEventType>().notNull(),
    eventData: jsonb('event_data').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ name: 'job_events_pkey', columns: [table.jobId, table.seq] }),
    uniqueIndex('job_events_id_uidx').on(table.id),
    uniqueIndex('job_events_job_idempotency_uidx').on(
      table.jobId,
      table.idempotencyKey,
    ),
    index('job_events_job_created_at_idx').on(table.jobId, table.createdAt),
    check('job_events_seq_check', sql`${table.seq} >= 0`),
    check(
      'job_events_idempotency_key_check',
      sql`length(trim(${table.idempotencyKey})) > 0`,
    ),
    check(
      'job_events_payload_fingerprint_check',
      sql`length(trim(${table.payloadFingerprint})) > 0`,
    ),
    check(
      'job_events_type_check',
      sql`${table.eventType} in (
        'done', 'cancelled', 'error',
        'stage_update', 'outline_ready',
        'generating_opinions', 'opinions_ready', 'searching', 'search_done',
        'extracting', 'extract_done',
        'writing_chapter', 'reviewing_chapter', 'chapter_done',
        'reviewing_full', 'review_done'
      )`,
    ),
  ],
)

export const runEffects = pgTable(
  'run_effects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    effectKey: text('effect_key').notNull(),
    effectType: text('effect_type').$type<RunEffectType>().notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    status: text('status').$type<RunEffectStatus>().default('reserved').notNull(),
    resultMetadata: jsonb('result_metadata').$type<Record<string, unknown>>(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('run_effects_job_key_uidx').on(table.jobId, table.effectKey),
    index('run_effects_run_status_idx').on(table.runId, table.status),
    check(
      'run_effects_type_check',
      sql`${table.effectType} in ('model_call', 'tool_call', 'search', 'export')`,
    ),
    check(
      'run_effects_status_check',
      sql`${table.status} in ('reserved', 'succeeded', 'failed', 'uncertain')`,
    ),
    check(
      'run_effects_finished_shape_check',
      sql`(
        ${table.status} = 'reserved' and ${table.finishedAt} is null
      ) or (
        ${table.status} <> 'reserved' and ${table.finishedAt} is not null
      )`,
    ),
    check('run_effects_key_check', sql`length(trim(${table.effectKey})) > 0`),
    check(
      'run_effects_fingerprint_check',
      sql`length(trim(${table.requestFingerprint})) > 0`,
    ),
  ],
)

export const traceSpans = pgTable(
  'trace_spans',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    traceId: text('trace_id').notNull(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    spanKey: text('span_key').notNull(),
    parentSpanKey: text('parent_span_key'),
    spanKind: text('span_kind').$type<TraceSpanKind>().notNull(),
    operation: text('operation').notNull(),
    status: text('status').$type<TraceSpanStatus>().default('running').notNull(),
    requestFingerprint: text('request_fingerprint'),
    provider: text('provider'),
    model: text('model'),
    providerRequestId: text('provider_request_id'),
    providerResponseId: text('provider_response_id'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadInputTokens: integer('cache_read_input_tokens'),
    cacheWriteInputTokens: integer('cache_write_input_tokens'),
    latencyMs: integer('latency_ms'),
    attributes: jsonb('attributes').$type<Record<string, unknown>>(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('trace_spans_run_key_uidx').on(table.runId, table.spanKey),
    index('trace_spans_trace_started_idx').on(table.traceId, table.startedAt),
    index('trace_spans_run_status_idx').on(table.runId, table.status),
    check(
      'trace_spans_kind_check',
      sql`${table.spanKind} in ('model', 'search', 'tool', 'workflow')`,
    ),
    check(
      'trace_spans_status_check',
      sql`${table.status} in ('running', 'succeeded', 'failed', 'cancelled', 'uncertain')`,
    ),
    check(
      'trace_spans_identity_check',
      sql`length(trim(${table.traceId})) > 0
        and length(trim(${table.spanKey})) > 0
        and length(trim(${table.operation})) > 0`,
    ),
    check(
      'trace_spans_finished_shape_check',
      sql`(${table.status} = 'running' and ${table.finishedAt} is null)
        or (${table.status} <> 'running' and ${table.finishedAt} is not null)`,
    ),
    check(
      'trace_spans_metrics_check',
      sql`(${table.inputTokens} is null or ${table.inputTokens} >= 0)
        and (${table.outputTokens} is null or ${table.outputTokens} >= 0)
        and (${table.cacheReadInputTokens} is null or ${table.cacheReadInputTokens} >= 0)
        and (${table.cacheWriteInputTokens} is null or ${table.cacheWriteInputTokens} >= 0)
        and (${table.latencyMs} is null or ${table.latencyMs} >= 0)`,
    ),
  ],
)

export const evalSuites = pgTable(
  'eval_suites',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, {
      onDelete: 'cascade',
    }),
    namespaceKey: text('namespace_key').notNull(),
    suiteKey: text('suite_key').notNull(),
    version: text('version').notNull(),
    name: text('name').notNull(),
    description: text('description').default('').notNull(),
    status: text('status').$type<EvalSuiteStatus>().default('draft').notNull(),
    datasetFingerprint: text('dataset_fingerprint').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('eval_suites_namespace_key_version_uidx').on(
      table.namespaceKey,
      table.suiteKey,
      table.version,
    ),
    index('eval_suites_namespace_status_idx').on(table.namespaceKey, table.status),
    index('eval_suites_workspace_status_idx').on(table.workspaceId, table.status),
    check(
      'eval_suites_status_check',
      sql`${table.status} in ('draft', 'active', 'archived')`,
    ),
    check(
      'eval_suites_identity_check',
      sql`length(trim(${table.namespaceKey})) between 1 and 256
        and length(trim(${table.suiteKey})) between 1 and 256
        and length(trim(${table.version})) between 1 and 256
        and length(trim(${table.name})) between 1 and 512`,
    ),
    check(
      'eval_suites_fingerprint_check',
      sql`${table.datasetFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  ],
)

export const evalCases = pgTable(
  'eval_cases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    suiteId: uuid('suite_id')
      .notNull()
      .references(() => evalSuites.id, { onDelete: 'cascade' }),
    caseKey: text('case_key').notNull(),
    input: jsonb('input').$type<unknown>().notNull(),
    expected: jsonb('expected').$type<unknown>(),
    inputFingerprint: text('input_fingerprint').notNull(),
    dataClassification: text('data_classification')
      .$type<EvalDataClassification>()
      .notNull(),
    sourceCandidateId: uuid('source_candidate_id')
      .references((): AnyPgColumn => evalCandidates.id, { onDelete: 'cascade' }),
    retentionUntil: timestamp('retention_until', { withTimezone: true }),
    materializerKey: text('materializer_key'),
    materializerVersion: text('materializer_version'),
    tags: jsonb('tags').$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('eval_cases_suite_key_uidx').on(table.suiteId, table.caseKey),
    index('eval_cases_suite_idx').on(table.suiteId, table.createdAt),
    uniqueIndex('eval_cases_source_candidate_uidx')
      .on(table.sourceCandidateId)
      .where(sql`${table.sourceCandidateId} is not null`),
    index('eval_cases_retention_idx').on(table.retentionUntil),
    check('eval_cases_key_check', sql`length(trim(${table.caseKey})) between 1 and 256`),
    check(
      'eval_cases_classification_check',
      sql`${table.dataClassification} in ('synthetic', 'deidentified', 'user_content')`,
    ),
    check(
      'eval_cases_fingerprint_check',
      sql`${table.inputFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check('eval_cases_tags_check', sql`jsonb_typeof(${table.tags}) = 'array'`),
    check(
      'eval_cases_materialization_shape_check',
      sql`(${table.sourceCandidateId} is null and ${table.retentionUntil} is null
          and ${table.materializerKey} is null and ${table.materializerVersion} is null)
        or (${table.sourceCandidateId} is not null and ${table.retentionUntil} is not null
          and length(trim(${table.materializerKey})) between 1 and 256
          and length(trim(${table.materializerVersion})) between 1 and 256)`,
    ),
  ],
)

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    suiteId: uuid('suite_id')
      .notNull()
      .references(() => evalSuites.id, { onDelete: 'restrict' }),
    status: text('status').$type<EvalRunStatus>().default('running').notNull(),
    mode: text('mode').$type<EvalRunMode>().default('inline').notNull(),
    idempotencyKey: text('idempotency_key'),
    trigger: text('trigger').$type<EvalRunTrigger>().notNull(),
    targetKey: text('target_key').notNull(),
    targetVersion: text('target_version').notNull(),
    executionSnapshot: jsonb('execution_snapshot').$type<EvalExecutionSnapshot>().notNull(),
    datasetFingerprint: text('dataset_fingerprint').notNull(),
    trialsPerCase: integer('trials_per_case').default(1).notNull(),
    attempt: integer('attempt').default(0).notNull(),
    leaseOwner: text('lease_owner'),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('eval_runs_suite_started_idx').on(table.suiteId, table.startedAt),
    index('eval_runs_status_started_idx').on(table.status, table.startedAt),
    uniqueIndex('eval_runs_suite_idempotency_uidx')
      .on(table.suiteId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index('eval_runs_queue_status_idx').on(table.mode, table.status, table.createdAt),
    check(
      'eval_runs_status_check',
      sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    check('eval_runs_mode_check', sql`${table.mode} in ('inline', 'queued')`),
    check(
      'eval_runs_trigger_check',
      sql`${table.trigger} in ('manual', 'ci', 'shadow', 'regression')`,
    ),
    check(
      'eval_runs_identity_check',
      sql`length(trim(${table.targetKey})) between 1 and 256
        and length(trim(${table.targetVersion})) between 1 and 256`,
    ),
    check(
      'eval_runs_dataset_check',
      sql`${table.datasetFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check('eval_runs_trials_check', sql`${table.trialsPerCase} between 1 and 20`),
    check('eval_runs_attempt_check', sql`${table.attempt} >= 0`),
    check(
      'eval_runs_idempotency_check',
      sql`(${table.mode} = 'inline' and ${table.idempotencyKey} is null)
        or (${table.mode} = 'queued' and length(trim(${table.idempotencyKey})) between 1 and 512)`,
    ),
    check(
      'eval_runs_lease_shape_check',
      sql`(${table.mode} = 'queued' and ${table.status} = 'running'
          and ${table.leaseOwner} is not null and ${table.leaseToken} is not null
          and ${table.leaseExpiresAt} is not null and ${table.heartbeatAt} is not null)
        or (not (${table.mode} = 'queued' and ${table.status} = 'running')
          and ${table.leaseOwner} is null and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null and ${table.heartbeatAt} is null)`,
    ),
    check(
      'eval_runs_finished_shape_check',
      sql`(${table.status} = 'queued' and ${table.startedAt} is null and ${table.finishedAt} is null)
        or (${table.status} = 'running' and ${table.startedAt} is not null and ${table.finishedAt} is null)
        or (${table.status} in ('completed', 'failed', 'cancelled')
          and ${table.startedAt} is not null and ${table.finishedAt} is not null)`,
    ),
  ],
)

export const memoryCalibrationAuthorizations = pgTable(
  'memory_calibration_authorizations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    suiteId: uuid('suite_id')
      .notNull()
      .references(() => evalSuites.id, { onDelete: 'restrict' }),
    evalRunId: uuid('eval_run_id')
      .references(() => evalRuns.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status')
      .$type<MemoryCalibrationAuthorizationStatus>()
      .default('draft')
      .notNull(),
    bindingSnapshot: jsonb('binding_snapshot').$type<EvalModelExecutionBinding>().notNull(),
    bindingFingerprint: text('binding_fingerprint').notNull(),
    baseExecutionSnapshot: jsonb('base_execution_snapshot')
      .$type<EvalExecutionSnapshot>()
      .notNull(),
    targetKey: text('target_key').notNull(),
    targetVersion: text('target_version').notNull(),
    trialsPerCase: integer('trials_per_case').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'restrict' }),
    approvalId: uuid('approval_id'),
    approvedByPrincipalId: uuid('approved_by_principal_id')
      .references(() => principals.id, { onDelete: 'restrict' }),
    approvalReasonCode: text('approval_reason_code'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    nextEventSeq: integer('next_event_seq').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('memory_calibration_auth_workspace_idempotency_uidx').on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    uniqueIndex('memory_calibration_auth_eval_run_uidx')
      .on(table.evalRunId)
      .where(sql`${table.evalRunId} is not null`),
    index('memory_calibration_auth_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
    check(
      'memory_calibration_auth_status_check',
      sql`${table.status} in ('draft', 'approved', 'enqueued')`,
    ),
    check(
      'memory_calibration_auth_identity_check',
      sql`length(trim(${table.idempotencyKey})) between 1 and 512
        and length(trim(${table.targetKey})) between 1 and 256
        and length(trim(${table.targetVersion})) between 1 and 256`,
    ),
    check(
      'memory_calibration_auth_fingerprint_check',
      sql`${table.bindingFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check('memory_calibration_auth_trials_check', sql`${table.trialsPerCase} between 1 and 20`),
    check('memory_calibration_auth_event_seq_check', sql`${table.nextEventSeq} >= 1`),
    check(
      'memory_calibration_auth_state_shape_check',
      sql`(${table.status} = 'draft'
          and ${table.approvalId} is null
          and ${table.approvedByPrincipalId} is null
          and ${table.approvalReasonCode} is null
          and ${table.approvedAt} is null
          and ${table.evalRunId} is null)
        or (${table.status} = 'approved'
          and ${table.approvalId} is not null
          and ${table.approvedByPrincipalId} is not null
          and length(trim(${table.approvalReasonCode})) between 1 and 256
          and ${table.approvedAt} is not null
          and ${table.evalRunId} is null)
        or (${table.status} = 'enqueued'
          and ${table.approvalId} is not null
          and ${table.approvedByPrincipalId} is not null
          and length(trim(${table.approvalReasonCode})) between 1 and 256
          and ${table.approvedAt} is not null
          and ${table.evalRunId} is not null)`,
    ),
  ],
)

export const memoryCalibrationAuthorizationEvents = pgTable(
  'memory_calibration_authorization_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    authorizationId: uuid('authorization_id')
      .notNull()
      .references(() => memoryCalibrationAuthorizations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    eventType: text('event_type')
      .$type<MemoryCalibrationAuthorizationEventType>()
      .notNull(),
    actorPrincipalId: uuid('actor_principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'restrict' }),
    bindingFingerprint: text('binding_fingerprint').notNull(),
    reasonCode: text('reason_code'),
    evalRunId: uuid('eval_run_id')
      .references(() => evalRuns.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('memory_calibration_auth_events_sequence_uidx').on(
      table.authorizationId,
      table.sequence,
    ),
    index('memory_calibration_auth_events_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    check('memory_calibration_auth_events_sequence_check', sql`${table.sequence} >= 1`),
    check(
      'memory_calibration_auth_events_type_check',
      sql`${table.eventType} in ('created', 'approved', 'enqueued')`,
    ),
    check(
      'memory_calibration_auth_events_fingerprint_check',
      sql`${table.bindingFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check(
      'memory_calibration_auth_events_shape_check',
      sql`(${table.eventType} = 'created' and ${table.reasonCode} is null and ${table.evalRunId} is null)
        or (${table.eventType} = 'approved'
          and length(trim(${table.reasonCode})) between 1 and 256
          and ${table.evalRunId} is null)
        or (${table.eventType} = 'enqueued' and ${table.reasonCode} is null and ${table.evalRunId} is not null)`,
    ),
  ],
)

export const evalTrials = pgTable(
  'eval_trials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    evalRunId: uuid('eval_run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id')
      .notNull()
      .references(() => evalCases.id, { onDelete: 'restrict' }),
    trialIndex: integer('trial_index').notNull(),
    status: text('status').$type<EvalTrialStatus>().notNull(),
    sourceRunId: uuid('source_run_id').references(() => runs.id, { onDelete: 'set null' }),
    output: jsonb('output').$type<unknown>(),
    outputFingerprint: text('output_fingerprint'),
    recordFingerprint: text('record_fingerprint').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('eval_trials_run_case_index_uidx').on(
      table.evalRunId,
      table.caseId,
      table.trialIndex,
    ),
    index('eval_trials_run_status_idx').on(table.evalRunId, table.status),
    check('eval_trials_index_check', sql`${table.trialIndex} between 0 and 19`),
    check('eval_trials_status_check', sql`${table.status} in ('succeeded', 'error')`),
    check(
      'eval_trials_fingerprint_check',
      sql`${table.outputFingerprint} is null
        or ${table.outputFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check(
      'eval_trials_record_fingerprint_check',
      sql`${table.recordFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check(
      'eval_trials_result_shape_check',
      sql`(${table.status} = 'succeeded' and ${table.outputFingerprint} is not null and ${table.errorCode} is null)
        or (${table.status} = 'error' and ${table.errorCode} is not null)`,
    ),
    check('eval_trials_time_check', sql`${table.finishedAt} >= ${table.startedAt}`),
  ],
)

export const evalScores = pgTable(
  'eval_scores',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    trialId: uuid('trial_id')
      .notNull()
      .references(() => evalTrials.id, { onDelete: 'cascade' }),
    evaluatorKey: text('evaluator_key').notNull(),
    evaluatorVersion: text('evaluator_version').notNull(),
    metric: text('metric').notNull(),
    status: text('status').$type<EvalScoreStatus>().notNull(),
    value: doublePrecision('value'),
    passed: boolean('passed'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    provider: text('provider'),
    model: text('model'),
    providerRequestId: text('provider_request_id'),
    providerResponseId: text('provider_response_id'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadInputTokens: integer('cache_read_input_tokens'),
    cacheWriteInputTokens: integer('cache_write_input_tokens'),
    costMicrousd: integer('cost_microusd'),
    pricingVersion: text('pricing_version'),
    costCurrency: text('cost_currency'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('eval_scores_trial_evaluator_metric_uidx').on(
      table.trialId,
      table.evaluatorKey,
      table.evaluatorVersion,
      table.metric,
    ),
    index('eval_scores_metric_idx').on(table.metric, table.createdAt),
    index('eval_scores_model_cost_idx').on(
      table.provider,
      table.model,
      table.pricingVersion,
      table.createdAt,
    ),
    check(
      'eval_scores_status_check',
      sql`${table.status} in ('succeeded', 'error', 'inconclusive')`,
    ),
    check(
      'eval_scores_identity_check',
      sql`length(trim(${table.evaluatorKey})) between 1 and 256
        and length(trim(${table.evaluatorVersion})) between 1 and 256
        and length(trim(${table.metric})) between 1 and 256`,
    ),
    check(
      'eval_scores_result_shape_check',
      sql`(${table.status} = 'succeeded'
          and (${table.value} is not null or ${table.passed} is not null)
          and ${table.errorCode} is null)
        or (${table.status} = 'error' and ${table.errorCode} is not null)
        or (${table.status} = 'inconclusive' and ${table.errorCode} is null)`,
    ),
    check(
      'eval_scores_model_metering_shape_check',
      sql`(${table.provider} is null
          and ${table.model} is null
          and ${table.providerRequestId} is null
          and ${table.providerResponseId} is null
          and ${table.inputTokens} is null
          and ${table.outputTokens} is null
          and ${table.cacheReadInputTokens} is null
          and ${table.cacheWriteInputTokens} is null
          and ${table.costMicrousd} is null
          and ${table.pricingVersion} is null
          and ${table.costCurrency} is null)
        or (${table.provider} is not null
          and length(trim(${table.provider})) between 1 and 256
          and ${table.model} is not null
          and length(trim(${table.model})) between 1 and 256
          and (${table.providerRequestId} is null or length(trim(${table.providerRequestId})) between 1 and 256)
          and (${table.providerResponseId} is null or length(trim(${table.providerResponseId})) between 1 and 512)
          and ${table.inputTokens} >= 0
          and ${table.outputTokens} >= 0
          and ${table.cacheReadInputTokens} >= 0
          and ${table.cacheWriteInputTokens} >= 0
          and ${table.costMicrousd} >= 0
          and ${table.pricingVersion} is not null
          and length(trim(${table.pricingVersion})) between 1 and 256
          and ${table.costCurrency} = 'USD')`,
    ),
  ],
)

export const evalSamplingPolicies = pgTable(
  'eval_sampling_policies',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    samplerKey: text('sampler_key').notNull(),
    samplerVersion: text('sampler_version').notNull(),
    status: text('status')
      .$type<EvalSamplingPolicyStatus>()
      .default('active')
      .notNull(),
    sampleRateBps: integer('sample_rate_bps').notNull(),
    consentPolicyVersion: text('consent_policy_version').notNull(),
    retentionDays: integer('retention_days').notNull(),
    configuredByPrincipalId: uuid('configured_by_principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'restrict' }),
    cursorFinishedAt: timestamp('cursor_finished_at', { withTimezone: true }),
    cursorRunId: uuid('cursor_run_id'),
    lastScannedAt: timestamp('last_scanned_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledByPrincipalId: uuid('disabled_by_principal_id')
      .references(() => principals.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('eval_sampling_policies_workspace_version_uidx').on(
      table.workspaceId,
      table.samplerKey,
      table.samplerVersion,
    ),
    uniqueIndex('eval_sampling_policies_active_uidx')
      .on(table.workspaceId, table.samplerKey)
      .where(sql`${table.status} = 'active'`),
    index('eval_sampling_policies_status_idx').on(table.status, table.lastScannedAt),
    check(
      'eval_sampling_policies_identity_check',
      sql`length(trim(${table.samplerKey})) between 1 and 256
        and length(trim(${table.samplerVersion})) between 1 and 256`,
    ),
    check(
      'eval_sampling_policies_status_check',
      sql`${table.status} in ('active', 'disabled')`,
    ),
    check(
      'eval_sampling_policies_config_check',
      sql`${table.sampleRateBps} between 1 and 10000
        and ${table.retentionDays} between 1 and 365
        and length(trim(${table.consentPolicyVersion})) between 1 and 256`,
    ),
    check(
      'eval_sampling_policies_cursor_check',
      sql`(${table.cursorFinishedAt} is null and ${table.cursorRunId} is null)
        or (${table.cursorFinishedAt} is not null and ${table.cursorRunId} is not null)`,
    ),
    check(
      'eval_sampling_policies_disabled_check',
      sql`(${table.status} = 'active'
          and ${table.disabledAt} is null and ${table.disabledByPrincipalId} is null)
        or (${table.status} = 'disabled' and ${table.disabledAt} is not null)`,
    ),
  ],
)

export const evalCandidates = pgTable(
  'eval_candidates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    samplingPolicyId: uuid('sampling_policy_id')
      .references(() => evalSamplingPolicies.id, { onDelete: 'set null' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    sourceRunId: uuid('source_run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sourceArticleId: uuid('source_article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    sourceRevision: integer('source_revision').notNull(),
    contentFingerprint: text('content_fingerprint').notNull(),
    samplerKey: text('sampler_key').notNull(),
    samplerVersion: text('sampler_version').notNull(),
    samplingBucket: integer('sampling_bucket').notNull(),
    sampleRateBps: integer('sample_rate_bps').notNull(),
    consentBasis: text('consent_basis').$type<EvalConsentBasis>().notNull(),
    consentPolicyVersion: text('consent_policy_version').notNull(),
    dataClassification: text('data_classification')
      .$type<EvalDataClassification>()
      .default('user_content')
      .notNull(),
    status: text('status')
      .$type<EvalCandidateStatus>()
      .default('pending_review')
      .notNull(),
    retentionUntil: timestamp('retention_until', { withTimezone: true }).notNull(),
    reviewedByPrincipalId: uuid('reviewed_by_principal_id')
      .references(() => principals.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    decisionReasonCode: text('decision_reason_code'),
    nextEventSeq: integer('next_event_seq').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('eval_candidates_source_sampler_uidx').on(
      table.sourceRunId,
      table.samplerKey,
      table.samplerVersion,
    ),
    index('eval_candidates_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
    index('eval_candidates_retention_idx').on(table.status, table.retentionUntil),
    check('eval_candidates_source_revision_check', sql`${table.sourceRevision} >= 0`),
    check(
      'eval_candidates_fingerprint_check',
      sql`${table.contentFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check(
      'eval_candidates_sampler_check',
      sql`length(trim(${table.samplerKey})) between 1 and 256
        and length(trim(${table.samplerVersion})) between 1 and 256`,
    ),
    check(
      'eval_candidates_sampling_check',
      sql`${table.samplingBucket} between 0 and 9999
        and ${table.sampleRateBps} between 1 and 10000`,
    ),
    check(
      'eval_candidates_consent_check',
      sql`${table.consentBasis} in ('workspace_policy', 'explicit_user')
        and length(trim(${table.consentPolicyVersion})) between 1 and 256`,
    ),
    check(
      'eval_candidates_classification_check',
      sql`${table.dataClassification} in ('deidentified', 'user_content')`,
    ),
    check(
      'eval_candidates_status_check',
      sql`${table.status} in ('pending_review', 'approved', 'materialized', 'rejected', 'expired')`,
    ),
    check('eval_candidates_next_event_seq_check', sql`${table.nextEventSeq} >= 1`),
    check(
      'eval_candidates_review_shape_check',
      sql`(${table.status} = 'pending_review'
          and ${table.reviewedByPrincipalId} is null and ${table.reviewedAt} is null
          and ${table.decisionReasonCode} is null)
        or (${table.status} in ('approved', 'materialized', 'rejected')
          and ${table.reviewedAt} is not null
          and length(trim(${table.decisionReasonCode})) between 1 and 256)
        or (${table.status} = 'expired')`,
    ),
  ],
)

export const evalCandidateEvents = pgTable(
  'eval_candidate_events',
  {
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => evalCandidates.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    eventType: text('event_type').$type<EvalCandidateEventType>().notNull(),
    actorPrincipalId: uuid('actor_principal_id')
      .references(() => principals.id, { onDelete: 'set null' }),
    reasonCode: text('reason_code').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.candidateId, table.seq] }),
    index('eval_candidate_events_created_idx').on(table.candidateId, table.createdAt),
    check('eval_candidate_events_seq_check', sql`${table.seq} >= 0`),
    check(
      'eval_candidate_events_type_check',
      sql`${table.eventType} in ('sampled', 'approved', 'materialized', 'rejected', 'expired')`,
    ),
    check(
      'eval_candidate_events_reason_check',
      sql`length(trim(${table.reasonCode})) between 1 and 256`,
    ),
  ],
)

export const memorySourceSignals = pgTable(
  'memory_source_signals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdByPrincipalId: uuid('created_by_principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    sourceRunId: uuid('source_run_id')
      .references(() => runs.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    sourceKind: text('source_kind').$type<MemorySourceSignalKind>().notNull(),
    subjectKind: text('subject_kind').$type<MemorySubjectKind>().notNull(),
    subjectKey: text('subject_key').notNull(),
    sourceText: text('source_text').notNull(),
    evidenceFingerprint: text('evidence_fingerprint').notNull(),
    consentBasis: text('consent_basis').$type<EvalConsentBasis>()
      .default('explicit_user')
      .notNull(),
    consentPolicyVersion: text('consent_policy_version').notNull(),
    retentionUntil: timestamp('retention_until', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('memory_source_signals_idempotency_uidx').on(
      table.workspaceId,
      table.createdByPrincipalId,
      table.idempotencyKey,
    ),
    index('memory_source_signals_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    index('memory_source_signals_workspace_author_id_idx').on(
      table.workspaceId,
      table.createdByPrincipalId,
      table.id,
    ),
    index('memory_source_signals_retention_idx').on(table.retentionUntil, table.id),
    check(
      'memory_source_signals_identity_check',
      sql`length(trim(${table.idempotencyKey})) between 1 and 256
        and ${table.requestFingerprint} ~ '^sha256:[0-9a-f]{64}$'
        and ${table.sourceKind} in ('explicit_remember', 'preference_setting', 'correction')
        and ${table.subjectKind} in ('workspace', 'principal', 'project')
        and length(trim(${table.subjectKey})) between 1 and 256`,
    ),
    check(
      'memory_source_signals_content_check',
      sql`length(${table.sourceText}) between 1 and 20000
        and ${table.evidenceFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check(
      'memory_source_signals_consent_check',
      sql`${table.consentBasis} = 'explicit_user'
        and length(trim(${table.consentPolicyVersion})) between 1 and 256`,
    ),
  ],
)

export const memorySourceSignalTombstones = pgTable(
  'memory_source_signal_tombstones',
  {
    sourceSignalId: uuid('source_signal_id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    deletedByPrincipalId: uuid('deleted_by_principal_id')
      .references(() => principals.id, { onDelete: 'set null' }),
    reasonCode: text('reason_code').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('memory_source_signal_tombstones_workspace_deleted_idx').on(
      table.workspaceId,
      table.deletedAt,
    ),
    check(
      'memory_source_signal_tombstones_reason_check',
      sql`length(trim(${table.reasonCode})) between 1 and 256`,
    ),
  ],
)

export const memoryExtractionTasks = pgTable(
  'memory_extraction_tasks',
  {
    sourceId: uuid('source_id').primaryKey(),
    sourceKind: text('source_kind').$type<MemoryEvidenceSourceKind>()
      .default('run')
      .notNull(),
    sourceRunId: uuid('source_run_id')
      .references(() => runs.id, { onDelete: 'cascade' }),
    sourceSignalId: uuid('source_signal_id')
      .references(() => memorySourceSignals.id, { onDelete: 'restrict' }),
    sourceDeletedAt: timestamp('source_deleted_at', { withTimezone: true }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    status: text('status')
      .$type<MemoryExtractionTaskStatus>()
      .default('queued')
      .notNull(),
    executionSnapshot: jsonb('execution_snapshot').$type<MemoryExtractionExecutionSnapshot>(),
    executionFingerprint: text('execution_fingerprint'),
    attempt: integer('attempt').default(0).notNull(),
    leaseOwner: text('lease_owner'),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    resultMetadata: jsonb('result_metadata').$type<Record<string, unknown>>(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('memory_extraction_tasks_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
    index('memory_extraction_tasks_lease_idx').on(table.status, table.leaseExpiresAt),
    uniqueIndex('memory_extraction_tasks_run_source_uidx').on(table.sourceRunId)
      .where(sql`${table.sourceKind} = 'run' and ${table.sourceDeletedAt} is null`),
    uniqueIndex('memory_extraction_tasks_signal_source_uidx').on(table.sourceSignalId)
      .where(sql`${table.sourceKind} = 'signal' and ${table.sourceDeletedAt} is null`),
    check(
      'memory_extraction_tasks_source_check',
      sql`(${table.sourceDeletedAt} is null
          and ((${table.sourceKind} = 'run'
              and ${table.sourceId} = ${table.sourceRunId}
              and ${table.sourceSignalId} is null)
            or (${table.sourceKind} = 'signal'
              and ${table.sourceId} = ${table.sourceSignalId}
              and ${table.sourceRunId} is null)))
        or (${table.sourceDeletedAt} is not null
          and ${table.sourceKind} = 'signal'
          and ${table.sourceRunId} is null
          and ${table.sourceSignalId} is null
          and ${table.status} in ('completed', 'failed', 'uncertain', 'cancelled'))`,
    ),
    check(
      'memory_extraction_tasks_status_check',
      sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'uncertain', 'cancelled')`,
    ),
    check('memory_extraction_tasks_attempt_check', sql`${table.attempt} >= 0`),
    check(
      'memory_extraction_tasks_execution_check',
      sql`(${table.attempt} = 0
          and ${table.executionSnapshot} is null
          and ${table.executionFingerprint} is null)
        or (${table.attempt} >= 1
          and ${table.executionSnapshot} is not null
          and ${table.executionFingerprint} ~ '^sha256:[0-9a-f]{64}$')`,
    ),
    check(
      'memory_extraction_tasks_lease_shape_check',
      sql`(${table.status} = 'running'
          and ${table.leaseOwner} is not null
          and ${table.leaseToken} is not null
          and ${table.leaseExpiresAt} is not null
          and ${table.heartbeatAt} is not null)
        or (${table.status} <> 'running'
          and ${table.leaseOwner} is null
          and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null
          and ${table.heartbeatAt} is null)`,
    ),
    check(
      'memory_extraction_tasks_terminal_shape_check',
      sql`(${table.status} = 'queued'
          and ${table.finishedAt} is null
          and ${table.resultMetadata} is null
          and ${table.errorCode} is null
          and ${table.errorMessage} is null)
        or (${table.status} = 'running'
          and ${table.startedAt} is not null
          and ${table.finishedAt} is null
          and ${table.resultMetadata} is null
          and ${table.errorCode} is null
          and ${table.errorMessage} is null)
        or (${table.status} = 'completed'
          and ${table.startedAt} is not null
          and ${table.finishedAt} is not null
          and ${table.resultMetadata} is not null
          and ${table.errorCode} is null
          and ${table.errorMessage} is null)
        or (${table.status} in ('failed', 'uncertain')
          and ${table.startedAt} is not null
          and ${table.finishedAt} is not null
          and ${table.resultMetadata} is null
          and length(trim(${table.errorCode})) between 1 and 256
          and ${table.errorMessage} is not null)
        or (${table.status} = 'cancelled'
          and ${table.finishedAt} is not null
          and ${table.resultMetadata} is null
          and length(trim(${table.errorCode})) between 1 and 256
          and ${table.errorMessage} is not null)`,
    ),
  ],
)

export const memoryExtractionAttempts = pgTable(
  'memory_extraction_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => memoryExtractionTasks.sourceId, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    workerId: text('worker_id').notNull(),
    leaseToken: uuid('lease_token').notNull(),
    status: text('status').$type<MemoryExtractionAttemptStatus>().notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('memory_extraction_attempts_source_attempt_uidx').on(
      table.sourceId,
      table.attempt,
    ),
    uniqueIndex('memory_extraction_attempts_lease_token_uidx').on(table.leaseToken),
    index('memory_extraction_attempts_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
    check('memory_extraction_attempts_attempt_check', sql`${table.attempt} >= 1`),
    check(
      'memory_extraction_attempts_status_check',
      sql`${table.status} in ('running', 'completed', 'failed', 'uncertain', 'cancelled')`,
    ),
    check(
      'memory_extraction_attempts_shape_check',
      sql`(${table.status} = 'running'
          and ${table.finishedAt} is null
          and ${table.errorCode} is null
          and ${table.errorMessage} is null)
        or (${table.status} = 'completed'
          and ${table.finishedAt} is not null
          and ${table.errorCode} is null
          and ${table.errorMessage} is null)
        or (${table.status} in ('failed', 'uncertain', 'cancelled')
          and ${table.finishedAt} is not null
          and length(trim(${table.errorCode})) between 1 and 256
          and ${table.errorMessage} is not null)`,
    ),
  ],
)

export const memoryExtractionEffects = pgTable(
  'memory_extraction_effects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => memoryExtractionTasks.sourceId, { onDelete: 'cascade' }),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => memoryExtractionAttempts.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    effectKey: text('effect_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    status: text('status')
      .$type<MemoryExtractionEffectStatus>()
      .default('reserved')
      .notNull(),
    resultFingerprint: text('result_fingerprint'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    providerRequestId: text('provider_request_id'),
    providerResponseId: text('provider_response_id'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadInputTokens: integer('cache_read_input_tokens'),
    cacheWriteInputTokens: integer('cache_write_input_tokens'),
    costMicrousd: integer('cost_microusd'),
    pricingVersion: text('pricing_version'),
    costCurrency: text('cost_currency'),
    budgetDay: date('budget_day'),
    budgetPolicyVersion: text('budget_policy_version'),
    reservedCostMicrousd: integer('reserved_cost_microusd'),
    sourceBudgetMicrousd: integer('source_budget_microusd'),
    workspaceDailyBudgetMicrousd: integer('workspace_daily_budget_microusd'),
    reservationPricingVersion: text('reservation_pricing_version'),
    latencyMs: integer('latency_ms'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('memory_extraction_effects_source_key_uidx').on(
      table.sourceId,
      table.effectKey,
    ),
    index('memory_extraction_effects_attempt_status_idx').on(table.attemptId, table.status),
    index('memory_extraction_effects_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    index('memory_extraction_effects_workspace_budget_day_idx').on(
      table.workspaceId,
      table.budgetDay,
    ),
    check(
      'memory_extraction_effects_identity_check',
      sql`length(trim(${table.effectKey})) between 1 and 512
        and ${table.requestFingerprint} ~ '^sha256:[0-9a-f]{64}$'
        and length(trim(${table.provider})) between 1 and 256
        and length(trim(${table.model})) between 1 and 256
        and (${table.providerRequestId} is null
          or length(trim(${table.providerRequestId})) between 1 and 512)
        and (${table.providerResponseId} is null
          or length(trim(${table.providerResponseId})) between 1 and 512)`,
    ),
    check(
      'memory_extraction_effects_status_check',
      sql`${table.status} in ('reserved', 'succeeded', 'failed', 'uncertain')`,
    ),
    check(
      'memory_extraction_effects_terminal_shape_check',
      sql`(${table.status} = 'reserved'
          and ${table.finishedAt} is null
          and ${table.resultFingerprint} is null
          and ${table.errorCode} is null
          and ${table.errorMessage} is null)
        or (${table.status} = 'succeeded'
          and ${table.finishedAt} is not null
          and ${table.resultFingerprint} ~ '^sha256:[0-9a-f]{64}$'
          and ${table.errorCode} is null
          and ${table.errorMessage} is null)
        or (${table.status} in ('failed', 'uncertain')
          and ${table.finishedAt} is not null
          and ${table.resultFingerprint} ~ '^sha256:[0-9a-f]{64}$'
          and length(trim(${table.errorCode})) between 1 and 256
          and ${table.errorMessage} is not null)`,
    ),
    check(
      'memory_extraction_effects_usage_check',
      sql`(${table.inputTokens} is null or ${table.inputTokens} >= 0)
        and (${table.outputTokens} is null or ${table.outputTokens} >= 0)
        and (${table.cacheReadInputTokens} is null or ${table.cacheReadInputTokens} >= 0)
        and (${table.cacheWriteInputTokens} is null or ${table.cacheWriteInputTokens} >= 0)
        and (${table.latencyMs} is null or ${table.latencyMs} >= 0)`,
    ),
    check(
      'memory_extraction_effects_cost_check',
      sql`(${table.costMicrousd} is null
          and ${table.pricingVersion} is null
          and ${table.costCurrency} is null)
        or (${table.costMicrousd} >= 0
          and length(trim(${table.pricingVersion})) between 1 and 256
          and ${table.costCurrency} = 'USD')`,
    ),
    check(
      'memory_extraction_effects_budget_check',
      sql`(${table.budgetDay} is null
          and ${table.budgetPolicyVersion} is null
          and ${table.reservedCostMicrousd} is null
          and ${table.sourceBudgetMicrousd} is null
          and ${table.workspaceDailyBudgetMicrousd} is null
          and ${table.reservationPricingVersion} is null)
        or (${table.budgetDay} is not null
          and length(trim(${table.budgetPolicyVersion})) between 1 and 256
          and ${table.reservedCostMicrousd} >= 0
          and ${table.sourceBudgetMicrousd} > 0
          and ${table.workspaceDailyBudgetMicrousd} >= ${table.sourceBudgetMicrousd}
          and length(trim(${table.reservationPricingVersion})) between 1 and 256)`,
    ),
  ],
)

export const memoryExtractionReconciliations = pgTable(
  'memory_extraction_reconciliations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => memoryExtractionTasks.sourceId, { onDelete: 'cascade' }),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => memoryExtractionAttempts.id, { onDelete: 'cascade' }),
    effectId: uuid('effect_id')
      .notNull()
      .references(() => memoryExtractionEffects.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    resolutionFingerprint: text('resolution_fingerprint').notNull(),
    decision: text('decision').$type<MemoryReconciliationDecision>().notNull(),
    retryDisposition: text('retry_disposition')
      .$type<MemoryReconciliationRetryDisposition>()
      .notNull(),
    maxAttempts: integer('max_attempts'),
    evidenceKind: text('evidence_kind').$type<MemoryReconciliationEvidenceKind>().notNull(),
    evidenceFingerprint: text('evidence_fingerprint').notNull(),
    reasonCode: text('reason_code').notNull(),
    resolvedByPrincipalId: uuid('resolved_by_principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'restrict' }),
    providerRequestId: text('provider_request_id'),
    providerResponseId: text('provider_response_id'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadInputTokens: integer('cache_read_input_tokens'),
    cacheWriteInputTokens: integer('cache_write_input_tokens'),
    costMicrousd: integer('cost_microusd'),
    pricingVersion: text('pricing_version'),
    costCurrency: text('cost_currency'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('memory_extraction_reconciliations_effect_uidx').on(table.effectId),
    uniqueIndex('memory_extraction_reconciliations_workspace_idempotency_uidx').on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    index('memory_extraction_reconciliations_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    check(
      'memory_extraction_reconciliations_identity_check',
      sql`length(trim(${table.idempotencyKey})) between 1 and 256
        and ${table.resolutionFingerprint} ~ '^sha256:[0-9a-f]{64}$'
        and ${table.evidenceFingerprint} ~ '^sha256:[0-9a-f]{64}$'
        and length(trim(${table.reasonCode})) between 1 and 256
        and (${table.providerRequestId} is null
          or length(trim(${table.providerRequestId})) between 1 and 512)
        and (${table.providerResponseId} is null
          or length(trim(${table.providerResponseId})) between 1 and 512)`,
    ),
    check(
      'memory_extraction_reconciliations_decision_check',
      sql`${table.decision} in ('confirmed_failed', 'confirmed_succeeded')
        and ${table.retryDisposition} in ('hold', 'requeue')
        and ${table.evidenceKind} in ('provider_lookup', 'billing_export', 'operator_attestation')
        and ((${table.decision} = 'confirmed_succeeded'
            and ${table.retryDisposition} = 'hold'
            and ${table.maxAttempts} is null)
          or (${table.decision} = 'confirmed_failed'
            and ((${table.retryDisposition} = 'hold' and ${table.maxAttempts} is null)
              or (${table.retryDisposition} = 'requeue'
                and ${table.maxAttempts} between 1 and 10))))`,
    ),
    check(
      'memory_extraction_reconciliations_usage_check',
      sql`(${table.inputTokens} is null or ${table.inputTokens} >= 0)
        and (${table.outputTokens} is null or ${table.outputTokens} >= 0)
        and (${table.cacheReadInputTokens} is null or ${table.cacheReadInputTokens} >= 0)
        and (${table.cacheWriteInputTokens} is null or ${table.cacheWriteInputTokens} >= 0)`,
    ),
    check(
      'memory_extraction_reconciliations_cost_check',
      sql`(${table.costMicrousd} is null
          and ${table.pricingVersion} is null
          and ${table.costCurrency} is null)
        or (${table.costMicrousd} >= 0
          and length(trim(${table.pricingVersion})) between 1 and 256
          and ${table.costCurrency} = 'USD')`,
    ),
  ],
)

export const memoryCandidates = pgTable(
  'memory_candidates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceKind: text('source_kind').$type<MemoryEvidenceSourceKind>()
      .default('run')
      .notNull(),
    sourceRunId: uuid('source_run_id')
      .references(() => runs.id, { onDelete: 'cascade' }),
    sourceSignalId: uuid('source_signal_id')
      .references(() => memorySourceSignals.id, { onDelete: 'cascade' }),
    subjectKind: text('subject_kind').$type<MemorySubjectKind>().notNull(),
    subjectKey: text('subject_key').notNull(),
    memoryKey: text('memory_key').notNull(),
    kind: text('kind').$type<MemoryKind>().notNull(),
    content: text('content').notNull(),
    contentFingerprint: text('content_fingerprint').notNull(),
    proposedBy: text('proposed_by').$type<MemoryProposer>().notNull(),
    confidence: doublePrecision('confidence').notNull(),
    sensitivity: text('sensitivity').$type<MemorySensitivity>().notNull(),
    consentBasis: text('consent_basis').$type<EvalConsentBasis>().notNull(),
    consentPolicyVersion: text('consent_policy_version').notNull(),
    evidenceFingerprint: text('evidence_fingerprint').notNull(),
    extractorKey: text('extractor_key').notNull(),
    extractorVersion: text('extractor_version').notNull(),
    policyVersion: text('policy_version').notNull(),
    policyOutcome: text('policy_outcome').$type<MemoryPolicyOutcome>().notNull(),
    status: text('status')
      .$type<MemoryCandidateStatus>()
      .default('pending_review')
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    reviewedByPrincipalId: uuid('reviewed_by_principal_id')
      .references(() => principals.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    decisionReasonCode: text('decision_reason_code'),
    materializedMemoryId: uuid('materialized_memory_id'),
    materializedRevision: integer('materialized_revision'),
    nextEventSeq: integer('next_event_seq').default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('memory_candidates_run_extractor_slot_uidx').on(
      table.sourceRunId,
      table.extractorKey,
      table.extractorVersion,
      table.subjectKind,
      table.subjectKey,
      table.memoryKey,
    ).where(sql`${table.sourceKind} = 'run'`),
    uniqueIndex('memory_candidates_signal_extractor_slot_uidx').on(
      table.sourceSignalId,
      table.extractorKey,
      table.extractorVersion,
      table.subjectKind,
      table.subjectKey,
      table.memoryKey,
    ).where(sql`${table.sourceKind} = 'signal'`),
    index('memory_candidates_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
    index('memory_candidates_workspace_id_idx').on(table.workspaceId, table.id),
    index('memory_candidates_expiry_idx').on(table.status, table.expiresAt),
    index('memory_candidates_due_idx').on(table.expiresAt, table.id),
    check(
      'memory_candidates_source_check',
      sql`(${table.sourceKind} = 'run'
          and ${table.sourceRunId} is not null
          and ${table.sourceSignalId} is null)
        or (${table.sourceKind} = 'signal'
          and ${table.sourceRunId} is null
          and ${table.sourceSignalId} is not null)`,
    ),
    check(
      'memory_candidates_identity_check',
      sql`${table.subjectKind} in ('workspace', 'principal', 'project')
        and length(trim(${table.subjectKey})) between 1 and 256
        and ${table.memoryKey} ~ '^[a-z0-9][a-z0-9_.-]{0,255}$'
        and ${table.kind} in ('preference', 'constraint', 'correction')`,
    ),
    check(
      'memory_candidates_content_check',
      sql`length(${table.content}) between 1 and 4096
        and ${table.contentFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check(
      'memory_candidates_proposal_check',
      sql`${table.proposedBy} in ('user', 'model')
        and ${table.confidence} between 0 and 1
        and ${table.sensitivity} in ('normal', 'sensitive')
        and ${table.consentBasis} in ('workspace_policy', 'explicit_user')
        and length(trim(${table.consentPolicyVersion})) between 1 and 256
        and ${table.evidenceFingerprint} ~ '^sha256:[0-9a-f]{64}$'
        and length(trim(${table.extractorKey})) between 1 and 256
        and length(trim(${table.extractorVersion})) between 1 and 256
        and length(trim(${table.policyVersion})) between 1 and 256
        and ${table.policyOutcome} in ('candidate', 'conflict')`,
    ),
    check(
      'memory_candidates_status_check',
      sql`${table.status} in ('pending_review', 'materialized', 'rejected', 'expired')
        and ${table.nextEventSeq} >= 1`,
    ),
    check(
      'memory_candidates_review_shape_check',
      sql`(${table.status} = 'pending_review'
          and ${table.reviewedByPrincipalId} is null
          and ${table.reviewedAt} is null
          and ${table.decisionReasonCode} is null
          and ${table.materializedMemoryId} is null
          and ${table.materializedRevision} is null)
        or (${table.status} = 'materialized'
          and ${table.reviewedAt} is not null
          and length(trim(${table.decisionReasonCode})) between 1 and 256
          and ${table.materializedMemoryId} is not null
          and ${table.materializedRevision} >= 1)
        or (${table.status} = 'rejected'
          and ${table.reviewedAt} is not null
          and length(trim(${table.decisionReasonCode})) between 1 and 256
          and ${table.materializedMemoryId} is null
          and ${table.materializedRevision} is null)
        or (${table.status} = 'expired'
          and ${table.materializedMemoryId} is null
          and ${table.materializedRevision} is null)`,
    ),
  ],
)

export const memories = pgTable(
  'memories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    subjectKind: text('subject_kind').$type<MemorySubjectKind>().notNull(),
    subjectKey: text('subject_key').notNull(),
    memoryKey: text('memory_key').notNull(),
    kind: text('kind').$type<MemoryKind>().notNull(),
    currentRevision: integer('current_revision').notNull(),
    currentContentFingerprint: text('current_content_fingerprint').notNull(),
    currentCandidateId: uuid('current_candidate_id')
      .notNull()
      .references(() => memoryCandidates.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('memories_workspace_subject_slot_uidx').on(
      table.workspaceId,
      table.subjectKind,
      table.subjectKey,
      table.memoryKey,
    ),
    index('memories_workspace_expiry_idx').on(table.workspaceId, table.expiresAt),
    index('memories_workspace_id_idx').on(table.workspaceId, table.id),
    index('memories_due_idx').on(table.expiresAt, table.id),
    check(
      'memories_identity_check',
      sql`${table.subjectKind} in ('workspace', 'principal', 'project')
        and length(trim(${table.subjectKey})) between 1 and 256
        and ${table.memoryKey} ~ '^[a-z0-9][a-z0-9_.-]{0,255}$'
        and ${table.kind} in ('preference', 'constraint', 'correction')`,
    ),
    check('memories_revision_check', sql`${table.currentRevision} >= 1`),
    check(
      'memories_fingerprint_check',
      sql`${table.currentContentFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  ],
)

export const memoryRevisions = pgTable(
  'memory_revisions',
  {
    memoryId: uuid('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    content: text('content').notNull(),
    contentFingerprint: text('content_fingerprint').notNull(),
    sourceCandidateId: uuid('source_candidate_id')
      .notNull()
      .references(() => memoryCandidates.id, { onDelete: 'cascade' }),
    createdByPrincipalId: uuid('created_by_principal_id')
      .references(() => principals.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.memoryId, table.revision] }),
    uniqueIndex('memory_revisions_source_candidate_uidx').on(table.sourceCandidateId),
    check('memory_revisions_revision_check', sql`${table.revision} >= 1`),
    check(
      'memory_revisions_content_check',
      sql`length(${table.content}) between 1 and 4096
        and ${table.contentFingerprint} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  ],
)

export const memoryCandidateEvents = pgTable(
  'memory_candidate_events',
  {
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => memoryCandidates.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    eventType: text('event_type').$type<MemoryCandidateEventType>().notNull(),
    actorPrincipalId: uuid('actor_principal_id')
      .references(() => principals.id, { onDelete: 'set null' }),
    reasonCode: text('reason_code').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.candidateId, table.seq] }),
    check('memory_candidate_events_seq_check', sql`${table.seq} >= 0`),
    check(
      'memory_candidate_events_type_check',
      sql`${table.eventType} in ('proposed', 'materialized', 'rejected', 'expired')`,
    ),
    check(
      'memory_candidate_events_reason_check',
      sql`length(trim(${table.reasonCode})) between 1 and 256`,
    ),
  ],
)

export const memoryTombstones = pgTable(
  'memory_tombstones',
  {
    memoryId: uuid('memory_id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slotFingerprint: text('slot_fingerprint').notNull(),
    deletedByPrincipalId: uuid('deleted_by_principal_id')
      .references(() => principals.id, { onDelete: 'set null' }),
    reasonCode: text('reason_code').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('memory_tombstones_workspace_deleted_idx').on(table.workspaceId, table.deletedAt),
    check(
      'memory_tombstones_shape_check',
      sql`${table.slotFingerprint} ~ '^sha256:[0-9a-f]{64}$'
        and length(trim(${table.reasonCode})) between 1 and 256`,
    ),
  ],
)

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    idempotencyKey: text('idempotency_key').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<OutboxStatus>().default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
    lockedBy: text('locked_by'),
    lockToken: uuid('lock_token'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('outbox_events_idempotency_key_uidx').on(table.idempotencyKey),
    index('outbox_events_ready_idx').on(table.status, table.availableAt, table.createdAt),
    check(
      'outbox_events_status_check',
      sql`${table.status} in ('pending', 'publishing', 'published', 'failed')`,
    ),
    check('outbox_events_attempts_check', sql`${table.attempts} >= 0`),
    check(
      'outbox_events_lock_shape_check',
      sql`(${table.status} = 'publishing' and ${table.lockedBy} is not null and ${table.lockToken} is not null and ${table.lockedAt} is not null)
        or (${table.status} <> 'publishing' and ${table.lockedBy} is null and ${table.lockToken} is null and ${table.lockedAt} is null)`,
    ),
    check(
      'outbox_events_published_shape_check',
      sql`(${table.status} = 'published' and ${table.publishedAt} is not null)
        or (${table.status} <> 'published' and ${table.publishedAt} is null)`,
    ),
  ],
)

export type JobRow = typeof jobs.$inferSelect
export type PrincipalRow = typeof principals.$inferSelect
export type PrincipalIdentityRow = typeof principalIdentities.$inferSelect
export type WorkspaceRow = typeof workspaces.$inferSelect
export type WorkspaceMembershipRow = typeof workspaceMemberships.$inferSelect
export type NewJobRow = typeof jobs.$inferInsert
export type RunRow = typeof runs.$inferSelect
export type CheckpointAttemptRow = typeof checkpointAttempts.$inferSelect
export type JobInterruptRow = typeof jobInterrupts.$inferSelect
export type JobCommandRow = typeof jobCommands.$inferSelect
export type ArticleRow = typeof articles.$inferSelect
export type ArticleVersionRow = typeof articleVersions.$inferSelect
export type NewRunRow = typeof runs.$inferInsert
export type JobEventRow = typeof jobEvents.$inferSelect
export type RunEffectRow = typeof runEffects.$inferSelect
export type OutboxEventRow = typeof outboxEvents.$inferSelect
export type TraceSpanRow = typeof traceSpans.$inferSelect
export type EvalSuiteRow = typeof evalSuites.$inferSelect
export type EvalCaseRow = typeof evalCases.$inferSelect
export type EvalRunRow = typeof evalRuns.$inferSelect
export type EvalTrialRow = typeof evalTrials.$inferSelect
export type EvalScoreRow = typeof evalScores.$inferSelect
export type MemoryCalibrationAuthorizationRow =
  typeof memoryCalibrationAuthorizations.$inferSelect
export type MemoryCalibrationAuthorizationEventRow =
  typeof memoryCalibrationAuthorizationEvents.$inferSelect
export type MemoryCandidateRow = typeof memoryCandidates.$inferSelect
export type MemoryExtractionTaskRow = typeof memoryExtractionTasks.$inferSelect
export type MemoryExtractionAttemptRow = typeof memoryExtractionAttempts.$inferSelect
export type MemoryExtractionEffectRow = typeof memoryExtractionEffects.$inferSelect
export type MemoryRow = typeof memories.$inferSelect
export type MemoryRevisionRow = typeof memoryRevisions.$inferSelect
export type MemoryCandidateEventRow = typeof memoryCandidateEvents.$inferSelect
export type MemoryTombstoneRow = typeof memoryTombstones.$inferSelect
export type MemorySourceSignalRow = typeof memorySourceSignals.$inferSelect
export type MemorySourceSignalTombstoneRow = typeof memorySourceSignalTombstones.$inferSelect
export type EvalCandidateRow = typeof evalCandidates.$inferSelect
export type EvalCandidateEventRow = typeof evalCandidateEvents.$inferSelect
export type EvalSamplingPolicyRow = typeof evalSamplingPolicies.$inferSelect
