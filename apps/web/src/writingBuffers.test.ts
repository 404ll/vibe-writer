import { describe, expect, it } from 'vitest'
import {
  appendWritingChunk,
  getActiveWritingPreview,
  removeWritingBuffer,
} from './writingBuffers'

describe('writing buffers', () => {
  it('keeps interleaved chapter chunks in separate buffers', () => {
    let buffers = {}
    buffers = appendWritingChunk(buffers, '第一章', '第一章-1')
    buffers = appendWritingChunk(buffers, '第二章', '第二章-1')
    buffers = appendWritingChunk(buffers, '第一章', '第一章-2')

    expect(buffers).toEqual({
      第一章: '第一章-1第一章-2',
      第二章: '第二章-1',
    })
    expect(getActiveWritingPreview(buffers)).toEqual({
      title: '第一章',
      buffer: '第一章-1第一章-2',
    })
  })

  it('moves the preview to the next active chapter when one finishes', () => {
    const buffers = {
      第一章: '第一章正文',
      第二章: '第二章正文',
    }

    const next = removeWritingBuffer(buffers, '第一章')

    expect(getActiveWritingPreview(next)).toEqual({
      title: '第二章',
      buffer: '第二章正文',
    })
    expect(buffers).toHaveProperty('第一章')
  })
})
