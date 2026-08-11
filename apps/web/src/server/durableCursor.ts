import 'server-only'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export type DurableUuidCursor = { id: string }

export function encodeDurableUuidCursor(cursor: DurableUuidCursor): string {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    id: cursor.id,
  }), 'utf8').toString('base64url')
}

export function decodeDurableUuidCursor(value: string): DurableUuidCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (
      Object.keys(record).sort().join(',') !== 'id,schemaVersion' ||
      record.schemaVersion !== 1 ||
      typeof record.id !== 'string' ||
      !UUID_PATTERN.test(record.id)
    ) return null
    return { id: record.id }
  } catch {
    return null
  }
}
