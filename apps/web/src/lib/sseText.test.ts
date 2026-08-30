import { describe, expect, it } from 'vitest'
import { parseSseFrame, takeCompleteSseFrames } from './sseText'

describe('takeCompleteSseFrames', () => {
  it('keeps an incomplete frame in rest', () => {
    expect(takeCompleteSseFrames('event: stage_update\ndata: {')).toEqual({
      frames: [],
      rest: 'event: stage_update\ndata: {',
    })
  })

  it('splits complete frames and leaves the tail', () => {
    expect(
      takeCompleteSseFrames('event: a\ndata: {"n":1}\n\nevent: b\ndata: {"n":2}\n\nevent: c\n'),
    ).toEqual({
      frames: ['event: a\ndata: {"n":1}', 'event: b\ndata: {"n":2}'],
      rest: 'event: c\n',
    })
  })
})

describe('parseSseFrame', () => {
  it('parses event name and JSON data', () => {
    expect(parseSseFrame('event: outline_ready\ndata: {"outline":["ch1"]}')).toEqual({
      event: 'outline_ready',
      data: { outline: ['ch1'] },
    })
  })

  it('skips comment lines and returns null without data', () => {
    expect(parseSseFrame(': keep-alive')).toBeNull()
    expect(parseSseFrame('event: stage_update')).toBeNull()
  })
})
