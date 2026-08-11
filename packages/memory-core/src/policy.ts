import { createHash } from 'node:crypto'
import { z } from 'zod'

export const MEMORY_POLICY = {
  version: '2026-08-07-v2',
  minimumModelConfidence: 0.8,
  maximumContentCharacters: 4_096,
} as const

const Identifier = z.string().trim().min(1).max(256)
const MemoryKey = z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{0,255}$/)
const EvidenceFingerprint = z.string().regex(/^sha256:[0-9a-f]{64}$/)

export const MemorySourcePointerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('run'),
    runId: z.uuid(),
  }).strict(),
  z.object({
    kind: z.literal('signal'),
    signalId: z.uuid(),
  }).strict(),
])

export const MemoryEvidenceSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('run'),
    runId: z.uuid(),
    evidenceFingerprint: EvidenceFingerprint,
  }).strict(),
  z.object({
    kind: z.literal('signal'),
    signalId: z.uuid(),
    evidenceFingerprint: EvidenceFingerprint,
  }).strict(),
])

export type MemorySourcePointer = z.infer<typeof MemorySourcePointerSchema>
export type MemoryEvidenceSource = z.infer<typeof MemoryEvidenceSourceSchema>

export const MemoryProposalSchema = z.object({
  schemaVersion: z.literal(2),
  workspaceId: z.uuid(),
  subject: z.object({
    kind: z.enum(['workspace', 'principal', 'project']),
    key: Identifier,
  }).strict(),
  memoryKey: MemoryKey,
  kind: z.enum(['preference', 'constraint', 'correction']),
  content: z.string().min(1).max(MEMORY_POLICY.maximumContentCharacters),
  proposedBy: z.enum(['user', 'model']),
  confidence: z.number().min(0).max(1),
  sensitivity: z.enum(['normal', 'sensitive']),
  consent: z.object({
    basis: z.enum(['explicit_user', 'workspace_policy']),
    policyVersion: Identifier,
  }).strict(),
  source: MemoryEvidenceSourceSchema,
  extractor: z.object({
    key: Identifier,
    version: Identifier,
  }).strict(),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict()

export type MemoryProposal = z.infer<typeof MemoryProposalSchema>

export type ActiveMemory = {
  workspaceId: string
  subject: MemoryProposal['subject']
  memoryKey: string
  contentFingerprint: string
}

export type MemoryPolicyDecision =
  | { outcome: 'candidate'; proposal: MemoryProposal; contentFingerprint: string }
  | { outcome: 'duplicate'; proposal: MemoryProposal; contentFingerprint: string }
  | { outcome: 'conflict'; proposal: MemoryProposal; contentFingerprint: string }
  | {
      outcome: 'rejected'
      reason: 'expired' | 'low_confidence' | 'sensitive_inference'
      contentFingerprint: string
    }

const MemoryReviewCandidateSchema = z.object({
  policyOutcome: z.enum(['candidate', 'conflict']),
  kind: z.enum(['preference', 'constraint', 'correction']),
  contentFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict()

const ActiveMemoryRevisionSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['preference', 'constraint', 'correction']),
  currentRevision: z.int().min(1),
}).strict()

export type MemoryReviewTransition =
  | { outcome: 'create'; revision: 1 }
  | { outcome: 'replace'; memoryId: string; revision: number }
  | {
      outcome: 'rejected'
      reason:
        | 'stale_candidate'
        | 'unexpected_replacement'
        | 'replacement_required'
        | 'kind_mismatch'
    }

export function normalizeMemoryContent(content: string): string {
  const normalized = content.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > MEMORY_POLICY.maximumContentCharacters) {
    throw new Error('Memory content must contain 1-4096 normalized characters')
  }
  return normalized
}

export function fingerprintMemoryContent(content: string): string {
  return `sha256:${createHash('sha256').update(normalizeMemoryContent(content)).digest('hex')}`
}

function sameSlot(proposal: MemoryProposal, active: ActiveMemory): boolean {
  return proposal.workspaceId === active.workspaceId &&
    proposal.subject.kind === active.subject.kind &&
    proposal.subject.key === active.subject.key &&
    proposal.memoryKey === active.memoryKey
}

export function evaluateMemoryProposal(input: {
  proposal: unknown
  now: Date
  activeMemory?: ActiveMemory
}): MemoryPolicyDecision {
  const parsed = MemoryProposalSchema.parse(input.proposal)
  const proposal = {
    ...parsed,
    content: normalizeMemoryContent(parsed.content),
  }
  const contentFingerprint = fingerprintMemoryContent(proposal.content)
  if (!Number.isFinite(input.now.getTime())) throw new Error('Memory policy clock is invalid')
  if (new Date(proposal.expiresAt).getTime() <= input.now.getTime()) {
    return { outcome: 'rejected', reason: 'expired', contentFingerprint }
  }
  if (proposal.proposedBy === 'model' && proposal.sensitivity === 'sensitive') {
    return { outcome: 'rejected', reason: 'sensitive_inference', contentFingerprint }
  }
  if (
    proposal.proposedBy === 'model' &&
    proposal.confidence < MEMORY_POLICY.minimumModelConfidence
  ) {
    return { outcome: 'rejected', reason: 'low_confidence', contentFingerprint }
  }
  if (!input.activeMemory) {
    return { outcome: 'candidate', proposal, contentFingerprint }
  }
  if (!sameSlot(proposal, input.activeMemory)) {
    throw new Error('Active memory does not belong to the proposal slot')
  }
  return input.activeMemory.contentFingerprint === contentFingerprint
    ? { outcome: 'duplicate', proposal, contentFingerprint }
    : { outcome: 'conflict', proposal, contentFingerprint }
}

export function planMemoryReviewTransition(input: {
  candidate: unknown
  activeMemory?: unknown
  replaceMemoryId?: unknown
}): MemoryReviewTransition {
  const candidate = MemoryReviewCandidateSchema.parse(input.candidate)
  const activeMemory = input.activeMemory === undefined
    ? undefined
    : ActiveMemoryRevisionSchema.parse(input.activeMemory)
  const replaceMemoryId = input.replaceMemoryId === undefined
    ? undefined
    : z.uuid().parse(input.replaceMemoryId)

  if (candidate.policyOutcome === 'candidate') {
    if (replaceMemoryId !== undefined) {
      return { outcome: 'rejected', reason: 'unexpected_replacement' }
    }
    if (activeMemory) return { outcome: 'rejected', reason: 'stale_candidate' }
    return { outcome: 'create', revision: 1 }
  }
  if (!activeMemory || replaceMemoryId !== activeMemory.id) {
    return { outcome: 'rejected', reason: 'replacement_required' }
  }
  if (activeMemory.kind !== candidate.kind) {
    return { outcome: 'rejected', reason: 'kind_mismatch' }
  }
  return {
    outcome: 'replace',
    memoryId: activeMemory.id,
    revision: activeMemory.currentRevision + 1,
  }
}
