export type ParsedSseFrame = {
  event: string
  data: Record<string, unknown>
}

/** 从尚未读完的文本里切出完整 SSE 帧（以空行分隔），半截留在 rest。 */
export function takeCompleteSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = []
  let rest = buffer
  let boundaryIndex = rest.search(/\r?\n\r?\n/)
  while (boundaryIndex !== -1) {
    frames.push(rest.slice(0, boundaryIndex))
    const boundaryMatch = rest.slice(boundaryIndex).match(/^\r?\n\r?\n/)
    rest = rest.slice(boundaryIndex + (boundaryMatch?.[0].length ?? 2))
    boundaryIndex = rest.search(/\r?\n\r?\n/)
  }
  return { frames, rest }
}

/** 把一块完整帧解析成事件名和 JSON data；注释行和空 data 会丢掉。 */
export function parseSseFrame(frame: string): ParsedSseFrame | null {
  let event = 'message'
  const dataLines: string[] = []

  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue

    const separatorIndex = line.indexOf(':')
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex)
    const rawValue = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1)
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue

    if (field === 'event') {
      event = value
    } else if (field === 'data') {
      dataLines.push(value)
    }
  }

  if (dataLines.length === 0) return null

  try {
    return {
      event,
      data: JSON.parse(dataLines.join('\n')) as Record<string, unknown>,
    }
  } catch (err) {
    console.error('[parseSseFrame] invalid JSON data', err)
    return null
  }
}
