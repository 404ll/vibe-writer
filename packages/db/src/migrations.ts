import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import type { VibePostgresDatabase } from './client'

const defaultMigrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

export function migrateVibePostgresDatabase(
  database: VibePostgresDatabase,
  migrationsFolder = defaultMigrationsFolder,
): Promise<void> {
  return migrate(database, { migrationsFolder })
}
