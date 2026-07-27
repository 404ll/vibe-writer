export type WritingBuffers = Record<string, string>

export interface WritingPreviewState {
  title: string
  buffer: string
}

export function appendWritingChunk(
  buffers: WritingBuffers,
  title: string,
  chunk: string,
): WritingBuffers {
  if (!chunk) return buffers
  return {
    ...buffers,
    [title]: (buffers[title] ?? '') + chunk,
  }
}

export function removeWritingBuffer(
  buffers: WritingBuffers,
  title: string,
): WritingBuffers {
  if (!(title in buffers)) return buffers
  const next = { ...buffers }
  delete next[title]
  return next
}

export function getActiveWritingPreview(
  buffers: WritingBuffers,
): WritingPreviewState | null {
  const title = Object.keys(buffers)[0]
  return title ? { title, buffer: buffers[title] } : null
}
