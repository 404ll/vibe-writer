import { z } from 'zod'
import { MemoryExtractionOutputSchema, type MemoryExtractionOutput } from './extraction'

export const MEMORY_EXTRACTOR_PROMPT = {
  key: 'durable-user-memory-extractor',
  version: '2026-08-07-v1',
  outputSchemaVersion: 1,
  maximumSegments: 50,
  maximumSegmentCharacters: 20_000,
  maximumSourceCharacters: 50_000,
} as const

const SegmentId = z.string().trim().regex(/^[a-z0-9][a-z0-9_.:-]{0,127}$/)

export const MemoryExtractionPromptInputSchema = z.object({
  segments: z.array(z.object({
    id: SegmentId,
    author: z.enum(['user', 'assistant', 'system']),
    scope: z.enum(['durable', 'task', 'unknown']),
    text: z.string().min(1).max(MEMORY_EXTRACTOR_PROMPT.maximumSegmentCharacters),
  }).strict())
    .min(1)
    .max(MEMORY_EXTRACTOR_PROMPT.maximumSegments),
}).strict()

export type MemoryExtractionPromptInput = z.infer<typeof MemoryExtractionPromptInputSchema>

const SYSTEM_PROMPT = `You extract durable user-authored writing memories from trusted source segments.

Safety and scope rules:
1. Emit a candidate only when the evidence is authored by the user AND scope is durable.
2. Never convert assistant-generated articles, system text, quoted third-party text, task-only instructions, or unknown-scope statements into long-term memory.
3. Do not infer health, politics, religion, ethnicity, sexuality, precise location, credentials, secrets, or other sensitive personal attributes. Return no candidate for such material.
4. Prefer an empty candidates array when evidence is ambiguous, temporary, contradictory, descriptive rather than prescriptive, or not explicitly about future behavior.
5. Use stable lowercase memory keys. Keep content concise and preserve the user's intended meaning.
6. Output strict JSON only. Do not use Markdown fences or add explanation.

Output shape:
{"schemaVersion":1,"candidates":[{"subject":{"kind":"workspace|principal|project","key":"..."},"memoryKey":"...","kind":"preference|constraint|correction","content":"...","confidence":0.0,"sensitivity":"normal|sensitive"}]}

The trusted runtime, not you, supplies workspace, source, consent, retention, and extractor identity.`

export function buildMemoryExtractorPrompt(input: unknown): {
  system: string
  user: string
  promptVersion: typeof MEMORY_EXTRACTOR_PROMPT.version
} {
  const parsed = MemoryExtractionPromptInputSchema.parse(input)
  const ids = new Set<string>()
  let sourceCharacters = 0
  for (const segment of parsed.segments) {
    if (ids.has(segment.id)) throw new Error('Memory extractor source contains a duplicate segment id')
    ids.add(segment.id)
    sourceCharacters += segment.text.length
  }
  if (sourceCharacters > MEMORY_EXTRACTOR_PROMPT.maximumSourceCharacters) {
    throw new Error('Memory extractor source exceeds the total character budget')
  }
  return {
    system: SYSTEM_PROMPT,
    user: JSON.stringify({ sourceSegments: parsed.segments }),
    promptVersion: MEMORY_EXTRACTOR_PROMPT.version,
  }
}

export function parseMemoryExtractorResponse(text: string): MemoryExtractionOutput {
  const normalized = text.trim()
  if (!normalized || normalized.length > 65_536) {
    throw new Error('Memory extractor response is empty or exceeds the response budget')
  }
  let value: unknown
  try {
    value = JSON.parse(normalized)
  } catch {
    throw new Error('Memory extractor response must be strict JSON')
  }
  return MemoryExtractionOutputSchema.parse(value)
}
