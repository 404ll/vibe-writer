import { createHash } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core'
import {
  articles,
  articleVersions,
  jobs,
  type ArticleRow,
  type ArticleVersionRow,
} from '../schema'
import type { VibeDatabase } from './jobs'

const MAX_MARKDOWN_BYTES = 8 * 1024 * 1024

export type ArticleWriteInput = {
  articleId: string
  content: string
  expectedRevision: number
}

export type RestoreArticleVersionInput = {
  articleId: string
  versionId: number
  expectedRevision: number
}

export type ArticleMutationResult =
  | { status: 'updated'; article: ArticleRow; snapshot: ArticleVersionRow }
  | { status: 'not_found' }
  | { status: 'version_not_found' }
  | { status: 'revision_conflict'; currentRevision: number }

function normalizeContent(content: string): string {
  if (!content.trim()) throw new Error('Article content is required')
  if (Buffer.byteLength(content, 'utf8') > MAX_MARKDOWN_BYTES) {
    throw new Error(`Article content exceeds ${MAX_MARKDOWN_BYTES} bytes`)
  }
  return content
}

function contentFingerprint(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function wordCount(content: string): number {
  return Array.from(content.replace(/\s/gu, '')).length
}

export class ArticleRepository<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: VibeDatabase<TQueryResult>) {}

  listArticles() {
    return this.db.select().from(articles).orderBy(desc(articles.createdAt))
  }

  listArticlesForWorkspace(workspaceId: string) {
    return this.db
      .select({ article: articles })
      .from(articles)
      .innerJoin(jobs, eq(jobs.id, articles.jobId))
      .where(eq(jobs.workspaceId, workspaceId))
      .orderBy(desc(articles.createdAt))
      .then((rows) => rows.map((row) => row.article))
  }

  async getArticle(articleId: string): Promise<ArticleRow | null> {
    const [article] = await this.db
      .select()
      .from(articles)
      .where(eq(articles.id, articleId))
      .limit(1)
    return article ?? null
  }

  async getArticleForWorkspace(
    articleId: string,
    workspaceId: string,
  ): Promise<ArticleRow | null> {
    const [row] = await this.db
      .select({ article: articles })
      .from(articles)
      .innerJoin(jobs, eq(jobs.id, articles.jobId))
      .where(and(eq(articles.id, articleId), eq(jobs.workspaceId, workspaceId)))
      .limit(1)
    return row?.article ?? null
  }

  async listVersions(articleId: string): Promise<ArticleVersionRow[] | null> {
    const [article] = await this.db
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.id, articleId))
      .limit(1)
    if (!article) return null
    return this.db
      .select()
      .from(articleVersions)
      .where(eq(articleVersions.articleId, articleId))
      .orderBy(desc(articleVersions.savedAt), desc(articleVersions.id))
  }

  async listVersionsForWorkspace(
    articleId: string,
    workspaceId: string,
  ): Promise<ArticleVersionRow[] | null> {
    if (!(await this.getArticleForWorkspace(articleId, workspaceId))) return null
    return this.db
      .select()
      .from(articleVersions)
      .where(eq(articleVersions.articleId, articleId))
      .orderBy(desc(articleVersions.savedAt), desc(articleVersions.id))
  }

  async getVersion(articleId: string, versionId: number): Promise<ArticleVersionRow | null> {
    const [version] = await this.db
      .select()
      .from(articleVersions)
      .where(
        and(
          eq(articleVersions.articleId, articleId),
          eq(articleVersions.id, versionId),
        ),
      )
      .limit(1)
    return version ?? null
  }

  async getVersionForWorkspace(
    articleId: string,
    versionId: number,
    workspaceId: string,
  ): Promise<ArticleVersionRow | null> {
    if (!(await this.getArticleForWorkspace(articleId, workspaceId))) return null
    return this.getVersion(articleId, versionId)
  }

  async patchArticle(input: ArticleWriteInput): Promise<ArticleMutationResult> {
    const content = normalizeContent(input.content)
    return this.mutateCurrent(input.articleId, input.expectedRevision, async () => ({
      content,
      contentFingerprint: contentFingerprint(content),
      wordCount: wordCount(content),
    }))
  }

  async patchArticleForWorkspace(
    input: ArticleWriteInput,
    workspaceId: string,
  ): Promise<ArticleMutationResult> {
    const content = normalizeContent(input.content)
    return this.mutateCurrent(input.articleId, input.expectedRevision, async () => ({
      content,
      contentFingerprint: contentFingerprint(content),
      wordCount: wordCount(content),
    }), workspaceId)
  }

  async restoreVersion(input: RestoreArticleVersionInput): Promise<ArticleMutationResult> {
    return this.mutateCurrent(
      input.articleId,
      input.expectedRevision,
      async (tx) => {
        const [version] = await tx
          .select()
          .from(articleVersions)
          .where(
            and(
              eq(articleVersions.articleId, input.articleId),
              eq(articleVersions.id, input.versionId),
            ),
          )
          .limit(1)
        if (!version) return null
        return {
          content: version.content,
          contentFingerprint: version.contentFingerprint,
          wordCount: version.wordCount,
        }
      },
    )
  }

  async restoreVersionForWorkspace(
    input: RestoreArticleVersionInput,
    workspaceId: string,
  ): Promise<ArticleMutationResult> {
    return this.mutateCurrent(
      input.articleId,
      input.expectedRevision,
      async (tx) => {
        const [version] = await tx
          .select()
          .from(articleVersions)
          .where(
            and(
              eq(articleVersions.articleId, input.articleId),
              eq(articleVersions.id, input.versionId),
            ),
          )
          .limit(1)
        if (!version) return null
        return {
          content: version.content,
          contentFingerprint: version.contentFingerprint,
          wordCount: version.wordCount,
        }
      },
      workspaceId,
    )
  }

  private async mutateCurrent(
    articleId: string,
    expectedRevision: number,
    nextContent: (
      tx: Parameters<Parameters<VibeDatabase<TQueryResult>['transaction']>[0]>[0],
      current: ArticleRow,
    ) => Promise<{
      content: string
      contentFingerprint: string
      wordCount: number
    } | null>,
    workspaceId?: string,
  ): Promise<ArticleMutationResult> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(articles)
        .where(
          workspaceId
            ? and(
                eq(articles.id, articleId),
                sql`exists (
                  select 1 from ${jobs}
                  where ${jobs.id} = ${articles.jobId}
                    and ${jobs.workspaceId} = ${workspaceId}
                )`,
              )
            : eq(articles.id, articleId),
        )
        .for('update')
        .limit(1)
      if (!current) return { status: 'not_found' as const }
      if (current.revision !== expectedRevision) {
        return {
          status: 'revision_conflict' as const,
          currentRevision: current.revision,
        }
      }

      const replacement = await nextContent(tx, current)
      if (!replacement) return { status: 'version_not_found' as const }

      const [snapshot] = await tx
        .insert(articleVersions)
        .values({
          articleId: current.id,
          sourceRevision: current.revision,
          content: current.content,
          contentFingerprint: current.contentFingerprint,
          wordCount: current.wordCount,
        })
        .returning()
      if (!snapshot) throw new Error(`Article snapshot failed for ${articleId}`)

      const [article] = await tx
        .update(articles)
        .set({
          ...replacement,
          revision: current.revision + 1,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(articles.id, articleId),
            eq(articles.revision, expectedRevision),
          ),
        )
        .returning()
      if (!article) throw new Error(`Article revision changed for ${articleId}`)
      return { status: 'updated' as const, article, snapshot }
    })
  }
}

export function createArticleRepository<TQueryResult extends PgQueryResultHKT>(
  db: VibeDatabase<TQueryResult>,
) {
  return new ArticleRepository(db)
}
