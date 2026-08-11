export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export type JsonObject = { [key: string]: JsonValue }

function asJsonObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function tryParseObject(raw: string): JsonObject | null {
  try {
    return asJsonObject(JSON.parse(raw))
  } catch {
    return null
  }
}

export function parseJsonObject(raw: string): JsonObject | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const direct = tryParseObject(trimmed)
  if (direct) return direct

  if (trimmed.startsWith('```')) {
    const lines = trimmed.split('\n')
    const withoutFence = lines.at(-1)?.trim() === '```' ? lines.slice(1, -1) : lines.slice(1)
    const fenced = tryParseObject(withoutFence.join('\n').trim())
    if (fenced) return fenced
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  return start >= 0 && end > start ? tryParseObject(trimmed.slice(start, end + 1)) : null
}
