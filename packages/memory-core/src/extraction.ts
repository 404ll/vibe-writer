import { z } from 'zod'
import {
  MemoryEvidenceSourceSchema,
  MemoryProposalSchema,
  type MemoryProposal,
} from './policy'

export const MEMORY_EXTRACTION_CONTRACT = {
  schemaVersion: 1,
  maximumCandidatesPerRun: 20,
} as const

const Identifier = z.string().trim().min(1).max(256)

export const MemoryExtractionOutputSchema = z.object({
  schemaVersion: z.literal(MEMORY_EXTRACTION_CONTRACT.schemaVersion),
  candidates: z.array(z.object({
    subject: z.object({
      kind: z.enum(['workspace', 'principal', 'project']),
      key: Identifier,
    }).strict(),
    memoryKey: z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{0,255}$/),
    kind: z.enum(['preference', 'constraint', 'correction']),
    content: z.string().min(1).max(4_096),
    confidence: z.number().min(0).max(1),
    sensitivity: z.enum(['normal', 'sensitive']),
  }).strict()).max(MEMORY_EXTRACTION_CONTRACT.maximumCandidatesPerRun),
}).strict()

export const MemoryExtractionEnvelopeSchema = z.object({
  workspaceId: z.uuid(),
  source: MemoryEvidenceSourceSchema,
  subject: z.object({
    kind: z.enum(['workspace', 'principal', 'project']),
    key: Identifier,
  }).strict().optional(),
  extractor: z.object({ key: Identifier, version: Identifier }).strict(),
  consent: z.object({
    basis: z.enum(['explicit_user', 'workspace_policy']),
    policyVersion: Identifier,
  }).strict(),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict()

export type MemoryExtractionOutput = z.infer<typeof MemoryExtractionOutputSchema>
export type MemoryExtractionEnvelope = z.infer<typeof MemoryExtractionEnvelopeSchema>

export function composeModelMemoryProposals(input: {
  envelope: unknown
  modelOutput: unknown
}): MemoryProposal[] {
  const envelope = MemoryExtractionEnvelopeSchema.parse(input.envelope)
  const output = MemoryExtractionOutputSchema.parse(input.modelOutput)
  const slots = new Set<string>()

  return output.candidates.map((candidate) => {
    const subject = envelope.subject ?? candidate.subject
    const slot = `${subject.kind}\0${subject.key}\0${candidate.memoryKey}`
    if (slots.has(slot)) {
      throw new Error('Memory extractor output contains a duplicate slot')
    }
    slots.add(slot)
    return MemoryProposalSchema.parse({
      schemaVersion: 2,
      workspaceId: envelope.workspaceId,
      subject,
      memoryKey: candidate.memoryKey,
      kind: candidate.kind,
      content: candidate.content,
      proposedBy: 'model',
      confidence: candidate.confidence,
      sensitivity: candidate.sensitivity,
      consent: envelope.consent,
      source: envelope.source,
      extractor: envelope.extractor,
      expiresAt: envelope.expiresAt,
    })
  })
}
