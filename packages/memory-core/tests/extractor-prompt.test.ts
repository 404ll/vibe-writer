import { describe, expect, it } from 'vitest'
import {
  MEMORY_EXTRACTOR_PROMPT,
  buildMemoryExtractorPrompt,
  parseMemoryExtractorResponse,
} from '../src'

const durableUser = {
  segments: [{
    id: 'user-1',
    author: 'user' as const,
    scope: 'durable' as const,
    text: '以后请一直使用简洁的技术表达。',
  }],
}

describe('versioned Memory extractor prompt', () => {
  it('serializes trusted provenance separately from fixed system instructions', () => {
    const prompt = buildMemoryExtractorPrompt(durableUser)
    expect(prompt.promptVersion).toBe(MEMORY_EXTRACTOR_PROMPT.version)
    expect(prompt.system).toContain('authored by the user AND scope is durable')
    expect(prompt.system).toContain('assistant-generated articles')
    expect(prompt.system).not.toContain('以后请一直使用简洁')
    expect(JSON.parse(prompt.user)).toEqual({ sourceSegments: durableUser.segments })
  })

  it('rejects duplicate segment ids and a source above the total character budget', () => {
    expect(() => buildMemoryExtractorPrompt({
      segments: [durableUser.segments[0], durableUser.segments[0]],
    })).toThrow('duplicate segment id')
    expect(() => buildMemoryExtractorPrompt({
      segments: [
        { id: 'one', author: 'user', scope: 'durable', text: 'a'.repeat(20_000) },
        { id: 'two', author: 'user', scope: 'durable', text: 'b'.repeat(20_000) },
        { id: 'three', author: 'user', scope: 'durable', text: 'c'.repeat(10_001) },
      ],
    })).toThrow('total character budget')
  })

  it('parses strict contract JSON and rejects Markdown or untrusted fields', () => {
    const valid = {
      schemaVersion: 1,
      candidates: [{
        subject: { kind: 'principal', key: 'self' },
        memoryKey: 'writing.tone',
        kind: 'preference',
        content: 'Prefer concise technical prose.',
        confidence: 0.95,
        sensitivity: 'normal',
      }],
    }
    expect(parseMemoryExtractorResponse(JSON.stringify(valid))).toEqual(valid)
    expect(() => parseMemoryExtractorResponse(
      `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
    )).toThrow('strict JSON')
    expect(() => parseMemoryExtractorResponse(JSON.stringify({
      ...valid,
      workspaceId: 'forged',
    }))).toThrow()
  })
})
