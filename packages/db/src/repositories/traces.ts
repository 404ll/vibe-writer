import { asc, eq } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { runs, traceSpans } from '../schema'
import type { VibeDatabase } from './jobs'

export class TraceRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  async getRunTrace(runId: string) {
    const [run] = await this.db
      .select({
        id: runs.id,
        jobId: runs.jobId,
        traceId: runs.traceId,
        status: runs.status,
        modelProfile: runs.modelProfile,
        promptVersion: runs.promptVersion,
        graphVersion: runs.graphVersion,
        toolVersions: runs.toolVersions,
        codeRevision: runs.codeRevision,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
    if (!run) return null

    const spans = await this.db
      .select()
      .from(traceSpans)
      .where(eq(traceSpans.runId, runId))
      .orderBy(asc(traceSpans.startedAt), asc(traceSpans.createdAt))

    return { run, spans }
  }
}

export function createTraceRepository<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
) {
  return new TraceRepository(db)
}
