import type { InterventionConfig } from '@vibe-writer/contracts/jobs'
import type { MemoryExtractionBudgetPolicy } from '@vibe-writer/memory-core'

export const JOB_STATUSES = [
  'queued',
  'running',
  'awaiting_input',
  'completed',
  'failed',
  'cancelled',
] as const

export const WORKFLOW_STAGES = ['plan', 'write', 'review', 'export'] as const
export const RUN_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const
export const OUTBOX_STATUSES = ['pending', 'publishing', 'published', 'failed'] as const
export const RUN_EFFECT_TYPES = ['model_call', 'tool_call', 'search', 'export'] as const
export const RUN_EFFECT_STATUSES = [
  'reserved',
  'succeeded',
  'failed',
  'uncertain',
] as const
export const CHECKPOINT_ATTEMPT_STATUSES = [
  'preparing',
  'active',
  'superseded',
] as const
export const JOB_INTERRUPT_STATUSES = ['pending', 'replied', 'cancelled'] as const
export const JOB_INTERRUPT_TYPES = ['outline_review'] as const
export const JOB_COMMAND_TYPES = ['outline_reply'] as const
export const TRACE_SPAN_KINDS = ['model', 'search', 'tool', 'workflow'] as const
export const TRACE_SPAN_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'uncertain',
] as const
export const EVAL_SUITE_STATUSES = ['draft', 'active', 'archived'] as const
export const EVAL_RUN_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const
export const EVAL_RUN_MODES = ['inline', 'queued'] as const
export const EVAL_RUN_TRIGGERS = ['manual', 'ci', 'shadow', 'regression'] as const
export const EVAL_TRIAL_STATUSES = ['succeeded', 'error'] as const
export const EVAL_SCORE_STATUSES = ['succeeded', 'error', 'inconclusive'] as const
export const EVAL_DATA_CLASSIFICATIONS = [
  'synthetic',
  'deidentified',
  'user_content',
] as const
export const EVAL_CANDIDATE_STATUSES = [
  'pending_review',
  'approved',
  'materialized',
  'rejected',
  'expired',
] as const
export const EVAL_CONSENT_BASES = ['workspace_policy', 'explicit_user'] as const
export const EVAL_SAMPLING_POLICY_STATUSES = ['active', 'disabled'] as const
export const EVAL_CANDIDATE_EVENT_TYPES = [
  'sampled',
  'approved',
  'materialized',
  'rejected',
  'expired',
] as const
export const MEMORY_CALIBRATION_AUTHORIZATION_STATUSES = [
  'draft',
  'approved',
  'enqueued',
] as const
export const MEMORY_CALIBRATION_AUTHORIZATION_EVENT_TYPES = [
  'created',
  'approved',
  'enqueued',
] as const
export const PRINCIPAL_STATUSES = ['active', 'disabled'] as const
export const WORKSPACE_STATUSES = ['active', 'suspended'] as const
export const WORKSPACE_ROLES = ['owner', 'editor', 'viewer'] as const
export const MEMORY_SUBJECT_KINDS = ['workspace', 'principal', 'project'] as const
export const MEMORY_KINDS = ['preference', 'constraint', 'correction'] as const
export const MEMORY_PROPOSERS = ['user', 'model'] as const
export const MEMORY_SENSITIVITIES = ['normal', 'sensitive'] as const
export const MEMORY_POLICY_OUTCOMES = ['candidate', 'conflict'] as const
export const MEMORY_CANDIDATE_STATUSES = [
  'pending_review',
  'materialized',
  'rejected',
  'expired',
] as const
export const MEMORY_CANDIDATE_EVENT_TYPES = [
  'proposed',
  'materialized',
  'rejected',
  'expired',
] as const
export const MEMORY_SOURCE_SIGNAL_KINDS = [
  'explicit_remember',
  'preference_setting',
  'correction',
] as const
export const MEMORY_EVIDENCE_SOURCE_KINDS = ['run', 'signal'] as const
export const MEMORY_EXTRACTION_TASK_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'uncertain',
  'cancelled',
] as const
export const MEMORY_EXTRACTION_ATTEMPT_STATUSES = [
  'running',
  'completed',
  'failed',
  'uncertain',
  'cancelled',
] as const
export const MEMORY_EXTRACTION_EFFECT_STATUSES = [
  'reserved',
  'succeeded',
  'failed',
  'uncertain',
] as const
export const MEMORY_RECONCILIATION_DECISIONS = [
  'confirmed_failed',
  'confirmed_succeeded',
] as const
export const MEMORY_RECONCILIATION_RETRY_DISPOSITIONS = ['hold', 'requeue'] as const
export const MEMORY_RECONCILIATION_EVIDENCE_KINDS = [
  'provider_lookup',
  'billing_export',
  'operator_attestation',
] as const

