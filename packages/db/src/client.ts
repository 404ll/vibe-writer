import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres, { type Options, type PostgresType, type Sql } from 'postgres'
import * as schema from './schema'

export type VibePostgresDatabase = PostgresJsDatabase<typeof schema>

export function createPostgresDatabase(
  connectionString: string,
  options: Options<Record<string, PostgresType>> = {},
): {
  db: VibePostgresDatabase
  client: Sql
  close: () => Promise<void>
} {
  const client = postgres(connectionString, options)
  const db = drizzle(client, { schema })

  return {
    db,
    client,
    close: () => client.end(),
  }
}
