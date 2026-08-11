import { describe, expect, it } from 'vitest'
import { ModelRuntimeError, parseJsonObject, textFromToolBlocks } from '../src'

describe('parseJsonObject', () => {
  it.each([
    ['direct JSON', '{"passed":true}', { passed: true }],
    ['markdown fence', '```json\n{"passed":false}\n```', { passed: false }],
    ['surrounding prose', 'result: {"passed":true} done', { passed: true }],
  ])('parses %s', (_name, raw, expected) => {
    expect(parseJsonObject(raw)).toEqual(expected)
  })

  it.each(['', 'not json', '[1, 2, 3]', '```json\nnot json\n```'])(
    'returns null for an invalid object: %s',
    (raw) => {
      expect(parseJsonObject(raw)).toBeNull()
    },
  )
})

describe('tool model helpers', () => {
  it('joins text blocks without exposing provider-specific block types', () => {
    expect(
      textFromToolBlocks([
        { type: 'text', text: '第一段' },
        { type: 'tool_call', id: 'call-1', name: 'search', input: { query: '资料' } },
        { type: 'text', text: '第二段' },
      ]),
    ).toBe('第一段第二段')
  })
})

describe('ModelRuntimeError', () => {
  it('keeps normalized error metadata without exposing a provider SDK type', () => {
    const cause = new Error('provider detail')
    const error = new ModelRuntimeError('Model timed out', {
      code: 'timeout',
      retryable: true,
      provider: 'test-provider',
      cause,
    })

    expect(error).toMatchObject({
      name: 'ModelRuntimeError',
      code: 'timeout',
      retryable: true,
      provider: 'test-provider',
    })
    expect(error.cause).toBe(cause)
  })
})