export type JobStatus = (typeof JOB_STATUSES)[number]
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number]
export type RunStatus = (typeof RUN_STATUSES)[number]
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number]
export type RunEffectType = (typeof RUN_EFFECT_TYPES)[number]
export type RunEffectStatus = (typeof RUN_EFFECT_STATUSES)[number]
export type CheckpointAttemptStatus = (typeof CHECKPOINT_ATTEMPT_STATUSES)[number]
export type JobInterruptStatus = (typeof JOB_INTERRUPT_STATUSES)[number]
export type JobInterruptType = (typeof JOB_INTERRUPT_TYPES)[number]
export type JobCommandType = (typeof JOB_COMMAND_TYPES)[number]
export type TraceSpanKind = (typeof TRACE_SPAN_KINDS)[number]
export type TraceSpanStatus = (typeof TRACE_SPAN_STATUSES)[number]
export type EvalSuiteStatus = (typeof EVAL_SUITE_STATUSES)[number]
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number]
export type EvalRunMode = (typeof EVAL_RUN_MODES)[number]
export type EvalRunTrigger = (typeof EVAL_RUN_TRIGGERS)[number]
export type EvalTrialStatus = (typeof EVAL_TRIAL_STATUSES)[number]
export type EvalScoreStatus = (typeof EVAL_SCORE_STATUSES)[number]
export type EvalDataClassification = (typeof EVAL_DATA_CLASSIFICATIONS)[number]
export type EvalCandidateStatus = (typeof EVAL_CANDIDATE_STATUSES)[number]
export type EvalConsentBasis = (typeof EVAL_CONSENT_BASES)[number]
export type EvalSamplingPolicyStatus = (typeof EVAL_SAMPLING_POLICY_STATUSES)[number]
export type EvalCandidateEventType = (typeof EVAL_CANDIDATE_EVENT_TYPES)[number]
export type MemoryCalibrationAuthorizationStatus =
  (typeof MEMORY_CALIBRATION_AUTHORIZATION_STATUSES)[number]
export type MemoryCalibrationAuthorizationEventType =
  (typeof MEMORY_CALIBRATION_AUTHORIZATION_EVENT_TYPES)[number]
export type PrincipalStatus = (typeof PRINCIPAL_STATUSES)[number]
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number]
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]
export type MemorySubjectKind = (typeof MEMORY_SUBJECT_KINDS)[number]
export type MemoryKind = (typeof MEMORY_KINDS)[number]
export type MemoryProposer = (typeof MEMORY_PROPOSERS)[number]
export type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number]
export type MemoryPolicyOutcome = (typeof MEMORY_POLICY_OUTCOMES)[number]
export type MemoryCandidateStatus = (typeof MEMORY_CANDIDATE_STATUSES)[number]
export type MemoryCandidateEventType = (typeof MEMORY_CANDIDATE_EVENT_TYPES)[number]
export type MemorySourceSignalKind = (typeof MEMORY_SOURCE_SIGNAL_KINDS)[number]
export type MemoryEvidenceSourceKind = (typeof MEMORY_EVIDENCE_SOURCE_KINDS)[number]
export type MemoryExtractionTaskStatus = (typeof MEMORY_EXTRACTION_TASK_STATUSES)[number]
export type MemoryExtractionAttemptStatus = (typeof MEMORY_EXTRACTION_ATTEMPT_STATUSES)[number]
export type MemoryExtractionEffectStatus = (typeof MEMORY_EXTRACTION_EFFECT_STATUSES)[number]
export type MemoryReconciliationDecision = (typeof MEMORY_RECONCILIATION_DECISIONS)[number]
export type MemoryReconciliationRetryDisposition =
  (typeof MEMORY_RECONCILIATION_RETRY_DISPOSITIONS)[number]
export type MemoryReconciliationEvidenceKind =
  (typeof MEMORY_RECONCILIATION_EVIDENCE_KINDS)[number]

export type WorkspaceScope = {
  workspaceId: string
  principalId: string
}

// These identities are reserved for explicit migration/system ownership. Product
// requests must always provide an authenticated principal and workspace instead.
export const SYSTEM_PRINCIPAL_ID = '00000000-0000-4000-8000-000000000001'
export const SYSTEM_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002'

export type ModelProfileSnapshot = {
  profile: string
  provider: string
  model: string
}

export type MemoryExtractionExecutionSnapshot = {
  extractorKey: string
  extractorVersion: string
  promptVersion: string
  consentPolicyVersion: string
  retentionDays: number
  modelProfile: ModelProfileSnapshot
  budget?: MemoryExtractionBudgetPolicy
}

export type ToolVersions = Record<string, string>
export type JobIntervention = InterventionConfig

export type EvalExecutionSnapshot = {
  modelProfile: string
  promptVersion: string
  graphVersion: string
  toolVersions: ToolVersions
  codeRevision: string
}

export type LeaseHeartbeatResult = 'renewed' | 'cancel_requested' | 'lease_lost'
export type ClaimSettlement = 'completed' | 'failed' | 'cancelled'
export type SettleClaimResult =
  | { status: 'settled' }
  | { status: 'cancel_requested' }
  | { status: 'lease_lost' }
export type CancellationRequestResult =
  | 'cancelled'
  | 'cancel_requested'
  | 'already_terminal'
  | 'not_found'

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
])
